// routes/auth.js
const express = require('express');
const router = express.Router();
const authCtrl = require('../controllers/authController');

// register & login
router.post('/register', authCtrl.register);
router.post('/login', authCtrl.login);

// forgot/reset
router.post('/forgot-password', authCtrl.forgotPassword);
router.post('/reset-password/:token', authCtrl.resetPassword);

// optional: whoami
router.get('/me', authCtrl.me);
router.put('/me', authCtrl.updateProfile);

module.exports = router;
