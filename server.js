// backend/server.js
const http = require('http');
const mongoose = require('mongoose');
require('dotenv').config();

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/flight_booking_dev';

(async function start() {
  try {
    console.log('Connecting to MongoDB at', MONGO_URI);
    await mongoose.connect(MONGO_URI);
    console.log('Mongoose: connected');

    // require app after DB connection so providers/models see connected mongoose
    const app = require('./app');

    const server = http.createServer(app);

    // socket.io for real-time flight updates
    const { Server } = require('socket.io');
    const io = new Server(server, {
      cors: { origin: process.env.FRONTEND_ORIGIN || '*' }
    });

    // make io available on app.locals so routes can emit if needed:
    app.locals.io = io;

    io.on('connection', (socket) => {
      console.log('socket connected', socket.id);
      socket.on('subscribe-flight', ({ flightId }) => {
        if (!flightId) return;
        socket.join(`flight:${flightId}`);
      });
      socket.on('unsubscribe-flight', ({ flightId }) => {
        if (!flightId) return;
        socket.leave(`flight:${flightId}`);
      });
      socket.on('disconnect', () => {
        // console.log('socket disconnect', socket.id);
      });
    });

    server.listen(PORT, () => {
      console.log('Backend listening on', PORT);
    });
  } catch (err) {
    console.error('Failed to start backend', err);
    process.exit(1);
  }
})();
