// tools/runReconcileOnce.js
const mongoose = require('mongoose');
const reconcile = require('../services/reconcile');
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/flight_booking_dev';

(async () => {
    try {
        console.log('Connecting to', MONGO_URI);
        await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true, serverSelectionTimeoutMS: 10000 });
        console.log('Connected (manual test). readyState=', mongoose.connection.readyState);
        await reconcile.reconcileOnce();
        console.log('reconcileOnce completed, disconnecting');
        await mongoose.disconnect();
        console.log('done');
    } catch (e) {
        console.error('manual reconcile failed:', e && e.stack ? e.stack : e);
        process.exit(1);
    }
})();
