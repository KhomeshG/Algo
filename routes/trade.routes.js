import express from 'express';
import { placeOrder, placeBracketOrder } from '../controller/trade.controller.js';
import { authenticateRequest } from '../utilities/auth.middleware.js';

const router = express.Router();

router.post('/order', authenticateRequest, placeOrder);
router.post('/bracket-order', authenticateRequest, placeBracketOrder);

export default router;
