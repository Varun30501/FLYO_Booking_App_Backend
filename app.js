require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const authRoutes = require('./routes/auth');
const flightsRoutes = require('./routes/flights');
const bookingsRoutes = require('./routes/bookings');
const paymentsRoutes = require('./routes/payments');
const healthRoutes = require('./routes/health');
const airlineRoutes = require('./routes/airline');
const webhooksRoutes = require('./routes/webhooks');
const flightsStatusRoutes = require('./routes/flightsStatus');
const adminReconcileRoutes = require('./routes/adminReconcile');
const adminFlightsRoutes = require('./routes/admin/flights');
const adminBookingsRoutes = require('./routes/admin/bookings');
const adminPaymentsRoutes = require('./routes/admin/payments');
const exportsRoutes = require('./routes/admin/exports');
const adminStatsRouter = require('./routes/admin/stats');
const adminProviderHealthRoutes = require('./routes/admin/providers');

const offersRouter = require('./routes/offers');
const reviewsRouter = require('./routes/reviews');
const statsRouter = require('./routes/stats');
const packagesRouter = require('./routes/packages');
const seatRouter = require('./routes/seats');
const providersRouter = require('./routes/providers');
const faqRouter = require('./routes/faq');

const paymentsCtrl = require('./controllers/paymentsController');
const reconciler = require('./services/reconcileScheduler');

const addonsRouter = require('./routes/addons');
const couponsRouter = require('./routes/coupons');

const app = express();
const FRONTEND = process.env.FRONTEND_URL || 'http://localhost:5173';

// optional reconcile scheduler
try { require('./services/reconcileScheduler'); } catch (e) { /* ignore */ }

// CORS options - allow idempotency header in preflight
const corsOptions = {
  origin: FRONTEND,
  credentials: true,
  methods: ['GET','POST','PUT', 'PATCH', 'DELETE','OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Accept',
    'X-Requested-With',
    'Idempotency-Key',
    'X-Idempotency-Key',
    'idempotency-key'
  ],
  exposedHeaders: [
    'Idempotency-Key', 'X-Idempotency-Key', 'idempotency-key'
  ]
};
app.use(cors(corsOptions));

/**
 * IMPORTANT:
 * Stripe requires the exact raw request body when verifying webhook signatures.
 * Therefore register the webhook route with bodyParser.raw BEFORE any body-parsing middleware
 * like express.json() or express.urlencoded().
 *
 * We register only the webhook route with the raw parser (route-specific), not as a global middleware.
 */
app.post('/api/payments/webhook', bodyParser.raw({ type: 'application/json' }), paymentsCtrl.webhook);

// JSON and urlencoded parsers (applied after the raw webhook route)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- API routes ---

// auth should come early
app.use('/api/auth', authRoutes);

// flights / bookings
app.use('/api/flights', flightsRoutes);
app.use('/api/bookings', bookingsRoutes);

// after explicit webhook route, mount regular payments routes (these use JSON middleware)
app.use('/api/payments', paymentsRoutes);

// provider webhook endpoint (separate)
app.use('/api/provider-webhook', webhooksRoutes);

// health, airline & other misc routes
app.use('/api/health', healthRoutes);
app.use('/api/airline', airlineRoutes);
app.use('/api/flights/status', flightsStatusRoutes);

app.use('/api/admin/reconcile', adminReconcileRoutes);
app.use('/api/admin/flights', adminFlightsRoutes);
app.use('/api/admin/bookings', adminBookingsRoutes);
app.use('/api/admin/payments', adminPaymentsRoutes);
app.use('/api/admin/exports', exportsRoutes);
app.use('/api/admin/stats', adminStatsRouter);
app.use('/api/admin/providers', adminProviderHealthRoutes);


app.use('/api/offers', offersRouter);
app.use('/api/reviews', reviewsRouter);
app.use('/api/airlines', airlineRoutes); // keep both /api/airline and /api/airlines if needed
app.use('/api/stats', statsRouter);
app.use('/api/packages', packagesRouter);
app.use('/api/seats', seatRouter);

// Use the dedicated providers router for /api/providers
app.use('/api/providers', providersRouter);

app.use('/api/addons', addonsRouter);
app.use('/api/coupons', couponsRouter);
app.use('/api/faqs', faqRouter);

// start reconciler (if present)
try {
  if (reconciler && typeof reconciler.startReconciler === 'function') {
    reconciler.startReconciler(5 * 60 * 1000);
  }
} catch (e) {
  console.error('[reconciler] start error', e && (e.message || e));
}

// 404 handler for API routes or unmatched requests
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  // for non-API requests (e.g. static serving disabled) show plain not found
  return res.status(404).send('Not found');
});

// error handler
app.use((err, req, res, next) => {
  console.error('[app] error handler:', err && (err.stack || err));
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  res.status(status).json({ success: false, message: err.message || 'Server error' });
});

module.exports = app;
