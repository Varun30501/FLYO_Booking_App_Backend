// scripts/patchFlightsToMockSchema.js
require('dotenv').config();
const mongoose = require('mongoose');
const Flight = require('../models/Flight');

async function patch(ids = []) {
  const MONGO = process.env.MONGO_URI || 'mongodb://localhost:27017/flight_booking_dev';
  console.log('Connecting to', MONGO);
  await mongoose.connect(MONGO, {});

  try {
    for (const id of ids) {
      console.log('---');
      console.log('Processing id:', id);

      const before = await Flight.findById(id).lean();
      console.log('Before:', before ? {
        _id: before._id,
        provider: before.provider,
        status: before.status,
        seatsAvailable: before.seatsAvailable,
        seatsTotal: before.seatsTotal,
        price: before.price
      } : null);

      if (!before) {
        console.warn(`Flight ${id} not found — skipping`);
        continue;
      }

      // Build safe defaults only for missing fields
      const update = {};
      if (!('provider' in before) || !before.provider) update.provider = 'mock';
      if (!('status' in before) || !before.status) update.status = { code: 'scheduled', text: 'On time' };
      if (!('seatsAvailable' in before) || typeof before.seatsAvailable !== 'number') update.seatsAvailable = 150;
      if (!('seatsTotal' in before) || typeof before.seatsTotal !== 'number') update.seatsTotal = 150;
      if (!('price' in before) || !before.price || typeof before.price.amount !== 'number') update.price = { amount: before.price && before.price.amount ? before.price.amount : 0, currency: (before.price && before.price.currency) || 'INR' };

      if (Object.keys(update).length === 0) {
        console.log('No updates required for', id);
        continue;
      }

      const updated = await Flight.findByIdAndUpdate(id, { $set: update }, { new: true }).lean();
      console.log('After:', {
        _id: updated._id,
        provider: updated.provider,
        status: updated.status,
        seatsAvailable: updated.seatsAvailable,
        seatsTotal: updated.seatsTotal,
        price: updated.price
      });
    }
  } catch (err) {
    console.error('Error during patch:', err && (err.stack || err.message || err));
  } finally {
    await mongoose.disconnect();
    console.log('Done.');
  }
}

// Read IDs from command line args or a hard-coded list below
const provided = process.argv.slice(2);
const ids = provided.length ? provided : [
  // Put the IDs you want to patch here as a fallback if you run `node scripts/patchFlightsToMockSchema.js` without args
  // Example:
  // '691a175fd62e23f0702007fc', '691a175fd62e23f0702007fd', '691a175fd62e23f0702007fe'
];

if (!ids.length) {
  console.error('No flight ids provided. Usage: node scripts/patchFlightsToMockSchema.js <id1> <id2> ...');
  process.exit(1);
}

patch(ids);
