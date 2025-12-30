const ProviderHealth = require('../models/ProviderHealth');

exports.list = async (req, res) => {
  const logs = await ProviderHealth.find()
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  res.json({ ok: true, logs });
};
