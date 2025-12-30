// models/Booking.js
const mongoose = require('mongoose');

const PassengerSchema = new mongoose.Schema({
  title: { type: String, default: '' },
  firstName: { type: String, default: '' },
  lastName: { type: String, default: '' },
  passport: { type: String, default: '' },
  dob: { type: Date },
  passengerType: { type: String, default: 'adult' },
  nationality: { type: String, default: '' },
  documentType: { type: String, default: '' },
  documentNumber: { type: String, default: '' },
  seat: { type: String, default: '' }
}, { _id: false });

const PriceSchema = new mongoose.Schema({
  amount: { type: Number, default: 0 }, // major units (e.g. rupees)
  currency: { type: String, default: 'INR' },
  tax: { type: Number, default: 0 },
  taxes: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  addonsTotal: { type: Number, default: 0 },
  discountsTotal: { type: Number, default: 0 }
}, { _id: false });

/**
 * AddonSchema supports:
 * - name, code
 * - amount (major units)
 * - qty
 * - category (meal, baggage, seat, priority, vip, etc)
 * - metadata: structured info like mealType, baggageWeight, seatRow etc
 */
const AddonSchema = new mongoose.Schema({
  name: { type: String, default: '' },
  code: { type: String, default: '' },
  amount: { type: Number, default: 0 }, // major units (per unit)
  qty: { type: Number, default: 1 },
  category: { type: String, default: '' },
  metadata: { type: mongoose.Schema.Types.Mixed }, // store any additional data
  createdAt: { type: Date, default: () => new Date() }
}, { _id: false });

/**
 * CouponSchema supports an advanced structure:
 * - code
 * - amount (absolute major units)
 * - percent (0-100) if percentage-based
 * - validated: whether server validated it at time of booking
 * - appliesTo: free-form (airline codes, route, etc)
 * - metadata: can include expiry, minFare, usage rules (copied at time of validation)
 * - appliedAt: timestamp when applied
 */
const CouponSchema = new mongoose.Schema({
  code: { type: String, default: '' },
  amount: { type: Number, default: 0 }, // absolute amount (major units)
  percent: { type: Number, default: 0 }, // percentage discount (0-100)
  validated: { type: Boolean, default: false },
  reason: { type: String, default: '' },
  appliesTo: { type: mongoose.Schema.Types.Mixed },
  metadata: { type: mongoose.Schema.Types.Mixed },
  appliedAt: { type: Date, default: null }
}, { _id: false });

const DiscountSchema = new mongoose.Schema({
  name: { type: String, default: '' },
  amount: { type: Number, default: 0 }, // positive number (we will subtract)
  reason: { type: String, default: '' },
  metadata: { type: mongoose.Schema.Types.Mixed }
}, { _id: false });

const BookingSchema = new mongoose.Schema({
  bookingRef: { type: String, index: true, unique: true, sparse: false },
  userId: { type: String, default: null },
  flightId: { type: String, default: null },
  provider: { type: String, default: null },
  providerBookingId: { type: String, default: null },

  passengers: { type: [PassengerSchema], default: [] },

  contact: {
    name: { type: String, default: '' },
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
    fullName: { type: String, default: '' }
  },

  seats: [{ type: mongoose.Schema.Types.Mixed }], // strings or objects
  seatsMeta: [{ type: mongoose.Schema.Types.Mixed }], // canonical seat objects with price etc.

  // Addons, coupons, discounts (itemized)
  addons: { type: [AddonSchema], default: [] },
  coupons: { type: [CouponSchema], default: [] },
  discounts: { type: [DiscountSchema], default: [] },

  // price object
  price: { type: PriceSchema, default: () => ({}) },

  status: { type: String, default: 'HELD' },
  paymentStatus: { type: String, default: 'PENDING' },
  bookingStatus: { type: String, default: 'PENDING' },
  stripeSessionId: { type: String, default: null },
  stripeSessionParams: { type: mongoose.Schema.Types.Mixed, default: null }, // persisted stripe params + opts
  paymentIntentId: { type: String, default: null },
  paymentId: { type: String, default: null },
  paymentProvider: { type: String, default: null },
  cancellationFeeMajor: { type: Number, default: 0 }, // major units, e.g., rupees
  cancellationPolicySnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  cancelledAt: { type: Date, default: null },
  idempotencyKey: { type: String, default: null, index: true, sparse: true },

  rawProviderResponse: mongoose.Schema.Types.Mixed,
  // ---- Phase C: Ticketing ----
  ticketStatus: {
    type: String,
    enum: ['PENDING', 'ISSUED', 'FAILED'],
    default: 'PENDING'
  },

  providerPNR: {
    type: String,
    default: null
  },

  ticketingAttempts: {
    type: Number,
    default: 0
  },

  reconciliationAttempts: { type: Number, default: 0 },
  lastReconciledAt: { type: Date, default: null },
  lastPaymentLinkUrl: { type: String, default: null }
}, { timestamps: true });

// helper: return seat labels in a safe way
BookingSchema.method('getSeatLabels', function () {
  const s = this.seats || [];
  try {
    return s.map(x => {
      if (x === null || x === undefined) return null;
      if (typeof x === 'string' || typeof x === 'number') return String(x);
      if (typeof x === 'object') return x.seatId || x.label || x.seat || x.name || x.id || null;
      return String(x);
    }).filter(Boolean);
  } catch (e) { return []; }
});

module.exports = mongoose.models.Booking || mongoose.model('Booking', BookingSchema);
