// services/airlines/adapter.js
'use strict';

const providers = {
  amadeus: (() => {
    try { return require('./providers/amadeusProvider'); } catch (e) { return null; }
  })(),
  // add other providers here (sabreProvider, travelportProvider, localCache, etc)
};

async function callProviderSearch(provider, params) {
  try {
    if (!provider || typeof provider.search !== 'function') {
      return { ok: false, flights: [], diagnostic: { message: 'provider unavailable' } };
    }
    const start = Date.now();
    const raw = await provider.search(params);
    const duration = Date.now() - start;

    // Normalize flights into array if provider returned mapped flight objects
    const flights = Array.isArray(raw) ? raw : (raw && raw.flights ? raw.flights : (raw && raw.data && Array.isArray(raw.data) ? raw.data : []));

    // If provider itself returned diagnostic shape, keep it
    const providerDiagnostic = (raw && raw.diagnostic) ? raw.diagnostic : null;

    return {
      ok: Array.isArray(flights),
      flights: flights || [],
      diagnostic: Object.assign({
        provider: provider.providerId || provider.name || 'unknown',
        ts: new Date().toISOString(),
        durationMs: duration,
        rawShape: (raw && typeof raw === 'object') ? Object.keys(raw).slice(0,6) : typeof raw
      }, providerDiagnostic || (raw && raw.error ? { error: raw.error } : {}))
    };
  } catch (err) {
    // Catch provider errors and return diagnostic (no throw)
    return {
      ok: false,
      flights: [],
      diagnostic: {
        provider: provider && (provider.providerId || provider.name) || 'unknown',
        ts: new Date().toISOString(),
        errorMessage: err && (err.message || String(err)),
        stack: (err && err.stack) ? String(err.stack).slice(0,2000) : undefined
      }
    };
  }
}

/**
 * search({ origin, destination, date, limit })
 * returns: { ok: boolean, flights: Array, diagnostic: Object }
 * This wrapper will try providers in preferred order and combine results.
 */
async function search(params = {}) {
  // Choose provider priority — here use amadeus first if available
  const order = ['amadeus']; // add others as fallback in array
  const aggregated = [];
  const diagnostics = [];

  for (const pKey of order) {
    const prov = providers[pKey];
    if (!prov) continue;
    const result = await callProviderSearch(prov, params);
    diagnostics.push(result.diagnostic || { provider: pKey });
    if (result.ok && Array.isArray(result.flights) && result.flights.length > 0) {
      // return first successful non-empty provider results (common UX)
      return { ok: true, flights: result.flights, diagnostic: result.diagnostic };
    }
    // else continue to next provider, but keep diagnostics
  }

  // If no provider produced results, return combined diagnostic info
  return {
    ok: false,
    flights: [],
    diagnostic: {
      message: 'no provider returned flights',
      providers: diagnostics,
      ts: new Date().toISOString()
    }
  };
}

async function status() {
  const prov = providers.amadeus;
  if (!prov) return { ok: false, provider: 'amadeus', status: 'missing' };

  const token = await (prov.getToken ? prov.getToken() : null);
  return {
    ok: !!token,
    provider: 'amadeus',
    status: token ? 'up' : 'auth_failed'
  };
}

async function revalidate(params) {
  const prov = providers.amadeus;
  if (!prov || typeof prov.revalidate !== 'function') {
    return { ok: false, reason: 'provider_unavailable' };
  }
  return prov.revalidate(params);
}

async function issueTicket({ booking }) {
  const prov = providers.amadeus;
  if (!prov || typeof prov.issueTicket !== 'function') {
    return { ok: false, reason: 'provider_unavailable' };
  }
  return prov.issueTicket({ booking });
}

module.exports = {
  search,
  status,
  revalidate,
  issueTicket
};
