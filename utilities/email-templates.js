// ─────────────────────────────────────────────────────────────────────────
// Shared "luxury" HTML email shell — pure white/black/graphite, serif
// display type, used for every system alert (errors, logins, orders, EOD).
// Table-based layout + inline styles throughout because most email clients
// (Outlook especially) ignore <style> blocks and modern CSS.
//
// INVERTED THEME: was dark (black bg / white text), now light (white bg /
// black text) — every base neutral below is the flipped counterpart of the
// old value. Status badge colors were re-tinted (not literally inverted,
// which would've turned green into pink) so success/error/warning/info are
// still readable on a light background.
// ─────────────────────────────────────────────────────────────────────────

const SILVER = '#17161a';
const SILVER_MUTED = '#47453f';
const INK = '#ffffff';
const PANEL = '#ededed';
const PANEL_BORDER = '#d1d1d1';
const TEXT_MAIN = '#0a0a09';
const TEXT_MUTED = '#65635d';

// Status badges keep a touch of color (green/red) since that's functional
// signal — success vs. failure — not decoration. Everything else stays
// monochrome. Re-tinted for a light background (light bg + darker text)
// instead of the old dark bg + light text.
const STATUS_COLORS = {
    success: { bg: '#eaf7f0', border: '#b7dcc7', text: '#1f7a4c' },
    error: { bg: '#fdecec', border: '#f0c2c2', text: '#a33232' },
    warning: { bg: '#fdf6e3', border: '#eddfa9', text: '#8a6d1f' },
    info: { bg: '#eef1f5', border: '#c7cdd6', text: '#3a4250' }
};

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * @param {'success'|'error'|'warning'|'info'} status
 */
function badge(status, label) {
    const c = STATUS_COLORS[status] || STATUS_COLORS.info;
    return `
    <span style="display:inline-block; padding:6px 16px; border-radius:999px; background:${c.bg}; border:1px solid ${c.border}; color:${c.text}; font-family:'Helvetica Neue',Arial,sans-serif; font-size:12px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase;">
      ${escapeHtml(label)}
    </span>`;
}

/**
 * A labeled key/value row inside a panel.
 */
function kvRow(label, value, opts = {}) {
    const valueColor = opts.color || TEXT_MAIN;
    return `
    <tr>
      <td style="padding:10px 0; border-bottom:1px solid ${PANEL_BORDER}; font-family:'Helvetica Neue',Arial,sans-serif; font-size:13px; color:${TEXT_MUTED}; letter-spacing:0.3px; width:38%; vertical-align:top;">
        ${escapeHtml(label)}
      </td>
      <td style="padding:10px 0; border-bottom:1px solid ${PANEL_BORDER}; font-family:'Helvetica Neue',Arial,sans-serif; font-size:14px; color:${valueColor}; font-weight:600; vertical-align:top; text-align:right;">
        ${value}
      </td>
    </tr>`;
}

/**
 * A panel (rounded card) wrapping arbitrary inner HTML (usually a <table> of kvRows).
 */
function panel(title, innerHtml) {
    return `
    <tr><td style="padding:0 0 28px 0;">
      ${title ? `<div style="font-family:Georgia,'Times New Roman',serif; font-size:13px; letter-spacing:2px; text-transform:uppercase; color:${SILVER}; margin:0 0 12px 2px;">${escapeHtml(title)}</div>` : ''}
      <div style="background:${PANEL}; border:1px solid ${PANEL_BORDER}; border-radius:10px; padding:20px 22px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${innerHtml}
        </table>
      </div>
    </td></tr>`;
}

/**
 * A monospace/code block panel (e.g. for stack traces / raw error messages).
 */
function codePanel(title, code) {
    return `
    <tr><td style="padding:0 0 28px 0;">
      ${title ? `<div style="font-family:Georgia,'Times New Roman',serif; font-size:13px; letter-spacing:2px; text-transform:uppercase; color:${SILVER}; margin:0 0 12px 2px;">${escapeHtml(title)}</div>` : ''}
      <div style="background:#ffffff; border:1px solid ${PANEL_BORDER}; border-radius:10px; padding:16px 18px; overflow-x:auto;">
        <code style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace; font-size:12.5px; line-height:1.6; color:#a30000; white-space:pre-wrap; word-break:break-word;">${escapeHtml(code)}</code>
      </div>
    </td></tr>`;
}

/**
 * A simple table (for lists of orders, signals, etc). columns: [{label,key,align}], rows: [{...}]
 */
