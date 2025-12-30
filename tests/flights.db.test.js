// src/tests/flights.db.test.js
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const app = require('../app');
const Flight = require('../models/flight.model');

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
});

test('search endpoint returns DB results when flights exist', async () => {
  // insert sample flight
  await Flight.create({
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

  const res = await request(app)
    .get('/api/flights/search')
    .query({ origin: 'DEL', destination: 'BLR', date: '2025-12-01' });

  expect(res.statusCode).toBe(200);
  expect(res.body).toHaveProperty('results');
  expect(res.body.meta.source).toBe('db');
  expect(Array.isArray(res.body.results)).toBe(true);
  expect(res.body.results.length).toBe(1);
});

test('search endpoint returns fallback when DB is empty', async () => {
  const res = await request(app)
    .get('/api/flights/search')
    .query({ origin: 'DEL', destination: 'BLR', date: '2025-12-01' });

  expect(res.statusCode).toBe(200);
  expect(res.body.meta.source).toBe('fallback');
  expect(Array.isArray(res.body.results)).toBe(true);
});
