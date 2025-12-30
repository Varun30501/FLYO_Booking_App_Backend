const express = require('express');
const router = express.Router();
const adminAuth = require('../../middleware/adminAuth');
const ctrl = require('../../controllers/adminExportsController');

router.use(adminAuth);

router.get('/bookings', ctrl.exportBookings);
router.get('/payments', ctrl.exportPayments);
router.get('/reconciliation', ctrl.exportReconcileLogs);

module.exports = router;
