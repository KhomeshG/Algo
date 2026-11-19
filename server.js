import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { connectToDatabase } from './db/mongodb.js';
import { logger } from './utilities/logger.js';
import routes from './routes/index.js';
import { loadOMSConfig } from './services/config.service.js';
import { startAlertScheduler } from './services/alert-scheduler.js';
import { connectShoonyaWebSocket } from './src/websocket/shoonya-socket.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, './.env') });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.set('view engine', 'ejs');
app.set('views', resolve(__dirname, 'views'));
app.use('/api', routes);

app.use((err, req, res, next) => {
  logger.error('Unhandled error', err);
  res.status(500).json({ success: false, message: 'Internal Server Error' });
});

const startServer = async () => {
  try {
    await connectToDatabase();
    // Shoonya order-update + exit socket (single account, ACC1)
    connectShoonyaWebSocket();
    startAlertScheduler(); // 9:30 orders digest + 3:30 PM EOD email
    app.listen(PORT, () => logger.info(`Nine-Fifteen server running on port ${PORT}`));
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

await loadOMSConfig();
startServer();
