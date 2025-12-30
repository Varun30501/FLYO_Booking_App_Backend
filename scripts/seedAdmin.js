// scripts/seedAdmin.js
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const User = require('../models/User'); // adjust path to your User model
require('dotenv').config();

async function run() {
  if (!process.env.MONGO_URI) {
    console.error('Set MONGO_URI env var before running');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  const pw = 'Admin123';
  const hash = await bcrypt.hash(pw, 10);
  const email = 'admin@example.com';
  // remove existing admin with same email so seed is deterministic
  await User.deleteMany({ email: { $regex: `^${email.replace(/\./g,'\\.')}$`, $options: 'i' } });
  const created = await User.create({
    name: 'Admin User',
    email,
    password: hash,
    passwordHash: hash,
    isAdmin: true,
    role: 'admin',
    createdAt: new Date(),
    updatedAt: new Date()
  });
  console.log('Created admin user id:', created._id.toString());
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
