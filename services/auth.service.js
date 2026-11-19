import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'vgt-tradebot-secret-key-change-in-production';

// Hardcoded credentials
const VALID_CREDENTIALS = {
  username: 'invester',
  password: 'hyd@511@in',
};

export const validateCredentials = (username, password) => {
  return username === VALID_CREDENTIALS.username && password === VALID_CREDENTIALS.password;
};

export const generateToken = (username) => {
  return jwt.sign(
    { username },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
};

export const verifyToken = (token) => {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded;
  } catch (error) {
    return null;
  }
};
