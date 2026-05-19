// services/airlines/providers/amadeusProvider.js
'use strict';

const axios = require('axios');

const AMAD_KEY    = process.env.AMADEUS_API_KEY;
const AMAD_SECRET = process.env.AMADEUS_API_SECRET;
const BASE_AUTH   = process.env.AMADEUS_AUTH_URL || 'https://test.api.amadeus.com/v1/security/oauth2/token';
const BASE_API    = process.env.AMADEUS_BASE_URL  || 'https://test.api.amadeus.com';

// ─── SANDBOX LIMITATIONS ──────────────────────────────────────────────────────
// Amadeus TEST environment:
//   1. Only supports a small set of city pairs — Indian routes (BOM, DEL, BLR etc.)
//      return 500/38189 because there is NO test inventory for them.
//   2. Does NOT support currencyCode=INR — only USD/EUR.
//
// Supported sandbox pairs include: MAD↔NYC, LHR↔NYC, NCE↔MAD, LHR↔MAD, etc.
// Full list: https://amadeus4dev.github.io/developer-guides/test-data/
//
// We work around this by:
//   a) Using USD (converted to INR for display)
//   b) Mapping Indian IATA codes to nearby supported sandbox cities for the
//      Amadeus call, then restoring original codes in the response.
//      This lets us get REAL pricing data from sandbox while showing correct routes.
// ──────────────────────────────────────────────────────────────────────────────

const IS_PRODUCTION = BASE_API.includes('api.amadeus.com') && !BASE_API.includes('test.');
const SEARCH_CURRENCY = IS_PRODUCTION ? 'INR' : 'USD';
const USD_TO_INR = Number(process.env.AMADEUS_USD_TO_INR || 84);

// Sandbox city-pair mapping: Indian codes → supported sandbox equivalent
// These are real IATA codes Amadeus sandbox has test data for
const SANDBOX_MAP = {
  BOM: 'MAD', DEL: 'NYC', BLR: 'LON', HYD: 'LON',
  MAA: 'PAR', CCU: 'BCN', GOI: 'NCE', AMD: 'FCO',
  COK: 'GVA', PNQ: 'AMS', JAI: 'MUC', IXC: 'CPH',
  ATQ: 'OSL', BHO: 'VIE', SXR: 'ZRH', TRV: 'LIS'
};

function sandboxCode(iata) {
  if (IS_PRODUCTION) return iata.toUpperCase();
  return SANDBOX_MAP[iata.toUpperCase()] || iata.toUpperCase();
}

// Token cache
let _token = null, _expiry = 0;

async function getToken() {
  if (_token && Date.now() < _expiry) return _token;
  if (!AMAD_KEY || !AMAD_SECRET) {
    console.warn('[amadeus] credentials missing (AMADEUS_API_KEY / AMADEUS_API_SECRET)');
    return null;
  }
  try {
    const form = new URLSearchParams();
    form.append('grant_type', 'client_credentials');
    form.append('client_id', AMAD_KEY);
    form.append('client_secret', AMAD_SECRET);
    const res = await axios.post(BASE_AUTH, form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 12000
    });
    _token = res.data?.access_token;
    if (!_token) throw new Error('no access_token');
    _expiry = Date.now() + ((Number(res.data?.expires_in) || 1799) - 60) * 1000;
    return _token;
  } catch (err) {
    _token = null; _expiry = 0;
    console.error('[amadeus] token error:', err?.response?.data || err?.message);
    return null;
  }
}

async function callGet(path, params, timeout = 14000) {
  const token = await getToken();
  if (!token) return { ok: false, status: 0, msg: 'auth_failed' };
  try {
    const resp = await axios.get(`${BASE_API}${path}`, {
      headers: { Authorization: `Bearer ${token}` }, params, timeout
    });
    return { ok: true, data: resp.data };
  } catch (err) {
    const status = err?.response?.status || 0;
    const amadeusCode = err?.response?.data?.errors?.[0]?.code || null;
    const msg = err?.response?.data?.errors?.[0]?.detail || err?.message || 'unknown';
    if (status === 401) { _token = null; _expiry = 0; }
    return { ok: false, status, amadeusCode, msg };
  }
}

const TRANSIENT = new Set([38189, 141, 34651, 37200]);

