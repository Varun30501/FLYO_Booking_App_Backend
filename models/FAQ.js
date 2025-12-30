const mongoose = require('mongoose');

const FAQSchema = new mongoose.Schema({
  question: {
    type: String,
    required: true
  },
  answer: {
    type: String,
    required: true
  },
  category: {
    type: String,
    default: 'general'
  },
  order: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true
  },
  views: {
  type: Number,
  default: 0
},

searchHits: {
  type: Number,
  default: 0
}

}, { timestamps: true });

module.exports = mongoose.model('FAQ', FAQSchema);
