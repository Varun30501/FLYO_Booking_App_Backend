// services/airlines/providers/duffelProvider.js
// Duffel API — real GDS inventory including Indian domestic routes
// Docs: https://duffel.com/docs/api
// Free sandbox: sign up at https://app.duffel.com → get test API key instantly
// Test key format: duffel_test_xxxxxxxxxxxx
// Production key: duffel_live_xxxxxxxxxxxx
'use strict';

const axios = require('axios');

const DUFFEL_KEY  = process.env.DUFFEL_API_KEY;
const DUFFEL_BASE = process.env.DUFFEL_BASE_URL || 'https://api.duffel.com';
const DUFFEL_VER  = 'v2';

const providerId = 'duffel';

// ── helpers ──────────────────────────────────────────────────────────────────

function toINR(amount, currency) {
  const n = Number(amount) || 0;
  if (currency === 'INR') return Math.round(n);
  const rates = { USD:84, EUR:91, GBP:107, AED:23, SGD:62, GBP:107 };
  return Math.round(n * (rates[currency] || 84));
}

function duffelClient() {
  if (!DUFFEL_KEY) return null;
  return axios.create({
    baseURL: `${DUFFEL_BASE}/air`,
    timeout: 20000,
    headers: {
      Authorization: `Bearer ${DUFFEL_KEY}`,
      'Duffel-Version': DUFFEL_VER,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });
}

// ── normalise one Duffel offer ─────────────────────────────────────────────

function mapOffer(offer, origin, destination) {
  try {
    const slices = offer.slices || [];
    const slice0 = slices[0];
    if (!slice0) return null;

    const segs  = slice0.segments || [];
    const first = segs[0];
    const last  = segs[segs.length - 1];
    if (!first) return null;

    const rawAmount   = Number(offer.total_amount || offer.base_amount || 0);
    const rawCurrency = (offer.total_currency || offer.base_currency || 'INR').toUpperCase();

    const airline = (first.marketing_carrier?.iata_code || first.operating_carrier?.iata_code || '').toUpperCase();
    const flightNum = first.marketing_carrier_flight_number || first.operating_carrier_flight_number || '';

    // Build a raw shape compatible with what FlightCard/SearchPage expects
    const rawCompat = {
      id: offer.id,
      itineraries: [{
        duration: slice0.duration,
        segments: segs.map(s => ({
          carrierCode:   (s.marketing_carrier?.iata_code || s.operating_carrier?.iata_code || '').toUpperCase(),
          number:        s.marketing_carrier_flight_number || '',
          duration:      s.duration,
          durationMinutes: s.duration ? parseDuration(s.duration) : null,
          departure: {
            iataCode: s.origin?.iata_code || '',
            at:       s.departing_at || '',
            terminal: s.origin_terminal,
          },
          arrival: {
            iataCode: s.destination?.iata_code || '',
            at:       s.arriving_at || '',
            terminal: s.destination_terminal,
          },
          cabin: s.passengers?.[0]?.cabin_class || '',
        })),
      }],
      price: { total: String(rawAmount), currency: rawCurrency },
      numberOfBookableSeats: offer.available_services?.length ?? null,
      travelerPricings: [{
        fareDetailsBySegment: segs.map(s => ({
          cabin: s.passengers?.[0]?.cabin_class_marketing_name || s.passengers?.[0]?.cabin_class || '',
          includedCheckedBags: { weight: s.passengers?.[0]?.baggages?.find(b => b.type === 'checked')?.quantity ? 23 : 0 },
        })),
      }],
      validatingAirlineCodes: [airline],
    };

    return {
      id:             offer.id,
      _id:            offer.id,
      provider:       providerId,
      airline,
      flightNumber:   flightNum,
      origin:         origin.toUpperCase(),
      destination:    destination.toUpperCase(),
      departureAt:    first.departing_at || '',
      arrivalAt:      last?.arriving_at  || '',
      seatsAvailable: null,
      price: { amount: toINR(rawAmount, rawCurrency), currency: 'INR' },
      raw:   rawCompat,
    };
  } catch (e) {
    return null;
  }
}

function parseDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  return m ? Number(m[1]||0)*60 + Number(m[2]||0) : 0;
}

// ── search ────────────────────────────────────────────────────────────────────

async function search({ origin, destination, date, adults = 1, limit = 20 } = {}) {
  if (!origin || !destination || !date) {
    return { ok:false, flights:[], diagnostic:{ message:'missing params' } };
  }
  if (!DUFFEL_KEY) {
    return { ok:false, flights:[], diagnostic:{ message:'DUFFEL_API_KEY not set' } };
  }

  const client = duffelClient();
  const ts = Date.now();

  try {
    // Step 1: Create an offer request
    const reqBody = {
      data: {
        slices: [{
          origin:      origin.toUpperCase(),
          destination: destination.toUpperCase(),
          departure_date: date,
        }],
        passengers:     Array(Math.max(1, Number(adults))).fill({ type:'adult' }),
        cabin_class:    'economy',
        return_offers:  false,
      },
    };

    console.log(`[duffel] creating offer request: ${origin}→${destination} on ${date}`);
    const offerReqRes = await client.post('/offer_requests?return_offers=true', reqBody);
    const offerData   = offerReqRes.data?.data;

    if (!offerData) {
      return { ok:false, flights:[], diagnostic:{ message:'empty offer_requests response', durationMs: Date.now()-ts } };
    }

    // Duffel can return offers inline (return_offers=true)
    let offers = offerData.offers || [];

    // If not inline, poll the offer_request
    if (!offers.length && offerData.id) {
      console.log(`[duffel] polling offers for request ${offerData.id}`);
      const pollRes = await client.get(`/offers?offer_request_id=${offerData.id}&limit=${Math.min(limit, 50)}&sort=total_amount`);
      offers = pollRes.data?.data || [];
    }

    const flights = offers
      .slice(0, limit)
      .map(o => mapOffer(o, origin, destination))
      .filter(Boolean);

    console.log(`[duffel] ✅ ${flights.length} flights (${origin}→${destination})`);
    return {
      ok: flights.length > 0,
      flights,
      diagnostic: { provider: providerId, durationMs: Date.now()-ts, count: flights.length },
    };

  } catch (err) {
    const status  = err?.response?.status;
    const errData = err?.response?.data;
    console.error(`[duffel] search error ${status}:`, errData || err.message);
    return {
      ok:false, flights:[],
      diagnostic: {
        provider: providerId,
        durationMs: Date.now()-ts,
        status,
        errorMessage: errData?.errors?.[0]?.message || err.message,
        errorCode: errData?.errors?.[0]?.code,
      },
    };
  }
}

async function revalidate({ offer } = {}) {
  if (!offer?.id || !DUFFEL_KEY) return { ok:false, reason:'provider_unavailable' };
  try {
    const client = duffelClient();
    const res = await client.get(`/offers/${offer.id}`);
    const fresh = res.data?.data;
    if (!fresh) return { ok:false, reason:'not_found' };
    const mapped = mapOffer(fresh, offer.origin||'', offer.destination||'');
    return { ok: !!mapped, offer: mapped };
  } catch (err) {
    return { ok:false, reason: err.message };
  }
}

async function issueTicket({ booking } = {}) {
  // Duffel ticketing requires an order — this needs a full booking flow integration
  // For now signal not supported so adapter falls back gracefully
  return { ok:false, reason:'duffel_ticketing_requires_order_flow' };
}

module.exports = { providerId, search, revalidate, issueTicket };
