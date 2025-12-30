// models/Addon.js
const mongoose = require('mongoose');

const AddonSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true }, // MEAL_VEG, BAG_20KG_AI
  name: { type: String, required: true },               // Vegetarian Meal
  amount: { type: Number, required: true },             // 300
  category: { type: String, enum: ['meal', 'baggage', 'seat', 'misc'], default: 'misc' },

  airline: { type: String, default: null },             // optional: "AI", "6E"
  seatClass: { type: String, default: null },           // economy | business | first | null

  active: { type: Boolean, default: true },

  metadata: { type: mongoose.Schema.Types.Mixed },       // description, image, baggage weight, meal type, etc.

  createdAt: { type: Date, default: () => new Date() },
  updatedAt: { type: Date, default: () => new Date() }
});

AddonSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.models.Addon || mongoose.model('Addon', AddonSchema);
