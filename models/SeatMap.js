// backend/models/SeatMap.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const SeatSchema = new Schema({
  seatId: { type: String, required: true }, // e.g. "12A"
  row: Number,
  col: Number,
  seatClass: { type: String, enum: ['Economy', 'PremiumEconomy', 'Business', 'First'], default: 'Economy' },
  priceModifier: { type: Number, default: 0 },
  status: { type: String, enum: ['free', 'held', 'booked'], default: 'free' },
  heldBy: { type: String, default: null }, // store userId or session id
  holdUntil: Date,
  heldUntil: Date, // alias used by frontend countdown timer
  features: {
    extraLegroom: { type: Boolean, default: false },
    exitRow:      { type: Boolean, default: false },
    window:       { type: Boolean, default: false },
    aisle:        { type: Boolean, default: false },
    bulkhead:     { type: Boolean, default: false },
  }
}, { _id: false });

const SeatMapSchema = new Schema({
  flightId: { type: String, required: true, index: true },
  travelDate: { type: String, required: true, index: true },
  airline: String,
  origin: String,
  destination: String,
  departsAt: Date,
  rows: Number,
  cols: Number,
  layoutMeta: { type: Schema.Types.Mixed, default: {} },
  seats: { type: [SeatSchema], default: [] },
  updatedAt: { type: Date, default: Date.now }
});

SeatMapSchema.index(
  { flightId: 1, travelDate: 1, origin: 1, destination: 1 },
  { unique: true }
);

module.exports = mongoose.models.SeatMap || mongoose.model('SeatMap', SeatMapSchema);
