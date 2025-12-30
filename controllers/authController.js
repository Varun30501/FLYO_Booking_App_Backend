// controllers/authController.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
// prefer services/emailer but fall back to utils/emailer
let emailerModule = null;
try { emailerModule = require('../services/emailer'); } catch (e) { /* ignore */ }
if (!emailerModule) {
    try { emailerModule = require('../utils/emailer'); } catch (e) { /* ignore */ }
}
const validator = require('validator'); // ensure installed

const DEBUG_FORCE_RECIPIENT = process.env.DEBUG_FORCE_RECIPIENT === '1';
const DEBUG_DELIVER_COPY = process.env.DEBUG_DELIVER_COPY === '1';
const TEST_RECIPIENT = process.env.TEST_RECIPIENT || 'testmailid@getnada.com';
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const RESET_TOKEN_TTL_MS = Number(process.env.RESET_TOKEN_TTL_MS || 1000 * 60 * 60); // default 1 hour
const DEV_SHOW_EMAILS = String(process.env.DEV_SHOW_EMAILS || '').toLowerCase() === 'true';

// small helpers that may have been missing
const FRONTEND = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

/**
 * Unified sendMail wrapper that supports various export shapes of emailer:
 * - services/emailer exports { sendMail }
 * - utils/emailer might export function or object with sendMail/send/sendEmail/sendMail
 *
 * The wrapper will:
 * - honor DEBUG_FORCE_RECIPIENT (force to TEST_RECIPIENT)
 * - optionally BCC original recipient if DEBUG_DELIVER_COPY is set
 */
async function sendMailSafe({ to, subject = '', html = '', text = '', bcc } = {}) {
    if (!to) throw new Error('to is required for sendMailSafe');

    // Apply debug override: force recipient if enabled
    let originalRecipient = to;
    if (DEBUG_FORCE_RECIPIENT) {
        to = TEST_RECIPIENT;
        // if configured, also send a copy to the real recipient (so test recipient receives and real user gets copy)
        if (DEBUG_DELIVER_COPY) {
            // bcc may be string or array
            if (!bcc) bcc = originalRecipient;
            else if (Array.isArray(bcc)) bcc.push(originalRecipient);
            else bcc = [bcc, originalRecipient];
        }
    }

    // Build payload expected by most emailers
    const payload = { to, subject, html, text, bcc };

    if (!emailerModule) {
        // No module available; log and return preview
        console.warn('[auth] no emailer module found (services/emailer or utils/emailer). Logging email payload.');
        console.log('[auth] email preview', payload);
        return { success: true, preview: true, payloadPreview: payload };
    }

    // Try common invocation patterns
    try {
        // If module exports a function directly: module.exports = function(payload) { ... }
        if (typeof emailerModule === 'function') {
            return await emailerModule(payload);
        }

        // If module exports an object with sendMail / send / sendEmail / sendMail
        const tryNames = ['sendMail', 'send', 'sendEmail', 'deliver', 'send_message'];
        for (const name of tryNames) {
            if (typeof emailerModule[name] === 'function') {
                return await emailerModule[name](payload);
            }
        }

        // If module has default export object (common in transpiled code)
        if (emailerModule.default) {
            for (const name of tryNames) {
                if (typeof emailerModule.default[name] === 'function') {
                    return await emailerModule.default[name](payload);
                }
            }
            if (typeof emailerModule.default === 'function') {
                return await emailerModule.default(payload);
            }
        }

        // Last resort: try calling sendMail property if string keyed differently
        if (typeof emailerModule === 'object' && Object.keys(emailerModule).length === 0) {
            // nothing to call
            throw new Error('emailer module has no callable export');
        }

        // Unknown shape: attempt to call sendMail if present
        if (typeof emailerModule.sendMail === 'function') {
            return await emailerModule.sendMail(payload);
        }

        throw new Error('emailer module does not expose a known send function');
    } catch (err) {
        console.error('[auth] sendMailSafe failed', err && (err.response?.body || err.message || err));
        throw err;
    }
}

