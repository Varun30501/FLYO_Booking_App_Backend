// services/airlines/adapter.js
// Provider cascade: Amadeus → Duffel → Mock
// Each provider is tried in order; first non-empty result wins.
// Failed providers are tracked and briefly circuit-broken to avoid
// cascading latency on every request.
'use strict';

/* ── lazy-load providers ─────────────────────────────────────── */
function tryLoad(path) {
  try { return require(path); } catch (e) {
    console.warn(`[adapter] could not load provider at ${path}:`, e.message);
    return null;
  }
}

const PROVIDERS = {
  amadeus: tryLoad('./providers/amadeusProvider'),
  duffel:  tryLoad('./providers/duffelProvider'),
  mock:    tryLoad('./providers/mockProvider'),
};

/* ── circuit breaker state ───────────────────────────────────── */
// After FAIL_THRESHOLD consecutive failures, skip the provider for
// COOLDOWN_MS milliseconds before retrying.
const FAIL_THRESHOLD = 3;
const COOLDOWN_MS    = 60_000; // 1 minute

const _health = {
  amadeus: { failures:0, openUntil:0 },
  duffel:  { failures:0, openUntil:0 },
  mock:    { failures:0, openUntil:0 },
};

function isOpen(key) {
  const h = _health[key];
  if (!h) return true;
  if (h.openUntil && Date.now() < h.openUntil) return false; // still in cooldown
  return true;
}
function recordSuccess(key) {
  if (_health[key]) { _health[key].failures = 0; _health[key].openUntil = 0; }
}
function recordFailure(key) {
  if (!_health[key]) return;
  _health[key].failures++;
  if (_health[key].failures >= FAIL_THRESHOLD) {
    _health[key].openUntil = Date.now() + COOLDOWN_MS;
    console.warn(`[adapter] circuit open for ${key} — cooling down ${COOLDOWN_MS/1000}s`);
  }
}

/* ── call one provider ───────────────────────────────────────── */
async function callProvider(key, fn, params) {
  const prov = PROVIDERS[key];
  if (!prov || typeof fn !== 'function') {
    return { ok:false, flights:[], diagnostic:{ provider:key, message:'provider unavailable' } };
  }
  if (!isOpen(key)) {
    return { ok:false, flights:[], diagnostic:{ provider:key, message:'circuit open (cooling down)' } };
  }
  const ts = Date.now();
  try {
    const raw = await fn.call(prov, params);
    // Normalise return shape
    const flights = Array.isArray(raw) ? raw
      : Array.isArray(raw?.flights) ? raw.flights
      : Array.isArray(raw?.data)    ? raw.data
      : [];
    const ok = flights.length > 0;
    if (ok) recordSuccess(key); else recordFailure(key);
    return {
      ok,
      flights,
      diagnostic: {
        provider: key,
        durationMs: Date.now() - ts,
        count: flights.length,
        ...(raw?.diagnostic || {}),
      },
    };
  } catch (err) {
    recordFailure(key);
    console.error(`[adapter][${key}] error:`, err.message);
    return {
      ok:false, flights:[],
      diagnostic: { provider:key, durationMs:Date.now()-ts, errorMessage:err.message },
    };
  }
}

/* ── search — cascade ────────────────────────────────────────── */
async function search(params = {}) {
  // Order: amadeus → duffel → mock
  const ORDER = ['amadeus', 'duffel', 'mock'];
  const diagnostics = [];

  for (const key of ORDER) {
    const prov = PROVIDERS[key];
    if (!prov || typeof prov.search !== 'function') continue;

    const result = await callProvider(key, prov.search, params);
    diagnostics.push(result.diagnostic);

    if (result.ok && result.flights.length > 0) {
      console.log(`[adapter] ✅ ${key} returned ${result.flights.length} flights`);
      return { ok:true, flights:result.flights, provider:key, diagnostic:result.diagnostic };
    }

    console.log(`[adapter] ⏭ ${key} returned 0 flights — trying next provider`);
  }

  return {
    ok: false,
    flights: [],
    provider: null,
    diagnostic: { message:'all providers exhausted', providers:diagnostics },
  };
}

/* ── status ──────────────────────────────────────────────────── */
async function status() {
  const out = {};
  for (const [key, prov] of Object.entries(PROVIDERS)) {
    if (!prov) { out[key] = { status:'not_loaded' }; continue; }
    const h = _health[key];
    const circuitOpen = h?.openUntil && Date.now() < h.openUntil;
    out[key] = {
      status: circuitOpen ? 'circuit_open' : 'ok',
      failures: h?.failures || 0,
      cooldownRemainingMs: circuitOpen ? h.openUntil - Date.now() : 0,
    };
    // For Amadeus, also check token
    if (key === 'amadeus' && typeof prov.getToken === 'function') {
      try {
        const token = await prov.getToken();
        out[key].authStatus = token ? 'token_ok' : 'auth_failed';
      } catch { out[key].authStatus = 'auth_error'; }
    }
  }
  return out;
}

/* ── revalidate — try the provider that created the offer ─────── */
async function revalidate(params = {}) {
  const provKey = params?.offer?.provider || 'amadeus';
  const prov    = PROVIDERS[provKey] || PROVIDERS.amadeus;
  if (!prov || typeof prov.revalidate !== 'function') {
    return { ok:false, reason:'provider_unavailable' };
  }
  return prov.revalidate(params);
}

/* ── issueTicket ─────────────────────────────────────────────── */
async function issueTicket({ booking } = {}) {
  const provKey = booking?.provider || 'amadeus';
  const prov    = PROVIDERS[provKey] || PROVIDERS.amadeus;
  if (!prov || typeof prov.issueTicket !== 'function') {
    return { ok:false, reason:'provider_unavailable' };
  }
  return prov.issueTicket({ booking });
}

/* ── health endpoint helper ──────────────────────────────────── */
function healthSnapshot() { return JSON.parse(JSON.stringify(_health)); }

module.exports = { search, status, revalidate, issueTicket, healthSnapshot };
