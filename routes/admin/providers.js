const express = require('express');
const router = express.Router();
const adminAuth = require('../../middleware/adminAuth');
const ctrl = require('../../controllers/adminProviderHealthController');

router.use(adminAuth);
router.get('/', ctrl.list);

module.exports = router;
