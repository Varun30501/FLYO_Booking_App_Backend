// backend/models/Review.js
const mongoose = require('mongoose');

const ReviewSchema = new mongoose.Schema({
  name: { type: String, required: true },
  rating: { type: Number, default: 5 },
  text: { type: String },
  createdAt: { type: Date, default: () => new Date() }
});

module.exports = mongoose.model('Review', ReviewSchema);
