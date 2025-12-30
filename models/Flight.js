// models/Flight.js
const mongoose = require('mongoose');

const DatePriceSchema = new mongoose.Schema(
  {
    date: { type: String }, // ISO date or readable label
    amount: { type: Number },
    currency: { type: String, default: 'INR' }
  },
  { _id: false }
);

const FlightSchema = new mongoose.Schema(
  {
    // -------- Core flight identity --------
    airline: { type: String, required: true },
    flightNumber: { type: String, required: true },
    origin: { type: String, required: true },
    destination: { type: String, required: true },

    departureAt: { type: Date, required: true },
    arrivalAt: { type: Date },
    duration: { type: String },

    // -------- Pricing --------
    price: {
      amount: { type: Number, required: true },
      currency: { type: String, default: 'INR' }
    },

    // -------- Provider & state (CRITICAL FIX) --------
    provider: {
      type: String,
      enum: ['manual', 'amadeus'],
      default: 'manual',
      index: true
    },

    active: {
      type: Boolean,
      default: true,
      index: true
    },

    // -------- UI / enrichment --------
    image: { type: String },
    rating: { type: Number },

    baggage: {
      cabin: { type: String },
      hold: { type: String }
    },

    meals: {
      included: { type: Boolean, default: false },
      description: { type: String }
    },

    cancellationPolicy: { type: String },

    // Date-wise pricing (carousel / cheapest day UI)
    datePrices: [DatePriceSchema],

    // -------- Raw provider payload (Amadeus etc.) --------
    raw: mongoose.Schema.Types.Mixed
  },
  {
    timestamps: true
  }
);

/**
 * Helpful compound index for admin/search performance
 * (optional but recommended)
 */
FlightSchema.index({ origin: 1, destination: 1, departureAt: 1 });
FlightSchema.index({ airline: 1, flightNumber: 1 });

module.exports =
  mongoose.models.Flight || mongoose.model('Flight', FlightSchema);
