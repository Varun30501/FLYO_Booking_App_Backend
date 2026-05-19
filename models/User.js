// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true, index: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },

  // Basic profile
  name:  { type: String, default: '' },
  phone: { type: String, default: '' },

  // ADMIN flags — both checked by frontend (isAdmin boolean + role string)
  isAdmin: { type: Boolean, default: false, index: true },
  role:    { type: String, default: 'user', enum: ['user', 'admin', 'superadmin'], index: true },

  // Structured profile
  profile: {
    title:          { type: String, default: '' },
    firstName:      { type: String, default: '' },
    lastName:       { type: String, default: '' },
    dob:            { type: Date,   default: null },
    nationality:    { type: String, default: '' },
    documentType:   { type: String, default: '' },
    documentNumber: { type: String, default: '' },
    address:        { type: String, default: '' }
  },

  // Password reset
  resetPasswordToken:   { type: String },
  resetPasswordExpires: { type: Date }
}, { timestamps: true });

// Virtual: resolved name from profile or name field
userSchema.virtual('displayName').get(function () {
  const p = this.profile;
  if (p && (p.firstName || p.lastName)) {
    return [p.firstName, p.lastName].filter(Boolean).join(' ');
  }
  return this.name || this.email;
});

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
