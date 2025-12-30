// services/flightData/index.js
const adapter = require('../airlines/adapter');

module.exports = {
  async search(opts) {
    // flightData is now a thin pass-through to airlines adapter
    if (!adapter || typeof adapter.search !== 'function') {
      return { ok: false, flights: [], diagnostic: { message: 'no provider adapter' } };
    }
    return adapter.search(opts);
  }
  ,
  async getFlight(id) {
    if (!adapter) return null;
    if (typeof adapter.getFlight === 'function') return adapter.getFlight(id);
    if (typeof adapter.get === 'function') return adapter.get(id);
    return null;
  },
  async getStatus(id, type) {
    if (!adapter) return null;
    if (typeof adapter.getStatus === 'function') return adapter.getStatus(id, type);
    return null;
  },
  async refresh(opts) {
    if (!adapter) return null;
    if (typeof adapter.refresh === 'function') return adapter.refresh(opts);
    return null;
  },
  _adapter: adapter
};
