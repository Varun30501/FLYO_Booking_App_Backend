// backend/services/flightData/mockAdapter.js
const crypto = require('crypto');

/**
 * Produce a deterministic **24-hex** id suitable for Mongo ObjectId casting.
 * We take an md5 hash and repeat/trim to 24 hex characters.
 */
function mkId(seed) {
    const h = crypto.createHash('md5').update(seed).digest('hex'); // 32 hex chars
    // take first 24 chars (valid 24-hex string)
    return h.slice(0, 24);
}

// helper to create ISO datetime for date + hour offset
function at(dateStr, hourOffset) {
    const d = new Date(dateStr + 'T00:00:00.000Z');
    d.setUTCHours(hourOffset);
    return d.toISOString();
}

/**
 * build 5 deterministic flights for given origin/destination/date
 * opts: { origin, destination, date, limit }
 */
async function search({ origin = 'BOM', destination = 'DEL', date, limit = 5 } = {}) {
    const d = date || new Date().toISOString().slice(0, 10);
    const airlines = ['IndiGo', 'Air India', 'SpiceJet', 'Vistara', 'GoAir'];

    const flights = [];
    for (let i = 0; i < limit; i++) {
        const airline = airlines[i % airlines.length];
        const flightNumber = `${airline.substring(0, 2).toUpperCase()}${400 + i}`;
        const seed = `${origin}-${destination}-${d}-${flightNumber}`;
        const id = mkId(seed);

        const departHour = 6 + i * 2;
        const departureAt = at(d, departHour);
        const arrivalAt = at(d, departHour + 2);

        flights.push({
            _id: id,
            id,
            airline,
            flightNumber,
            origin,
            destination,
            departureAt,
            arrivalAt,
            seatsAvailable: 10 + i,
            price: { amount: 3000 + i * 500, currency: 'INR' },
            status: { code: 'scheduled', text: 'On time' },
            meta: { generatedBy: 'mockAdapter' }
        });
    }

    return flights;
}

async function getFlight(id) {
    if (!id) return null;
    return {
        _id: id.length === 24 ? id : mkId(String(id || 'flight')),
        id: id,
        airline: 'IndiGo',
        flightNumber: `IG${(String(id).slice(0, 4).toUpperCase())}`,
        origin: 'BOM',
        destination: 'DEL',
        departureAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
        arrivalAt: new Date(Date.now() + 1000 * 60 * 60 * 26).toISOString(),
        seatsAvailable: 5,
        price: { amount: 3500, currency: 'INR' },
        status: { code: 'scheduled', text: 'On time' },
        meta: { generatedBy: 'mockAdapter-getFlight' }
    };
}

async function getStatus(id) {
    if (!id) return { code: 'unknown', text: 'Unknown' };
    return {
        code: 'scheduled',
        text: 'On time',
        departureAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
        arrivalAt: new Date(Date.now() + 1000 * 60 * 60 * 26).toISOString(),
        delayMinutes: 0
    };
}

async function refresh() {
    return { ok: true, message: 'mock refresh no-op' };
}

module.exports = { search, getFlight, getStatus, refresh };
