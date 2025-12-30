// services/airlines/providers/mockProvider.js
const path = require('path');
const { v4: uuidv4 } = (() => {
  try { return require('uuid'); } catch (e) { return { v4: () => require('crypto').randomBytes(16).toString('hex') }; }
})();

const providerId = 'mock';

function models() {
  // __dirname is services/airlines/providers
  const base = path.join(__dirname, '..', '..', '..'); // backend root
  const Flight = require(path.join(base, 'models', 'Flight'));
  const Booking = require(path.join(base, 'models', 'Booking'));
  return { Flight, Booking };
}

async function seed(sampleFlights = []) {
  const { Flight } = models();
  const ops = sampleFlights.map(f => {
    const doc = {
      provider: providerId,
      flightNumber: f.flightNumber,
      airline: f.airline,
      origin: (f.origin || '').toUpperCase(),
      destination: (f.destination || '').toUpperCase(),
      departureAt: f.departureAt ? new Date(f.departureAt) : undefined,
      arrivalAt: f.arrivalAt ? new Date(f.arrivalAt) : undefined,
      price: f.price || { amount: 0, currency: 'INR' },
      seatsAvailable: typeof f.seatsAvailable === 'number' ? f.seatsAvailable : 150,
      status: f.status || { code: 'scheduled', text: 'On time' },
      meta: f.meta || {},
      raw: f.raw || {}
    };
    Object.keys(doc).forEach(k => doc[k] === undefined && delete doc[k]);
    return {
      updateOne: {
        filter: { provider: providerId, flightNumber: doc.flightNumber, departureAt: doc.departureAt },
        update: { $set: doc },
        upsert: true
      }
    };
  });

  if (ops.length) await Flight.bulkWrite(ops);
  return await Flight.find({ provider: providerId }).sort({ departureAt: 1 }).limit(200).lean();
}

async function search({ origin, destination, date, limit = 20 } = {}) {
  const { Flight } = models();
  if (!origin || !destination) return [];

  const start = date ? new Date(date) : new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const q = {
    provider: providerId,
    origin: origin.toUpperCase(),
    destination: destination.toUpperCase(),
    departureAt: { $gte: start, $lt: end }
  };

  const rows = await Flight.find(q).sort({ price: 1, departureAt: 1 }).limit(limit).lean();
  return rows;
}

async function getFlight(id) {
  const { Flight } = models();
  if (!id) return null;
  try {
    const f = await Flight.findById(id).lean();
    if (f) return f;
  } catch (e) {
    // ignore
  }
  const maybe = await Flight.findOne({ $or: [{ _id: id }, { id: id }, { 'raw.id': id }, { 'meta.offerId': id }] }).lean();
  return maybe || null;
}

async function book(bookingPayload = {}) {
  const { Flight } = models();
  const flightId = bookingPayload.flightId;
  const flight = await Flight.findById(flightId);
  if (!flight) throw new Error('flight not found');
  if (flight.seatsAvailable <= 0) return { success: false, error: 'No seats' };

  const decrement = Math.max(1, (bookingPayload.passengers?.length || 1));
  flight.seatsAvailable = Math.max(0, (flight.seatsAvailable || 0) - decrement);
  await flight.save();

  const providerBookingId = `MOCKPNR-${(Math.random() * 1e8 | 0).toString(16).toUpperCase()}`;

  return {
    success: true,
    providerBookingId,
    pnr: providerBookingId,
    ticketStatus: 'HELD',
    raw: {
      provider: providerId,
      seatsLeft: flight.seatsAvailable,
      createdAt: new Date().toISOString()
    }
  };
}

async function getStatus(idOrBookingId, type = 'flight') {
  try {
    const { Flight, Booking } = models();

    if (type === 'flight') {
      const f = await Flight.findById(idOrBookingId).lean();
      if (!f) return null;
      return {
        code: (f.status && f.status.code) || 'scheduled',
        text: (f.status && f.status.text) || 'On time',
        departureAt: f.departureAt ? f.departureAt.toISOString() : undefined,
        arrivalAt: f.arrivalAt ? f.arrivalAt.toISOString() : undefined,
        seatsAvailable: f.seatsAvailable
      };
    }

    if (type === 'booking') {
      const b = await Booking.findById(idOrBookingId).lean();
      if (!b) return null;
      return {
        code: (b.status || 'HELD').toLowerCase(),
        text: b.status || 'HELD',
        providerBookingId: b.providerBookingId || null
      };
    }

    return null;
  } catch (err) {
    console.error('[mockProvider.getStatus] error', err && (err.message || err));
    return null;
  }
}

async function refresh() { return { ok: true }; }

module.exports = { providerId, seed, search, getFlight, book, getStatus, refresh };
