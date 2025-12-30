const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
db.bookings.find({
  paymentStatus: "PENDING",
  stripeSessionParams: { $exists: false }
}).forEach(b => {
  if (!b.contact || !b.contact.email) return;

  b.stripeSessionParams = {
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: b.contact.email,
    line_items: [{
      price_data: {
        currency: (b.price && b.price.currency) || "INR",
        product_data: { name: `Flight Booking ${b.bookingRef}` },
        unit_amount: Math.round((b.price?.amount || 0) * 100)
      },
      quantity: 1
    }],
    success_url: `${FRONTEND_URL}/booking-details/${b.bookingRef}?payment=success`,
    cancel_url: `${FRONTEND_URL}/booking-details/${b.bookingRef}?payment=cancelled`,
    metadata: {
      bookingId: String(b._id),
      bookingRef: b.bookingRef
    }
  };

  db.bookings.save(b);
});
