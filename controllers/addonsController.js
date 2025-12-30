// controllers/addonsController.js
const Addon = (() => { try { return require('../models/Addon'); } catch (e) { return null; } })();

exports.list = async (req, res) => {
  try {
    if (!Addon) return res.status(404).json({ success: false, message: 'addons model not available' });
    const q = { active: true };
    if (req.query.category) q.category = req.query.category;
    if (req.query.airline) q.airline = req.query.airline;
    const rows = await Addon.find(q).sort({ category: 1, name: 1 }).lean();
    return res.json({ success: true, addons: rows });
  } catch (err) {
    console.error('[addons] list error', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, message: 'server error' });
  }
};