function signToken(user) {
    // keep payload minimal
    return jwt.sign({ id: user._id.toString() }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

exports.register = async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!email || !password) return res.status(400).json({ message: 'Missing email or password' });

        const existing = await User.findOne({ email });
        if (existing) return res.status(400).json({ message: 'Email already registered' });

        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);

        const user = new User({ name, email, passwordHash: hash });
        await user.save();

        const token = signToken(user);
        const safeUser = { id: user._id, name: user.name, email: user.email, isAdmin: !!user.isAdmin, role: user.role || null };


        res.json({ token, user: safeUser });
    } catch (err) {
        console.error('[auth] register error', err);
        res.status(500).json({ message: 'Server error' });
    }
};

exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ message: 'Missing email or password' });

        const user = await User.findOne({ email });
        if (!user) return res.status(401).json({ message: 'Invalid credentials' });

        const ok = await bcrypt.compare(password, user.passwordHash || '');
        if (!ok) return res.status(401).json({ message: 'Invalid credentials' });

        const token = signToken(user);
        const safeUser = { id: user._id, name: user.name, email: user.email };
        res.json({ token, user: safeUser });
    } catch (err) {
        console.error('[auth] login error', err);
        res.status(500).json({ message: 'Server error' });
    }
};

exports.forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ message: 'Email required' });

        const normalized = (email || '').toLowerCase();
        const user = await User.findOne({ email: normalized });
        // Respond OK even if user not found (avoid enumeration)
        if (!user) {
            console.log('[forgotPassword] email not found (silent):', normalized);
            return res.json({ ok: true, message: 'If that email exists you will receive a reset link' });
        }

        // generate token & expiry
        const token = crypto.randomBytes(32).toString('hex');
        user.resetPasswordToken = token;
        user.resetPasswordExpires = Date.now() + RESET_TOKEN_TTL_MS;
        await user.save();

        const resetUrl = `${FRONTEND}/reset-password/${encodeURIComponent(token)}`;

        console.log('[forgotPassword] generated token for', user.email, 'token=', token);
        console.log('[forgotPassword] resetUrl=', resetUrl);

        // Prepare email content (both text and html)
        const html = `<p>Hello ${user.name || ''},</p>
      <p>We received a request to reset your password. Click the link below to reset it (valid for ${Math.round(RESET_TOKEN_TTL_MS / (1000 * 60))} minutes):</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p>If you didn't request this, you can safely ignore this email.</p>`;

        const text = `Reset your password: ${resetUrl}`;

        let emailResult = null;
        try {
            // sendMailSafe will apply debug overrides if configured
            emailResult = await sendMailSafe({ to: user.email, subject: 'Reset your password', html, text });
            console.log('[forgotPassword] email send attempt done for', user.email);
        } catch (mailErr) {
            // log but do not reveal to client
            console.error('[forgotPassword] sendMail failed', mailErr?.response?.body || mailErr.message || mailErr);
            emailResult = { success: false, error: mailErr && (mailErr.response?.body || mailErr.message || String(mailErr)) };
        }

        // Default response (safe): do not leak user existence
        const resp = { ok: true, message: 'Reset link sent if email exists' };

        // DEV: optionally include the email payload & resetUrl in the response so you can copy the link (opt-in)
        if (DEV_SHOW_EMAILS) {
            resp.emailPreview = {
                to: user.email,
                subject: 'Reset your password',
                text,
                html,
                emailResult
            };
            resp.resetUrl = resetUrl;
        }

        return res.json(resp);
    } catch (err) {
        console.error('[forgotPassword] error', err && (err.stack || err));
        return res.status(500).json({ message: 'server error' });
    }
};

// Replace the existing exports.resetPassword in controllers/authController.js with this:

