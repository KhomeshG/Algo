import express from 'express';
import configRoutes from './config.routes.js';
import eodReportRoutes from './eod-report.routes.js';
import tradeRoutes from './trade.routes.js';

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok', strategy: 'nine-fifteen', timestamp: new Date().toISOString() });
});

router.use('/config', configRoutes);
router.use('/eod-report', eodReportRoutes);
router.use('/trade', tradeRoutes);

export default router;
