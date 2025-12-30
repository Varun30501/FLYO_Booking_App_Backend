// models/Package.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const PackageSchema = new Schema({
  title: String,
  subtitle: String,
  img: String,
  origin: String,
  destination: String,
  price: Number,
  nights: Number,
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Package', PackageSchema);
