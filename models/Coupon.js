// models/Coupon.js
const mongoose = require('mongoose');

const CouponSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true
  },

  // Fixed discount
  amount: { type: Number, default: 0 },

  // Percent discount
  percent: { type: Number, default: 0 },

  // Hard cap on discount (₹)
  cap: { type: Number, default: 0 },

  // Cap in percentage of fare
  capPercent: { type: Number, default: 0 },

  // Optional description (your DB sample contains it)
  description: { type: String, default: "" },

  // Currency for amount fields
  currency: { type: String, default: "INR" },

  // Status flag
  active: { type: Boolean, default: true },

  // Validity dates
  validFrom: { type: Date, default: null },
  validTo: { type: Date, default: null },

  // Minimum fare required
  minFare: { type: Number, default: 0 },

  // Restrict by airline
  allowedAirlines: { type: [String], default: [] },

  // Route restriction
  appliesTo: { type: mongoose.Schema.Types.Mixed, default: null },

  // Extra metadata (UI usage)
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Usage tracking
  usageLimit: { type: Number, default: null },
  usedCount: { type: Number, default: 0 },
  perUserLimit: { type: Number, default: null },

  usageByUser: {
    type: Map,
    of: Number,
    default: {}
  },

  createdAt: { type: Date, default: () => new Date() },
  updatedAt: { type: Date, default: () => new Date() }
});

CouponSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

CouponSchema.methods.incrementUsage = async function (userId = null) {
  this.usedCount = (this.usedCount || 0) + 1;
  if (userId) {
    const prev = this.usageByUser.get(String(userId)) || 0;
    this.usageByUser.set(String(userId), prev + 1);
  }
  await this.save();
};

module.exports =
  mongoose.models.Coupon || mongoose.model("Coupon", CouponSchema);
