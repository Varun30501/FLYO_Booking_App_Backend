const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'changeme';

function extractToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7);
  }

  if (req.headers['x-access-token']) {
    return req.headers['x-access-token'];
  }

  if (req.cookies?.token) {
    return req.cookies.token;
  }

  return null;
}

async function adminAuth(req, res, next) {
  // ✅ IMPORTANT: allow preflight for PATCH/PUT/DELETE
  if (req.method === 'OPTIONS') {
    return next();
  }

  try {
    const token = extractToken(req);

    if (!token) {
      console.warn('[adminAuth] No token provided');
      return res.status(401).json({ ok: false, error: 'Missing token' });
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      console.warn('[adminAuth] Invalid token');
      return res.status(401).json({ ok: false, error: 'Invalid token' });
    }

    const userId = payload.id || payload.userId || payload._id;
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'Invalid token payload' });
    }

    const user = await User.findById(userId)
      .select('-passwordHash')
      .lean();

    if (!user) {
      return res.status(401).json({ ok: false, error: 'User not found' });
    }

    if (user.isAdmin !== true && user.role !== 'admin') {
      return res.status(403).json({
        ok: false,
        error: 'Admin access required'
      });
    }

    req.user = user;
    req.userId = String(user._id);

    next();
  } catch (err) {
    console.error('[adminAuth] fatal error', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

module.exports = adminAuth;
