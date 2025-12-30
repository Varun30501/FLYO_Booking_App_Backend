//middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey';

module.exports = async function auth(req, res, next) {
  try {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ message: 'Unauthorized' });
    const token = h.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload?.id) return res.status(401).json({ message: 'Unauthorized' });
    req.userId = payload.id;
    try { req.user = await User.findById(payload.id).select('-passwordHash -resetPasswordToken -resetPasswordExpires'); } catch (e) {}
    next();
  } catch (err) {
    console.error('[authMiddleware] err', err && (err.message || err));
    return res.status(401).json({ message: 'Unauthorized' });
  }
};
