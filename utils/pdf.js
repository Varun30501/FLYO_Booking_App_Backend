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
  // Seats subtotal = final seat prices (already discounted)
  // AUTHORITATIVE JOURNEY SEAT FARE
  // Seat fares = total paid - taxes - addons + discounts
  const totalPaid = Number(booking?.price?.amount || 0);
  const taxMajor =
    typeof booking?.price?.tax === 'number'
      ? Number(booking.price.tax)
      : typeof booking?.price?.taxes === 'number'
        ? Number(booking.price.taxes)
        : 0;

  const addonsArr = Array.isArray(booking.addons) ? booking.addons : [];
  const addonsTotal = addonsArr.reduce(
    (acc, a) => acc + (Number(a.amount || 0) * (Number(a.qty || 1) || 1)),
    0
  );

  let discountsTotal = 0;
  if (Array.isArray(booking.discounts))
    discountsTotal += booking.discounts.reduce(
      (acc, d) => acc + Math.abs(Number(d.amount || 0)),
      0
    );
  if (Array.isArray(booking.coupons))
    discountsTotal += booking.coupons.reduce(
      (acc, c) => acc + Math.abs(Number(c.amount || 0)),
      0
    );

  // 🔐 THIS is the correct seat fare
  const seatsSubtotal =
    totalPaid - taxMajor - addonsTotal + discountsTotal;



  // Base/class split is no longer reliable post SeatMap v3
  const baseSubtotal = seatsSubtotal;
  const classExtras = 0;


  // // addons
  // const addonsArr = Array.isArray(booking.addons) ? booking.addons : [];
  // const addonsTotal = addonsArr.reduce((acc, a) => acc + (Number(a.amount || 0) * (Number(a.qty || 1) || 1)), 0);

  // // discounts - combine explicit discounts + coupons
  // let discountsTotal = 0;
  // if (Array.isArray(booking.discounts)) discountsTotal += booking.discounts.reduce((acc, d) => acc + Math.abs(Number(d.amount || 0)), 0);
  // if (Array.isArray(booking.coupons)) discountsTotal += booking.coupons.reduce((acc, c) => acc + Math.abs(Number(c.amount || 0)), 0);
  // if (!discountsTotal && booking.price && Number.isFinite(Number(booking.price.discount))) discountsTotal += Math.abs(Number(booking.price.discount || 0));

  // // tax detection
  // let taxMajor = 0;
  // if (booking.price && typeof booking.price.tax === 'number') taxMajor = Number(booking.price.tax);
  // else if (booking.price && typeof booking.price.taxes === 'number') taxMajor = Number(booking.price.taxes);
  // else if (booking.price && typeof booking.price.amount === 'number') {
  //   if (seatsSubtotal + addonsTotal - discountsTotal > 0) {
  //     const inferred = Number(booking.price.amount) - (seatsSubtotal + addonsTotal - discountsTotal);
  //     if (Number.isFinite(inferred) && inferred >= 0) taxMajor = Math.round(inferred);
  //   }
  // }

  const totalMajor = (booking.price && typeof booking.price.amount === 'number') ? Math.round(booking.price.amount) : Math.round(baseSubtotal + classExtras + addonsTotal - discountsTotal + taxMajor);

  return {
    seatFares: Math.round(seatsSubtotal || 0),
    tax: Math.round(taxMajor || 0),
    addonsTotal: Math.round(addonsTotal || 0),
    discountsTotal: Math.round(discountsTotal || 0),
    total: Math.round(totalPaid || 0),
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

      doc.text('Seat fares (journey):', labelColX, doc.y, { continued: true });
      doc.text(
        formatMoneyMajor(pb.seatFares, pb.currency),
        valueColX,
        doc.y
      );
      doc.moveDown(0.2);

      doc.moveDown(0.3);


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

          // SeatMap v3: price is already final
          const base = priceMaj;
          const extra = 0;


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
 * generateCancellationInvoicePDF(booking)
 * User-friendly cancellation / refund invoice (NO raw JSON)
 */
function generateCancellationInvoicePDF(booking) {
  return new Promise((resolve, reject) => {
    try {
      const b =
        booking && typeof booking.toObject === "function"
          ? booking.toObject()
          : booking || {};

      const currency = b.price?.currency || "INR";
      const pb = computePriceBreakdown(b);

      const totalPaid = pb.total || 0;
      const cancellationFee = Number(b.cancellationFeeMajor || 0);
      const refundAmount = Math.max(0, totalPaid - cancellationFee);

      // try to extract a Stripe-like refund object (if present)
      const refund =
        b.refund ||
        b.refundInfo ||
        b.refundResult ||
        b.rawRefund ||
        null;

      const refundId = refund?.id || "—";
      const refundStatus = refund?.status || "initiated";
      const refundCreated =
        refund?.created
          ? new Date(refund.created * 1000)
          : b.cancelledAt
            ? new Date(b.cancelledAt)
            : new Date();

      const doc = new PDFDocument({ size: "A4", margin: 40 });
      const chunks = [];

      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));

      /* ---------- HEADER ---------- */
      doc.fontSize(18).font("Helvetica-Bold").text("Cancellation Invoice", {
        align: "center",
      });
      doc.moveDown(0.6);

      doc.fontSize(10).font("Helvetica");
      doc.text(`Booking Reference: ${b.bookingRef || "—"}`);
      doc.text(`Cancelled On: ${refundCreated.toLocaleString()}`);
      doc.moveDown(1);

      /* ---------- CUSTOMER ---------- */
      doc.fontSize(12).font("Helvetica-Bold").text("Customer");
      doc.moveDown(0.2);
      doc.fontSize(10).font("Helvetica");
      doc.text(`Name: ${b.contact?.name || "—"}`);
      doc.text(`Email: ${b.contact?.email || "—"}`);
      doc.moveDown(0.8);

      /* ---------- BOOKING SUMMARY ---------- */
      doc.fontSize(12).font("Helvetica-Bold").text("Booking Summary");
      doc.moveDown(0.2);
      doc.fontSize(10).font("Helvetica");
      doc.text(`Flight ID: ${b.flightId || "—"}`);
      doc.text(
        `Passengers: ${Array.isArray(b.passengers) ? b.passengers.length : 0
        }`
      );
      const seats =
        Array.isArray(b.seats) && b.seats.length
          ? b.seats
            .map((s) =>
              typeof s === "string"
                ? s
                : s.seatId || s.label || s.seat
            )
            .join(", ")
          : "—";
      doc.text(`Seats: ${seats}`);
      doc.moveDown(0.8);

      /* ---------- AMOUNT DETAILS ---------- */
      doc.fontSize(12).font("Helvetica-Bold").text("Amount Details");
      doc.moveDown(0.3);
      doc.fontSize(10).font("Helvetica");

      const labelX = doc.x;
      const valueX = doc.page.width - doc.page.margins.right - 160;

      doc.text("Total paid:", labelX, doc.y, { continued: true });
      doc.text(formatMoneyMajor(totalPaid, currency), valueX, doc.y);
      doc.moveDown(0.2);

      doc.text("Cancellation fee:", labelX, doc.y, { continued: true });
      doc.text(
        formatMoneyMajor(cancellationFee, currency),
        valueX,
        doc.y
      );
      doc.moveDown(0.2);

      doc.font("Helvetica-Bold")
        .text("Refund amount:", labelX, doc.y, { continued: true });
      doc.text(
        formatMoneyMajor(refundAmount, currency),
        valueX,
        doc.y
      );
      doc.font("Helvetica");
      doc.moveDown(0.8);

      /* ---------- REFUND DETAILS ---------- */
      doc.fontSize(12).font("Helvetica-Bold").text("Refund Details");
      doc.moveDown(0.3);
      doc.fontSize(10).font("Helvetica");

      doc.text(`Refund ID: ${refundId}`);
      doc.text(`Refund Status: ${refundStatus}`);
      doc.text("Refund Method: Original payment method");
      doc.text("Expected Credit: 5–7 business days");

      doc.moveDown(1.2);

      /* ---------- FOOTER ---------- */
      doc.fontSize(9)
        .fillColor("gray")
        .text(
          "If you have any questions regarding this refund, please contact support@example.com",
          { align: "center" }
        );
      doc.moveDown(0.4);
      doc.text(`Generated: ${new Date().toLocaleString()}`, {
        align: "center",
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}


module.exports = { generateItineraryPDF, generateCancellationInvoicePDF };
