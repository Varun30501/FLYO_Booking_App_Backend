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
 * composeBookingEmail — FLYO branded HTML email
 */
function composeBookingEmail(b) {
  const bookingRef     = b.bookingRef || '—';
  const flightId       = b.flightId   || '—';
  const currency       = (b.price && b.price.currency) || 'INR';
  const passengerLines = (Array.isArray(b.passengers) ? b.passengers : []).map((p, idx) => {
    const name = [p.title, p.firstName, p.lastName].filter(Boolean).join(' ').trim() || p.name || `Passenger ${idx + 1}`;
    let seat = '—';
    try {
      if (Array.isArray(b.seats) && b.seats[idx]) {
        const s = b.seats[idx];
        seat = typeof s === 'string' ? s : (s.label || s.seatId || s.seat || '—');
      } else if (p.seat) seat = p.seat;
    } catch { seat = '—'; }
    return { name, seat: String(seat) };
  });

  const seatList = passengerLines.length
    ? passengerLines.map(x => x.seat).join(', ')
    : (Array.isArray(b.seats) ? b.seats.map(s => (s && (s.label || s.seatId)) || s).join(', ') : '—');

  // Pricing
  const seatsMeta      = Array.isArray(b.seatsMeta) ? b.seatsMeta : [];
  const seatsSubtotal  = seatsMeta.reduce((a, s) => a + Number(s.price || 0), 0);
  const classExtras    = seatsMeta.reduce((a, s) => a + Number(s.priceModifier || 0), 0);
  const baseSubtotal   = seatsSubtotal - classExtras;
  let   addonsTotal    = 0;
  const addonsList     = [];
  if (Array.isArray(b.addons) && b.addons.length) {
    b.addons.forEach(a => {
      const amt  = Number(a.amount ?? a.price ?? 0) || 0;
      const qty  = Number(a.qty ?? 1) || 1;
      const line = Math.round(amt * qty);
      addonsTotal += line;
      addonsList.push({ name: a.name || 'Add-on', amount: line, qty });
    });
  } else addonsTotal = Number(b.price?.addonsTotal || 0);

  let discountsTotal = 0;
  const couponLines  = [];
  (Array.isArray(b.discounts) ? b.discounts : []).forEach(d => {
    const amt = Math.abs(Number(d.amount || 0));
    discountsTotal += amt;
    couponLines.push({ label: d.name || 'Discount', amount: amt });
  });
  (Array.isArray(b.coupons) ? b.coupons : []).forEach(c => {
    const amt = Math.abs(Number(c.amount || c.discount || 0));
    discountsTotal += amt;
    couponLines.push({ label: `Coupon ${c.code || ''}`, amount: amt });
  });

  const taxMajor    = Number(b.price?.tax || b.price?.taxes || 0);
  const totalMajor  = Number(b.price?.amount) || Math.round(baseSubtotal + classExtras + addonsTotal - discountsTotal + taxMajor);

  const fmt = n => formatMoneyMajor(n, currency);

  // ── Route info from raw itinerary
  const segs  = b.raw?.itineraries?.[0]?.segments || [];
  const first = segs[0];
  const last  = segs[segs.length - 1];
  const depTime = first?.departure?.at ? new Date(first.departure.at).toLocaleString('en-IN', { dateStyle:'medium', timeStyle:'short' }) : safeDate(b.travelDate);
  const arrTime = last?.arrival?.at   ? new Date(last.arrival.at).toLocaleString('en-IN',   { dateStyle:'medium', timeStyle:'short' }) : '—';
  const origin  = b.origin      || first?.departure?.iataCode || '—';
  const dest    = b.destination || last?.arrival?.iataCode    || '—';
  const airline = b.airline     || first?.carrierCode         || '—';
  const flightNo = b.flightNumber || first?.number            || '';

  // ── plain text fallback
  const text = [
    `FLYO — Booking Confirmed`,
    `Ref: ${bookingRef}`,
    ``,
    `${origin} → ${dest} | ${airline} ${flightNo}`,
    `Departure: ${depTime} | Arrival: ${arrTime}`,
    ``,
    `Passengers:`,
    ...passengerLines.map(p => `  ${p.name} — Seat ${p.seat}`),
    ``,
    `Base fare:    ${fmt(baseSubtotal)}`,
    classExtras   ? `Class extras: ${fmt(classExtras)}`   : null,
    addonsTotal   ? `Add-ons:      ${fmt(addonsTotal)}`   : null,
    discountsTotal? `Discounts:   -${fmt(discountsTotal)}`  : null,
    taxMajor      ? `Taxes & fees: ${fmt(taxMajor)}`      : null,
    `Total paid:   ${fmt(totalMajor)}`,
    ``,
    `Your itinerary PDF is attached.`,
    `Thank you for flying with FLYO.`,
  ].filter(l => l !== null).join('\n');

  // ── HTML
  const BRAND   = '#00d4ff';
  const DARK_BG = '#04071a';
  const CARD_BG = '#07102a';
  const BORDER  = '#1e2d4d';
  const MUTED   = '#8b9dbf';
  const WHITE   = '#f0f4ff';

  const row = (label, value, bold = false, color = WHITE) =>
    `<tr>
      <td style="padding:8px 12px;color:${MUTED};font-size:13px;">${label}</td>
      <td style="padding:8px 12px;color:${color};font-size:13px;text-align:right;${bold ? 'font-weight:700;' : ''}">${value}</td>
    </tr>`;

  const divider = `<tr><td colspan="2" style="padding:0 12px;"><div style="height:1px;background:${BORDER};"></div></td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Booking Confirmed — ${bookingRef}</title></head>
<body style="margin:0;padding:0;background:${DARK_BG};font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${DARK_BG};padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

  <!-- Header -->
  <tr><td style="background:${CARD_BG};border-radius:16px 16px 0 0;padding:0;overflow:hidden;">
    <div style="height:3px;background:linear-gradient(90deg,#00d4ff,#2563eb,#7c3aed);border-radius:16px 16px 0 0;"></div>
    <div style="padding:24px 32px;display:flex;align-items:center;gap:12px;">
      <table cellpadding="0" cellspacing="0"><tr>
        <td style="width:36px;height:36px;background:#00d4ff;border-radius:50%;text-align:center;vertical-align:middle;">
          <span style="color:#04071a;font-weight:900;font-size:14px;font-family:Georgia,serif;">F</span>
        </td>
        <td style="padding-left:12px;vertical-align:middle;">
          <span style="color:#ffffff;font-weight:900;font-size:20px;letter-spacing:-0.5px;">FLYO</span>
        </td>
        <td style="padding-left:24px;vertical-align:middle;">
          <span style="background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.35);color:#10b981;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:0.08em;">✓ CONFIRMED</span>
        </td>
      </tr></table>
    </div>
  </td></tr>

  <!-- Route hero -->
  <tr><td style="background:linear-gradient(135deg,rgba(0,212,255,0.06),rgba(37,99,235,0.08));padding:28px 32px;border-top:1px solid ${BORDER};">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="text-align:center;width:33%;">
        <div style="font-size:36px;font-weight:900;color:${WHITE};letter-spacing:-1px;">${origin}</div>
        <div style="font-size:12px;color:${MUTED};margin-top:4px;">${depTime}</div>
      </td>
      <td style="text-align:center;width:34%;vertical-align:middle;padding:0 8px;">
        <div style="color:${MUTED};font-size:11px;margin-bottom:6px;">${airline} ${flightNo}</div>
        <div style="position:relative;height:2px;background:linear-gradient(90deg,transparent,${BRAND},transparent);border-radius:2px;">
          <span style="position:absolute;top:-9px;left:50%;transform:translateX(-50%);font-size:18px;">✈</span>
        </div>
        <div style="color:${MUTED};font-size:11px;margin-top:6px;">Non-stop</div>
      </td>
      <td style="text-align:center;width:33%;">
        <div style="font-size:36px;font-weight:900;color:${WHITE};letter-spacing:-1px;">${dest}</div>
        <div style="font-size:12px;color:${MUTED};margin-top:4px;">${arrTime}</div>
      </td>
    </tr></table>

    <!-- Booking ref chip -->
    <div style="margin-top:20px;text-align:center;">
      <span style="display:inline-block;background:rgba(0,212,255,0.08);border:1px solid rgba(0,212,255,0.22);color:${BRAND};padding:6px 20px;border-radius:20px;font-size:13px;font-weight:700;letter-spacing:0.08em;font-family:monospace;">
        ${bookingRef}
      </span>
    </div>
  </td></tr>

  <!-- Passengers -->
  <tr><td style="background:${CARD_BG};padding:24px 32px;border-top:1px solid ${BORDER};">
    <div style="font-size:11px;font-weight:700;color:${MUTED};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:14px;">Passengers & Seats</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <thead>
        <tr style="background:rgba(255,255,255,0.03);">
          <th style="padding:8px 12px;text-align:left;color:${MUTED};font-size:11px;font-weight:600;border-bottom:1px solid ${BORDER};">Name</th>
          <th style="padding:8px 12px;text-align:right;color:${MUTED};font-size:11px;font-weight:600;border-bottom:1px solid ${BORDER};">Type</th>
          <th style="padding:8px 12px;text-align:right;color:${MUTED};font-size:11px;font-weight:600;border-bottom:1px solid ${BORDER};">Seat</th>
        </tr>
      </thead>
      <tbody>
        ${passengerLines.map((p, i) => `
        <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
          <td style="padding:10px 12px;color:${WHITE};font-size:13px;">${p.name}</td>
          <td style="padding:10px 12px;color:${MUTED};font-size:12px;text-align:right;">${(b.passengers?.[i]?.type || b.passengers?.[i]?.passengerType || 'Adult').toLowerCase()}</td>
          <td style="padding:10px 12px;text-align:right;">
            <span style="background:rgba(0,212,255,0.1);border:1px solid rgba(0,212,255,0.2);color:${BRAND};padding:2px 10px;border-radius:6px;font-size:12px;font-weight:700;font-family:monospace;">${p.seat}</span>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>
  </td></tr>

  <!-- Price breakdown -->
  <tr><td style="background:${CARD_BG};padding:24px 32px;border-top:1px solid ${BORDER};">
    <div style="font-size:11px;font-weight:700;color:${MUTED};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:14px;">Fare Breakdown</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tbody>
        ${row('Base fare', fmt(baseSubtotal))}
        ${classExtras > 0 ? row('Class / seat extras', fmt(classExtras)) : ''}
        ${addonsList.map(a => row(`Add-on: ${a.name} ×${a.qty}`, fmt(a.amount))).join('')}
        ${couponLines.map(c => row(c.label, `-${fmt(c.amount)}`, false, '#10b981')).join('')}
        ${taxMajor > 0 ? row('Taxes & fees', fmt(taxMajor)) : ''}
        ${divider}
        ${row('<strong>Total paid</strong>', `<strong>${fmt(totalMajor)}</strong>`, true, BRAND)}
      </tbody>
    </table>
  </td></tr>

  <!-- What next -->
  <tr><td style="background:rgba(0,212,255,0.04);padding:20px 32px;border-top:1px solid ${BORDER};border-radius:0 0 16px 16px;">
    <div style="font-size:11px;font-weight:700;color:${MUTED};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:12px;">What's next?</div>
    <table cellpadding="0" cellspacing="0"><tbody>
      ${[
        ['📄', 'Your itinerary PDF is attached to this email'],
        ['🗓', 'Check in opens 48 hours before departure'],
        ['📞', 'Need help? Email support@flyo.com'],
      ].map(([icon, text]) => `
      <tr><td style="padding:4px 0;">
        <span style="font-size:15px;">${icon}</span>
        <span style="color:${MUTED};font-size:13px;padding-left:10px;">${text}</span>
      </td></tr>`).join('')}
    </tbody></table>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:24px 0;text-align:center;">
    <div style="color:rgba(139,157,191,0.5);font-size:11px;">
      © ${new Date().getFullYear()} FLYO · flyo.in · support@flyo.com<br>
      <span style="color:rgba(139,157,191,0.3);">You're receiving this because you booked a flight with FLYO.</span>
    </div>
  </td></tr>

</table>
</td></tr></table>
</body>
</html>`;

  return { subject: `Your FLYO booking is confirmed — ${bookingRef}`, text, html, attachments: [], debug: { totalMajor, taxMajor, addonsTotal, discountsTotal } };
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

async function sendPaymentLink({ to, bookingRef, paymentUrl, amount, currency = 'INR' }) {
  const subject = `Complete your payment — FLYO Booking ${bookingRef}`;
  const fmt = n => formatMoneyMajor(n, currency);

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Payment Pending — ${bookingRef}</title></head>
<body style="margin:0;padding:0;background:#04071a;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#04071a;padding:32px 16px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
  <tr><td style="background:#07102a;border-radius:16px;overflow:hidden;border:1px solid #1e2d4d;">
    <div style="height:3px;background:linear-gradient(90deg,#00d4ff,#2563eb,#7c3aed);"></div>
    <div style="padding:32px;">
      <!-- Logo -->
      <table cellpadding="0" cellspacing="0" style="margin-bottom:28px;"><tr>
        <td style="width:32px;height:32px;background:#00d4ff;border-radius:50%;text-align:center;vertical-align:middle;">
          <span style="color:#04071a;font-weight:900;font-size:13px;">F</span>
        </td>
        <td style="padding-left:10px;vertical-align:middle;">
          <span style="color:#fff;font-weight:900;font-size:18px;">FLYO</span>
        </td>
      </tr></table>

      <!-- Status badge -->
      <div style="margin-bottom:20px;">
        <span style="background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.3);color:#f59e0b;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:0.08em;">⏳ PAYMENT PENDING</span>
      </div>

      <h2 style="color:#f0f4ff;margin:0 0 8px;font-size:22px;font-weight:900;">Complete your booking</h2>
      <p style="color:#8b9dbf;font-size:14px;margin:0 0 20px;line-height:1.6;">
        Your booking <strong style="color:#f0f4ff;font-family:monospace;">${bookingRef}</strong> is reserved but awaiting payment. 
        Complete your payment to confirm your seat.
      </p>

      <!-- Amount chip -->
      <div style="background:rgba(0,212,255,0.07);border:1px solid rgba(0,212,255,0.18);border-radius:12px;padding:16px 20px;margin-bottom:24px;">
        <div style="color:#8b9dbf;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px;">Amount due</div>
        <div style="color:#00d4ff;font-size:28px;font-weight:900;">${fmt(amount)}</div>
      </div>

      <!-- CTA button -->
      <a href="${paymentUrl}" style="display:block;text-align:center;background:linear-gradient(135deg,#00d4ff,#2563eb);color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:12px;font-weight:700;font-size:15px;margin-bottom:20px;">
        Complete Payment →
      </a>

      <p style="color:rgba(139,157,191,0.5);font-size:12px;text-align:center;margin:0;">
        This link expires in 24 hours. If you have already paid, please ignore this email.
      </p>
    </div>
    <div style="background:rgba(255,255,255,0.02);border-top:1px solid #1e2d4d;padding:16px 32px;text-align:center;">
      <span style="color:rgba(139,157,191,0.4);font-size:11px;">© ${new Date().getFullYear()} FLYO · support@flyo.com</span>
    </div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = `FLYO — Complete your booking ${bookingRef}\n\nAmount due: ${fmt(amount)}\n\nPay here: ${paymentUrl}\n\nThis link expires in 24 hours.`;

  return sendMail({ to, subject, html, text });
}

module.exports = { sendMail, sendBookingConfirmation, composeBookingEmail, sendPaymentLink };
