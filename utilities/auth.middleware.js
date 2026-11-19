import { verifyToken } from '../services/auth.service.js';

export const authenticateRequest = (req, res, next) => {
  const authHeader = req.headers.authorization;

  console.log("authHeader", authHeader)
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid authorization header' });
  }

  const token = authHeader.substring(7);
  const decoded = verifyToken(token);

  if (!decoded) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }

  req.user = decoded;
  next();
};
