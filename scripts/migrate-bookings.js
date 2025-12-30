// scripts/migrate_bookings.js
// Usage: MONGO_URI="mongodb://..." node scripts/migrate_bookings.js

const mongoose = require('mongoose');
const crypto = require('crypto');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/flight_booking_dev';

async function main() {
  console.log('Connecting to', MONGO_URI);
  await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

  const Booking = require('../models/Booking');

  // Helper to generate short bookingRef (like MIFLOVK2-XXXXXX)
  function genRef() {
    const part = crypto.randomBytes(4).toString('hex').toUpperCase();
    const short = Date.now().toString(36).slice(-6).toUpperCase();
    return `MIF${short}-${part.slice(0,6)}`;
  }

  // Step 1: find all bookings that don't have bookingRef or have null
  const cursor = Booking.find({ $or: [ { bookingRef: { $exists: false } }, { bookingRef: null } ] }).cursor();
  let count = 0;
  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    count++;
    console.log('Migrating booking _id=', doc._id);

    // bookingRef
    if (!doc.bookingRef) doc.bookingRef = genRef();

    // price: if stored as number, convert
    if (doc.price && typeof doc.price === 'number') {
      doc.price = { amount: Number(doc.price) || 0, currency: 'INR' };
    } else if (!doc.price || typeof doc.price !== 'object') {
      doc.price = doc.price || { amount: 0, currency: 'INR' };
    } else {
      // ensure amount numeric
      doc.price.amount = Number(doc.price.amount || doc.price.amount === 0 ? doc.price.amount : 0);
      doc.price.currency = doc.price.currency || 'INR';
    }

    // ensure payment fields
    doc.paymentStatus = doc.paymentStatus || (doc.status === 'HELD' ? 'PENDING' : (doc.paymentStatus || 'PENDING'));
    doc.bookingStatus = doc.bookingStatus || (doc.status || 'PENDING');

    doc.stripeSessionId = doc.stripeSessionId || null;
    doc.paymentIntentId = doc.paymentIntentId || null;
    doc.paymentId = doc.paymentId || null;
    doc.paymentProvider = doc.paymentProvider || null;
    doc.idempotencyKey = doc.idempotencyKey || null;
    doc.reconciliationAttempts = Number(doc.reconciliationAttempts || 0);

    // Save
    try {
      await doc.save();
      console.log(' -> updated', doc._id.toString());
    } catch (err) {
      console.error(' -> failed saving', doc._id.toString(), err && err.message);
    }
  }
  console.log('Processed missing-ref bookings:', count);

  // Step 2: Ensure bookingRef uniqueness index.
  // Ensure there are no duplicates now. If duplicates found, we should resolve (rare).
  try {
    console.log('Creating unique index on bookingRef...');
    await Booking.collection.createIndex({ bookingRef: 1 }, { unique: true, background: false });
    console.log('Index created.');
  } catch (err) {
    console.error('Failed to create unique index on bookingRef:', err && err.message);
    console.error('Check duplicates: listing duplicate bookingRef values:');
    const agg = await Booking.aggregate([
      { $group: { _id: '$bookingRef', count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { _id: { $ne: null }, count: { $gt: 1 } } }
    ]);
    console.log(JSON.stringify(agg, null, 2));
  }

  console.log('Migration finished.');
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('Migration failed', err && err.stack || err);
  process.exit(1);
});