function dataTable(title, columns, rows, opts = {}) {
    const head = columns.map(c => `
      <th align="${c.align || 'left'}" style="padding:10px 14px; border-bottom:1px solid ${SILVER}; font-family:'Helvetica Neue',Arial,sans-serif; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:${SILVER_MUTED}; white-space:nowrap;">
        ${escapeHtml(c.label)}
      </th>`).join('');

    const body = rows.length
        ? rows.map((row, i) => `
      <tr style="background:${i % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.03)'};">
        ${columns.map(c => `
          <td align="${c.align || 'left'}" style="padding:10px 14px; border-bottom:1px solid ${PANEL_BORDER}; font-family:'Helvetica Neue',Arial,sans-serif; font-size:13px; color:${row[`${c.key}Color`] || TEXT_MAIN}; white-space:nowrap;">
            ${escapeHtml(row[c.key] ?? '-')}
          </td>`).join('')}
      </tr>`).join('')
        : `<tr><td colspan="${columns.length}" style="padding:24px 14px; text-align:center; font-family:'Helvetica Neue',Arial,sans-serif; font-size:13px; color:${TEXT_MUTED};">${escapeHtml(opts.emptyText || 'No rows.')}</td></tr>`;

    return `
    <tr><td style="padding:0 0 28px 0;">
      ${title ? `<div style="font-family:Georgia,'Times New Roman',serif; font-size:13px; letter-spacing:2px; text-transform:uppercase; color:${SILVER}; margin:0 0 12px 2px;">${escapeHtml(title)}</div>` : ''}
      <div style="background:${PANEL}; border:1px solid ${PANEL_BORDER}; border-radius:10px; overflow:hidden;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
          <thead><tr>${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </td></tr>`;
}

/**
 * Builds the full HTML document for an alert email.
 *
 * @param {object} opts
 * @param {'success'|'error'|'warning'|'info'} opts.status
 * @param {string} opts.badgeLabel   - small pill text, e.g. "LOGIN FAILED"
 * @param {string} opts.title        - big headline, e.g. "Shoonya Login Failed"
 * @param {string} [opts.subtitle]   - one-line summary under the headline
 * @param {string} opts.bodyHtml     - pre-built inner <tr> blocks (panel/codePanel/dataTable/kvRow-wrapped)
 * @param {string} [opts.footerNote] - small print at the bottom
 */
export function buildAlertEmail({ status = 'info', badgeLabel, title, subtitle, bodyHtml, footerNote }) {
    const c = STATUS_COLORS[status] || STATUS_COLORS.info;
    const timestamp = new Date().toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'full',
        timeStyle: 'medium'
    });

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0; padding:0; background:${INK}; background-image:radial-gradient(circle at 50% 0%, #f5f5f5 0%, ${INK} 60%);">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${INK}; background-image:radial-gradient(circle at 50% 0%, #f5f5f5 0%, ${INK} 60%);">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%;">

          <!-- Crest / brand -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <div style="font-family:Georgia,'Times New Roman',serif; font-size:11px; letter-spacing:5px; text-transform:uppercase; color:${SILVER};">
                — VGT TRADE BOT —
              </div>
              <div style="width:60px; height:1px; background:linear-gradient(90deg, transparent, ${SILVER}, transparent); margin:14px auto 0;"></div>
            </td>
          </tr>

          <!-- Main card -->
          <tr>
            <td style="background:linear-gradient(180deg, #ffffff 0%, #f6f6f6 100%); border:1px solid ${PANEL_BORDER}; border-top:3px solid ${SILVER}; border-radius:16px; padding:38px 34px; box-shadow:0 20px 60px rgba(0,0,0,0.12);">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">

                <tr><td align="center" style="padding-bottom:20px;">${badge(status, badgeLabel || status)}</td></tr>

                <tr>
                  <td align="center" style="padding-bottom:8px;">
                    <div style="font-family:Georgia,'Times New Roman',serif; font-size:24px; line-height:1.35; color:${TEXT_MAIN}; font-weight:400;">
                      ${escapeHtml(title)}
                    </div>
                  </td>
                </tr>

                ${subtitle ? `
                <tr>
                  <td align="center" style="padding-bottom:28px;">
                    <div style="font-family:'Helvetica Neue',Arial,sans-serif; font-size:14px; color:${TEXT_MUTED}; line-height:1.6;">
                      ${escapeHtml(subtitle)}
                    </div>
                  </td>
                </tr>` : `<tr><td style="padding-bottom:20px;"></td></tr>`}

                <tr><td><div style="height:1px; background:${PANEL_BORDER}; margin-bottom:26px;"></div></td></tr>

                ${bodyHtml}

              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:26px;">
              <div style="font-family:'Helvetica Neue',Arial,sans-serif; font-size:11px; color:${TEXT_MUTED}; letter-spacing:0.5px;">
                ${escapeHtml(timestamp)} IST
              </div>
              ${footerNote ? `<div style="font-family:'Helvetica Neue',Arial,sans-serif; font-size:11px; color:#a39fab; margin-top:6px;">${escapeHtml(footerNote)}</div>` : ''}
              <div style="font-family:'Helvetica Neue',Arial,sans-serif; font-size:10px; color:#bab5ab; margin-top:16px;">
                Automated system alert — do not reply to this email.
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export { panel, codePanel, dataTable, kvRow, escapeHtml, STATUS_COLORS };