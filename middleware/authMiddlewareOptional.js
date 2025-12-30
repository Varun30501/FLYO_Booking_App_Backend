// middleware/authMiddlewareOptional.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');

module.exports = async function (req, res, next) {
    const auth = req.headers.authorization;
    if (!auth) return next();
    const parts = auth.split(' ');
    if (parts.length !== 2) return next();
    const token = parts[1];
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(payload.id).select('-passwordHash');
        if (user) req.user = user;
    } catch (err) {
        // ignore invalid token for optional middleware
    }
    next();
};
