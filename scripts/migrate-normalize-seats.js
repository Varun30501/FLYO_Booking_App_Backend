// scripts/migrate-normalize-seats.js
// Usage: NODE_ENV=development node scripts/migrate-normalize-seats.js
const mongoose = require('mongoose');
const Booking = require('../models/Booking');
require('dotenv').config();

const MONGO = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/yourdb';

async function normalizeSeatsField(seats) {
  if (!seats) return { seats: [], seatsMeta: [] };
  if (Array.isArray(seats)) {
    // convert items to plain labels and meta
    const labels = [];
    const meta = [];
    for (const s of seats) {
      if (s === null || s === undefined) continue;
      if (typeof s === 'string' || typeof s === 'number') {
        labels.push(String(s));
        meta.push({ seatId: String(s) });
      } else if (typeof s === 'object') {
        const seatId = s.seatId || s.label || s.seat || s.name || s.id || null;
        if (seatId) labels.push(String(seatId));
        meta.push(s);
      } else {
        labels.push(String(s));
        meta.push({ seatId: String(s) });
      }
    }
    return { seats: labels, seatsMeta: meta };
  }
  // if seats is an object, try to extract meaningful values
  if (typeof seats === 'object') {
    const seatId = seats.seatId || seats.label || seats.seat || seats.name || seats.id || null;
    if (seatId) return { seats: [String(seatId)], seatsMeta: [seats] };
  }
  // number or strange: return empty
  return { seats: [], seatsMeta: [] };
}

async function run() {
  await mongoose.connect(MONGO, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log('Connected to Mongo');

  const cursor = Booking.find().cursor();
  let updated = 0;
  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    try {
      const current = doc.seats;
      // heuristic: if seats is 0, null, or non-array, normalize
      if (!current || (Array.isArray(current) && current.length === 0) || (typeof current === 'number')) {
        // skip if seatsMeta already present
        continue;
      }
      const { seats, seatsMeta } = await normalizeSeatsField(current);
      // only update if transformation results in useful labels or meta
      if ((Array.isArray(seats) && seats.length > 0) || (Array.isArray(seatsMeta) && seatsMeta.length>0)) {
        doc.seats = seats;
        doc.seatsMeta = seatsMeta;
        await doc.save();
        updated++;
        console.log(`Updated booking ${doc._id} -> seats: ${JSON.stringify(seats)}`);
      }
    } catch (e) {
      console.error('error processing doc', doc._id, e.message || e);
    }
  }

  console.log('Done. updated:', updated);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
