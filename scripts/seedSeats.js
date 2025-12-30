// backend/seedSeats.js
// Usage: node backend/seedSeats.js --flightId FLIGHT123 --rows 30 --cols 6 --prefix "BOM-DEL"
// It will create a SeatMap document in MongoDB using your MONGO_URI env var.

const mongoose = require('mongoose');
require('dotenv').config();
const SeatMap = require('../models/SeatMap');

function parseArgs() {
  const argv = require('minimist')(process.argv.slice(2));
  return {
    flightId: argv.flightId || argv.flight || argv.f || 'TESTFLIGHT-001',
    rows: Math.max(1, parseInt(argv.rows || argv.r || 25, 10)),
    cols: Math.max(1, parseInt(argv.cols || argv.c || 6, 10)),
    origin: argv.origin || 'BOM',
    destination: argv.destination || 'DEL',
    airline: argv.airline || 'MockAir',
    prefix: argv.prefix || '',
  };
}

// seat letter generator for 6 columns => A..F, for >6 will continue with letters
function seatLetters(n) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (n <= letters.length) return letters.slice(0, n).split('');
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(letters[i % letters.length]);
  return arr;
}

(async function main() {
  const { flightId, rows, cols, origin, destination, airline, prefix } = parseArgs();
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/flight_booking_dev';
  try {
    console.log('Connecting to MongoDB at', MONGO_URI);
    await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected.');

    // Build seats
    const letters = seatLetters(cols);
    const seats = [];
    for (let r = 1; r <= rows; r++) {
      for (let c = 0; c < cols; c++) {
        const seatId = `${r}${letters[c]}`;
        // simple class mapping: first 2 rows -> First, next 3 -> Business, next 5 -> PremiumEconomy, rest -> Economy
        let seatClass = 'Economy';
        if (r <= 2) seatClass = 'First';
        else if (r <= 5) seatClass = 'Business';
        else if (r <= 10) seatClass = 'PremiumEconomy';

        // price modifier: higher for front section
        const baseModifier = seatClass === 'First' ? 7000 : seatClass === 'Business' ? 3500 : seatClass === 'PremiumEconomy' ? 1200 : 0;

        seats.push({
          seatId,
          row: r,
          col: c + 1,
          seatClass,
          priceModifier: baseModifier,
          status: 'free',
          heldBy: null,
          holdUntil: null,
        });
      }
    }

    // remove existing seatmap for same flightId if exists (optional)
    await SeatMap.deleteOne({ flightId });

    const map = new SeatMap({
      flightId,
      airline,
      origin,
      destination,
      departsAt: new Date(Date.now() + 1000 * 60 * 60 * 24), // tomorrow
      rows,
      cols,
      layoutMeta: { generatedAt: new Date() },
      seats,
    });

    await map.save();
    console.log(`Created SeatMap for flightId=${flightId} : rows=${rows} cols=${cols} seats=${seats.length}`);
    process.exit(0);
  } catch (err) {
    console.error('Seeder error', err);
    process.exit(1);
  }
})();
