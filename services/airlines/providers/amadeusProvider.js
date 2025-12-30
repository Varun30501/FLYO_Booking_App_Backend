// services/airlines/providers/amadeusProvider.js
'use strict';

const axios = require('axios');

const AMAD_KEY = process.env.AMADEUS_API_KEY;
const AMAD_SECRET = process.env.AMADEUS_API_SECRET;
const AMAD_ENV = process.env.AMADEUS_ENVIRONMENT || 'test';

// endpoints (sandbox/test by default)
const BASE_AUTH = process.env.AMADEUS_AUTH_URL || "https://test.api.amadeus.com/v1/security/oauth2/token";
const BASE_API = process.env.AMADEUS_BASE_URL || "https://test.api.amadeus.com";

let cachedToken = null;
let cachedExpiry = null;

/** Get OAuth token (cached). Returns token string or null */
async function getToken() {
  try {
    if (cachedToken && cachedExpiry && Date.now() < cachedExpiry) {
      return cachedToken;
    }
    if (!AMAD_KEY || !AMAD_SECRET) {
      console.error('[amadeus] missing API credentials');
      return null;
    }
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', AMAD_KEY);
    params.append('client_secret', AMAD_SECRET);

    const res = await axios.post(BASE_AUTH, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    });

    const data = res.data;
    if (!data || !data.access_token) {
      console.error('[amadeus] token response missing access_token', data);
      return null;
    }

    cachedToken = data.access_token;
    cachedExpiry = Date.now() + ((Number(data.expires_in) || 3600) - 200) * 1000;
    // console.log('[amadeus] fetched token (len=' + (cachedToken ? cachedToken.length : 0) + ') expires_in=' + (data.expires_in || 0));
    return cachedToken;
  } catch (err) {
    console.error('[amadeus] token fetch error:', err && (err.response ? err.response.data || err.response.status : err.message));
    return null;
  }
}

/** Internal helper that calls the Amadeus endpoint with retries and returns a diagnostic object on failure */
async function callAmadeusWithRetries(path, opts = {}) {
  const maxAttempts = Number(opts.attempts || 4);
  let attempt = 0;
  let lastErr = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const token = await getToken();
      if (!token) {
        lastErr = { message: 'no_token' };
        break;
      }

      const url = `${BASE_API}${path}`;
      const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        params: opts.params || {},
        timeout: opts.timeout || 15000
      });

      // success path: return resp.data
      return { ok: true, data: resp.data, headers: resp.headers, attempt };

    } catch (err) {
      lastErr = err;
      // diagnostics to log
      const diag = { attempt, message: err?.message || String(err) };

      if (err?.response) {
        diag.status = err.response.status;
        diag.data = err.response.data;
        diag.headers = err.response.headers;
        // Log both status and any Amadeus-provided errors array if present
        try {
          const errors = err.response.data && err.response.data.errors ? err.response.data.errors : null;
          if (errors) diag.amadeusErrors = errors;
        } catch (ee) { /* ignore */ }
      } else if (err?.request) {
        diag.request = 'no-response';
      }

      console.warn('[amadeus] CALL ERROR DIAGNOSTIC', diag);

      // If error looks like a system upstream error (500 / code 141) we may retry with backoff
      // For 4xx non-retryable errors, break early.
      const status = err?.response?.status || null;
      // treat 400 with amadeus 500-code as provider internal system error: we will retry a few times
      const amadeusCode = err?.response?.data && Array.isArray(err.response.data.errors) && err.response.data.errors[0] && err.response.data.errors[0].code ? err.response.data.errors[0].code : null;
      const isProviderSystemError = (amadeusCode === 141) || (status >= 500 && status < 600);

      // Non-retryable: 401/403/422 etc (explicit client error), break
      if (!isProviderSystemError && status && status >= 400 && status < 500) {
        return {
          ok: false,
          diagnostic: {
            message: 'provider returned client error',
            status,
            data: err.response && err.response.data ? err.response.data : null,
            attempt
          }
        };
      }

      // if we've reached max attempts break and return diagnostic
      if (attempt >= maxAttempts) break;

      // exponential backoff
      const backoff = 300 * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, backoff));
    }
  }

  // final diagnostic on failure
  const fallbackDiag = {
    message: 'call failed',
    errorMessage: lastErr?.message || String(lastErr),
  };
  if (lastErr?.response) {
    fallbackDiag.status = lastErr.response.status;
    fallbackDiag.data = lastErr.response.data;
    fallbackDiag.headers = lastErr.response.headers;
  }
  return { ok: false, diagnostic: fallbackDiag };
}

