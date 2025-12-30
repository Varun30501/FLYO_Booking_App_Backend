// backend/controllers/reviewsController.js
const Review = require('../models/Review');

exports.list = async (req, res) => {
  try {
    const rows = await Review.find().sort({ createdAt: -1 }).lean();
    return res.json(rows);
  } catch (err) {
    console.error('[reviews] list error', err);
    return res.status(500).json({ ok: false, error: err.message || 'server error' });
  }
};

exports.create = async (req, res) => {
  try {
    const payload = req.body || {};
    const r = new Review({
      name: payload.name || 'Anonymous',
      rating: Number(payload.rating) || 5,
      text: payload.text || ''
    });
    await r.save();
    return res.status(201).json({ ok: true, review: r });
  } catch (err) {
    console.error('[reviews] create error', err);
    return res.status(500).json({ ok: false, error: err.message || 'server error' });
  }
};
