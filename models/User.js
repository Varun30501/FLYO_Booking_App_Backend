const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    email: { type: String, unique: true, required: true, index: true },
    passwordHash: { type: String, required: true },

    // legacy/simple fields (keep for compatibility)
    name: { type: String },
    phone: { type: String },

    // NEW: structured profile (real-world booking data)
    profile: {
        title: { type: String, default: '' },            // Mr / Ms / Mrs
        firstName: { type: String, default: '' },
        lastName: { type: String, default: '' },
        dob: { type: Date, default: null },
        nationality: { type: String, default: '' },

        documentType: { type: String, default: '' },     // passport / aadhaar
        documentNumber: { type: String, default: '' },

        address: { type: String, default: '' }
    },

    resetPasswordToken: { type: String },
    resetPasswordExpires: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
