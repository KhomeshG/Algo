import nodemailer from 'nodemailer';
import { logger } from './logger.js';

// ─────────────────────────────────────────────────────────────────────────
// Gmail SMTP transport for all system alert emails.
//
// .env needs:
//   ALERT_EMAIL_USER=youraddress@gmail.com
//   ALERT_EMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx   (16-char Gmail "App Password",
//                                                 NOT your normal Gmail password —
//                                                 generate one at
//                                                 https://myaccount.google.com/apppasswords,
//                                                 requires 2-Step Verification on)
//   ALERT_EMAIL_TO=you@example.com,teammate@example.com   (comma-separated)
//   ALERT_EMAIL_FROM_NAME=VGT Trade Bot            (optional, display name)
// ─────────────────────────────────────────────────────────────────────────

let transporter = null;

function getTransporter() {
    if (transporter) return transporter;

    const user = process.env.ALERT_EMAIL_USER;
    const pass = process.env.ALERT_EMAIL_APP_PASSWORD;

    if (!user || !pass) {
        logger.warn('[Mailer] ALERT_EMAIL_USER / ALERT_EMAIL_APP_PASSWORD not set — email alerts are DISABLED.');
        return null;
    }

    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user, pass }
    });

    return transporter;
}

function getRecipients() {
    const raw = process.env.ALERT_EMAIL_TO || process.env.ALERT_EMAIL_USER || '';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Sends one alert email. Never throws — a failed alert email should never
 * crash the worker/route that triggered it. Retries once on transient
 * failure (network blip, Gmail rate limit) before giving up silently
 * (logged either way).
 *
 * @param {object} opts
 * @param {string} opts.subject
 * @param {string} opts.html
 * @param {string} [opts.text] - plain-text fallback (auto-derived if omitted)
 * @param {number} [opts.maxAttempts=2] - maximum SMTP send attempts
 */
export async function sendAlertEmail({ subject, html, text, maxAttempts = 2 }) {
    const t = getTransporter();
    if (!t) return { sent: false, reason: 'mailer-not-configured' };

    const to = getRecipients();
    if (!to.length) {
        logger.warn('[Mailer] No ALERT_EMAIL_TO recipients configured — skipping send.');
        return { sent: false, reason: 'no-recipients' };
    }

    const fromName = process.env.ALERT_EMAIL_FROM_NAME || 'VGT Trade Bot';
    const mail = {
        from: `"${fromName}" <${process.env.ALERT_EMAIL_USER}>`,
        to: to.join(','),
        subject,
        html,
        text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    };

    const attempts = Math.max(1, Number(maxAttempts) || 1);

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const info = await t.sendMail(mail);
            logger.info(`[Mailer] Sent: "${subject}" -> ${to.join(', ')}`, { messageId: info.messageId });
            return { sent: true, messageId: info.messageId };
        } catch (err) {
            logger.error(`[Mailer] Send attempt ${attempt} failed for "${subject}":`, err.message);
            if (attempt === attempts) return { sent: false, reason: err.message };
            await new Promise(r => setTimeout(r, 1500));
        }
    }
}