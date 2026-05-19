// backend/utils/pdf.js — Structured, branded PDFs
'use strict';
const PDFDocument = require('pdfkit');

/* ── helpers ─────────────────────────────────────────────────── */
function fmt(n, cur = 'INR') {
  try {
    const num = Number(n || 0);
    const parts = num.toFixed(2).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (cur.toUpperCase() === 'INR' ? '\u20B9 ' : cur + ' ') + parts.join('.');
  } catch { return String(n || ''); }
}

function fmtDate(d) {
  if (!d) return '\u2014';
  try { return new Date(d).toLocaleString('en-IN', { dateStyle:'medium', timeStyle:'short' }); }
  catch { return String(d); }
}

function priceBreakdown(b) {
  const total        = Number(b?.price?.amount   || 0);
  const tax          = Number(b?.price?.tax      || b?.price?.taxes || 0);
  const addons       = (b?.addons   || []).reduce((s,a) => s + Number(a.amount||0)*Number(a.qty||1), 0);
  const discounts    = (b?.discounts|| []).reduce((s,d) => s + Math.abs(Number(d.amount||0)), 0)
                     + (b?.coupons  || []).reduce((s,c) => s + Math.abs(Number(c.amount||0)), 0);
  const seatFares    = total - tax - addons + discounts;
  const currency     = b?.price?.currency || 'INR';
  return { total: Math.round(total), tax: Math.round(tax), addons: Math.round(addons),
           discounts: Math.round(discounts), seatFares: Math.round(seatFares),
           currency, addonsArr: b?.addons||[], discountsArr: b?.discounts||[], coupons: b?.coupons||[] };
}

/* ── shared drawing primitives ───────────────────────────────── */
function drawBrandHeader(doc, title) {
  const W = doc.page.width;
  // Navy header bar
  doc.rect(0, 0, W, 72).fill('#07102a');
  // Cyan accent line
  doc.rect(0, 72, W, 3).fill('#00d4ff');
  // Logo placeholder circle
  doc.circle(52, 36, 20).fill('#00d4ff');
  doc.fillColor('#07102a').fontSize(11).font('Helvetica-Bold').text('FLYO', 37, 30);
  // Title
  doc.fillColor('#ffffff').fontSize(18).font('Helvetica-Bold').text(title, 84, 24, { width: W - 100 });
  doc.fillColor('#94a3b8').fontSize(9).font('Helvetica').text('flyo.in · support@flyo.com', 84, 46);
  doc.y = 96;
  doc.fillColor('#000000'); // reset
}

function hRule(doc, color = '#1e293b') {
  const L = doc.page.margins.left, R = doc.page.width - doc.page.margins.right;
  doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor(color).lineWidth(0.5).stroke();
  doc.moveDown(0.4);
}

function sectionTitle(doc, text) {
  doc.moveDown(0.6);
  doc.fillColor('#00d4ff').fontSize(9).font('Helvetica-Bold').text(text.toUpperCase(), { characterSpacing: 1.2 });
  hRule(doc, '#00d4ff');
  doc.fillColor('#000000');
}

function twoCol(doc, label, value, labelColor = '#64748b', valueColor = '#1e293b') {
  const L = doc.page.margins.left;
  const R = doc.page.width - doc.page.margins.right - 160;
  const y = doc.y;
  doc.fillColor(labelColor).fontSize(9).font('Helvetica').text(label, L, y, { width: R - L });
  doc.fillColor(valueColor).fontSize(9).font('Helvetica-Bold').text(value, R, y);
  doc.moveDown(0.25);
}

function priceRow(doc, label, value, bold = false, color = '#1e293b') {
  const L = doc.page.margins.left;
  const VX = doc.page.width - doc.page.margins.right - 130;
  const y = doc.y;
  doc.fillColor('#64748b').fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica').text(label, L, y, { width: VX - L - 8 });
  doc.fillColor(color).fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica').text(value, VX, y);
  doc.moveDown(0.25);
}

