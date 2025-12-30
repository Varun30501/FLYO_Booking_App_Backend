// scripts/seed-addons-coupons.js
const mongoose = require('mongoose');
require('dotenv').config();

const Addon = require('../models/Addon');
const Coupon = require('../models/Coupon');

async function main() {
  const mongo = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/flightapp';
  await mongoose.connect(mongo, { useNewUrlParser: true, useUnifiedTopology: true });

  // Seed addons
  const addons = [
    { code: 'MEAL_VEG', name: 'Vegetarian Meal', amount: 300, category: 'meal', metadata: { veg: true, description: 'Vegetarian meal' } },
    { code: 'MEAL_NONVEG', name: 'Non-Veg Meal', amount: 350, category: 'meal', metadata: { veg: false } },
    { code: 'BAG_10KG', name: 'Extra Baggage 10kg', amount: 700, category: 'baggage', metadata: { weightKg: 10 } },
    { code: 'BAG_20KG', name: 'Extra Baggage 20kg', amount: 1200, category: 'baggage', metadata: { weightKg: 20 } },
    { code: 'SEAT_EXIT_ROW', name: 'Exit Row Seat', amount: 500, category: 'seat', metadata: { benefits: ['extra legroom'] } },
  ];

  console.log('Seeding addons...');
  for (const a of addons) {
    try {
      await Addon.findOneAndUpdate({ code: a.code }, { $set: a }, { upsert: true });
      console.log('Upserted addon', a.code);
    } catch (e) {
      console.warn('Addon upsert failed', a.code, e && e.message);
    }
  }

  // Seed coupons
  const coupons = [
    {
      code: 'NEWUSER100',
      title: 'New user ₹100 off',
      amount: 100,
      percent: 0,
      cap: 0,
      validFrom: null,
      validTo: null,
      minFare: 0,
      active: true,
      metadata: { note: 'Welcome offer' }
    },
    {
      code: 'PERCENT20',
      title: '20% off up to ₹500',
      percent: 20,
      cap: 500,
      amount: 0,
      minFare: 2000,
      active: true,
      metadata: { note: 'Seasonal percent discount' }
    },
    {
      code: 'AI10',
      title: 'Airline AI specific ₹200 off',
      amount: 200,
      percent: 0,
      cap: 0,
      allowedAirlines: ['AI'],
      active: true,
      metadata: { note: 'Air India loyalty' }
    }
  ];

  console.log('Seeding coupons...');
  for (const c of coupons) {
    try {
      await Coupon.findOneAndUpdate({ code: c.code }, { $set: c }, { upsert: true });
      console.log('Upserted coupon', c.code);
    } catch (e) {
      console.warn('Coupon upsert failed', c.code, e && e.message);
    }
  }

  console.log('Done. Closing connection.');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Seed failed', err && err.stack ? err.stack : err);
  process.exit(1);
});
