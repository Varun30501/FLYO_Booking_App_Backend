✈️ FlyO – Flight Booking & Reservation System (Backend)

This backend powers the FlyO flight booking platform, handling flight search, bookings, payments, notifications, and integrations with third-party services.

Built using the MERN stack, it is designed to be modular, scalable, and production-ready.

🔧 Tech Stack

Node.js

Express.js

MongoDB Atlas

Mongoose

Stripe API (Test Mode)

SendGrid (Email)

Amadeus API (Sandbox)

JWT Authentication

Render (Deployment)

🚀 Core Features Implemented
✈️ Flight Search

Search flights by origin, destination, date

Provider priority:

Amadeus API (sandbox)

Local database fallback

🧾 Booking Management

Create bookings

Store passenger, seat, and pricing data

Booking status lifecycle:

PENDING

CONFIRMED

CANCELLED

💳 Payment Processing

Stripe Checkout integration

Idempotent session creation

Payment retry logic

Admin-triggered payment resend

Secure webhook handling

📧 Notifications

Booking confirmation emails

Payment link resend emails

Email content includes booking details

🪑 Seat Management

Seat hold & booking tracking

Seat metadata stored with booking

Static seat maps (current phase)

🔐 Authentication & Security

JWT-based authentication

Admin routes protected

Idempotency keys for payments

⚠️ Current Fallbacks & Incomplete Modules (Backend)

Stripe is TEST MODE ONLY

Amadeus API is sandbox, not production

Real-time flight status updates are mocked

Seat maps are not dynamically aircraft-based

Ticket issuance is not finalized

Reports & analytics are not implemented yet

🔮 Planned Improvements (Backend)

Stripe Live mode integration

Real-time flight status sync

Dynamic seat map generation

PDF ticket generation enhancements

Booking cancellation & refunds

Admin analytics dashboard

SMS notifications

Rate limiting & audit logging

🧪 Payments Disclaimer

⚠️ All payments are processed via Stripe Sandbox (Test Mode).
Live payments are not enabled yet and will be activated after final audits.

🏁 Project Status

✅ Core booking flow completed
✅ Payment integration stable
✅ Email notifications working
✅ Production deployment successful

🚧 Enhancements ongoing