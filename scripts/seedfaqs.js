const mongoose = require('mongoose');
const FAQ = require('../models/FAQ');
require('dotenv').config();

async function seed() {
    await mongoose.connect(process.env.MONGO_URI);

    await FAQ.deleteMany({});

    await FAQ.insertMany([
        {
            question: 'What is FLYO?',
            answer: 'FLYO is a flight booking platform that helps you search, book and manage flights easily.',
            category: 'general',
            order: 1
        },
        {
            question: 'How do I search for flights?',
            answer: 'Use the Search page to find flights by origin, destination and date.',
            category: 'booking',
            order: 1
        },
        {
            question: 'How do I cancel my booking?',
            answer: 'You can cancel your booking from My Bookings. Refund eligibility depends on airline rules.',
            category: 'booking',
            order: 2
        },
        {
            question: 'What happens if my payment fails?',
            answer: 'If payment fails, you will receive a retry payment link via email.',
            category: 'payments',
            order: 1
        },
        {
            question: 'How long do refunds take?',
            answer: 'Refunds are usually processed within 5–7 working days.',
            category: 'payments',
            order: 2
        },
        {
            question: 'How do I update my profile details?',
            answer: 'You can update your email and phone number from the Profile page.',
            category: 'account',
            order: 1
        },
        {
            question: 'How do I contact customer support?',
            answer: 'You can reach us via the Contact Us page or email support@flyo.com.',
            category: 'general',
            order: 2
        }
    ]);


    console.log('FAQs seeded successfully');
    process.exit();
}

seed();
