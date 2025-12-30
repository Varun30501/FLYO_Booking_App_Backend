// /backend/tools/migrateBookingsAddFields.js
const mongoose = require('mongoose');
const Booking = require('../models/Booking.js');

const MONGO = process.env.MONGO_URI || process.env.MONGO || 'mongodb://localhost:27017/your_db_name';

async function run() {
  await mongoose.connect(MONGO, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log("Connected to Mongo");

  // Find bookings that have some payment id but no paymentStatus field (null/undefined)
  const query = {
    $or: [
      { paymentIntentId: { $exists: true, $ne: null } },
      { stripeSessionId: { $exists: true, $ne: null } },
      { paymentId: { $exists: true, $ne: null } }
    ],
    $or: [
      { paymentStatus: { $exists: false } },
      { paymentStatus: null }
    ]
  };

  const cursor = Booking.find(query).cursor();
  let count = 0;
  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    count++;
    await Booking.updateOne({ _id: doc._id }, {
      $set: { paymentStatus: "PENDING", bookingStatus: "PENDING", reconciliationAttempts: 0 }
    });
    console.log("Updated booking:", doc._id.toString());
  }

  console.log(`Migration complete. Updated ${count} bookings.`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