/* ══════════════════════════════════════════════════════════════
   ITINERARY PDF
══════════════════════════════════════════════════════════════ */
function generateItineraryPDF(booking) {
  return new Promise((resolve, reject) => {
    try {
      const b = (booking && typeof booking.toObject === 'function') ? booking.toObject() : (booking || {});
      const pb = priceBreakdown(b);
      const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `FLYO Itinerary – ${b.bookingRef||''}` } });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      /* ─ Header ─ */
      drawBrandHeader(doc, 'Flight Itinerary');

      /* ─ Booking reference box ─ */
      const bxY = doc.y;
      doc.rect(doc.page.margins.left, bxY, doc.page.width - 80, 42).fill('#f0f9ff').stroke('#bae6fd');
      doc.fillColor('#0369a1').fontSize(9).font('Helvetica').text('BOOKING REFERENCE', 52, bxY + 7, { characterSpacing: 1 });
      doc.fillColor('#07102a').fontSize(18).font('Helvetica-Bold').text(b.bookingRef || '—', 52, bxY + 18);
      doc.fillColor('#64748b').fontSize(8).font('Helvetica').text(`Booked: ${fmtDate(b.createdAt)}`, 340, bxY + 7);
      doc.fillColor('#64748b').fontSize(8).text(`Status: ${b.bookingStatus || '—'}`, 340, bxY + 20);
      doc.fillColor('#64748b').fontSize(8).text(`Payment: ${b.paymentStatus || '—'}`, 340, bxY + 33);
      doc.y = bxY + 54;

      /* ─ Contact ─ */
      sectionTitle(doc, 'Contact');
      twoCol(doc, 'Name',  b.contact?.name  || '—');
      twoCol(doc, 'Email', b.contact?.email || '—');
      twoCol(doc, 'Phone', b.contact?.phone || '—');

      /* ─ Flight details ─ */
      sectionTitle(doc, 'Flight Details');
      twoCol(doc, 'Flight ID',     b.flightId           || '—');
      twoCol(doc, 'Provider PNR',  b.providerBookingId  || '—');
      twoCol(doc, 'Airline',       b.airline            || '—');

      // Itinerary segments
      const segs = b.raw?.itineraries?.[0]?.segments || b.segments || [];
      if (segs.length) {
        doc.moveDown(0.3);
        doc.fillColor('#334155').fontSize(9).font('Helvetica-Bold').text('Segments');
        doc.moveDown(0.2);

        // Table header
        const colW = [60, 90, 90, 80, 60, 60];
        const colX = colW.reduce((acc, w, i) => { acc.push((acc[i-1]||doc.page.margins.left) + (i>0?colW[i-1]:0)); return acc; }, []);
        const thY = doc.y;
        doc.rect(doc.page.margins.left, thY, doc.page.width - 80, 16).fill('#e2e8f0');
        ['Flight', 'From', 'Departs', 'To', 'Arrives', 'Class'].forEach((h, i) => {
          doc.fillColor('#475569').fontSize(7.5).font('Helvetica-Bold').text(h, colX[i] + 2, thY + 4, { width: colW[i] - 4 });
        });
        doc.y = thY + 18;

        segs.forEach((s, si) => {
          const rowY = doc.y;
          if (si % 2 === 0) doc.rect(doc.page.margins.left, rowY, doc.page.width - 80, 18).fill('#f8fafc');
          const vals = [
            `${s.carrierCode||''}${s.number||''}`,
            `${s.departure?.iataCode||'—'} ${s.departure?.terminal ? 'T'+s.departure.terminal : ''}`,
            fmtDate(s.departure?.at),
            `${s.arrival?.iataCode||'—'}`,
            fmtDate(s.arrival?.at),
            s.cabin || s.class || '—',
          ];
          vals.forEach((v, i) => {
            doc.fillColor('#1e293b').fontSize(8).font('Helvetica').text(v, colX[i] + 2, rowY + 4, { width: colW[i] - 4 });
          });
          doc.y = rowY + 20;
        });
        doc.moveDown(0.4);
      } else {
        twoCol(doc, 'Travel date', b.travelDate || '—');
      }

      /* ─ Passengers ─ */
      sectionTitle(doc, `Passengers (${(b.passengers||[]).length})`);
      const paxSeats = b.seats || [];

      const phY = doc.y;
      doc.rect(doc.page.margins.left, phY, doc.page.width - 80, 16).fill('#e2e8f0');
      ['#', 'Name', 'Type', 'Seat', 'DOB', 'Doc'].forEach((h, i) => {
        const xs = [40, 60, 200, 270, 340, 440];
        doc.fillColor('#475569').fontSize(7.5).font('Helvetica-Bold').text(h, xs[i], phY + 4);
      });
      doc.y = phY + 18;

      (b.passengers || []).forEach((p, pi) => {
        const rowY = doc.y;
        if (pi % 2 === 0) doc.rect(doc.page.margins.left, rowY, doc.page.width - 80, 18).fill('#f8fafc');
        const name = [p.title, p.firstName, p.lastName].filter(Boolean).join(' ') || p.name || `Passenger ${pi+1}`;
        const seatRaw = paxSeats[pi];
        const seat = typeof seatRaw === 'string' ? seatRaw : seatRaw?.seatId || seatRaw?.label || seatRaw?.seat || '—';
        const vals = [String(pi+1), name, p.type||'ADT', seat, p.dob?new Date(p.dob).toLocaleDateString('en-IN'):'—', p.documentNumber||'—'];
        [40, 60, 200, 270, 340, 440].forEach((x, i) => {
          doc.fillColor('#1e293b').fontSize(8).font('Helvetica').text(vals[i], x, rowY + 4, { width: i===1?138:80 });
        });
        doc.y = rowY + 20;
      });

      /* ─ Price breakdown ─ */
      sectionTitle(doc, 'Price Breakdown');
      priceRow(doc, 'Seat fares',           fmt(pb.seatFares, pb.currency));
      if (pb.addons > 0) priceRow(doc, 'Add-ons', fmt(pb.addons, pb.currency));
      if (pb.discounts > 0) priceRow(doc, 'Discounts & coupons', `-${fmt(pb.discounts, pb.currency)}`, false, '#16a34a');
      priceRow(doc, 'Taxes & fees',         fmt(pb.tax, pb.currency));
      hRule(doc, '#cbd5e1');
      priceRow(doc, 'Total paid',           fmt(pb.total, pb.currency), true, '#0369a1');

      /* ─ Footer ─ */
      doc.moveDown(1.5);
      hRule(doc, '#e2e8f0');
      doc.fillColor('#94a3b8').fontSize(8).font('Helvetica')
        .text(`Generated: ${new Date().toLocaleString('en-IN')}   ·   FLYO · flyo.in · support@flyo.com`, { align:'center' });

      doc.end();
    } catch (err) { reject(err); }
  });
}

