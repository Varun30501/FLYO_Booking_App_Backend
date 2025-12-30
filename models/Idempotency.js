// backend/models/Idempotency.js
const mongoose = require('mongoose');

const IdempotencySchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  processed: { type: Boolean, default: false },
  event: { type: mongoose.Schema.Types.Mixed, default: null },
  bookingId: { type: mongoose.Schema.Types.ObjectId, default: null },
  createdAt: { type: Date, default: () => new Date() },
  processedAt: { type: Date, default: null }
});

module.exports = mongoose.models.Idempotency || mongoose.model('Idempotency', IdempotencySchema);
