const express = require('express');
const router = express.Router();
const adminAuth = require('../../middleware/adminAuth');
const SeatMap = require('../../models/SeatMap');

router.use(adminAuth);

router.get('/locks', async (req, res) => {
  const maps = await SeatMap.find({
    'seats.status': { $in: ['held', 'booked'] }
  }).lean();

  const stuck = [];
  maps.forEach(m => {
    m.seats.forEach(s => {
      if (['held', 'booked'].includes(s.status)) {
        stuck.push({
          flightId: m.flightId,
          seatId: s.seatId,
          status: s.status,
          heldBy: s.heldBy,
          heldUntil: s.heldUntil
        });
      }
    });
  });

  res.json({ ok: true, seats: stuck });
});

module.exports = router;
