// scripts/createAdmin.js
// Creates or updates the admin user in MongoDB.
// Usage:
//   node scripts/createAdmin.js
//   ADMIN_EMAIL=me@example.com ADMIN_PASS=secret123 node scripts/createAdmin.js
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');

const MONGO        = process.env.MONGO_URI || 'mongodb://localhost:27017/flight_booking_dev';
const ADMIN_EMAIL  = process.env.ADMIN_EMAIL  || 'admin@flyo.com';
const ADMIN_PASS   = process.env.ADMIN_PASS   || 'admin123';
const ADMIN_NAME   = process.env.ADMIN_NAME   || 'Flyo Admin';

async function main() {
  console.log('[createAdmin] Connecting:', MONGO);
  await mongoose.connect(MONGO);

  // Require model AFTER connect so indexes are applied
  const User = require('../models/User');

  const hash = await bcrypt.hash(ADMIN_PASS, 12);

  const result = await User.findOneAndUpdate(
    { email: ADMIN_EMAIL },
    {
      $set: {
        email:        ADMIN_EMAIL,
        passwordHash: hash,
        name:         ADMIN_NAME,
        isAdmin:      true,
        role:         'admin'
      }
    },
    { upsert: true, new: true }
  );

  console.log('[createAdmin] ✅ Admin user upserted:');
  console.log('  _id:     ', result._id.toString());
  console.log('  email:   ', result.email);
  console.log('  name:    ', result.name);
  console.log('  isAdmin: ', result.isAdmin);
  console.log('  role:    ', result.role);
  console.log('');
  console.log('  Login with:', ADMIN_EMAIL, '/', ADMIN_PASS);

  await mongoose.disconnect();
  console.log('[createAdmin] Done ✅');
}

main().catch(err => { console.error('[createAdmin] Error:', err.message); process.exit(1); });