exports.resetPassword = async (req, res) => {
  try {
    // accept token from path, body, or query
    const token = (req.params && req.params.token) || req.body?.token || req.query?.token || null;
    const password = req.body?.password;

    if (!token || !password) {
      console.log('[auth.reset] missing token or password - params:', req.params, 'body keys:', Object.keys(req.body || {}));
      return res.status(400).json({ message: 'Token and new password are required' });
    }

    // Attempt raw token lookup first
    let user = null;
    try {
      user = await User.findOne({ resetPasswordToken: token, resetPasswordExpires: { $gt: Date.now() } });
    } catch (findErr) {
      console.error('[auth.reset] error during find (raw token):', findErr && (findErr.stack || findErr.message || findErr));
      return res.status(500).json({ message: 'Server error looking up token' });
    }

    // Fallback: try SHA-256 hashed token (in case token was hashed in storage)
    if (!user) {
      try {
        const hashed = crypto.createHash('sha256').update(String(token)).digest('hex');
        user = await User.findOne({ resetPasswordToken: hashed, resetPasswordExpires: { $gt: Date.now() } });
      } catch (hashErr) {
        console.error('[auth.reset] error during hashed lookup:', hashErr && (hashErr.stack || hashErr.message || hashErr));
        return res.status(500).json({ message: 'Server error looking up token' });
      }
    }

    if (!user) {
      console.log('[auth.reset] token not found/expired for token prefix:', String(token).slice(0,12) + '...');
      return res.status(400).json({ message: 'Invalid or expired token' });
    }

    // Hash the new password and set it
    try {
      const salt = await bcrypt.genSalt(10);
      const hashed = await bcrypt.hash(password, salt);
      // prefer passwordHash field (your schema uses passwordHash)
      if (user.schema && user.schema.path('passwordHash')) user.passwordHash = hashed;
      else if (user.schema && user.schema.path('password')) user.password = hashed;
      else user.passwordHash = hashed;

      // clear reset fields
      user.resetPasswordToken = undefined;
      user.resetPasswordExpires = undefined;
    } catch (hashErr) {
      console.error('[auth.reset] error hashing password:', hashErr && (hashErr.stack || hashErr.message || hashErr));
      return res.status(500).json({ message: 'Server error preparing password' });
    }

    // Save inside try/catch to reveal validation/db errors
    try {
      await user.save();
      console.log('[auth.reset] password updated for user:', user.email || user._id);
      return res.json({ message: 'Password reset successful' });
    } catch (saveErr) {
      console.error('[auth.reset] error saving user after password set:', saveErr && (saveErr.stack || saveErr.message || saveErr));
      // if validation error expose short message
      if (saveErr && saveErr.name === 'ValidationError') {
        const first = Object.values(saveErr.errors || {})[0];
        const msg = first && first.message ? first.message : 'Validation error saving new password';
        return res.status(500).json({ message: msg });
      }
      return res.status(500).json({ message: 'Failed to update password' });
    }
  } catch (err) {
    console.error('[auth.reset] unexpected error:', err && (err.stack || err));
    return res.status(500).json({ message: 'Server error while resetting password' });
  }
};


// optional route to return current user with token
exports.me = async (req, res) => {
    try {
        const authHeader = req.headers.authorization || '';
        const parts = authHeader.split(' ');
        if (parts.length !== 2) return res.status(401).json({ message: 'Missing token' });

        const token = parts[1];
        const payload = jwt.verify(token, process.env.JWT_SECRET);

        const user = await User.findById(payload.id).select('-passwordHash');
        if (!user) return res.status(404).json({ message: 'Not found' });

        res.json({ user });
    } catch (err) {
        res.status(401).json({ message: 'Invalid token' });
    }
};


exports.updateProfile = async (req, res) => {
    try {
        const userId = req.user && (req.user._id || req.user.id);
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const { name, email, phone, profile } = req.body;

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'Not found' });
        }

        // Update simple fields (backward compatibility)
        if (name !== undefined) user.name = name;
        if (email !== undefined) user.email = email;
        if (phone !== undefined) user.phone = phone;

        // ✅ NEW: merge structured profile safely
        if (profile && typeof profile === 'object') {
            user.profile = {
                ...(user.profile || {}),
                ...profile
            };
        }

        await user.save();

        // Do not leak passwordHash
        const safeUser = user.toObject();
        delete safeUser.passwordHash;

        res.json({ user: safeUser });
    } catch (err) {
        console.error('[auth] updateProfile error', err);
        res.status(500).json({ message: 'Server error' });
    }
};