/* ══════════════════════════════════════════════════════════════
   CANCELLATION / REFUND INVOICE PDF
══════════════════════════════════════════════════════════════ */
function generateCancellationInvoicePDF(booking) {
  return new Promise((resolve, reject) => {
    try {
      const b = (booking && typeof booking.toObject === 'function') ? booking.toObject() : (booking || {});
      const pb = priceBreakdown(b);
      const currency = b.price?.currency || 'INR';

      const cancellationFee = Number(b.cancellationFeeMajor || 0);
      const refundAmount    = Math.max(0, pb.total - cancellationFee);

      const refund       = b.refund || b.refundInfo || b.refundResult || null;
      const refundId     = refund?.id || '—';
      const refundStatus = refund?.status || 'initiated';
      const cancelledAt  = b.cancelledAt ? fmtDate(b.cancelledAt) : fmtDate(new Date());

      const doc = new PDFDocument({ size:'A4', margin:40, info:{ Title:`FLYO Cancellation – ${b.bookingRef||''}` } });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      /* ─ Header ─ */
      drawBrandHeader(doc, 'Cancellation Invoice');

      /* ─ Status banner ─ */
      const bxY = doc.y;
      doc.rect(doc.page.margins.left, bxY, doc.page.width - 80, 42).fill('#fff7f7').stroke('#fecaca');
      doc.fillColor('#b91c1c').fontSize(9).font('Helvetica-Bold').text('BOOKING CANCELLED', 52, bxY + 7, { characterSpacing: 1 });
      doc.fillColor('#07102a').fontSize(18).font('Helvetica-Bold').text(b.bookingRef || '—', 52, bxY + 18);
      doc.fillColor('#64748b').fontSize(8).font('Helvetica').text(`Cancelled: ${cancelledAt}`, 340, bxY + 12);
      doc.fillColor('#64748b').fontSize(8).text(`Refund status: ${refundStatus}`, 340, bxY + 26);
      doc.y = bxY + 54;

      /* ─ Customer ─ */
      sectionTitle(doc, 'Customer');
      twoCol(doc, 'Name',  b.contact?.name  || '—');
      twoCol(doc, 'Email', b.contact?.email || '—');
      twoCol(doc, 'Phone', b.contact?.phone || '—');

      /* ─ Booking summary ─ */
      sectionTitle(doc, 'Booking Summary');
      twoCol(doc, 'Flight ID',    b.flightId          || '—');
      twoCol(doc, 'Provider PNR', b.providerBookingId || '—');
      const seats = (b.seats||[]).map(s => typeof s==='string'?s:(s?.seatId||s?.label||s?.seat||'?')).join(', ') || '—';
      twoCol(doc, 'Seats', seats);
      twoCol(doc, 'Passengers', String((b.passengers||[]).length));

      /* ─ Amount details ─ */
      sectionTitle(doc, 'Amount Details');
      priceRow(doc, 'Original seat fares', fmt(pb.seatFares, currency));
      if (pb.addons > 0)     priceRow(doc, 'Add-ons',     fmt(pb.addons, currency));
      if (pb.discounts > 0)  priceRow(doc, 'Discounts',   `-${fmt(pb.discounts, currency)}`, false, '#16a34a');
      priceRow(doc, 'Taxes & fees',        fmt(pb.tax, currency));
      hRule(doc, '#cbd5e1');
      priceRow(doc, 'Total paid',          fmt(pb.total, currency), true);
      doc.moveDown(0.3);
      priceRow(doc, 'Cancellation fee',    fmt(cancellationFee, currency), false, '#b91c1c');
      hRule(doc, '#cbd5e1');
      priceRow(doc, 'Net refund amount',   fmt(refundAmount, currency), true, '#0369a1');

      /* ─ Refund details ─ */
      sectionTitle(doc, 'Refund Details');
      twoCol(doc, 'Refund ID',      refundId);
      twoCol(doc, 'Status',         refundStatus.charAt(0).toUpperCase() + refundStatus.slice(1));
      twoCol(doc, 'Method',         'Original payment method (Stripe)');
      twoCol(doc, 'Amount',         fmt(refundAmount, currency), '#64748b', '#0369a1');
      twoCol(doc, 'Expected credit', '5–7 business days');

      /* ─ Important note ─ */
      doc.moveDown(0.6);
      const noteY = doc.y;
      doc.rect(doc.page.margins.left, noteY, doc.page.width - 80, 36).fill('#fffbeb').stroke('#fde68a');
      doc.fillColor('#92400e').fontSize(8).font('Helvetica-Bold').text('Note:', 52, noteY + 6);
      doc.fillColor('#78350f').fontSize(8).font('Helvetica').text(
        'Refund processing time depends on your bank. If you do not receive the refund within 7 business days, contact support@flyo.com with your booking reference.',
        52, noteY + 17, { width: doc.page.width - 100 }
      );
      doc.y = noteY + 46;

      /* ─ Footer ─ */
      doc.moveDown(1);
      hRule(doc, '#e2e8f0');
      doc.fillColor('#94a3b8').fontSize(8).font('Helvetica')
        .text(`Generated: ${new Date().toLocaleString('en-IN')}   ·   FLYO · flyo.in · support@flyo.com`, { align:'center' });

      doc.end();
    } catch (err) { reject(err); }
  });
}

module.exports = { generateItineraryPDF, generateCancellationInvoicePDF };
