// test-sendgrid.js
const sgMail = require('@sendgrid/mail');
require('dotenv').config();

const key = process.env.SENDGRID_API_KEY;
const from = process.env.SENDGRID_FROM || 'testmailid30501@gmail.com';
const to = 'testmailid@getnada.com'; // testing sending to same address

if (!key) {
    console.error('ERROR: No SENDGRID_API_KEY in .env');
    process.exit(1);
}

sgMail.setApiKey(key);

async function run() {
    try {
        console.log('Using FROM:', from, 'TO:', to);
        const msg = {
            to,
            from,
            subject: 'SendGrid test from FlightBooker',
            text: 'Test message from FlightBooker — if you see this, SendGrid worked.',
            html: '<p>Test message from <strong>FlightBooker</strong></p>'
        };
        const res = await sgMail.send(msg);
        console.log('SendGrid response array length:', res.length);
        console.log('Status code (first):', res[0]?.statusCode);
        console.log('Headers (first):', res[0]?.headers);
        console.log('Done — check your inbox at inboxes.com');
    } catch (err) {
        console.error('SendGrid send error:', err.response?.body || err.message || err);
    }
}

run();
