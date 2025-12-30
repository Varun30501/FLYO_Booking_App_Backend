// backend/utils/pdf.js
const PDFDocument = require('pdfkit');

function formatMoneyMajor(amount, currency = 'INR') {
  try {
    const n = Number(amount || 0);
    const cur = (currency || 'INR').toUpperCase();
    const parts = n.toFixed(2).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (cur === 'INR' ? '₹ ' : cur + ' ') + parts.join('.');
  } catch (e) {
    return String(amount || '');
  }
}

function computePriceBreakdown(booking) {
  const seatsMeta = Array.isArray(booking.seatsMeta) ? booking.seatsMeta : [];
  const seatsSubtotal = seatsMeta.reduce((acc, s) => acc + (Number(s.price || 0)), 0);
  const classExtras = seatsMeta.reduce((acc, s) => acc + (Number(s.priceModifier || 0)), 0);
  const baseSubtotal = Math.max(0, seatsSubtotal - classExtras);

  // addons
  const addonsArr = Array.isArray(booking.addons) ? booking.addons : [];
  const addonsTotal = addonsArr.reduce((acc, a) => acc + (Number(a.amount || 0) * (Number(a.qty || 1) || 1)), 0);

  // discounts - combine explicit discounts + coupons
  let discountsTotal = 0;
  if (Array.isArray(booking.discounts)) discountsTotal += booking.discounts.reduce((acc, d) => acc + Math.abs(Number(d.amount || 0)), 0);
  if (Array.isArray(booking.coupons)) discountsTotal += booking.coupons.reduce((acc, c) => acc + Math.abs(Number(c.amount || 0)), 0);
  if (!discountsTotal && booking.price && Number.isFinite(Number(booking.price.discount))) discountsTotal += Math.abs(Number(booking.price.discount || 0));

  // tax detection
  let taxMajor = 0;
  if (booking.price && typeof booking.price.tax === 'number') taxMajor = Number(booking.price.tax);
  else if (booking.price && typeof booking.price.taxes === 'number') taxMajor = Number(booking.price.taxes);
  else if (booking.price && typeof booking.price.amount === 'number') {
    if (seatsSubtotal + addonsTotal - discountsTotal > 0) {
      const inferred = Number(booking.price.amount) - (seatsSubtotal + addonsTotal - discountsTotal);
      if (Number.isFinite(inferred) && inferred >= 0) taxMajor = Math.round(inferred);
    }
  }

  const totalMajor = (booking.price && typeof booking.price.amount === 'number') ? Math.round(booking.price.amount) : Math.round(baseSubtotal + classExtras + addonsTotal - discountsTotal + taxMajor);

  return {
    baseSubtotal: Math.round(baseSubtotal || 0),
    classExtras: Math.round(classExtras || 0),
    tax: Math.round(taxMajor || 0),
    seatsSubtotal: Math.round(seatsSubtotal || 0),
    addonsTotal: Math.round(addonsTotal || 0),
    discountsTotal: Math.round(discountsTotal || 0),
    total: Math.round(totalMajor || 0),
    currency: (booking.price && booking.price.currency) || 'INR',
    addons: addonsArr,
    discountsArr: booking.discounts || [],
    coupons: booking.coupons || []
  };
}

/**
 * generateItineraryPDF(booking)
 * existing function — unchanged in behavior
 */
