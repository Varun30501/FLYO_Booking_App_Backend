// backend/models/SeatMap.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const SeatSchema = new Schema({
  seatId: { type: String, required: true }, // e.g. "12A"
  row: Number,
  col: Number,
  seatClass: { type: String, enum: ['Economy','PremiumEconomy','Business','First'], default: 'Economy' },
  priceModifier: { type: Number, default: 0 },
  status: { type: String, enum: ['free','held','booked'], default: 'free' },
  heldBy: { type: String, default: null }, // store userId or session id
  holdUntil: Date
}, { _id: false });

const SeatMapSchema = new Schema({
  flightId: { type: String, required: true, index: true },
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

module.exports = mongoose.models.SeatMap || mongoose.model('SeatMap', SeatMapSchema);
