const Booking = require('../models/Booking');
const ReconciliationLog = require('../models/ReconciliationLog');

exports.overviewStats = async (req, res) => {
  try {
    /* ---------------- BASIC COUNTS ---------------- */

    const totalBookings = await Booking.countDocuments();

    const confirmedBookings = await Booking.countDocuments({
      paymentStatus: 'PAID'
    });

    const cancelledBookings = await Booking.countDocuments({
      bookingStatus: 'CANCELLED'
    });

    const pendingPayments = await Booking.countDocuments({
      paymentStatus: 'PENDING',
      bookingStatus: 'PENDING'
    });

    /* ---------------- REVENUE ---------------- */

    const revenueAgg = await Booking.aggregate([
      { $match: { paymentStatus: 'PAID' } },
      {
        $group: {
          _id: null,
          total: { $sum: '$price.amount' }
        }
      }
    ]);

    const refundsAgg = await Booking.aggregate([
      { $match: { paymentStatus: { $in: ['REFUNDED', 'PARTIALLY_REFUNDED'] } } },
      { $unwind: '$refunds' },
      {
        $group: {
          _id: null,
          total: { $sum: '$refunds.amount' }
        }
      }
    ]);

    /* ---------------- RECENT BOOKINGS ---------------- */

    const recentBookings = await Booking.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select('bookingRef paymentStatus price createdAt')
      .lean();

    /* ---------------- LAST RECONCILIATION ---------------- */

    const lastReconcile = await ReconciliationLog.findOne()
      .sort({ runAt: -1 })
      .lean();

    /* ---------------- REVENUE TREND (LAST 7 DAYS) ---------------- */

    const revenueTrendRaw = await Booking.aggregate([
      {
        $match: {
          paymentStatus: 'PAID',
          createdAt: {
            $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
          }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
          },
          amount: { $sum: '$price.amount' }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    const revenueTrend = revenueTrendRaw.map(r => ({
      date: r._id,
      amount: r.amount
    }));

    /* ---------------- RESPONSE ---------------- */

    return res.json({
      ok: true,
      kpis: {
        totalBookings,
        confirmedBookings,
        cancelledBookings,
        pendingPayments,
        revenue: revenueAgg[0]?.total || 0,
        refunds: refundsAgg[0]?.total || 0
      },
      recentBookings,
      lastReconcile,
      revenueTrend
    });

  } catch (err) {
    console.error('[adminStats] overviewStats error', err);
    return res.status(500).json({
      ok: false,
      error: 'Failed to load admin overview stats'
    });
  }
};
