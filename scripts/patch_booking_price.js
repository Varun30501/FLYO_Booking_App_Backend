// scripts/patch_booking_price.js
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const MONGO = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB = process.env.MONGO_DBNAME || 'flight_booking_dev';

(async()=>{
  const client = new MongoClient(MONGO);
  await client.connect();
  const db = client.db(DB);
  const id = "6925ef30146daa1c755a32c7";
  const res = await db.collection('bookings').updateOne(
    { _id: ObjectId(id) },
    { $set: { "price.amount": 1000, "price.currency": "INR", updatedAt: new Date() } }
  );
  console.log('patched', res.modifiedCount);
  await client.close();
})();
