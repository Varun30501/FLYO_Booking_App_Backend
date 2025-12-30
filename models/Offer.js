// backend/models/Offer.js
const mongoose = require('mongoose');

const OfferSchema = new mongoose.Schema({
  title: { type: String, required: true },
  subtitle: { type: String },
  img: { type: String },
  priceText: { type: String },

  // NEW: type allows distinguishing promo vs addon
  type: { type: String, enum: ['promo', 'addon', 'coupon'], default: 'promo' },

  // numeric amount in major units (e.g. rupees)
  amount: { type: Number, default: 0 },

  // validity window (optional)
  validFrom: { type: Date, default: null },
  validTo: { type: Date, default: null },

  // whether the offer/addon is active
  active: { type: Boolean, default: true },

  // free-form metadata (carrier, appliesTo, baggage size, meal type, etc.)
  metadata: { type: mongoose.Schema.Types.Mixed },

  createdAt: { type: Date, default: () => new Date() },
  updatedAt: { type: Date, default: () => new Date() }
});

OfferSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.models.Offer || mongoose.model('Offer', OfferSchema);
