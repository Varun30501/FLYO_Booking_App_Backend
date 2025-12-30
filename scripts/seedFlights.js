// scripts/seedFlights.js
require('dotenv').config();
const mongoose = require('mongoose');
const adapter = require('../services/airlines/adapter');
const Flight = require('../models/Flight');

const MONGO = process.env.MONGO_URI || 'mongodb://localhost:27017/flight_booking_dev';

async function main() {
    await mongoose.connect(MONGO, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to mongo');

    // Generate sample flights: 5 flights for today from BOM->DEL and 5 for DEL->BOM on given dates
    const today = new Date();
    const dateISO = (d) => {
        d.setMinutes(0, 0, 0);
        return d.toISOString();
    };

    const samples = [];
    for (let i = 0; i < 10; i++) {
        const dep = new Date(today);
        dep.setHours(8 + i * 2); // 8:00, 10:00, 12:00...
        const arr = new Date(dep);
        arr.setHours(arr.getHours() + 2); // 2 hour flight
        samples.push({
            flightNumber: `MK${300 + i}`,
            airline: 'MockAir',
            origin: 'BOM',
            destination: 'DEL',
            departureAt: dep.toISOString(),
            arrivalAt: arr.toISOString(),
            durationMinutes: 120,
            price: { amount: 4500 + i * 500, currency: 'INR' },
            seatsAvailable: 6 + i,
            cabin: 'economy'
        });
    }

    // reverse route
    for (let i = 0; i < 5; i++) {
        const dep = new Date(today);
        dep.setHours(9 + i * 2);
        const arr = new Date(dep);
        arr.setHours(arr.getHours() + 2);
        samples.push({
            flightNumber: `MK${400 + i}`,
            airline: 'MockAir',
            origin: 'DEL',
            destination: 'BOM',
            departureAt: dep.toISOString(),
            arrivalAt: arr.toISOString(),
            durationMinutes: 120,
            price: { amount: 4700 + i * 400, currency: 'INR' },
            seatsAvailable: 5 + i,
            cabin: 'economy'
        });
    }

    const seeded = await adapter.seedProvider('mock', samples);
    console.log('Seeded flights count:', seeded.length);

    await mongoose.disconnect();
    console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
