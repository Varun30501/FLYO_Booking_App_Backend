const Booking = require('../models/Booking');
const Payment = require('../models/Payment');
const ReconcileLog = require('../models/ReconciliationLog');

function toCSV(rows = []) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const lines = [
    headers.join(','),
    ...rows.map(r => headers.map(h => escape(r[h])).join(','))
  ];

  return lines.join('\n');
}

exports.exportBookings = async (req, res) => {
  const bookings = await Booking.find().lean();
  const csv = toCSV(bookings);
  res.header('Content-Type', 'text/csv');
  res.attachment('bookings.csv');
  res.send(csv);
};

exports.exportPayments = async (req, res) => {
  const payments = await Payment.find().lean();
  const csv = toCSV(payments);
  res.header('Content-Type', 'text/csv');
  res.attachment('payments.csv');
  res.send(csv);
};

exports.exportReconcileLogs = async (req, res) => {
  const logs = await ReconcileLog.find().lean();
  const csv = toCSV(logs);
  res.header('Content-Type', 'text/csv');
  res.attachment('reconciliation_logs.csv');
  res.send(csv);
};
