const router = require('express').Router();
const faq = require('../controllers/faqController');
const admin = require('../middleware/adminAuth'); // or your admin guard

/* Public */
router.get('/', faq.list);
router.post('/track-search', faq.trackSearch);

/* Admin */
router.get('/admin', admin, faq.adminList);
router.post('/admin', admin, faq.upsert);
router.post('/admin/:id/toggle', admin, faq.toggle);
router.get('/admin/analytics', admin, faq.analytics);

module.exports = router;
