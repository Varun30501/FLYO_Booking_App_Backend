// backend/utils/emailer.js
const sgMail = require('@sendgrid/mail');
const path = require('path');
const fs = require('fs');

const { generateItineraryPDF } = require('./pdf'); // keep pdf helper separate

const SENDGRID_KEY = process.env.SENDGRID_API_KEY || '';
const SENDER = process.env.EMAIL_FROM || 'no-reply@example.com';
const SENDER_NAME = process.env.EMAIL_FROM_NAME || 'FlightApp';

if (SENDGRID_KEY) {
  sgMail.setApiKey(SENDGRID_KEY);
} else {
  console.warn('[emailer] SENDGRID_API_KEY not set - emails will be logged (dev mode)');
}

/** Utility - format major-unit amount (e.g. 11542 -> "₹ 11,542.00") */
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

// Defensive date formatter (prevents resend-confirmation crashes)
function safeDate(value) {
  try {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString();
  } catch (e) {
    return '—';
  }
}
/** Normalize attachments for SendGrid */
function normalizeAttachments(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(a => {
    let content = a.content;
    try {
      if (Buffer.isBuffer(content)) content = content.toString('base64');
      else if (typeof content === 'object' && content !== null && Array.isArray(content.data)) content = Buffer.from(content.data).toString('base64');
      else if (typeof content === 'string' && fs.existsSync(content)) content = fs.readFileSync(content).toString('base64');
    } catch (e) {
      console.warn('[emailer] normalizeAttachments error', e && e.message);
    }
    return {
      content: content || '',
      filename: a.filename || 'attachment.bin',
      type: a.type || 'application/octet-stream',
      disposition: 'attachment'
    };
  });
}

/**
 * sendMail({ to, subject = '', html = '', text = '', bcc, attachments })
 */
/**
 * sendMail({ to, subject = '', html = '', text = '', bcc, attachments, reply_to })
 */
async function sendMail({ to, subject = '', html = '', text = '', bcc, attachments, reply_to } = {}) {
  if (!to && !process.env.TO_RECIPIENT) throw new Error('to is required (or set TO_RECIPIENT env)');
  if (!html && !text) text = subject || 'Message';

  // Respect a forced override only when explicitly requested via env
  const forceRecipient = String(process.env.TO_RECIPIENT_FORCE || '').toLowerCase() === 'true';
  let finalTo = forceRecipient ? (process.env.TO_RECIPIENT || to) : (to || process.env.TO_RECIPIENT);

  // Accept array or string for `to`
  if (Array.isArray(finalTo)) {
    finalTo = finalTo.map(t => (typeof t === 'string' ? t : (t.email || t.address || ''))).filter(Boolean);
  } else if (typeof finalTo === 'object' && finalTo !== null) {
    // maybe { email, name } object
    finalTo = finalTo.email || finalTo.address || String(finalTo) || null;
  }

  if (!finalTo) throw new Error('final recipient (to) not resolved');

  const msg = {
    to: finalTo,
    from: { email: SENDER, name: SENDER_NAME },
    subject,
    html: html || undefined,
    text: text || undefined
  };

  if (bcc) msg.bcc = bcc;

  // SendGrid expects `replyTo` (camelCase), not reply_to
  if (reply_to) msg.replyTo = reply_to;

  if (Array.isArray(attachments) && attachments.length) {
    msg.attachments = normalizeAttachments(attachments);
  }

  // DEV: If no API key configured, keep the previous dev preview behavior
  if (!SENDGRID_KEY) {
    try {
      if (msg.attachments && msg.attachments.length) {
        const tmp = '/tmp/flight-email-attachments';
        if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });
        msg.attachments.forEach((att, idx) => {
          try {
            const outPath = path.join(tmp, `${Date.now()}-${idx}-${att.filename}`);
            fs.writeFileSync(outPath, Buffer.from(att.content, 'base64'));
          } catch (e) {
            console.warn('[emailer] preview write failed for attachment', att.filename, e && e.message);
          }
        });
      }
    } catch (e) {
      console.warn('[emailer] preview write failed', e && e.message);
    }
    // console.log('[emailer] SKIP send (dev). preview payload:', {
    //   to: msg.to,
    //   bcc: msg.bcc,
    //   subject,
    //   text: (text || '').slice(0, 800),
    //   html: html ? (html || '').slice(0, 800) : null,
    //   attachments: msg.attachments ? msg.attachments.map(a => a.filename) : [],
    //   replyTo: msg.replyTo
    // });
    return { success: true, preview: true, payloadPreview: msg };
  }

  // Live send: log the outgoing message (safe fields) before sending
  // console.log('[emailer] Sending email (SendGrid). to:', msg.to, 'subject:', subject, 'replyTo:', msg.replyTo || null);

  try {
    // sgMail.send accepts single message object; returns an array of responses
    const res = await sgMail.send(msg);
    const status = Array.isArray(res) && res[0] && res[0].statusCode ? res[0].statusCode : null;
    // console.log('[emailer] SendGrid OK', status, 'to:', msg.to, 'bcc:', msg.bcc);
    return { success: true, status, sgResponse: res };
  } catch (err) {
    // Try to extract sendgrid response body for better debugging
    const extra = err?.response?.body ? err.response.body : err.message || err;
    console.error('[emailer] SendGrid error:', extra);
    // rethrow so callers (sendBookingConfirmation) can handle fallback logic
    throw err;
  }
}


