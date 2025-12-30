// routes/admin/stats.js
const express = require('express');
const router = express.Router();
const adminAuth = require('../../middleware/adminAuth');
const Booking = require('../../models/Booking');
const Payment = require('../../models/Payment');
const ReconcileLog = require('../../models/ReconciliationLog'); // already exists
const ctrl = require('../../controllers/adminStatsController');

router.use(adminAuth);

router.get('/overview', ctrl.overviewStats);


module.exports = router;
