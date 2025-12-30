// tools/testMongoConn.js
const mongoose = require('mongoose');
const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/flight_booking_dev';
(async () => {
    try {
        console.log('Testing connection to', uri);
        await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverSelectionTimeoutMS: 10000 });
        console.log('Connected OK');
        await mongoose.disconnect();
        process.exit(0);
    } catch (e) {
        console.error('Connect failed:', e && e.message);
        process.exit(2);
    }
})();