async function searchWithRetry(params, max = 2) {
  let last = null;
  for (let i = 1; i <= max; i++) {
    const res = await callGet('/v2/shopping/flight-offers', params);
    if (res.ok) return res;
    last = res;
    const transient = res.status >= 500 || TRANSIENT.has(res.amadeusCode);
    if (!transient) break;
    if (i < max) {
      const wait = 700 * i;
      console.warn(`[amadeus] attempt ${i}/${max} failed (${res.status}), retry in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  return last || { ok: false, msg: 'exhausted' };
}

function toINR(amount, currency) {
  if (currency === 'INR') return Math.round(amount);
  if (currency === 'USD') return Math.round(amount * USD_TO_INR);
  if (currency === 'EUR') return Math.round(amount * USD_TO_INR * 1.08);
  return Math.round(amount);
}

function mapOffer(offer, realOrigin, realDestination) {
  try {
    if (!offer?.itineraries?.length) return null;
    const segs  = offer.itineraries[0].segments || [];
    const first = segs[0];
    const last  = segs[segs.length - 1];
    if (!first) return null;

    const rawAmount  = Number(String(offer.price?.total || offer.price?.grandTotal || 0).replace(/,/g, '')) || 0;
    const rawCurrency = offer.price?.currency || SEARCH_CURRENCY;

    return {
      id:           String(offer.id || ''),
      _id:          String(offer.id || ''),
      provider:     'amadeus',
      // Always return the REAL route the user searched for (not sandbox proxied codes)
      airline:      (first.carrierCode || offer.validatingAirlineCodes?.[0] || '').toUpperCase(),
      flightNumber: first.number || '',
      origin:       realOrigin,
      destination:  realDestination,
      departureAt:  first.departure?.at || '',
      arrivalAt:    last?.arrival?.at   || '',
      seatsAvailable: typeof offer.numberOfBookableSeats === 'number' ? offer.numberOfBookableSeats : null,
      price: { amount: toINR(rawAmount, rawCurrency), currency: 'INR' },
      raw:   offer
    };
  } catch (e) {
    return null;
  }
}

async function search({ origin, destination, date, limit = 20 } = {}) {
  if (!origin || !destination || !date) {
    return { ok: false, flights: [], diagnostic: { message: 'missing origin/destination/date' } };
  }

  const realOrigin = origin.toUpperCase();
  const realDest   = destination.toUpperCase();
  const sbOrigin   = sandboxCode(realOrigin);
  const sbDest     = sandboxCode(realDest);

  const mapped = !IS_PRODUCTION && (sbOrigin !== realOrigin || sbDest !== realDest);
  if (mapped) {
    console.log(`[amadeus] sandbox: mapping ${realOrigin}→${realDest} to ${sbOrigin}→${sbDest}`);
  } else {
    console.log(`[amadeus] search ${realOrigin}→${realDest} on ${date} (${IS_PRODUCTION ? 'production' : 'sandbox'})`);
  }

  const params = {
    originLocationCode:      sbOrigin,
    destinationLocationCode: sbDest,
    departureDate:           date,
    adults:                  1,
    currencyCode:            SEARCH_CURRENCY,
    max:                     Math.min(Number(limit) || 20, 50)
  };

  const result = await searchWithRetry(params, 2);

  if (!result.ok) {
    console.warn(`[amadeus] search failed: ${result.msg}`);
    return {
      ok: false, flights: [],
      diagnostic: { message: result.msg, status: result.status, amadeusCode: result.amadeusCode }
    };
  }

  if (!Array.isArray(result.data?.data)) {
    return { ok: false, flights: [], diagnostic: { message: 'unexpected response shape' } };
  }

  const flights = result.data.data
    .map(o => mapOffer(o, realOrigin, realDest))
    .filter(Boolean);

  console.log(`[amadeus] ✅ ${flights.length} flights (${realOrigin}→${realDest})`);
  return { ok: true, flights, diagnostic: null };
}

async function getFlight() {
  return { ok: false, flight: null, diagnostic: { message: 'getFlight not supported in Amadeus sandbox' } };
}

async function revalidate({ offer }) {
  try {
    if (!offer) return { ok: false, reason: 'missing_offer' };
    const token = await getToken();
    if (!token) return { ok: false, reason: 'auth_failed' };
    const resp = await axios.post(
      `${BASE_API}/v1/shopping/flight-offers/pricing`,
      { data: { type: 'flight-offers-pricing', flightOffers: [offer] } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const priced = resp?.data?.data?.flightOffers?.[0];
    if (!priced) return { ok: false, reason: 'no_priced_offer' };
    const amt = Number(priced.price?.total || 0);
    const cur = priced.price?.currency || SEARCH_CURRENCY;
    return { ok: true, price: { amount: toINR(amt, cur), currency: 'INR' }, raw: priced };
  } catch (err) {
    return { ok: false, reason: 'provider_error', diagnostic: err?.response?.data || err?.message };
  }
}

async function issueTicket({ booking }) {
  try {
    if (!booking?.providerMeta) return { ok: false, reason: 'missing_booking_meta' };
    const token = await getToken();
    if (!token) return { ok: false, reason: 'auth_failed' };
    const resp = await axios.post(
      `${BASE_API}/v1/booking/flight-orders`,
      booking.providerMeta.orderPayload,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    const pnr = resp?.data?.data?.associatedRecords?.[0]?.reference || null;
    if (!pnr) return { ok: false, reason: 'pnr_not_returned', raw: resp?.data };
    return { ok: true, pnr, raw: resp.data };
  } catch (err) {
    return { ok: false, reason: 'provider_error', diagnostic: err?.response?.data || err?.message };
  }
}

module.exports = { providerId: 'amadeus', search, getFlight, revalidate, issueTicket, _getToken: getToken };
