const mongoose = require("mongoose");

const AirlineSchema = new mongoose.Schema(
  {
    code: { type: String, required: true },
    name: { type: String, required: true },
    slug: { type: String, required: true },
    image: { type: String },
    description: { type: String },
    rating: { type: Number, default: 4 },
    offers: { type: Array, default: [] },
    meta: { type: Object, default: {} }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Airline", AirlineSchema);
