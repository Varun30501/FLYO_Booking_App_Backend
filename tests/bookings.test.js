// src/tests/bookings.test.js
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const app = require('../app');
const Flight = require('../models/Flight');
const Booking = require('../models/Booking');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Flight.deleteMany({});
  await Booking.deleteMany({});
});

test('create booking success', async () => {
  const f = await Flight.create({
    airlineCode: 'AI',
    flightNumber: 'AI202',
    origin: 'DEL',
    destination: 'BLR',
    departureAt: new Date('2025-12-01T05:00:00Z'),
    arrivalAt: new Date('2025-12-01T07:45:00Z'),
    durationMinutes: 165,
    price: { currency: 'INR', amount: 5500 },
    fareClass: 'economy',
    seatsLeft: 12
  });

  const payload = {
    passengers: [{ firstName: 'John', lastName: 'Doe', passengerType: 'adult' }],
    itinerary: [{ flightId: f._id.toString() }],
    totalAmount: { amount: 5500, currency: 'INR' }
  };

  const res = await request(app).post('/api/bookings').send(payload);
  expect(res.statusCode).toBe(201);
  expect(res.body).toHaveProperty('bookingRef');
  expect(res.body).toHaveProperty('bookingId');

  // verify booking stored
  const booking = await Booking.findOne({ bookingRef: res.body.bookingRef });
  expect(booking).not.toBeNull();
  expect(booking.itinerary.length).toBe(1);
});