function generateItineraryPDF(booking) {
  return new Promise((resolve, reject) => {
    try {
      const b = (booking && typeof booking.toObject === 'function') ? booking.toObject() : booking || {};

      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => {
        const result = Buffer.concat(chunks);
        resolve(result);
      });

      // Header
      doc.fontSize(18).font('Helvetica-Bold').text('Flight Itinerary', { align: 'center' });
      doc.moveDown(0.4);
      doc.fontSize(10).font('Helvetica').text(`Booking Reference: ${b.bookingRef || '—'}`, { align: 'left' });
      doc.text(`Booking created: ${b.createdAt ? new Date(b.createdAt).toLocaleString() : '—'}`);
      doc.moveDown(0.6);

      // Flight meta
      doc.fontSize(12).font('Helvetica-Bold').text('Flight Details');
      doc.moveDown(0.2);
      doc.fontSize(10).font('Helvetica');
      doc.text(`Flight ID: ${b.flightId || '—'}`);
      doc.text(`Provider PNR: ${b.providerBookingId || '—'}`);
      doc.moveDown(0.4);

      // Passengers table
      doc.fontSize(12).font('Helvetica-Bold').text(`Passengers (${Array.isArray(b.passengers) ? b.passengers.length : 0})`);
      doc.moveDown(0.2);
      doc.fontSize(9).font('Helvetica');

      const passengerLines = (Array.isArray(b.passengers) ? b.passengers : []).map((p, idx) => {
        const name = [p.title, p.firstName, p.lastName].filter(Boolean).join(' ').trim() || (p.name || `Passenger ${idx + 1}`);
        let seat = '-';
        try {
          if (Array.isArray(b.seats) && b.seats[idx]) {
            const s = b.seats[idx];
            seat = (typeof s === 'string' || typeof s === 'number') ? String(s) : (s.label || s.seatId || s.seat || '-');
          } else if (p.seat) seat = p.seat;
        } catch (e) { seat = '-'; }
        return { name, seat };
      });

      const pageInnerWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const nameColWidth = Math.round(pageInnerWidth * 0.65);
      const seatColX = doc.page.margins.left + nameColWidth + 10;

      passengerLines.forEach((pl, idx) => {
        const y = doc.y;
        doc.text(`${idx + 1}. ${pl.name}`, { width: nameColWidth, continued: false });
        doc.text(`Seat: ${pl.seat}`, seatColX, y);
        doc.moveDown(0.4);
      });

      doc.moveDown(0.4);

      // Price breakdown
      const pb = computePriceBreakdown(b);
      doc.fontSize(12).font('Helvetica-Bold').text('Price breakdown');
      doc.moveDown(0.2);
      doc.fontSize(10).font('Helvetica');

      const labelColX = doc.x;
      const valueColX = doc.page.width - doc.page.margins.right - 140;

      doc.text('Base price (sum of base fares):', labelColX, doc.y, { continued: true });
      doc.text(formatMoneyMajor(pb.baseSubtotal, pb.currency), valueColX, doc.y);
      doc.moveDown(0.2);

      doc.text('Class / seat extras:', labelColX, doc.y, { continued: true });
      doc.text(formatMoneyMajor(pb.classExtras, pb.currency), valueColX, doc.y);
      doc.moveDown(0.2);

      doc.text('Seats subtotal (base + class):', labelColX, doc.y, { continued: true });
      doc.text(formatMoneyMajor(pb.seatsSubtotal, pb.currency), valueColX, doc.y);
      doc.moveDown(0.2);

      if (pb.addonsTotal && pb.addonsTotal > 0) {
        doc.text('Add-ons:', labelColX, doc.y, { continued: true });
        doc.text(formatMoneyMajor(pb.addonsTotal, pb.currency), valueColX, doc.y);
        doc.moveDown(0.2);
      }

      if (pb.discountsTotal && pb.discountsTotal > 0) {
        doc.text('Discounts / coupons:', labelColX, doc.y, { continued: true });
        doc.text(`-${formatMoneyMajor(pb.discountsTotal, pb.currency)}`, valueColX, doc.y);
        doc.moveDown(0.2);
      }

      doc.text('Taxes & fees:', labelColX, doc.y, { continued: true });
      doc.text(formatMoneyMajor(pb.tax, pb.currency), valueColX, doc.y);
      doc.moveDown(0.4);

      doc.font('Helvetica-Bold').text('Total paid:', labelColX, doc.y, { continued: true });
      doc.text(formatMoneyMajor(pb.total, pb.currency), valueColX, doc.y);

      doc.moveDown(0.8);

      // Per-seat details, addons, discounts and footer (same as before)
      if (Array.isArray(b.seatsMeta) && b.seatsMeta.length) {
        doc.fontSize(11).font('Helvetica-Bold').text('Per-seat details');
        doc.moveDown(0.2);
        doc.fontSize(9).font('Helvetica');

        const colSeatX = doc.x;
        const colClassX = colSeatX + 90;
        const colBaseX = colClassX + 140;
        const colExtraX = colBaseX + 80;
        const colPriceX = doc.page.width - doc.page.margins.right - 120;

        doc.text('Seat', colSeatX, doc.y, { continued: true });
        doc.text('Class', colClassX, doc.y, { continued: true });
        doc.text('Base', colBaseX, doc.y, { continued: true });
        doc.text('Extra', colExtraX, doc.y, { continued: true });
        doc.text('Price', colPriceX, doc.y);
        doc.moveDown(0.2);

        b.seatsMeta.forEach(s => {
          const seatId = s.seatId || s.seat || '-';
          const cls = s.seatClass || s.class || s.category || '-';
          const priceMaj = Number(s.price || 0);
          const extra = Number(s.priceModifier || 0);
          const base = Math.max(0, priceMaj - extra);

          doc.text(String(seatId), colSeatX, doc.y, { continued: true });
          doc.text(String(cls), colClassX, doc.y, { continued: true });
          doc.text(formatMoneyMajor(base, pb.currency), colBaseX, doc.y, { continued: true });
          doc.text(formatMoneyMajor(extra, pb.currency), colExtraX, doc.y, { continued: true });
          doc.text(formatMoneyMajor(priceMaj, pb.currency), colPriceX, doc.y);
          doc.moveDown(0.1);
        });

        doc.moveDown(0.6);
      }

      if (Array.isArray(pb.addons) && pb.addons.length) {
        doc.fontSize(11).font('Helvetica-Bold').text('Add-ons');
        doc.moveDown(0.2);
        doc.fontSize(9).font('Helvetica');
        const col1 = doc.x;
        const col2 = doc.page.width - doc.page.margins.right - 120;
        pb.addons.forEach(a => {
          const name = (a.name || a.title || a.code || 'addon') + (a.qty && a.qty > 1 ? ` x${a.qty}` : '');
          const amt = Number((a.amount || 0) * (Number(a.qty || 1) || 1));
          doc.text(name, col1, doc.y, { continued: true });
          doc.text(formatMoneyMajor(amt, pb.currency), col2, doc.y);
          doc.moveDown(0.1);
        });
        doc.moveDown(0.4);
      }

      if ((Array.isArray(pb.discountsArr) && pb.discountsArr.length) || (Array.isArray(pb.coupons) && pb.coupons.length)) {
        doc.fontSize(11).font('Helvetica-Bold').text('Discounts & coupons');
        doc.moveDown(0.2);
        doc.fontSize(9).font('Helvetica');
        const col1 = doc.x;
        const col2 = doc.page.width - doc.page.margins.right - 120;
        (pb.discountsArr || []).forEach(d => {
          const name = d.name || d.reason || 'discount';
          const amt = Math.abs(Number(d.amount || 0));
          doc.text(name, col1, doc.y, { continued: true });
          doc.text(`-${formatMoneyMajor(amt, pb.currency)}`, col2, doc.y);
          doc.moveDown(0.1);
        });
        (pb.coupons || []).forEach(c => {
          const name = c.code || c.coupon || c.name || 'coupon';
          const amt = Math.abs(Number(c.amount || 0));
          doc.text(`${name}${c.percent ? ` (${c.percent}% off)` : ''}`, col1, doc.y, { continued: true });
          doc.text(`-${formatMoneyMajor(amt, pb.currency)}`, col2, doc.y);
          if (c.cap && Number(c.cap) > 0) {
            doc.moveDown(0.05);
            doc.text(`(cap: ${formatMoneyMajor(c.cap, pb.currency)})`, col1 + 6, doc.y);
            doc.moveDown(0.05);
          }
          if (c.metadata && Object.keys(c.metadata || {}).length) {
            doc.moveDown(0.05);
            doc.text(`Metadata: ${Object.entries(c.metadata).map(([k, v]) => `${k}: ${v}`).join(', ')}`, col1 + 6, doc.y);
            doc.moveDown(0.05);
          }
          doc.moveDown(0.1);
        });
        doc.moveDown(0.4);
      }

      doc.fontSize(9).font('Helvetica').text('If you have questions, contact us at support@example.com', { align: 'left' });
      doc.moveDown(0.4);
      doc.text(`Generated: ${new Date().toLocaleString()}`, { align: 'left' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * NEW: generateCancellationInvoicePDF(booking, { cancellationFeeMajor, refundMajor, refundRaw })
 * - produces a small invoice that explicitly shows cancellation fee and refund amount
 * - amounts are in major units (rupees). If null, shows 0.
 */
function generateCancellationInvoicePDF(booking, { cancellationFeeMajor = 0, refundMajor = 0, refundRaw = null } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const b = (booking && typeof booking.toObject === 'function') ? booking.toObject() : (booking || {});
      const currency = (b.price && b.price.currency) ? b.price.currency : 'INR';
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      // Header
      doc.fontSize(18).font('Helvetica-Bold').text('Cancellation Invoice', { align: 'center' });
      doc.moveDown(0.4);
      doc.fontSize(10).font('Helvetica').text(`Booking Reference: ${b.bookingRef || '—'}`, { align: 'left' });
      doc.text(`Cancelled: ${b.cancelledAt ? new Date(b.cancelledAt).toLocaleString() : new Date().toLocaleString()}`);
      doc.moveDown(0.6);

      // Customer
      doc.fontSize(11).font('Helvetica-Bold').text('Customer');
      doc.moveDown(0.1);
      doc.fontSize(10).font('Helvetica');
      doc.text(`Name: ${b.contact?.name || '—'}`);
      doc.text(`Email: ${b.contact?.email || '—'}`);
      doc.moveDown(0.4);

      // Flight & passenger summary
      doc.fontSize(11).font('Helvetica-Bold').text('Booking Summary');
      doc.moveDown(0.1);
      doc.fontSize(10).font('Helvetica');
      doc.text(`Flight ID: ${b.flightId || '—'}`);
      doc.text(`Passengers: ${Array.isArray(b.passengers) ? b.passengers.length : 0}`);
      const seats = (Array.isArray(b.seats) && b.seats.length) ? b.seats.map(s => (typeof s === 'string' ? s : (s.seatId || s.label || s.seat))).join(', ') : '—';
      doc.text(`Seats: ${seats}`);
      doc.moveDown(0.4);

      // Price breakdown and cancellation values
      const pb = computePriceBreakdown(b);
      const totalPaid = pb.total || 0;
      const cancellationFee = Number(cancellationFeeMajor || 0);
      const refund = Number(refundMajor || 0);

      doc.fontSize(11).font('Helvetica-Bold').text('Amount details');
      doc.moveDown(0.2);
      doc.fontSize(10).font('Helvetica');
      const labelX = doc.x;
      const valueX = doc.page.width - doc.page.margins.right - 160;
      doc.text('Total paid:', labelX, doc.y, { continued: true });
      doc.text(formatMoneyMajor(totalPaid, currency), valueX, doc.y);
      doc.moveDown(0.2);
      doc.text('Cancellation fee:', labelX, doc.y, { continued: true });
      doc.text(formatMoneyMajor(cancellationFee, currency), valueX, doc.y);
      doc.moveDown(0.2);
      doc.text('Refund amount:', labelX, doc.y, { continued: true });
      doc.text(formatMoneyMajor(refund, currency), valueX, doc.y);
      doc.moveDown(0.6);

      // Per-passenger listing
      if (Array.isArray(b.passengers) && b.passengers.length) {
        doc.fontSize(11).font('Helvetica-Bold').text('Passengers');
        doc.moveDown(0.2);
        doc.fontSize(9).font('Helvetica');
        b.passengers.forEach((p, idx) => {
          const name = [p.title, p.firstName, p.lastName].filter(Boolean).join(' ').trim() || (p.name || `Passenger ${idx + 1}`);
          doc.text(`${idx + 1}. ${name} — Seat: ${((b.seats && b.seats[idx]) ? (typeof b.seats[idx] === 'string' ? b.seats[idx] : (b.seats[idx].label || b.seats[idx].seatId || b.seats[idx].seat)) : (p.seat || '-'))}`);
        });
        doc.moveDown(0.4);
      }

      // Refund diagnostic (small)
      if (refundRaw) {
        doc.fontSize(10).font('Helvetica-Bold').text('Refund (server response)');
        doc.moveDown(0.1);
        doc.fontSize(8).font('Helvetica');
        const smallText = typeof refundRaw === 'string' ? refundRaw : JSON.stringify(refundRaw, null, 2);
        // ensure not too large
        const preview = smallText.length > 1200 ? smallText.slice(0, 1200) + '... (truncated)' : smallText;
        doc.text(preview, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
        doc.moveDown(0.4);
      }

      // Footer
      doc.moveDown(0.6);
      doc.fontSize(9).font('Helvetica').text('If you have questions, contact support@example.com', { align: 'left' });
      doc.text(`Generated: ${new Date().toLocaleString()}`, { align: 'left' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateItineraryPDF, generateCancellationInvoicePDF };
