// /backend/models/ReconciliationLog.js
const mongoose = require('mongoose');

const ReconciliationEntrySchema = new mongoose.Schema({
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true },
  paymentIdUsed: { type: String }, // which id was used (paymentIntentId | stripeSessionId | paymentId)
  beforePaymentStatus: { type: String },
  afterPaymentStatus: { type: String },
  beforeBookingStatus: { type: String },
  afterBookingStatus: { type: String },
  result: { type: String }, // MATCH, UPDATED, ERROR
  message: { type: String }
}, { _id: false });

const ReconciliationLogSchema = new mongoose.Schema({
  runAt: { type: Date, default: Date.now },
  runBy: { type: String, default: "system" }, // cron / admin:userId
  processedCount: { type: Number, default: 0 },
  updatedCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 },
  entries: [ReconciliationEntrySchema]
});

module.exports = mongoose.models.ReconciliationLog || mongoose.model("ReconciliationLog", ReconciliationLogSchema);
