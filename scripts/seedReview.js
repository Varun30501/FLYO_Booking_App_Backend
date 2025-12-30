// scripts/seedReviews.js
// Node script - uses mongoose to insert 60 sample reviews into `reviews` collection
const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/flight_booking_dev";

const sampleTexts = [
  "Fantastic experience — booked in minutes!",
  "Great prices and easy checkout. Highly recommend.",
  "Support was quick to respond and helped with my refund.",
  "App layout is beautiful and booking flow is smooth.",
  "Found a great deal for my family trip — impressed.",
  "UI is modern, but I had a minor issue with seats selection.",
  "Payment experience was seamless and secure.",
  "App showed better fares than competitors for same route.",
  "Loved the offers carousel. Simple and useful.",
  "Booking confirmation came instantly, great!",
  "Customer support could be improved, overall fine.",
  "App is fast and intuitive, booking took less than 5 minutes.",
  "Wish there were more payment options, otherwise good.",
  "Search results were accurate and easy to filter.",
  "Great value — saved money on my trip.",
  "Happy with the itinerary suggestions on offers.",
  "Booking flow had one small UI bug but recovered fine.",
  "Very helpful booking notifications via email.",
  "Solid app — would recommend to friends.",
  "Loved the design and the neon accents, looks premium."
];

const names = [
  "Aisha", "Rohan", "Priya", "Ananya", "Rahul", "Vikram", "Isha", "Kavya", "Siddharth", "Neha",
  "Amit", "Sunita", "Raj", "Meera", "Karan", "Divya", "Arjun", "Seema", "Arvind", "Pooja",
  "Nikhil", "Sana", "Ritesh", "Tanya", "Vikas", "Shreya", "Kabir", "Maya", "Rhea", "Sameer"
];

async function run() {
  await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log("Connected to MongoDB:", MONGO_URI);

  // define simple schema just for insertion (collection name: reviews)
  const Review = mongoose.model('Review', new mongoose.Schema({
    name: String,
    rating: Number,
    text: String,
    date: Date,
    avatarUrl: String,
    verified: Boolean
  }, { collection: 'reviews' }));

  // create 60 reviews
  const docs = [];
  for (let i=0;i<60;i++) {
    const name = names[Math.floor(Math.random()*names.length)];
    // bias to 4-5 star for a generally good rating
    const rRand = Math.random();
    const rating = rRand < 0.6 ? 5 : (rRand < 0.85 ? 4 : (rRand < 0.95 ? 3 : 2));
    const text = sampleTexts[Math.floor(Math.random()*sampleTexts.length)];
    const daysAgo = Math.floor(Math.random()*60); // up to 60 days
    const date = new Date(Date.now() - daysAgo*24*3600*1000);
    docs.push({ name, rating, text, date, avatarUrl: null, verified: Math.random() > 0.2 });
  }

  // insertMany (upsert is not needed)
  const res = await Review.insertMany(docs);
  console.log("Inserted reviews:", res.length);
  await mongoose.disconnect();
  console.log("Done.");
}

run().catch(err => {
  console.error("Seed error:", err);
  process.exit(1);
});
