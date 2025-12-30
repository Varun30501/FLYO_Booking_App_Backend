// models/Stats.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const StatsSchema = new Schema({
  bookingsToday: { type: Number, default: 0 },
  happyCustomers: { type: Number, default: 0 },
  totalOffers: { type: Number, default: 0 },
  bookingsTrend: { type: [Number], default: [0,0,0,0,0,0,0] },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Stats', StatsSchema);
