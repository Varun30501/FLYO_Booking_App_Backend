const { sendMail } = require('./emailer');

function buildPaymentLinkEmail({ booking, paymentUrl }) {
  return {
    to: booking.contact?.email,
    subject: `Complete payment for booking ${booking.bookingRef}`,
    html: `
      <h2>Complete your payment</h2>
      <p>Your booking <strong>${booking.bookingRef}</strong> is awaiting payment.</p>
      <p>Please complete payment using the link below:</p>
      <p>
        <a href="${paymentUrl}" target="_blank"
           style="padding:12px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">
           Pay Now
        </a>
      </p>
      <p><small>This link may expire.</small></p>
    `,
    text: `
Complete your payment

Booking: ${booking.bookingRef}
Payment link: ${paymentUrl}
`
  };
}

async function sendPaymentLinkEmail({ booking, paymentUrl }) {
  if (!booking?.contact?.email) {
    throw new Error('Booking has no contact email');
  }

  const mail = buildPaymentLinkEmail({ booking, paymentUrl });
  return sendMail(mail);
}

module.exports = { sendPaymentLinkEmail };