/**
 * Compose email body with price breakdown using seatsMeta and booking.price
 * Supports addons, discounts, coupons arrays and single discount fields.
 */
function composeBookingEmail(b) {
  const bookingRef = b.bookingRef || '—';
  const flightId = b.flightId || '—';
  const passengerCount = Array.isArray(b.passengers) ? b.passengers.length : (b.passengerCount || 0);
  const booking = b; // alias for clarity

  // Build passengers with seats: try to pair passenger index -> seat label
  const passengerLines = (Array.isArray(b.passengers) ? b.passengers : []).map((p, idx) => {
    const nameParts = [p.title, p.firstName, p.lastName].filter(Boolean).join(' ').trim() || (p.name || `Passenger ${idx + 1}`);
    let seat = '-';
    try {
      if (Array.isArray(b.seats) && b.seats[idx]) {
        const s = b.seats[idx];
        seat = (typeof s === 'string' || typeof s === 'number') ? String(s) : (s.label || s.seatId || s.seat || JSON.stringify(s));
      } else if (p.seat) seat = p.seat;
    } catch (e) { seat = '-'; }
    return { name: nameParts, seat: String(seat || '-') };
  });

  // fallback seat list
  let seatList = '-';
  if (passengerLines.length) seatList = passengerLines.map(x => `${x.seat}`).join(', ');
  else if (Array.isArray(b.seats) && b.seats.length) seatList = b.seats.map(s => (s && (s.label || s.seatId)) ? (s.label || s.seatId) : s).join(', ');
  else if (Array.isArray(b.seatsMeta) && b.seatsMeta.length) seatList = b.seatsMeta.map(s => s.seatId || s.seat || '').join(', ');

  // pricing: compute using seatsMeta (preferred)
  const currency = (b.price && b.price.currency) || 'INR';

  const seatsMeta = Array.isArray(b.seatsMeta) ? b.seatsMeta : [];

  // seatsSubtotal = sum(seat.price)
  const seatsSubtotal = seatsMeta.reduce((acc, s) => acc + (Number(s.price || 0)), 0);

  // classExtras = sum(seat.priceModifier)
  const classExtras = seatsMeta.reduce((acc, s) => acc + (Number(s.priceModifier || 0)), 0);

  // baseSubtotal = seatsSubtotal - classExtras
  const baseSubtotal = seatsSubtotal - classExtras;

  // ADDONS support: b.addons array or b.addonsTotal
  let addonsTotal = 0;
  let addonsList = [];
  if (Array.isArray(b.addons) && b.addons.length) {
    b.addons.forEach(a => {
      const name = a.name || a.key || a.label || 'addon';
      const amt = Number(a.amount ?? a.price ?? a.value ?? 0) || 0;
      const qty = Number(a.qty ?? a.Qty ?? a.quantity ?? 1) || 1;
      const line = Math.round(amt * qty);
      addonsTotal += line;
      addonsList.push({ name, amount: line, qty });
    });
  } else if (b.price && Number.isFinite(Number(b.price.addonsTotal))) {
    addonsTotal = Math.round(Number(b.price.addonsTotal));
  } else if (b.addonsTotal && Number.isFinite(Number(b.addonsTotal))) {
    addonsTotal = Math.round(Number(b.addonsTotal));
  }

  // DISCOUNTS / COUPONS support
  let discountsTotal = 0;
  const couponsApplied = [];

  if (Array.isArray(b.discounts) && b.discounts.length) {
    b.discounts.forEach(d => {
      const name = d.name || d.reason || "discount";
      const amt = Math.abs(Number(d.amount || 0));
      discountsTotal += amt;
      couponsApplied.push({ type: "discount", name, code: null, amount: Math.round(amt), percent: 0, reason: d.reason || "", metadata: d.metadata || {} });
    });
  }

  if (Array.isArray(b.coupons) && b.coupons.length) {
    b.coupons.forEach(c => {
      const code = c.code || c.coupon || "COUPON";
      const amt = Math.abs(Number(c.amount || c.discount || 0));
      const pct = Number(c.percent || 0);
      const reason = c.reason || c.metadata?.note || '';
      const meta = c.metadata || {};
      discountsTotal += amt;
      couponsApplied.push({ type: "coupon", name: code, code, percent: pct, amount: Math.round(amt), reason, metadata: meta, cap: c.cap || 0, validated: c.validated || false });
    });
  }

  // single fallback discount fields
  if (!discountsTotal && b.price && (Number.isFinite(Number(b.price.discount)) || Number.isFinite(Number(b.discount)))) {
    const single = Number(b.price.discount ?? b.discount ?? 0) || 0;
    discountsTotal += Math.abs(single);
    if (single) couponsApplied.push({ type: "discount", name: "discount", code: null, amount: Math.round(Math.abs(single)), percent: 0, reason: "", metadata: {} });
  }

  // Tax: prefer booking.price.tax or booking.price.taxes else fallback to b.price.tax (0)
  let taxMajor = 0;
  if (b.price && typeof b.price.tax === 'number') taxMajor = Number(b.price.tax);
  else if (b.price && typeof b.price.taxes === 'number') taxMajor = Number(b.price.taxes);
  else if (typeof b.price === 'object' && (b.price.tax || b.price.taxes)) taxMajor = Number(b.price.tax || b.price.taxes || 0);

  // If tax not present but booking.price.amount present, derive tax as difference if seatsSubtotal+addons-discounts exists
  let totalMajor = Number.isFinite(Number(b.price && b.price.amount)) ? Number(b.price.amount) : null;
  if ((taxMajor === 0 || !Number.isFinite(taxMajor)) && totalMajor !== null && (seatsSubtotal + addonsTotal - discountsTotal) > 0) {
    const calcTax = totalMajor - (seatsSubtotal + addonsTotal - discountsTotal);
    if (Number.isFinite(calcTax) && calcTax >= 0) taxMajor = Math.round(calcTax);
  }

  // final totals fallback
  const subtotal = Math.round(baseSubtotal || 0);
  const classPrice = Math.round(classExtras || 0);
  const addons = Math.round(addonsTotal || 0);
  const discounts = Math.round(discountsTotal || 0);
  const tax = Math.round(taxMajor || 0);
  const total = (totalMajor !== null && Number.isFinite(totalMajor)) ? Math.round(totalMajor) : Math.round(subtotal + classPrice + addons - discounts + tax);

  // build plain text
  const lines = [];
  lines.push(`Your booking ${bookingRef} is confirmed.`);
  lines.push('');
  lines.push(`Flight ID: ${flightId}`);
  lines.push(`Passengers: ${passengerCount}`);
  lines.push('');
  lines.push('Passenger details:');
  passengerLines.forEach(pl => lines.push(` - ${pl.name} — Seat: ${pl.seat}`));
  lines.push('');
  lines.push(`Seats: ${seatList}`);
  lines.push('');
  lines.push(`Base price: ${formatMoneyMajor(subtotal, currency)}`);
  lines.push(`Class / seat extras: ${formatMoneyMajor(classPrice, currency)}`);
  if (addons > 0) {
    lines.push(`Add-ons: ${formatMoneyMajor(addons, currency)}`);
    (addonsList || []).forEach(a => lines.push(`   • ${a.name} x${a.qty}: ${formatMoneyMajor(a.amount, currency)}`));
  }
  if (discounts > 0) {
    lines.push(`Discounts / coupons: -${formatMoneyMajor(discounts, currency)}`);
    (couponsApplied || []).forEach(c => {
      if (c.type === 'coupon') {
        lines.push(`   • Coupon ${c.code}: -${formatMoneyMajor(c.amount, currency)}${c.cap ? ` (cap ${formatMoneyMajor(c.cap, currency)})` : ''}${c.reason ? ` — ${c.reason}` : ''}`);
        if (c.metadata && Object.keys(c.metadata).length) {
          lines.push(`      metadata: ${JSON.stringify(c.metadata)}`);
        }
      } else {
        lines.push(`   • ${c.name}: -${formatMoneyMajor(c.amount, currency)}`);
      }
    });
  }
  lines.push(`Taxes & fees: ${formatMoneyMajor(tax, currency)}`);
  lines.push('');
  lines.push(`Total Paid: ${formatMoneyMajor(total, currency)}`);
  lines.push('');
  lines.push('Thank you for booking with us!');
  lines.push('----------------------------------------------');
  lines.push(`BookingRef: ${bookingRef}`);
  lines.push(`Passenger Count: ${passengerCount}`);
  lines.push(`Seats: ${seatList}`);
  lines.push(`Price object: ${JSON.stringify(b.price || {})}`);
  lines.push('----------------------------------------------');

  const text = lines.join('\n');

  // Compose HTML (readable)
  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; color: #111;">
      <h2>Booking Confirmed — ${bookingRef}</h2>
      <p>Your booking <strong>${bookingRef}</strong> is confirmed.</p>

//       <h3>Flight details</h3>
// <p>
//   <strong>Flight:</strong> ${b.airline || 'Flight'} ${b.flightNumber || b.flightId || '—'}<br/>
//  <strong>Route:</strong> ${b.origin || '—'} → ${b.destination || '—'}<br/>
//   <strong>Departure:</strong> ${safeDate(b.departureAt)}<br/>
//   <strong>Arrival:</strong> ${safeDate(b.arrivalAt)}
// </p>

// <h3>Fare breakup</h3>
// <ul>
//   <li>Base fare: ₹${b.price?.base}</li>
//   <li>Seats & class: ₹${b.price?.seatTotal}</li>
//   <li>Add-ons: ₹${b.price?.addonsTotal}</li>
//   <li>Discounts: -₹${b.price?.discountsTotal}</li>
//   <li>Taxes: ₹${b.price?.taxes}</li>
// </ul>

// <p><strong>Total paid: ₹${b.price?.amount}</strong></p>


      <h3>Flight & Passenger details</h3>
      <p><strong>Flight ID:</strong> ${flightId}<br/>
         <strong>Passengers:</strong> ${passengerCount}</p>

      <table style="width:100%; border-collapse:collapse; margin-bottom:12px;">
        <thead>
          <tr>
            <th style="text-align:left; padding:6px; border-bottom:1px solid #eee;">Passenger</th>
            <th style="text-align:left; padding:6px; border-bottom:1px solid #eee;">Seat</th>
          </tr>
        </thead>
        <tbody>
          ${passengerLines.map(pl => `<tr><td style="padding:6px;">${pl.name}</td><td style="padding:6px;">${pl.seat}</td></tr>`).join('')}
        </tbody>
      </table>

      <h3 style="margin-top:8px;">Price breakdown</h3>
      <table style="width:100%; border-collapse:collapse;">
        <tbody>
          <tr><td style="padding:6px;">Base price</td><td style="padding:6px; text-align:right;">${formatMoneyMajor(subtotal, currency)}</td></tr>
          <tr><td style="padding:6px;">Class / seat extras</td><td style="padding:6px; text-align:right;">${formatMoneyMajor(classPrice, currency)}</td></tr>
          <tr><td style="padding:6px;">Seats subtotal (base + class)</td><td style="padding:6px; text-align:right;">${formatMoneyMajor(seatsSubtotal, currency)}</td></tr>
          ${addons > 0 ? `<tr><td style="padding:6px;">Add-ons</td><td style="padding:6px; text-align:right;">${formatMoneyMajor(addons, currency)}</td></tr>
            ${addonsList.map(a => `<tr><td style="padding:6px; padding-left:18px;">• ${a.name} x${a.qty}</td><td style="padding:6px; text-align:right;">${formatMoneyMajor(a.amount, currency)}</td></tr>`).join('')}` : ''}

          ${discounts > 0 ? `
            <tr><td style="padding:6px;">Discounts & Coupons</td>
            <td style="padding:6px; text-align:right;">-${formatMoneyMajor(discounts, currency)}</td></tr>

          ${couponsApplied.map(c => `
            <tr>
              <td style="padding:6px; padding-left:18px;">
                ${c.type === "coupon" ? `Coupon <strong>${c.code}</strong>` : c.name}
                ${c.percent ? ` (${c.percent}% off)` : ""}
                ${c.cap ? ` (cap ${formatMoneyMajor(c.cap, currency)})` : ""}
                ${c.reason ? `<div style="color:#777; font-size:12px;">${c.reason}</div>` : ""}
                ${c.metadata && Object.keys(c.metadata).length
      ? `<div style="font-size:11px;color:#888;margin-top:4px;">${Object.entries(c.metadata)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")}</div>`
      : ""}
              </td>
              <td style="padding:6px; text-align:right;">-${formatMoneyMajor(c.amount, currency)}</td>
            </tr>
          `).join('')}
          ` : ''}

          <tr><td style="padding:6px;">Taxes & fees</td><td style="padding:6px; text-align:right;">${formatMoneyMajor(tax, currency)}</td></tr>
          <tr><td style="padding:6px; border-top:1px solid #eee;"><strong>Total Paid</strong></td><td style="padding:6px; text-align:right; border-top:1px solid #eee;"><strong>${formatMoneyMajor(total, currency)}</strong></td></tr>
        </tbody>
      </table>

      <p style="margin-top:12px;">Seats: ${seatList}</p>

      <hr/>
      <p style="font-size:12px;color:#666;">BookingRef: ${bookingRef} • Passenger Count: ${passengerCount}</p>
    </div>
  `;

  // debug info includes coupon breakdown for frontend if desired
  const debug = { subtotal, classPrice, seatsSubtotal, addons, discounts, tax, total, coupons: couponsApplied };

  return { subject: `Booking Confirmed — ${bookingRef}`, text, html, attachments: [], debug };
}

/**
 * sendBookingConfirmation(booking, options)
 */
async function sendBookingConfirmation(booking, options = {}) {
  if (!booking) throw new Error('booking required');

  const b = (booking.toObject && typeof booking.toObject === 'function') ? booking.toObject() : booking;
  const to = options.to || (b.contact && (b.contact.email || b.contact.emailAddress)) || null;

  // generate PDF (best-effort)
  let pdfBuffer = null;
  try {
    if (typeof generateItineraryPDF === 'function') {
      pdfBuffer = await generateItineraryPDF(b);
      if (!Buffer.isBuffer(pdfBuffer)) {
        if (pdfBuffer && pdfBuffer.data && Buffer.isBuffer(pdfBuffer.data)) pdfBuffer = pdfBuffer.data;
        else {
          console.error('[emailer] generateItineraryPDF did not return a Buffer (continuing without PDF)');
          pdfBuffer = null;
        }
      }
    }
  } catch (err) {
    console.error('[emailer] generateItineraryPDF error', err && (err.message || err));
    pdfBuffer = null;
  }

  const composed = composeBookingEmail(b);
  const subject = options.subject || composed.subject;
  const text = options.text || composed.text;
  const html = options.html || composed.html;

  const attachments = [];
  if (pdfBuffer) attachments.push({ filename: `${(b.bookingRef || 'itinerary')}.pdf`, content: pdfBuffer, type: 'application/pdf' });

  // Always log full preview to console (helps when mailbox down)
  // console.log('================ EMAIL PREVIEW ================');
  // console.log('To:        ', to || '(none)');
  // console.log('Subject:   ', subject);
  // console.log('Message:\n', text);
  // if (attachments.length) {
  //   console.log('PDF Attachment: (will attach, size bytes):', attachments[0].content ? (Buffer.isBuffer(attachments[0].content) ? attachments[0].content.length : '(unknown)') : '(none)');
  //   if (attachments[0].content && Buffer.isBuffer(attachments[0].content)) {
  //     console.log('PDF base64 preview:', attachments[0].content.toString('base64').slice(0, 200));
  //   }
  // } else {
  //   console.log('PDF Attachment: (none)');
  // }
  // console.log('===============================================');

  // if (!to) {
  //   // persist pdf preview for dev if present
  //   if (pdfBuffer) {
  //     try {
  //       const tmp = '/tmp/flight-email-attachments';
  //       if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });
  //       const outPath = path.join(tmp, `${Date.now()}-${b.bookingRef || 'itinerary'}.pdf`);
  //       fs.writeFileSync(outPath, pdfBuffer);
  //       console.log(`[emailer] wrote itinerary preview to ${outPath}`);
  //     } catch (e) {
  //       console.warn('[emailer] failed writing itinerary preview', e && e.message);
  //     }
  //     return { success: true, preview: true, previewBase64: pdfBuffer.toString('base64').slice(0, 200) + '...' };
  //   }
  //   return { success: false, message: 'no recipient email', preview: true };
  // }

  try {
    const mailResult = await sendMail({ to, subject, text, html, attachments, reply_to: options.reply_to || SENDER });
    return { success: true, mailResult, debug: composed.debug || null };
  } catch (err) {
    console.error('[emailer] sendBookingConfirmation failed', err && (err.message || err));
    if (pdfBuffer) {
      try {
        const tmp = '/tmp/flight-email-attachments';
        if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });
        const outPath = path.join(tmp, `${Date.now()}-failed-${b.bookingRef || 'itinerary'}.pdf`);
        fs.writeFileSync(outPath, pdfBuffer);
        console.log(`[emailer] wrote failed-send itinerary to ${outPath}`);
      } catch (e) {
        console.warn('[emailer] failed writing fallback pdf', e && e.message);
      }
    }
    throw err;
  }
}

async function sendPaymentLink({
  to,
  bookingRef,
  paymentUrl,
  amount,
  currency = 'INR'
}) {
  const subject = `Complete your payment – Booking ${bookingRef}`;

  const html = `
    <h2>Payment Pending</h2>
    <p>Your booking <strong>${bookingRef}</strong> is awaiting payment.</p>
    <p><strong>Amount:</strong> ${currency} ${amount}</p>

    <p>
      <a href="${paymentUrl}"
         style="
           display:inline-block;
           padding:12px 18px;
           background:#2563eb;
           color:#fff;
           text-decoration:none;
           border-radius:6px;
           font-weight:600;
         ">
        Complete Payment
      </a>
    </p>

    <p>If you have already completed payment, you may ignore this email.</p>
  `;

  return sendMail({
    to,
    subject,
    html
  });
}

module.exports = { sendMail, sendBookingConfirmation, composeBookingEmail, sendPaymentLink };
