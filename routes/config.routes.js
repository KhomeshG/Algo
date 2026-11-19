import express from 'express';
import { setupConfig, shoonyaSetupConfig, updateConfig, getConfig } from '../controller/config.controller.js';
import { authenticateRequest } from '../utilities/auth.middleware.js';

const router = express.Router();

router.post('/setup', authenticateRequest, setupConfig);
// router.post("/update/setup", authenticateRequest, updateConfig)
router.post('/update/setup', authenticateRequest, updateConfig);
router.get('/system/setup', authenticateRequest, getConfig);


export default router;
