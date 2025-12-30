const FAQ = require('../models/FAQ');

/* Public */
exports.list = async (req, res) => {
  const { category } = req.query;

  const filter = { isActive: true };
  if (category && category !== 'all') {
    filter.category = category;
  }

  const faqs = await FAQ.find(filter).sort({ order: 1 });
  res.json({ ok: true, faqs });
};

exports.trackSearch = async (req, res) => {
  const { ids = [] } = req.body;

  if (ids.length) {
    await FAQ.updateMany(
      { _id: { $in: ids } },
      { $inc: { searchHits: 1 } }
    );
  }

  res.json({ ok: true });
};

/* Admin */
exports.adminList = async (req, res) => {
  const faqs = await FAQ.find().sort({ category: 1, order: 1 });
  res.json({ ok: true, faqs });
};

exports.upsert = async (req, res) => {
  const faq = await FAQ.findByIdAndUpdate(
    req.body._id || undefined,
    req.body,
    { upsert: true, new: true }
  );
  res.json({ ok: true, faq });
};

exports.toggle = async (req, res) => {
  const faq = await FAQ.findById(req.params.id);
  faq.isActive = !faq.isActive;
  await faq.save();
  res.json({ ok: true });
};

exports.analytics = async (req, res) => {
  const top = await FAQ.find()
    .sort({ searchHits: -1 })
    .limit(5);

  res.json({ ok: true, top });
};
