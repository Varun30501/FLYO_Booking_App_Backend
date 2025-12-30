// backend/controllers/offersController.js
const Offer = require('../models/Offer');

exports.list = async (req, res) => {
  try {
    const rows = await Offer.find().sort({ createdAt: -1 }).lean();
    return res.json(rows);
  } catch (err) {
    console.error('[offers] list error', err);
    return res.status(500).json({ ok: false, error: err.message || 'server error' });
  }
};

exports.create = async (req, res) => {
  try {
    const payload = req.body || {};
    const o = new Offer({
      title: payload.title || 'Untitled offer',
      subtitle: payload.subtitle,
      img: payload.img,
      priceText: payload.priceText,
      metadata: payload.metadata || {}
    });
    await o.save();
    return res.status(201).json({ ok: true, offer: o });
  } catch (err) {
    console.error('[offers] create error', err);
    return res.status(500).json({ ok: false, error: err.message || 'server error' });
  }
};
