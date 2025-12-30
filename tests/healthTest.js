const request = require('supertest');
const app = require('./app');

describe('Health', () => {
  it('GET /health -> 200', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
  });
});

describe('Flights search', () => {
  it('GET /api/flights/search -> 400 without params', async () => {
    const res = await request(app).get('/api/flights/search');
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/flights/search -> 200 with params', async () => {
    const res = await request(app).get('/api/flights/search?origin=DEL&destination=BLR&date=2025-12-01');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('results');
    expect(Array.isArray(res.body.results)).toBe(true);
  });
});
