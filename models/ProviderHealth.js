const mongoose = require('mongoose');

const ProviderHealthSchema = new mongoose.Schema({
  provider: { type: String, required: true },
  ok: { type: Boolean, required: true },
  diagnostic: mongoose.Schema.Types.Mixed,
  checkedAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports =
  mongoose.models.ProviderHealth ||
  mongoose.model('ProviderHealth', ProviderHealthSchema);
