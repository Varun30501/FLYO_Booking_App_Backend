// models/Payment.js
const mongoose = require('mongoose');

const PaymentSchema = new mongoose.Schema({
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  bookingRef: String,
  provider: String, // stripe / razorpay / etc
  amount: Number,
  currency: { type: String, default: 'INR' },
  status: String, // succeeded / failed / refunded
  raw: mongoose.Schema.Types.Mixed
}, { timestamps: true });

module.exports =
  mongoose.models.Payment ||
  mongoose.model('Payment', PaymentSchema);