/** Convert one Amadeus flight offer into app-friendly format */
/** Convert one Amadeus flight offer into app-friendly format */
function mapAmadeusOffer(offer) {
  try {
    if (!offer || !offer.itineraries || !Array.isArray(offer.itineraries) || offer.itineraries.length === 0) return null;
    const itinerary = offer.itineraries[0];
    const segment = (Array.isArray(itinerary.segments) && itinerary.segments.length > 0) ? itinerary.segments[0] : null;
    const normalizeAirlineCode = code => (code || '').toUpperCase();

    // Price parsing - Amadeus often returns strings
    let priceAmount = 0;
    try {
      if (offer.price && typeof offer.price.total !== 'undefined') {
        priceAmount = Number.parseFloat(String(offer.price.total).replace(/,/g, '')) || 0;
      } else if (offer.price && typeof offer.price.totalPrice !== 'undefined') {
        priceAmount = Number.parseFloat(String(offer.price.totalPrice).replace(/,/g, '')) || 0;
      } else {
        priceAmount = 0;
      }
    } catch (e) { priceAmount = 0; }

    const currency =
      (offer.price && (offer.price.currency || offer.price.currencyCode)) ||
      offer.currencyCode ||
      'INR';

    // seatsAvailable — try common fields if present, otherwise leave undefined
    const seatsAvailable =
      typeof offer.numberOfBookableSeats === 'number' ? offer.numberOfBookableSeats :
      (offer.validatingAirlineCodes ? null : null);

    return {
      id: String(offer.id || (offer && offer.slice ? offer.slice(0,8) : '')),
      _id: String(offer.id || ''),
      provider: 'amadeus',
      airline: segment ? (normalizeAirlineCode(segment.carrierCode) || '') : (String((offer.validatingAirlineCodes || [])[0] || '')).toUpperCase(),
      flightNumber: segment ? (segment.number || '') : '',
      origin: segment ? (segment.departure?.iataCode || '') : '',
      destination: segment ? (segment.arrival?.iataCode || '') : '',
      departureAt: segment ? (segment.departure?.at || '') : '',
      arrivalAt: segment ? (segment.arrival?.at || '') : '',
      seatsAvailable: seatsAvailable,
      price: {
        amount: Number(Math.round(priceAmount || 0)), // major units (rounded)
        currency: currency || 'INR'
      },
      raw: offer
    };
  } catch (e) {
    console.error('[amadeus] map error', e && e.message);
    return null;
  }
}


/** Public search function — returns wrapper { ok, flights, diagnostic } */
async function search({ origin, destination, date, limit = 20 } = {}) {
  try {
    if (!origin || !destination || !date) {
      return { ok: false, flights: [], diagnostic: { message: 'missing origin/destination/date' } };
    }

    // Build params exactly as Amadeus expects
    const params = {
      originLocationCode: origin,
      destinationLocationCode: destination,
      departureDate: date,
      adults: 1,
      currencyCode: 'INR',
      max: limit
    };

    // console.log('[amadeus] issuing search', { ...params, ts: new Date().toISOString() });

    const call = await callAmadeusWithRetries('/v2/shopping/flight-offers', { params, timeout: 15000, attempts: 4 });

    if (!call.ok) {
      console.warn('[amadeus] search error (final):', call.diagnostic || call);
      return { ok: false, flights: [], diagnostic: call.diagnostic || call };
    }

    const data = call.data;
    if (!data || !Array.isArray(data.data)) {
      // sometimes Amadeus returns wrapper objects or errors — include whole data for diagnostics
      return { ok: false, flights: [], diagnostic: { message: 'unexpected response shape', data } };
    }

    const offers = data.data;
    const mapped = offers.map(mapAmadeusOffer).filter(Boolean);
    return { ok: true, flights: mapped, diagnostic: null };

  } catch (err) {
    console.error('[amadeus] unexpected search error', err && err.stack ? err.stack : err);
    const diag = { message: err?.message || String(err) };
    if (err?.response) { diag.status = err.response.status; diag.data = err.response.data; diag.headers = err.response.headers; }
    return { ok: false, flights: [], diagnostic: diag };
  }
}

/** getFlight: in sandbox we cannot fetch by id; return diagnostic */
async function getFlight(id) {
  return {
    ok: false,
    flight: null,
    diagnostic: { message: 'Amadeus sandbox: getFlight by id not supported. Use search and pass full offer.' }
  };
}

async function revalidate({ offer }) {
  try {
    if (!offer) {
      return { ok: false, reason: 'missing_offer' };
    }

    const params = {
      data: {
        type: 'flight-offers-pricing',
        flightOffers: [offer]
      }
    };

    const token = await getToken();
    if (!token) {
      return { ok: false, reason: 'auth_failed' };
    }

    const resp = await axios.post(
      `${BASE_API}/v1/shopping/flight-offers/pricing`,
      params,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const pricedOffer = resp?.data?.data?.flightOffers?.[0];
    if (!pricedOffer) {
      return { ok: false, reason: 'no_priced_offer' };
    }

    return {
      ok: true,
      price: {
        amount: Number(pricedOffer.price.total),
        currency: pricedOffer.price.currency
      },
      raw: pricedOffer
    };
  } catch (err) {
    console.error('[amadeus] revalidate error', err?.response?.data || err.message);
    return {
      ok: false,
      reason: 'provider_error',
      diagnostic: err?.response?.data || err.message
    };
  }
}

async function issueTicket({ booking }) {
  try {
    if (!booking || !booking.providerMeta) {
      return { ok: false, reason: 'missing_booking_meta' };
    }

    const token = await getToken();
    if (!token) {
      return { ok: false, reason: 'auth_failed' };
    }

    // Existing Amadeus order creation logic (reuse what you already have)
    const resp = await axios.post(
      `${BASE_API}/v1/booking/flight-orders`,
      booking.providerMeta.orderPayload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const pnr =
      resp?.data?.data?.associatedRecords?.[0]?.reference ||
      null;

    if (!pnr) {
      return { ok: false, reason: 'pnr_not_returned', raw: resp?.data };
    }

    return {
      ok: true,
      pnr,
      raw: resp.data
    };
  } catch (err) {
    console.error('[amadeus] issueTicket error', err?.response?.data || err.message);
    return {
      ok: false,
      reason: 'provider_error',
      diagnostic: err?.response?.data || err.message
    };
  }
}


module.exports = {
  providerId: 'amadeus',
  search,
  getFlight,
  revalidate,
  issueTicket,
};
