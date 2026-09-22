/**
 * server_load.js
 * Load Smart Pvt. Ltd. — web server + registration portal
 *
 * Serves the marketing site and handles registration forms for
 * Shippers, Brokers and Carriers. Submissions are stored in MongoDB
 * (via Mongoose). Set MONGODB_URI in your environment / .env file.
 *
 * Run:
 *   npm install
 *   node server_load.js
 *
 * Then open http://localhost:4000
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const matchingEngine = require('./lib/matchingEngine');
const trustScoreLib = require('./lib/trustScore');
// ---------- Full load-lifecycle workflow (posting → approval → driver
// assignment → manual tracking → delivery → POD → completion) ----------
// New, additive modules — see each file's header comment for what it does
// and why it's separate from the inline models/routes above.
const ops = require('./lib/opsModels');
const notificationService = require('./lib/notificationService');
const emailService = require('./lib/emailService');
const statusMachine = require('./lib/loadStatusMachine');
const bidding = require('./lib/biddingModels');
const biddingEngine = require('./lib/biddingEngine');
const aiService = require('./lib/aiService');
const kycFileStore = require('./lib/kycFileStore');
// ---------- Permanent (GridFS-backed) file storage ----------
// Replaces reliance on this deployment's local disk (confirmed non-
// persistent across restarts/redeploys — see lib/kycFileStore.js's header
// comment for the original diagnosis) for every NEW upload. Old records
// still referencing the legacy /admin/kyc-photo/:filename format keep being
// served by the existing disk+kycFileStore fallback below — nothing about
// that path changes; this only changes what a brand-new upload does.
const fileStorageService = require('./lib/fileStorageService');
const { FileMeta } = require('./lib/fileStorageModels');
// ---------- Broker module (Complete Broker Portal, KYC, real AI) ----------
// Kept in their own files, same additive pattern as every other lib/* module
// above — nothing here changes or removes any existing Shipper/Carrier/
// Driver/Admin model or route.
const brokerService = require('./lib/brokerService');
const brokerAiTools = require('./lib/brokerAiTools');
const brokerDocReview = require('./lib/brokerDocReview');
// ---------- Broker Automation (Broker -> Carrier -> Shipper workflow) ----------
// Find Loads for a Carrier / Save Load / Smart Truck Matching / Shipper
// Connection requests — see each file's header comment. Additive: reuses
// the existing Truck/Driver/BookingRequest/Bid models and the existing
// matchingEngine/biddingEngine/notificationService/emailService, never a
// second competing system.
const brokerAutomationModels = require('./lib/brokerAutomationModels');
const brokerAutomation = require('./lib/brokerAutomation');
const brokerLoadPosting = require('./lib/brokerLoadPosting');
const brokerAiFallback = require('./lib/brokerAiFallback');
// ---------- Production-ready email notification system ----------
// EmailProvider abstraction (SMTP/Resend/SendGrid/SES, chosen by
// EMAIL_PROVIDER in .env), the queue+worker that actually delivers every
// email lib/emailService.js renders, and the configurable match-score
// thresholds that gate the "Perfect Match" emails. See each file's header
// comment. emailService.js is still the only module routes call directly —
// these two are wired in once at startup and otherwise used only inside
// lib/emailService.js / lib/emailQueue.js.
const emailProvider = require('./lib/emailProvider');
const emailQueue = require('./lib/emailQueue');
const emailTemplates = require('./lib/emailTemplates');
const matchConfig = require('./lib/matchConfig');
// SMS — same "one gateway, runtime-selected transport" shape as email
// above (see lib/smsProvider.js's header comment: this project had no
// existing Twilio/SMS integration before this feature, so it's built to
// match the already-working email pattern exactly).
const smsProvider = require('./lib/smsProvider');
const smsQueue = require('./lib/smsQueue');
const smsService = require('./lib/smsService');
// ---------- GPS tracking system improvements ----------
const gpsConfig = require('./lib/gpsConfig');
const gpsValidation = require('./lib/gpsValidation');

const app = express();
const PORT = process.env.PORT || 4000;

// ---------- Global crash protection ----------
// CRITICAL FIX: since Node 15, an unhandled promise rejection terminates
// the entire process by default. This file has many `async (req, res) =>
// {...}` route handlers — if any single one throws without a try/catch
// (a bad MongoDB write, a transient connection blip, anything), the whole
// server would silently die, taking down every other in-flight request
// with it — not just the one that failed. That "sometimes it works,
// sometimes it doesn't, with no clear pattern" symptom is exactly what a
// crash-and-silently-restart (or crash-and-stay-down) cycle looks like
// from the outside. This keeps the server alive and logs the real error
// instead, so one bad request can never take the whole site down.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (server kept running):', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  // A failed port bind (EADDRINUSE — the exact "port already in use" issue
  // this project has hit before) should still exit loudly with a clear
  // message, exactly like it always has — silently swallowing THAT one
  // would leave a process running that looks alive but isn't actually
  // listening on anything, which is far more confusing to debug. Every
  // other uncaught error (a bug inside some request handler) is logged
  // and the server stays up, since that's the actual fix for one bad
  // request being able to take the whole site down.
  if (err && err.code === 'EADDRINUSE') {
    console.error(err.message);
    process.exit(1);
  }
  console.error('Uncaught exception (server kept running):', err && err.stack ? err.stack : err);
  console.error('Uncaught exception (server kept running):', err && err.stack ? err.stack : err);
});

const PUBLIC_DIR = path.join(__dirname, 'public');
const VIEWS_DIR = path.join(__dirname, 'views', 'admin');
const PORTAL_VIEWS_DIR = path.join(__dirname, 'views', 'portal');

// ---------- Middleware ----------
// Registered before any route below, so every route can rely on req.body
// already being populated when it runs.
app.use(express.urlencoded({ extended: true, limit: '6mb' })); // parse HTML form posts
app.use(express.json({ limit: '6mb' }));          // parse JSON posts (API use) — raised for KYC photo uploads

// Every /api/* JSON response is always fetched fresh from MongoDB — never
// served from a browser/proxy cache. Without this, a GET like
// /api/rate-requests has no cache-control headers at all, so it's at the
// mercy of whatever heuristic caching a given browser/proxy applies; the
// symptom of that going wrong looks exactly like "a newly submitted rate
// request doesn't show up in the Admin Portal" even though the record is
// sitting in the database the whole time. Scoped to /api/ only — static
// assets (CSS/JS/images) keep their normal caching behavior.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

app.use(express.static(PUBLIC_DIR));              // serve index.html, /register/*.html, /assets/*

// views/admin/*.html and views/portal/*.html each now link a matching
// page-specific .css and .js file (split out of what used to be inline
// <style>/<script> blocks). Those pages themselves are served openly (see
// the note above requireAdmin/getShipperSession — sessions live in each
// browser tab's sessionStorage, not a cookie, so a page GET can't carry
// proof of login) — this middleware ONLY ever serves .css/.js, never the
// page markup itself, which stays behind /assets/auth.js's client-side check.
function serveViewAssets(dir, mountPath) {
  app.get(mountPath + '/:file', (req, res, next) => {
    const file = req.params.file;
    if (!/^[a-zA-Z0-9_-]+\.(css|js)$/.test(file)) return next();
    const filePath = path.join(dir, file);
    if (!fs.existsSync(filePath)) return next();
    res.type(file.endsWith('.css') ? 'text/css' : 'application/javascript');
    res.sendFile(filePath);
  });
}
serveViewAssets(path.join(__dirname, 'views', 'admin'), '/admin-assets');
serveViewAssets(path.join(__dirname, 'views', 'portal'), '/portal-assets');

// ---------- MongoDB connection ----------
// Put your connection string in an env var so it never gets committed to git.
// Example (local):  MONGODB_URI=mongodb://127.0.0.1:27017/loadsmart
// Example (Atlas):   MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/loadsmart
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/loadsmart';

mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('MongoDB connected:', MONGODB_URI);
    // Permanent file storage (GridFS) — must be initialized only after the
    // connection is actually open (GridFSBucket needs the real driver `db`
    // handle). This is what makes uploaded photos/KYC documents survive a
    // server restart or redeploy: they live inside MongoDB itself, in the
    // same database/cluster as every other collection, not on this
    // container's local (non-persistent) disk.
    try {
      fileStorageService.init(mongoose.connection, { bucketName: process.env.FILE_BUCKET_NAME || 'loadsmartFiles' });
      console.log(`GridFS file storage ready — bucket "${process.env.FILE_BUCKET_NAME || 'loadsmartFiles'}".`);
    } catch (err) {
      console.error('GridFS file storage FAILED to initialize — uploads will fail until this is fixed:', err.message);
    }
    // Self-heal: older versions of this project used a "refId" unique index
    // on the registrations collection. The current schema doesn't set that
    // field, so leftover copies of that index cause every new signup after
    // the first to fail with "E11000 duplicate key ... refId: null". Drop
    // any such stray index automatically so upgrades don't need manual DB
    // surgery.
    try {
      const collection = mongoose.connection.collection('registrations');
      const existingIndexes = await collection.indexes();
      const staleIndexes = existingIndexes.filter((idx) => idx.name !== '_id_' && idx.name !== 'id_1');
      for (const idx of staleIndexes) {
        console.log(`Removing stale index "${idx.name}" from registrations collection...`);
        await collection.dropIndex(idx.name);
      }
    } catch (err) {
      console.warn('Index cleanup skipped:', err.message);
    }

    // Backfill: any booking/order created before the Live Tracking feature
    // existed won't have a tokenNo yet. Give each one a unique token (and a
    // baseline tracking object) once, so every order in the system has the
    // same primary reference key going forward.
    try {
      const legacyRecords = await BookingRequest.find({ $or: [{ tokenNo: { $exists: false } }, { tokenNo: null }] });
      for (const rec of legacyRecords) {
        rec.tokenNo = await generateUniqueToken();
        if (!rec.tracking) rec.tracking = {};
        if (!rec.tracking.currentLocation) rec.tracking.currentLocation = rec.pickup || '';
        if (!rec.tracking.updatedAt) rec.tracking.updatedAt = rec.createdAt || new Date();
        await rec.save();
      }
      if (legacyRecords.length) console.log(`Backfilled tokenNo/tracking for ${legacyRecords.length} existing booking(s).`);
    } catch (err) {
      console.warn('Token backfill skipped:', err.message);
    }
  })
  .catch((err) => console.error('MongoDB connection error:', err.message));

// ---------- Account-creation email notification ----------
// Every time a Shipper, Broker or Carrier registers, an email is sent to the
// operations inbox below so the team knows a new account came in. Uses SMTP
// creds from .env; without them it just logs the notification (no cost, no
// external call) so the app still runs on a fresh checkout.
const NOTIFY_TO_EMAIL = process.env.NOTIFY_TO_EMAIL || 'singhshail144@gmail.com';
let mailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  console.log('Email notifications: configured — new-account alerts will be sent to', NOTIFY_TO_EMAIL);
  // Verify the SMTP connection/credentials right away, so a bad host,
  // port, or app password shows up clearly in the console at startup
  // instead of only surfacing later as "Could not send the verification
  // email" when someone tries to register.
  mailTransporter.verify((err) => {
    if (err) {
      console.error('SMTP verification FAILED — emails will not send. Reason:', err.message);
      console.error('Double-check SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS in .env.');
    } else {
      console.log('SMTP connection verified OK — ready to send emails.');
    }
  });
} else {
  console.log('Email notifications: NOT configured (missing SMTP_HOST / SMTP_USER / SMTP_PASS in .env) — new-account alerts will only be logged here.');
}
// Hand the (possibly null, if SMTP isn't configured) transporter to the
// EmailProvider abstraction (lib/emailProvider.js) — the one place that
// actually knows how to talk to SMTP/Resend/SendGrid/SES, selected via
// EMAIL_PROVIDER in .env (defaults to 'smtp' when a transporter exists,
// else 'console' — same "log instead of send" dev fallback the app has
// always had). emailService.js never talks to a provider directly; it
// renders content and hands it to lib/emailQueue.js, which calls this.
emailProvider.init({
  transporter: mailTransporter,
  from: process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.MAIL_FROM || '',
});
console.log(`Email notification system: provider="${emailProvider.getProviderName()}", match thresholds =`, matchConfig.getThresholds());

// ---------- SMS notification system ----------
// Twilio (or SMS_PROVIDER override) if TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN
// (+ a from number/messaging service) are set in .env; otherwise falls back
// to logging the message server-side (never claims delivery) — exactly the
// same fail-soft behavior email already has. See lib/smsProvider.js.
smsProvider.init({});
console.log(`SMS notification system: provider="${smsProvider.getProviderName()}"${smsProvider.isConfigured() ? '' : ' (NOT fully configured — set TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER in .env to send real SMS; messages will be logged here instead)'}`);

// ---------- Audit log helper (spec section 24) ----------
// Fire-and-forget-safe, same rule as email/notifications: a logging
// failure must never break the action it's describing.
async function logActivity({ loadId = '', userId = '', userRole = '', userName = '', action, oldStatus = '', newStatus = '', metadata = {} }) {
  try {
    await ops.ActivityLog.create({ loadId, userId, userRole, userName, action, oldStatus, newStatus, metadata });
  } catch (err) {
    console.error('logActivity failed:', err.message);
  }
}

// ---------- Load posted (spec section 2) ----------
// Called right after a booking OR rate_request is created — confirms to
// the shipper it was submitted, alerts the ops inbox a load needs review,
// creates the first TrackingEvent, and logs the audit trail entry. Shared
// by both /api/estimate/book and /api/estimate/rate-request so the two
// creation paths can never drift out of sync on what "posted" means.
async function notifyLoadPosted(load, shipperRecord) {
  const to = shipperRecord && shipperRecord.email;
  if (to) {
    await emailService.sendLoadPostedEmail({ to, tokenNo: load.tokenNo });
  }
  await emailService.sendNewLoadAdminAlertEmail({
    to: NOTIFY_TO_EMAIL, tokenNo: load.tokenNo,
    companyName: load.companyName, pickup: load.pickup, destination: load.destination,
    material: load.material, weight: load.weight,
  });
  if (shipperRecord) {
    await notificationService.notify({
      userId: shipperRecord.id, userRole: 'shipper', loadId: load.tokenNo, type: 'LOAD_POSTED',
      title: 'Load submitted', message: `Your load ${load.tokenNo} has been successfully submitted and is pending admin approval.`,
    });
  }
  await notificationService.notify({
    userId: 'admin', userRole: 'admin', loadId: load.tokenNo, type: 'LOAD_POSTED',
    title: 'New load pending approval', message: `Load ${load.tokenNo} from ${load.companyName || load.shipperUsername || 'a shipper'} is waiting for admin approval.`,
  });
  await ops.TrackingEvent.create({ tokenNo: load.tokenNo, type: 'LOAD_POSTED', label: 'Load Posted', location: load.pickup || '', createdByRole: 'shipper', createdByName: load.companyName || load.shipperUsername || '', createdAt: load.createdAt || new Date() });
  await logActivity({ loadId: load.tokenNo, userId: (shipperRecord && shipperRecord.id) || '', userRole: 'shipper', userName: load.companyName || load.shipperUsername || '', action: 'LOAD_POSTED', newStatus: 'pending' });
  // Fire-and-forget: never let the carrier broadcast slow down or fail the
  // load-posting response — the load is already safely persisted above.
  notifyMatchingCarriersOfNewLoad(load).catch((err) => console.error('notifyMatchingCarriersOfNewLoad failed for', load.tokenNo, '—', err.message));
}

// ---------- LoadCreated -> matching carriers (email spec section 2) ----------
// "Send an email to the relevant available/suitable carriers — NOT
// everyone." A carrier is considered relevant here if they have at least
// one verified, available truck whose type matches what the load actually
// requires (or ANY verified/available truck, when the load didn't specify
// a required type). Capped to a sane batch size so one very popular load
// type can't fan out to an unbounded number of emails in one shot.
const NEW_LOAD_CARRIER_ALERT_CAP = 30;
async function notifyMatchingCarriersOfNewLoad(load) {
  const truckFilter = { verified: true, status: 'available' };
  if (load.requiredTruckType) truckFilter.truckType = new RegExp(`^${load.requiredTruckType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const trucks = await Truck.find(truckFilter).select('carrierUsername').lean();
  const carrierUsernames = [...new Set(trucks.map((t) => t.carrierUsername).filter(Boolean))].slice(0, NEW_LOAD_CARRIER_ALERT_CAP);
  if (!carrierUsernames.length) return;
  const carriers = await Registration.find({ role: 'carrier', username: { $in: carrierUsernames }, active: { $ne: false } })
    .select('id username companyName email notificationPrefs').lean();
  // "Truck Matches" preference (spec section 17) — this alert is about a
  // load that might suit one of the carrier's trucks, so it's gated by the
  // same toggle as the richer truck-match emails below.
  await Promise.all(carriers.filter((c) => c.email && prefEnabled(c, 'truckMatches')).map((c) => emailService.sendCarrierNewLoadEmail({
    to: c.email, tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination,
    pickupDateTime: load.pickupDateTime, deliveryDeadline: load.deliveryDeadline,
    material: load.material, weight: load.weight, requiredTruckType: load.requiredTruckType,
    distanceKm: load.distanceKm, estimatedRate: load.estimatedRate,
  }).catch(() => {})));
}

async function notifyNewAccount(role, id, payload) {
  const displayName = payload.companyName || payload.contactPerson || payload.username || id;
  const subject = `New ${role} account created on Load Smart — ${displayName}`;
  const lines = [
    `A new ${role} account was just created on Load Smart.`,
    ``,
    `Reference ID: ${id}`,
    `Name / Company: ${displayName}`,
    payload.username ? `Username: ${payload.username}` : null,
    payload.email ? `Email: ${payload.email}` : null,
    payload.phoneNumber ? `Phone: ${payload.phoneNumber}` : null,
    payload.gstNumber ? `GST: ${payload.gstNumber}` : null,
    `Submitted: ${new Date().toLocaleString()}`,
  ].filter(Boolean).join('\n');

  if (!mailTransporter) {
    console.log(`[DEV EMAIL to ${NOTIFY_TO_EMAIL}] ${subject}\n${lines}`);
    return;
  }
  try {
    await mailTransporter.sendMail({
      from: process.env.SMTP_USER,
      to: NOTIFY_TO_EMAIL,
      subject,
      text: lines,
    });
  } catch (err) {
    console.error('Account-notification email failed:', err.message);
  }
}

// ---------- Email OTP (registration verification) ----------
// Security notes (per spec):
//  - OTP is generated and verified ONLY here on the backend.
//  - The OTP value itself is NEVER put in an API response, a log line, or
//    anything the frontend can read — not even in local/dev mode. If SMTP
//    isn't configured, the email is simply not delivered (see sendEmailOtp);
//    that's a deliberate tradeoff for safety over local-dev convenience.
//  - Each OTP expires automatically (OTP_TTL_MS) and is deleted the moment
//    it's used, so it can never be replayed.
//  - Resends are rate-limited (OTP_RESEND_COOLDOWN_MS) to stop OTP-bombing.
const emailOtpStore = new Map(); // email -> { otp, expiresAt, attempts, lastSentAt }
const verifiedEmails = new Map(); // verifyToken -> { email, expiresAt }
const OTP_TTL_MS = 2 * 60 * 1000;              // 2:00 countdown shown to the user
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;      // minimum gap between resend requests

async function sendEmailOtp(email, otp) {
  const subject = 'Your Load Smart verification code';
  const text = `Your Load Smart email verification code is ${otp}. It expires in 2 minutes.`;
  if (!mailTransporter) {
    // Never log or return the OTP itself — only note that an email would
    // have been sent, so local runs without SMTP configured stay silent
    // on the actual code.
    console.log(`[DEV EMAIL OTP] Verification email would be sent to ${email} (SMTP not configured, code withheld for security).`);
    return;
  }
  await mailTransporter.sendMail({ from: process.env.SMTP_USER, to: email, subject, text });
}

// Shared by /api/email-otp/send (registration) and the shipper Forgot
// Password flow below — one OTP generation/cooldown/send implementation,
// not a second parallel OTP system.
async function generateAndSendOtp(email) {
  const existing = emailOtpStore.get(email);
  if (existing && existing.lastSentAt && Date.now() - existing.lastSentAt < OTP_RESEND_COOLDOWN_MS) {
    const waitSeconds = Math.ceil((OTP_RESEND_COOLDOWN_MS - (Date.now() - existing.lastSentAt)) / 1000);
    const err = new Error(`Please wait ${waitSeconds}s before requesting another OTP.`);
    err.status = 429;
    throw err;
  }
  const otp = String(crypto.randomInt(100000, 999999));
  emailOtpStore.set(email, { otp, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0, lastSentAt: Date.now() });
  try {
    await sendEmailOtp(email, otp);
    return { sent: true, expiresInSeconds: OTP_TTL_MS / 1000 };
  } catch (err) {
    emailOtpStore.delete(email);
    // Log the real SMTP failure reason server-side for debugging — this is
    // safe to log (it's a connection/auth error, never the OTP itself).
    console.error('OTP email send failed for', email, '—', err.message);
    const wrapped = new Error('Could not send the verification email. Please try again.');
    wrapped.status = 502;
    throw wrapped;
  }
}

app.post('/api/email-otp/send', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = String(req.body.role || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  // Registration OTPs (role is 'shipper', 'carrier', or 'broker') are
  // blocked upfront if the email is already registered — no point sending
  // (and the person typing in) a one-time code for an account that can't
  // be created anyway. This is a UX nicety only: the real, unbypassable
  // duplicate-email check runs again at actual account-creation time in
  // /register/shipper, /register/carrier, and /register/broker below.
  if (['shipper', 'carrier', 'broker'].includes(role) && await isEmailAlreadyRegistered(email)) {
    return res.status(409).json({ error: 'An account already exists with this email address. Please log in instead.' });
  }
  try {
    const result = await generateAndSendOtp(email);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/email-otp/verify', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const otp = String(req.body.otp || '').trim();
  const entry = emailOtpStore.get(email);
  if (!entry) return res.status(400).json({ verified: false, error: 'No code was sent to this email.' });
  if (Date.now() > entry.expiresAt) {
    emailOtpStore.delete(email);
    return res.status(400).json({ verified: false, error: 'OTP expired. Please click Resend OTP.' });
  }
  entry.attempts += 1;
  if (entry.attempts > 5) {
    emailOtpStore.delete(email);
    return res.status(429).json({ verified: false, error: 'Too many attempts — please click Resend OTP.' });
  }
  if (entry.otp !== otp) {
    return res.status(400).json({ verified: false, error: 'Invalid OTP. Please try again.' });
  }
  // Correct code — delete immediately so it can never be reused (replay-proof).
  emailOtpStore.delete(email);
  const verifyToken = crypto.randomBytes(20).toString('hex');
  verifiedEmails.set(verifyToken, { email, expiresAt: Date.now() + 30 * 60 * 1000 });
  res.json({ verified: true, verifyToken });
});

function isEmailVerified(token, email) {
  const entry = verifiedEmails.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) { verifiedEmails.delete(token); return false; }
  return entry.email === String(email || '').trim().toLowerCase();
}

// ---------- Registration success email ----------
// Separate from notifyNewAccount() above (which emails the *operations*
// inbox) — this one goes straight to the account holder's own just-verified
// email address once their account is actually created, and deliberately
// never includes their password.
async function sendRegistrationConfirmationEmail(email, { username, role }) {
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
  const subject = 'Your Load Smart account has been created';
  const text = [
    'Welcome to Load Smart!',
    '',
    `Your ${roleLabel} account has been created successfully.`,
    '',
    `Username: ${username}`,
    `Registered email: ${email}`,
    `Account type: ${roleLabel}`,
    '',
    'You can sign in any time using your username and password.',
    'For your security, we never include your password in email — if you forget it, use "Forgot password" on the sign-in page.',
  ].join('\n');
  if (!mailTransporter) {
    console.log(`[DEV EMAIL to ${email}] ${subject}\n${text}`);
    return;
  }
  try {
    await mailTransporter.sendMail({ from: process.env.SMTP_USER, to: email, subject, text });
  } catch (err) {
    console.error('Registration confirmation email failed for', email, '—', err.message);
  }
}

// ---------- Shipper Login — Forgot Password ----------
// Reuses the exact same OTP store/send/verify machinery as registration
// (generateAndSendOtp + the existing /api/email-otp/verify endpoint) —
// this is not a second OTP system, just a different entry point into the
// same one.
app.post('/api/shipper/forgot-password/send-otp', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  const record = await Registration.findOne({ role: 'shipper', email, active: { $ne: false } }).lean();
  if (!record) {
    return res.status(404).json({ error: 'No shipper account found with that email.' });
  }
  try {
    const result = await generateAndSendOtp(email);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Verifying the OTP itself uses the existing generic
// POST /api/email-otp/verify endpoint directly from the frontend — no
// duplicate verify logic needed here.

app.post('/api/shipper/forgot-password/reset', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const { verifyToken, newPassword, confirmNewPassword } = req.body;
  if (!isEmailVerified(verifyToken, email)) {
    return res.status(401).json({ error: 'Email verification expired or invalid. Please start again.' });
  }
  if (newPassword !== confirmNewPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }
  if (!isValidPassword(newPassword)) {
    return res.status(400).json({ error: 'Password must be 1–10 characters with an uppercase letter and an @ symbol.' });
  }
  const record = await Registration.findOne({ role: 'shipper', email });
  if (!record) {
    return res.status(404).json({ error: 'No shipper account found with that email.' });
  }
  record.password = newPassword;
  await record.save();
  res.json({ ok: true, username: record.username });
});

// ---------- Mongoose models ----------
// Registration record: role + id + whatever dynamic fields the form posted.
const registrationSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  role: { type: String, required: true },
  active: { type: Boolean, default: true },
  // Admin KYC review status — separate from "active" (which controls public
  // listing visibility). Shown to the account holder on their portal page.
  status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
  // Set by admin when status is "rejected" — shown back to the account
  // holder so they know why. Required by the admin UI whenever rejecting.
  rejectionReason: { type: String, default: '' },
  // Admin-controlled switch (Shipper Portal — Lock/Unlock Update): when
  // true, the shipper's "Update" button/profile-edit flow is disabled
  // server-side regardless of what the frontend shows, so this can't be
  // bypassed by editing the page. Independent of `status` — a shipper can
  // be accepted/pending AND locked at the same time.
  updateLocked: { type: Boolean, default: false },
  // GST Certificate / MSME Certificate document uploads (photo or PDF) —
  // separate from the existing `gstNumber` text field: this is the actual
  // scanned/photographed certificate document, for Admin to visually
  // verify against the number the shipper typed in. Also used by Carrier
  // registration (see the GST-or-MSME requirement there).
  gstPhotoPath: { type: String, default: '' },
  msmePhotoPath: { type: String, default: '' },
  // Shipper's mandatory Office Photo — a photo of their office/business
  // location, replacing the old Selfie/face-photo requirement entirely.
  // Image only (enforced in /api/kyc/upload's PHOTO_ONLY_TYPES).
  officePhotoPath: { type: String, default: '' },
  // Loading Slip — mandatory for Carrier AND Broker registration (never
  // required for Shipper). Photo or PDF, same upload pattern as every
  // other document here.
  loadingSlipPath: { type: String, default: '' },
  // Bank Details + Bank KYC — collected at registration for all three
  // roles (Shipper/Broker/Carrier), used for payouts/settlements. The
  // proof document (cancelled cheque or passbook photo) is a separate
  // upload, same pattern as the GST/MSME certificate above.
  bankAccountHolder: { type: String, default: '' },
  bankAccountNumber: { type: String, default: '' },
  bankIfsc: { type: String, default: '' },
  bankName: { type: String, default: '' },
  bankBranch: { type: String, default: '' },
  bankAccountType: { type: String, enum: ['savings', 'current', ''], default: '' },
  bankProofPhotoPath: { type: String, default: '' },
  // Driver identity/vehicle documents — collected specifically for Carrier
  // registrations. Aadhaar is intentionally requested for the DRIVER only
  // (an individual) — never for the carrier/company account itself, whose
  // identity is already covered by GST/PAN/business details like every
  // other role. RC (vehicle Registration Certificate) and DL (Driving
  // Licence) photos can be supplied at registration or added/replaced any
  // time afterwards from the Carrier account page (see
  // /api/carrier/update-driver-documents below).
  driverAadharFrontPhotoPath: { type: String, default: '' },
  driverAadharBackPhotoPath: { type: String, default: '' },
  driverRcPhotoPath: { type: String, default: '' },
  driverDlPhotoPath: { type: String, default: '' },
  // Admin reviews the bank details against the uploaded proof document —
  // independent of overall account status, since the account could already
  // be Accepted before bank details are specifically double-checked.
  // Starts "pending" the moment bank details are submitted; admin then
  // moves it to "verified" or "rejected" (with a reason).
  bankVerificationStatus: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
  bankRejectionReason: { type: String, default: '' },
  // Auto-generated at registration time (see generateUniqueUsername below)
  // for Broker; Shipper & Carrier now choose their own username at
  // registration (validated + uniqueness-checked in their route handlers
  // before saveSubmission is ever called). Unique across all roles either
  // way, since it works as the login identifier for everyone.
  username: { type: String, unique: true, sparse: true },
  // "One account per email" (enforced for Shipper & Carrier — see
  // isEmailAlreadyRegistered() and the checks in /register/shipper and
  // /register/carrier below). unique+sparse here is the DB-level backstop
  // against a race between two near-simultaneous signups; the explicit
  // application-level check is what gives a fast, friendly error in the
  // normal (non-race) case.
  email: { type: String, default: undefined, index: { unique: true, sparse: true } },
  submittedAt: { type: Date, default: Date.now },
  // ---------- Broker module additions ----------
  // Declared explicitly (rather than left to strict:false) because these
  // need real indexes/enums — every other role simply never sets them.
  mobileNumber: { type: String, default: '' },
  gstNumber: { type: String, default: '' },
  // Broker-only: whether the broker HAS a given registration at all — GST
  // and MSME are each independently optional (spec section 2-3). Number and
  // document fields below are only ever required/validated when the
  // matching flag is true — see lib/brokerService.js's
  // validateBrokerRegistration(). Left `false` by default for every
  // existing/non-broker record, so nothing already in the database changes
  // meaning.
  hasGST: { type: Boolean, default: false },
  hasMSME: { type: Boolean, default: false },
  msmeNumber: { type: String, default: '' },
  brokerType: { type: String, enum: ['individual', 'company', ''], default: '' },
  address: {
    addressLine: { type: String, default: '' },
    city: { type: String, default: '' },
    state: { type: String, default: '' },
    pincode: { type: String, default: '' },
  },
  panDocumentPath: { type: String, default: '' },
  addressProofPath: { type: String, default: '' },
  profilePhotoPath: { type: String, default: '' },
  // Broker's own preferences for the Opportunity Radar (spec section 7A) —
  // configurable from the Broker dashboard when no activity history exists
  // yet to infer them from.
  loadPreferences: {
    preferredOrigins: { type: [String], default: [] },
    preferredDestinations: { type: [String], default: [] },
    preferredTruckTypes: { type: [String], default: [] },
    preferredLoadCategories: { type: [String], default: [] },
  },
  // Richer, broker-specific KYC workflow — deliberately separate from the
  // existing generic `status` field above (which every role already uses
  // and which admin's original accept/reject screen still edits directly).
  // Kept in sync both ways (see brokerService.kycStatusToAccountStatus /
  // accountStatusToKycStatus) so using either the old or new admin
  // endpoint on a broker record can never leave the two disagreeing.
  kycStatus: { type: String, enum: brokerService.KYC_STATUSES, default: 'DRAFT' },
  kycRejectionReason: { type: String, default: '' },
  kycDocumentsRequested: { type: String, default: '' },
  kycSubmittedAt: { type: Date, default: null },
  kycReviewedAt: { type: Date, default: null },
  // Per-document AI advisory review results (spec section 9) — one entry
  // per document type reviewed, upserted by documentType so re-uploading a
  // document replaces its own prior review rather than growing forever.
  aiDocumentReviews: {
    type: [{
      documentType: String,
      looksReadable: { type: Boolean, default: null },
      looksLikeExpectedDocument: { type: Boolean, default: null },
      confidence: { type: Number, default: 0 },
      concerns: { type: [String], default: [] },
      summary: { type: String, default: '' },
      reviewedAt: { type: Date, default: Date.now },
    }],
    default: [],
  },
  // Rollup of the above, in the exact shape spec section 4 asks for — kept
  // as a convenience single-object summary alongside the richer per-document
  // array above.
  aiKycReview: {
    status: { type: String, default: '' },
    confidence: { type: Number, default: 0 },
    summary: { type: String, default: '' },
    concerns: { type: [String], default: [] },
    reviewedAt: { type: Date, default: null },
  },
}, { strict: false }); // strict:false lets each role's form fields be saved as-is
registrationSchema.index({ role: 1 });
registrationSchema.index({ mobileNumber: 1 });
registrationSchema.index({ kycStatus: 1 });
registrationSchema.index({ status: 1 }); // Carrier Connect verification-status filter
registrationSchema.index({ gstNumber: 1 }, { sparse: true });
registrationSchema.index({ msmeNumber: 1 }, { sparse: true });
const Registration = mongoose.model('Registration', registrationSchema);

// Estimate & Booking (Shipper Portal): covers both "Book Now" and
// "Send Rate Request" actions — one schema, a `kind` field distinguishes
// them, so we're not duplicating near-identical collections/APIs.
const bookingRequestSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  kind: { type: String, enum: ['booking', 'rate_request'], required: true },
  // Unique Token/Order No. — generated once at creation (see generateUniqueToken)
  // and used as the primary reference key across every tracking module
  // (Shipper Live Tracking, Admin Tracking, Carrier/Broker lookups).
  tokenNo: { type: String, unique: true, sparse: true },
  shipperUsername: String,
  companyName: String,
  pickup: String,
  destination: String,
  // Full manual address entered by the shipper (house/building no., street,
  // area, landmark, etc.) — supplementary to `pickup`/`destination` (which
  // stay "District, State" and remain the source for geocoding/distance so
  // nothing that already depends on that format breaks).
  pickupAddress: { type: String, default: '' },
  destAddress: { type: String, default: '' },
  distanceKm: Number,
  material: String,
  weight: Number,
  estimatedRate: Number,
  requestedRate: Number,   // for rate_request: the shipper's offer; for booking: same as estimatedRate
  minAllowedRate: Number,  // estimatedRate - MIN_BARGAIN_REDUCTION, floored at 0
  adminOfferedRate: Number, // set by admin as a counter-offer on a rate_request
  // Final agreed rate once a request reaches "accepted" — either the
  // shipper's own requestedRate (admin accepted it directly) or the
  // adminOfferedRate (shipper accepted admin's counter rate).
  finalRate: Number,
  // 'withdrawn' added for the Broker load-request workflow (spec section
  // 6) — a broker can withdraw their own still-pending rate_request/load
  // request, mirroring the Carrier Bidding system's WITHDRAWN bid status.
  // Purely additive: no existing code ever sets or checks for 'withdrawn',
  // so every prior status transition is completely unaffected.
  status: { type: String, enum: ['pending', 'accepted', 'rejected', 'countered', 'withdrawn'], default: 'pending' },
  rejectionReason: { type: String, default: '' },
  // Invoice — the shipper uploads this after the load/rate is finalized,
  // and it's required (see the guard in the Admin tracking-update endpoint
  // below) before Admin can mark the order "Picked Up" (truck loaded).
  invoicePath: { type: String, default: '' },
  invoiceUploadedAt: { type: Date, default: null },
  invoiceVerified: { type: Boolean, default: false },
  // POD (Proof of Delivery) — uploaded by the CARRIER, and only once the
  // order's tracking status is already "Delivered" (enforced server-side
  // in the upload endpoint, not just hidden in the UI). Reuses the same
  // private-uploads/kyc storage + /api/kyc/upload flow as every other
  // KYC-style document in this app.
  podPath: { type: String, default: '' },
  podUploadedAt: { type: Date, default: null },
  podVerified: { type: Boolean, default: false },
  podRejectionReason: { type: String, default: '' },
  // Auto-generated invoices — never uploaded by a person, always produced
  // by the server itself (see generateLoadInvoice / generateTransportInvoice
  // below). Each field stores just the bare generated PDF filename (not a
  // URL) — the bytes are served through the access-controlled
  // /api/orders/:token/document/:kind route, open only to the shipper who
  // owns the order, the carrier assigned to it, or an admin.
  //   - loadInvoicePath: generated the moment the load is posted / its
  //     rate is finalized (see /api/estimate/book and the rate-request
  //     accept flows).
  //   - transportInvoicePath: generated once the carrier uploads POD for a
  //     Delivered order — deliberately the LAST step of the required flow
  //     (Posted → Carrier/Driver Assigned → In Transit → Delivered → POD
  //     Uploaded → Invoice Generated), so it always has a POD behind it.
  loadInvoicePath: { type: String, default: '' },
  loadInvoiceGeneratedAt: { type: Date, default: null },
  transportInvoicePath: { type: String, default: '' },
  transportInvoiceGeneratedAt: { type: Date, default: null },
  // Carrier / Broker assignment — set by admin from the Tracking module's
  // manual update form. Keeps the same order document as the single link
  // between Shipper ↔ Token No. ↔ Carrier ↔ Broker ↔ Admin, so there's
  // never a second "tracking record" to keep in sync.
  carrierUsername: { type: String, default: '' },
  carrierCompanyName: { type: String, default: '' },
  brokerUsername: { type: String, default: '' },
  brokerCompanyName: { type: String, default: '' },
  // Live tracking info — manually updated by admin, read by the shipper's
  // Live Tracking dashboard. Lives directly on the order/token record.
  tracking: {
    currentLocation: { type: String, default: '' },
    status: {
      type: String,
      enum: ['Booked', 'Confirmed', 'Picked Up', 'In Transit', 'Out for Delivery', 'Delayed', 'Delivered'],
      default: 'Booked',
    },
    progressPercent: { type: Number, default: 0, min: 0, max: 100 },
    remarks: { type: String, default: '' },
    // Driver / truck info — free-text so admin can record whatever's
    // relevant (truck number, driver name/phone, etc.) without needing a
    // separate vehicles collection.
    vehicleInfo: { type: String, default: '' },
    updatedAt: { type: Date, default: Date.now },
  },
  // ---------- Automated Truck/Driver Matching & Assignment ----------
  // Deliberately a SEPARATE, more granular pipeline from the admin-managed
  // `tracking.status` above — not a replacement for it. Every transition
  // here also updates `tracking.status`/`tracking.remarks` (see
  // syncTrackingStatusFromLoadStage() below) so the existing admin
  // Tracking module and shipper Live Tracking page keep working exactly
  // as before, without needing to know this pipeline exists.
  //   POSTED -> MATCHED -> ASSIGNED -> DRIVER_ACCEPTED (or DRIVER_REJECTED)
  //   -> ARRIVED_PICKUP -> LOADING -> LOADED -> IN_TRANSIT
  //   -> REACHED_DESTINATION -> UNLOADING -> DELIVERED -> COMPLETED
  // DRIVER_REJECTED, REACHED_DESTINATION, UNLOADING, and COMPLETED are new
  // additions (full load-lifecycle workflow) — every value that already
  // existed is unchanged, so nothing that reads/writes the earlier stages
  // needs to change. See lib/loadStatusMachine.js for the full transition
  // table and the mapping from the spec's requested status vocabulary onto
  // these actual values.
  loadStage: {
    type: String,
    enum: statusMachine.LOAD_STAGE_KEYS,
    default: 'POSTED',
  },
  // ---------- Carrier Bidding System ----------
  // 'auto_match' (default, schema level — see note below) keeps the
  // EXISTING single-carrier AI auto-match pipeline (tryAutoAssignLoad,
  // loadStage MATCHED->ASSIGNED) working completely untouched, byte for
  // byte, exactly as it already did. 'bidding' is the new path: instead of
  // the engine picking one truck automatically, the load opens to every
  // eligible carrier (loadStage BIDDING_OPEN) and the shipper picks a
  // winning bid themselves. The actual DEFAULT a shipper sees when posting
  // a new load is set client-side (Post a Load screen defaults to
  // 'bidding', the new primary flow) — the schema default here stays the
  // conservative 'auto_match' as defense-in-depth for any create path that
  // doesn't explicitly set it.
  assignmentMode: { type: String, enum: ['auto_match', 'bidding'], default: 'auto_match' },
  biddingDeadline: { type: Date, default: null },
  biddingOpenedAt: { type: Date, default: null },
  biddingClosedAt: { type: Date, default: null },
  // Bid.id of the accepted bid, once one exists — set inside the
  // transactional accept flow (see acceptBidTransactional below).
  winningBidId: { type: String, default: '' },
  // ---------- Full load-lifecycle workflow additions ----------
  // Who/when the current truck+driver assignment was made — 'admin:<id>'
  // when a human approved/assigned it, 'auto-match-engine' when
  // tryAutoAssignLoad picked it automatically (still requires a separate
  // admin approval before the driver ever sees it — see loadStage MATCHED).
  assignedBy: { type: String, default: '' },
  assignedAt: { type: Date, default: null },
  // Set when the driver rejects an ASSIGNED load (loadStage -> DRIVER_REJECTED).
  driverRejectedReason: { type: String, default: '' },
  // ---------- Delay reporting (spec section 9) ----------
  // Deliberately an OVERLAY, not a pipeline stage: a delay doesn't lose the
  // load's real place in the loadStage pipeline (still IN_TRANSIT, etc.) —
  // it just flags that stage as currently delayed. tracking.status is set
  // to the existing 'Delayed' enum value alongside this (see
  // reportDelayHandler below) so the shipper's existing Live Tracking page
  // shows it with zero changes on that end.
  delay: {
    active: { type: Boolean, default: false },
    reason: { type: String, default: '' },
    currentLocation: { type: String, default: '' },
    expectedDurationMinutes: { type: Number, default: null },
    notes: { type: String, default: '' },
    photoPath: { type: String, default: '' },
    reportedAt: { type: Date, default: null },
  },
  // ---------- Delivery confirmation (spec section 11) ----------
  // Captured the moment the driver marks the load Delivered (loadStage:
  // UNLOADING -> DELIVERED) — separate from the POD fields below, since the
  // spec asks for delivery confirmation to happen before POD is even
  // uploaded.
  deliveryReceiverName: { type: String, default: '' },
  deliveryReceiverPhone: { type: String, default: '' },
  deliveryNotes: { type: String, default: '' },
  deliveryConfirmedAt: { type: Date, default: null },
  // ---------- POD workflow (spec sections 12-13) ----------
  // podStatus is the new, explicit 4-state workflow the spec asks for;
  // podVerified/podRejectionReason (below, pre-existing) are kept in sync
  // alongside it so every existing screen that already reads podVerified
  // (admin/tracking.js, live-tracking.js, toTrackingSummary) keeps working
  // unchanged. podStatus is the richer field new code should prefer.
  podStatus: { type: String, enum: ['pending', 'uploaded', 'approved', 'rejected'], default: 'pending' },
  // ---------- AI POD Vision Check ----------
  // A real Claude vision call (lib/aiService.js), run once automatically
  // the moment a POD photo is uploaded (see runPodAiCheck below) — NEVER
  // replaces the human admin review (podVerified/podStatus stay exactly as
  // they were), only adds a fast, informational pre-check so both the
  // driver (instant "this looks blurry, retake it?" feedback) and admin
  // (a written note alongside the photo) get a head start. Left entirely
  // null/absent whenever AI isn't configured (aiService.isConfigured()) or
  // the uploaded file isn't an image — the rest of the POD flow is
  // completely unaffected either way.
  podAiCheck: {
    checkedAt: { type: Date, default: null },
    looksValid: { type: Boolean, default: null },
    confidence: { type: String, default: '' }, // 'high' | 'medium' | 'low'
    concerns: { type: [String], default: [] },
    summary: { type: String, default: '' },
    error: { type: String, default: '' }, // set only if the AI call itself failed — never blocks the upload
  },
  // loadStage reaches COMPLETED only once POD is approved (or an admin
  // explicitly overrides — see /api/admin/tracking/order/:token/override-complete).
  completedAt: { type: Date, default: null },
  completedByOverride: { type: Boolean, default: false },
  completedOverrideReason: { type: String, default: '' },
  // What kind of truck this load needs — free text (matches Truck.truckType
  // below), never a hard-coded enum, so it works with whatever truck types
  // carriers have actually onboarded.
  requiredTruckType: { type: String, default: '' },
  // Cargo body requirement (e.g. "Closed", "Open", "Refrigerated") —
  // matched against Truck.bodyType by the matching engine, same
  // any-value-OK-when-empty convention as requiredTruckType above.
  requiredBodyType: { type: String, default: '' },
  // Optional scheduling window — not required by any existing booking
  // flow, but read by the matching engine when present (see
  // lib/matchingEngine.js) so a future booking form can populate them
  // without any further schema changes.
  pickupDateTime: { type: Date, default: null },
  deliveryDeadline: { type: Date, default: null },
  // Stamped the moment the driver marks the trip "complete" (loadStage ->
  // DELIVERED) — used to know when a shipper becomes eligible to leave
  // feedback and to show "Delivered 2 hours ago" style copy.
  deliveredAt: { type: Date, default: null },
  matchAttempted: { type: Boolean, default: false },
  matchNote: { type: String, default: '' },
  // Set the moment the AI matching engine picks a candidate (loadStage
  // becomes 'MATCHED') — shown on the Admin Approval screen so admin sees
  // exactly why this truck/driver was recommended, without recomputing it.
  matchScore: { type: Number, default: null },
  matchReasons: { type: [String], default: [] },
  assignedTruckId: { type: String, default: '' },
  assignedDriverId: { type: String, default: '' },
  driverAcceptedAt: { type: Date, default: null },
  trackingSessionActive: { type: Boolean, default: false },
  trackingStartedAt: { type: Date, default: null },
  trackingStoppedAt: { type: Date, default: null },
  // Most recent GPS ping — full history lives in the separate
  // TrackingPoint collection below (see "Tracking History"). Kept as its
  // own small sub-document (rather than looking up the latest
  // TrackingPoint on every read) specifically so "where is this load right
  // now" stays a single fast field read — spec: "store/update the latest
  // location for a load/vehicle efficiently."
  lastGps: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    speedKph: { type: Number, default: null },
    headingDeg: { type: Number, default: null },
    accuracy: { type: Number, default: null },
    altitude: { type: Number, default: null },
    deviceTimestamp: { type: Date, default: null }, // when the phone took the fix
    updatedAt: { type: Date, default: null },        // when this server persisted it
  },
  createdAt: { type: Date, default: Date.now },
  // ---------- Broker-posted loads (Broker Portal "Post New Load") ----------
  // Purely additive. `brokerUsername` above already exists and keeps its
  // original meaning (the broker who actually brokered the WINNING deal —
  // set only inside the accept-bid transaction / admin assignment, see
  // those call sites). `postedByBrokerUsername` is a SEPARATE field, set
  // once at creation time and never overwritten, recording who actually
  // created this load record when it was a broker rather than a shipper —
  // so "who posted this" and "who ended up brokering it" can never be
  // confused with each other, and every existing query that already filters
  // on `brokerUsername` (My Shipments, the Broker AI repo, etc.) keeps its
  // exact original meaning with zero behavior change.
  postedByRole: { type: String, enum: ['shipper', 'broker'], default: 'shipper' },
  postedByBrokerUsername: { type: String, default: '', index: true },
  postedByBrokerCompanyName: { type: String, default: '' },
  // A broker often posts freight on behalf of a client who may not have
  // (or need) their own LoadSmart shipper login — so unlike the
  // shipper-posted flow, `shipperUsername` is allowed to stay empty for a
  // broker-posted load. `companyName` above is reused as "who the freight
  // is for" in that case (the shipper/consignor's company name), same field
  // the shipper-posted flow already uses for the same purpose.
  numberOfTrucks: { type: Number, default: 1, min: 1 },
  budgetRate: { type: Number, default: null }, // broker's own "budget / expected freight rate" — kept separate from estimatedRate/requestedRate (the shipper-flow pricing fields) so neither flow's pricing logic has to change
  loadingInstructions: { type: String, default: '' },
  unloadingInstructions: { type: String, default: '' },
  specialRequirements: { type: String, default: '' },
  contactPerson: { type: String, default: '' },
  contactPhone: { type: String, default: '' },
  advancePaymentRequired: { type: Boolean, default: false },
  advancePaymentPercent: { type: Number, default: null },
  // Set only by an explicit admin action (see PATCH
  // /api/admin/loads/:token/advance-payment below) — never inferred, so
  // "Advance payment received" SMS/status never fires on a guess.
  advancePaymentReceivedAt: { type: Date, default: null },
  requiredDocuments: { type: [String], default: [] },
  // A broker-posted load starts as a private DRAFT the broker can still
  // edit/cancel freely, and only becomes visible to carriers (BIDDING_OPEN)
  // once the broker explicitly opens it — see POST /api/broker/loads and
  // POST /api/broker/loads/:token/open-bidding below. This never changes
  // what loadStage/status mean for the existing shipper-posted flow (which
  // never sets or reads this field).
  brokerLoadStatus: { type: String, enum: ['DRAFT', 'POSTED', 'CANCELLED'], default: 'DRAFT' },
  cancelledAt: { type: Date, default: null },
  cancelledReason: { type: String, default: '' },
});
// Per the Carrier Bidding spec's required index list (adapted to this
// app's actual field names — Load.status/Load.shipperId become
// loadStage/shipperUsername here, the two fields every bidding query
// actually filters on: "loads currently open for bidding", "a shipper's
// own loads").
bookingRequestSchema.index({ loadStage: 1 });
bookingRequestSchema.index({ shipperUsername: 1 });
// New indexes for the Broker Portal upgrade (spec section 8.5): the fields
// Load Board / Load Matching / Carrier Connect queries actually filter on.
bookingRequestSchema.index({ pickup: 1 });
bookingRequestSchema.index({ destination: 1 });
bookingRequestSchema.index({ requiredTruckType: 1 });
const BookingRequest = mongoose.model('BookingRequest', bookingRequestSchema);

// ---------- Fleet: Truck & Driver (Automated Matching feature) ----------
// Both are owned by a Carrier account (carrierUsername) but are separate
// collections from Registration — a Carrier can onboard many trucks and
// many drivers, unlike the single vehicle/driver fields collected at
// Carrier registration (which continue to work unchanged for backward
// compatibility with existing accounts; new fleet entries are additive).
const truckSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  carrierUsername: { type: String, required: true, index: true },
  vehicleNumber: { type: String, required: true, unique: true, sparse: true },
  // Free text on purpose, NOT a hard-coded enum — any truck type a carrier
  // actually operates can be entered. The UI offers a curated dropdown of
  // common types (Open/Closed/Container/Trailer/Flatbed/Mini/Pickup/...)
  // plus a free-text "Other" option, so the matching engine below works
  // against whatever types exist in this project already.
  truckType: { type: String, required: true },
  capacityTons: { type: Number, required: true },
  bodyType: { type: String, default: '' },
  documentPhotoPath: { type: String, default: '' },
  verified: { type: Boolean, default: false },
  status: { type: String, enum: ['available', 'assigned', 'in_transit', 'maintenance'], default: 'available' },
  // Simple location proxy: a city/place name (used for coarse pickup-
  // distance scoring) plus optional lat/lng if a more precise value is
  // ever available (e.g. carried over from the truck's last GPS ping).
  currentLocation: { type: String, default: '' },
  currentLat: { type: Number, default: null },
  currentLng: { type: Number, default: null },
  assignedDriverId: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});
truckSchema.index({ truckType: 1 });
truckSchema.index({ status: 1 });
const Truck = mongoose.model('Truck', truckSchema);

const driverSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  carrierUsername: { type: String, required: true, index: true },
  name: { type: String, required: true },
  // Login identifier for the driver's own mobile-OTP login (see
  // /api/driver/login/*) — must be unique across all drivers.
  mobileNumber: { type: String, required: true, unique: true, sparse: true },
  // Optional — driver login is mobile-OTP only, so this is never required,
  // but when the carrier provides it (Fleet page), it's used to email the
  // driver assignment/POD-outcome notifications listed in spec section 15.
  // A driver with no email on file simply has those emails logged/skipped
  // (see lib/emailService.js) — never blocks the workflow.
  email: { type: String, default: '' },
  licenseNumber: { type: String, required: true },
  licenseExpiry: { type: Date, required: true },
  verified: { type: Boolean, default: false },
  status: { type: String, enum: ['available', 'on_trip', 'off_duty'], default: 'available' },
  assignedTruckId: { type: String, default: '' },
  // Disciplinary flag, deliberately separate from `status` above (which
  // describes operational state, not conduct) — a blocked driver is
  // ineligible for matching regardless of what `status` says. Toggled by
  // an admin, never by the driver or the matching/trust pipeline itself.
  blocked: { type: Boolean, default: false },
  // ---------- Driver Trust Score (see lib/trustScore.js) ----------
  // `trustScore`/`trustBreakdown` are a cached, fast-to-read snapshot of
  // the last computeTrustScore() result — recomputed and re-saved here
  // every time a trip completes or new feedback is submitted (see
  // recomputeDriverTrust() below). The Feedback collection remains the
  // single source of truth; these two fields exist purely so the
  // matching engine and every list/profile screen can read a driver's
  // trust standing with a single field lookup instead of recomputing it
  // (which needs a Feedback query) on every request.
  trustScore: { type: Number, default: 70 },
  trustBreakdown: { type: mongoose.Schema.Types.Mixed, default: {} },
  // All-time operational counters — incremented by the pipeline itself
  // (trip completion / cancellation), independent of whether the
  // customer ever leaves feedback. Power "127 Completed Trips" and the
  // cancellation-rate component of the trust score.
  completedTrips: { type: Number, default: 0 },
  cancelledCount: { type: Number, default: 0 },
  // Email notification preferences (spec section 17) — see
  // getNotificationPrefs()/DEFAULT_NOTIFICATION_PREFS below. Mixed/free-form
  // on purpose so new categories can be added without a schema migration;
  // every key defaults to true when absent.
  notificationPrefs: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now },
});
const Driver = mongoose.model('Driver', driverSchema);

// ---------- Post-trip Customer Feedback ----------
// One document per completed trip (tokenNo is unique — see the index
// below — so a duplicate submission is rejected server-side, not just
// hidden in the UI). This is the single source of truth the Driver Trust
// Score is computed from; Driver.trustScore/trustBreakdown are a cached
// snapshot, this collection is never overwritten or summarized away.
const feedbackSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  tokenNo: { type: String, required: true, unique: true }, // one feedback per trip
  driverId: { type: String, required: true, index: true },
  truckId: { type: String, default: '' },
  shipperUsername: { type: String, default: '' },
  rating: { type: Number, required: true, min: 1, max: 5 },
  onTime: { type: Boolean, required: true },
  cargoHandling: { type: Boolean, required: true },
  communication: { type: Boolean, required: true },
  deliverySuccess: { type: Boolean, required: true },
  recommend: { type: Boolean, required: true },
  comments: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});
const Feedback = mongoose.model('Feedback', feedbackSchema);

// ---------- Driver Trust Score History ----------
// One snapshot per driver per calendar month (upserted — see
// recomputeDriverTrust()) so the Driver Profile's trend chart has a
// stable, non-noisy timeline ("Jan 86, Feb 88, ...") instead of one point
// per individual feedback submission.
const driverTrustHistorySchema = new mongoose.Schema({
  driverId: { type: String, required: true, index: true },
  monthKey: { type: String, required: true }, // 'YYYY-MM'
  score: { type: Number, required: true },
  updatedAt: { type: Date, default: Date.now },
});
driverTrustHistorySchema.index({ driverId: 1, monthKey: 1 }, { unique: true });
const DriverTrustHistory = mongoose.model('DriverTrustHistory', driverTrustHistorySchema);

// ---------- Tracking History ----------
// One document per GPS ping — kept separate from BookingRequest.lastGps
// (which only holds the single most recent point for fast reads) so the
// full historical route survives after delivery and can be redrawn later.
const trackingPointSchema = new mongoose.Schema({
  tokenNo: { type: String, required: true, index: true },
  truckId: { type: String, default: '', index: true },
  driverId: { type: String, default: '', index: true },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  speedKph: { type: Number, default: null },
  headingDeg: { type: Number, default: null },
  // ---------- GPS tracking system improvements ----------
  // accuracy/altitude are what the browser Geolocation API actually
  // provides alongside lat/lng — collected but not required (older/lower-
  // end devices may omit them). deviceTimestamp is when the FIX itself was
  // taken on the phone (GeolocationPosition.timestamp), which can differ
  // from createdAt (when this server received/persisted it) by a second or
  // more on a slow connection — keeping both lets a delayed queued point
  // (see the offline-queue flush in driver-dashboard.js) still be plotted
  // at its true, original time rather than when it happened to arrive.
  accuracy: { type: Number, default: null },
  altitude: { type: Number, default: null },
  deviceTimestamp: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, index: true }, // server-received timestamp
});
// Compound indexes for the actual query patterns used below (history by
// load over a time range; "all recent pings for this truck/driver" for any
// future fleet-wide view) — spec: "indexes for tokenNo, truck, driver,
// timestamp".
trackingPointSchema.index({ tokenNo: 1, createdAt: 1 });
trackingPointSchema.index({ truckId: 1, createdAt: -1 });
trackingPointSchema.index({ driverId: 1, createdAt: -1 });
const TrackingPoint = mongoose.model('TrackingPoint', trackingPointSchema);

const adminSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  password: String,
  createdAt: { type: Date, default: Date.now },
  createdBy: String,
});
const Admin = mongoose.model('Admin', adminSchema);

// User Complaints (Services > Complaint) — one collection covering both
// logged-in users (username/userType auto-attached server-side from their
// session, never trusted from the client) and anonymous "new user"
// submissions (email required either way).
const complaintSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  username: { type: String, default: '' },
  userType: { type: String, enum: ['existing', 'new'], default: 'new' },
  email: { type: String, required: true },
  message: { type: String, required: true },
  status: { type: String, enum: ['open', 'resolved'], default: 'open' },
  createdAt: { type: Date, default: Date.now },
});
const Complaint = mongoose.model('Complaint', complaintSchema);

// ---------- User Flow / Cookie Consent tracking ----------
// One event per document — a full session's journey is reconstructed by
// querying all documents that share the same sessionId, sorted by
// timestamp. Explicitly mapped to the "USER-FLOW" collection name (hyphens
// are valid in MongoDB collection names) per spec, rather than letting
// Mongoose pluralize/lowercase the model name automatically.
const userFlowSchema = new mongoose.Schema({
  sessionId: { type: String, required: true },
  // Left blank for anonymous visitors — never required, never used to
  // force a login just to record a consent/tracking event.
  userId: { type: String, default: '' },
  username: { type: String, default: '' },
  userType: { type: String, default: 'anonymous' }, // shipper | broker | carrier | admin | anonymous
  eventType: { type: String, required: true },
  action: { type: String, default: '' },
  page: { type: String, default: '' },
  route: { type: String, default: '' },
  previousPage: { type: String, default: '' },
  // Free-form but sanitized server-side (see sanitizeTrackingMetadata) —
  // never field values, passwords, OTPs, tokens, or full Aadhaar/PAN.
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  timestamp: { type: Date, default: Date.now },
}, { collection: 'USER-FLOW' });
const UserFlow = mongoose.model('UserFlow', userFlowSchema, 'USER-FLOW');

// Server-side defense-in-depth: even though the frontend tracking client is
// only ever supposed to send safe, non-sensitive metadata, strip anything
// that looks like a secret before it's ever written to MongoDB.
const SENSITIVE_METADATA_KEY_RE = /pass|otp|aadh|pan\b|card|cvv|token|secret|auth/i;
function sanitizeTrackingMetadata(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const clean = {};
  Object.keys(raw).forEach((key) => {
    if (SENSITIVE_METADATA_KEY_RE.test(key)) return;
    const val = raw[key];
    if (val == null) return;
    if (typeof val === 'object') return; // keep metadata flat and simple
    clean[key] = String(val).slice(0, 200);
  });
  return clean;
}

// Single-document collection holding site-wide toggles (e.g. broker visibility).
const settingsSchema = new mongoose.Schema({
  key: { type: String, default: 'site', unique: true },
  brokerVisible: { type: Boolean, default: true },
});
const Settings = mongoose.model('Settings', settingsSchema);

async function getSettings() {
  let s = await Settings.findOne({ key: 'site' });
  if (!s) s = await Settings.create({ key: 'site', brokerVisible: true });
  return s;
}

// ---------- Fixed super admin credentials ----------
// Per requirements, this ID/password pair is permanent and always valid.
const SUPER_ADMIN_ID = '2410997322';
const SUPER_ADMIN_PASSWORD = '2410997322';

// In-memory session store: token -> adminId.
// Restarting the server clears all sessions (everyone has to log back in) —
// swap this for a real session store / DB-backed sessions in production.
const sessions = new Map();

// Separate in-memory session store for shipper/broker/carrier account logins.
// token -> { role, recordId }
const userSessions = new Map();

// ---------- Helpers ----------

// ---------- KYC: Aadhaar number format check (Verhoeff checksum) ----------
// This only confirms the submitted number is a structurally valid Aadhaar
// number (right length + correct checksum digit). It does NOT verify the
// number belongs to a real person or check it against UIDAI's database —
// that requires UIDAI e-KYC / a licensed AUA-KUA integration.
const VERHOEFF_D = [
  [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
  [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
  [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
  [9,8,7,6,5,4,3,2,1,0],
];
const VERHOEFF_P = [
  [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
  [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
  [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
];
function isValidAadhaarFormat(rawNumber) {
  const digits = String(rawNumber || '').replace(/\s/g, '');
  if (!/^[0-9]{12}$/.test(digits)) return false;
  let c = 0;
  const rev = digits.split('').reverse();
  for (let i = 0; i < rev.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][parseInt(rev[i], 10)]];
  }
  return c === 0;
}

function isValidPAN(v) {
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(v || '').toUpperCase());
}

const GST_CODES = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// Validates a GSTIN's format AND its official checksum (the 15th/last
// character). Input is normalized first — trimmed of surrounding
// whitespace and uppercased — so a genuinely valid GSTIN is never rejected
// just because it was pasted with a stray leading/trailing space or typed
// in lowercase. This is pure local computation (ISO 7064-style mod-36
// checksum defined by GSTN); there is no external GST-verification API
// call anywhere in this app, so there's no API response-handling path to
// misinterpret here.
function isValidGST(raw) {
  const v = String(raw || '').trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const code = GST_CODES.indexOf(v[i]);
    const factor = (i % 2 === 0) ? 1 : 2;
    const val = code * factor;
    sum += Math.floor(val / 36) + (val % 36);
  }
  const checkDigit = GST_CODES[(36 - (sum % 36)) % 36];
  return checkDigit === v[14];
}
// Same normalization isValidGST() applies internally, exposed separately
// so callers can store the canonical (trimmed, uppercased) value rather
// than whatever stray whitespace/casing the person originally typed.
function normalizeGST(raw) {
  return String(raw || '').trim().toUpperCase();
}

// MSME/Udyam registration numbers don't have one universal, stable format
// (older "UAM-XX-00-0000000" vs the newer "UDYAM-XX-00-0000000" scheme, plus
// state-specific variants) the way GST/PAN do, so this is a lenient
// presence + length check rather than a strict pattern/checksum match —
// enough to catch an empty or obviously-too-short value.
function isValidMsme(v) {
  return String(v || '').trim().length >= 8;
}

// IFSC: 4 bank-code letters, a fixed '0' (reserved for future use), then 6
// alphanumeric branch-code characters — standard RBI format, e.g. HDFC0001234.
function isValidIFSC(v) {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(v || '').toUpperCase());
}

// Shared Bank Details validation for Shipper/Broker/Carrier registration —
// returns an error code string (matching the ?error= query param pattern
// already used by these routes) or null if everything checks out.
function validateBankDetails(b) {
  if (!String(b.bankAccountHolder || '').trim()) return 'bank_account_holder_required';
  if (!/^[0-9]{9,18}$/.test(String(b.bankAccountNumber || '').trim())) return 'invalid_bank_account_number';
  if (!isValidIFSC(b.bankIfsc)) return 'invalid_ifsc';
  if (!String(b.bankName || '').trim()) return 'bank_name_required';
  if (!['savings', 'current'].includes(b.bankAccountType)) return 'bank_account_type_required';
  if (!b.bankProofPhotoPath) return 'bank_proof_required';
  return null;
}

// Username is no longer typed by the registrant — it's generated
// automatically (see generateUniqueUsername below) so every account gets a
// unique, primary-key-style identifier without relying on the user to avoid
// duplicates.

// Password: 1-10 characters, must contain at least one uppercase letter
// AND the '@' symbol.
function isValidPassword(v) {
  const s = String(v || '');
  return s.length >= 1 && s.length <= 10 && /[A-Z]/.test(s) && s.includes('@');
}

// ---------- Auto-generated, unique username ----------
// Format: role initial + 9 random digits (e.g. "S482910337"), which is
// short enough to type back in at login but effectively collision-free.
// The DB-level unique index on `username` is the real guarantee — this
// loop just avoids a wasted round trip in the (very rare) collision case.
const ROLE_PREFIX = { shipper: 'S', broker: 'B', carrier: 'C' };
async function generateUniqueUsername(role) {
  const prefix = ROLE_PREFIX[role] || 'U';
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = prefix + String(crypto.randomInt(100000000, 999999999));
    const exists = await Registration.findOne({ username: candidate }).lean();
    if (!exists) return candidate;
  }
  // Extremely unlikely fallback: timestamp-based, still checked by the
  // unique index at save time.
  return prefix + Date.now();
}

// ---------- Unique Token/Order No. (Live Tracking) ----------
// Format: "LS" + 10 random digits (e.g. "LS4820193765") — short enough to
// read/type back at a search bar, effectively collision-free, and the
// DB-level unique index on `tokenNo` is the real guarantee against
// duplicates (this loop just avoids a wasted round trip on the rare clash).
function generateTokenCandidate() {
  return 'LS' + String(crypto.randomInt(1000000000, 9999999999));
}
async function generateUniqueToken() {
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = generateTokenCandidate();
    const exists = await BookingRequest.findOne({ tokenNo: candidate }).lean();
    if (!exists) return candidate;
  }
  // Extremely unlikely fallback: timestamp-based, still checked by the
  // unique index at save time.
  return 'LS' + Date.now();
}

// Escapes a user-supplied search string so it's safe to drop into a RegExp
// (used by every "search by Token No. / city / username" endpoint below).
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- Username validation (Shipper & Carrier choose their own) ----------
// Letters, digits, underscores; must start with a letter; 3-20 characters
// total. Enforced identically on the client (shipper.js / carrier.js) and
// here — this server check is the actual source of truth.
function isValidUsername(v) {
  return /^[a-zA-Z][a-zA-Z0-9_]{2,19}$/.test(String(v || '').trim());
}

// Case-insensitive existence checks. Mongo's own unique index (see
// `username`/`email` on registrationSchema) is the real guarantee against a
// race between two near-simultaneous signups; these pre-checks are what
// turn a normal (non-race) duplicate into a clear, friendly error instead
// of a raw database exception.
async function isUsernameTaken(username) {
  const re = new RegExp('^' + escapeRegex(String(username || '').trim()) + '$', 'i');
  return !!(await Registration.findOne({ username: re }).lean());
}

// "An email address can have only one account" — checked across every role
// (Shipper/Broker/Carrier all live in the same Registration collection), so
// the same person can't end up with two logins under one email address.
async function isEmailAlreadyRegistered(email) {
  const re = new RegExp('^' + escapeRegex(String(email || '').trim()) + '$', 'i');
  return !!(await Registration.findOne({ email: re }).lean());
}

function normalizePhone(countryCode, rawNumber) {
  const cc = String(countryCode || '').replace(/\D/g, ''); // e.g. "91"
  let digits = String(rawNumber || '').replace(/\D/g, '');
  // If the user re-typed the country code inside the number field
  // (e.g. "919588096250" while +91 is already selected), strip it once.
  if (cc && digits.length > 10 && digits.startsWith(cc)) {
    digits = digits.slice(cc.length);
  }
  return '+' + cc + digits;
}

// ---------- Phone validation per country code ----------
// Expected national-number digit length for each supported country flag/code.
// Keeps the flag dropdown honest: +91 must be 10 digits, +1 must be 10, etc.
const PHONE_LENGTH_BY_CC = {
  '91': 10,   // India
  '1': 10,    // USA / Canada
  '44': 10,   // UK
  '61': 9,    // Australia
  '971': 9,   // UAE
  '65': 8,    // Singapore
  '81': 10,   // Japan
  '82': 10,   // South Korea
  '49': 11,   // Germany
  '33': 9,    // France
  '39': 10,   // Italy
  '34': 9,    // Spain
  '86': 11,   // China
  '880': 10,  // Bangladesh
  '92': 10,   // Pakistan
  '94': 9,    // Sri Lanka
  '66': 9,    // Thailand
  '62': 10,   // Indonesia
  '27': 9,    // South Africa
  '55': 11,   // Brazil
};
function isValidPhoneForCountry(countryCode, rawNumber) {
  const cc = String(countryCode || '').replace(/\D/g, '');
  let digits = String(rawNumber || '').replace(/\D/g, '');
  if (cc && digits.length > (PHONE_LENGTH_BY_CC[cc] || 10) && digits.startsWith(cc)) {
    digits = digits.slice(cc.length);
  }
  const expected = PHONE_LENGTH_BY_CC[cc];
  if (!expected) return digits.length >= 7 && digits.length <= 12; // unknown flag: sane fallback
  return digits.length === expected;
}


// ---------- Pincode -> District / State lookup ----------
// Uses India Post's free public API (no API key, no per-call cost) so the
// address section can auto-fill District/State straight from a 6-digit PIN.
function fetchPincodeInfo(pincode) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://api.postalpincode.in/pincode/${pincode}`,
      // Some public APIs/CDNs silently reject or reset connections for
      // requests with no User-Agent header (Node doesn't send one by
      // default) — matching the header already used for the Nominatim
      // call below avoids that class of failure.
      { headers: { 'User-Agent': 'LoadSmart-Pincode/1.0', 'Accept': 'application/json' } },
      (r) => {
        let data = '';
        r.on('data', (chunk) => { data += chunk; });
        r.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Pincode lookup timed out')));
  });
}

app.get('/api/pincode/:code', async (req, res) => {
  const code = String(req.params.code || '').replace(/\D/g, '');
  if (!/^[0-9]{6}$/.test(code)) {
    return res.status(400).json({ error: 'Enter a valid 6-digit PIN code.' });
  }
  try {
    const result = await fetchPincodeInfo(code);
    const entry = Array.isArray(result) ? result[0] : null;
    const postOffice = entry && entry.Status === 'Success' && entry.PostOffice && entry.PostOffice[0];
    if (!postOffice) {
      return res.status(404).json({ error: 'No location found for that PIN code.' });
    }
    res.json({
      pincode: code,
      district: postOffice.District,
      state: postOffice.State,
      area: postOffice.Name,
    });
  } catch (err) {
    // Log the real reason server-side (DNS failure, timeout, bad JSON,
    // etc.) — safe to log, it's just network diagnostics, no user data.
    console.error('Pincode lookup failed for', code, '—', err.message);
    res.status(502).json({ error: 'Could not look up that PIN code right now — please enter district/state manually.' });
  }
});

// ---------- Estimate & Booking (Shipper Portal) ----------
// Same free-API pattern as the PIN code lookup above: geocode pickup/
// destination with OpenStreetMap Nominatim (no key, no cost) and compute
// straight-line (haversine) distance — reused as the one "distance" source
// for both the live estimate and its sample rate chart.
function geocodePlace(place) {
  return new Promise((resolve, reject) => {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(place)}`;
    const req = https.get(url, { headers: { 'User-Agent': 'LoadSmart-Estimate/1.0' } }, (r) => {
      let data = '';
      r.on('data', (chunk) => { data += chunk; });
      r.on('end', () => {
        try {
          const arr = JSON.parse(data);
          if (!Array.isArray(arr) || !arr.length) return reject(new Error(`Could not find location: ${place}`));
          resolve({ lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon) });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Location lookup timed out')));
  });
}
function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// Same geocodePlace() as above, but never throws — used by the Live
// Tracking map, where one unrecognized/blank location string (e.g. no
// currentLocation set yet) should just mean "no marker for that point",
// not a failed API response for the whole order.
async function geocodePlaceSafe(place) {
  if (!place || !String(place).trim()) return null;
  try {
    return await geocodePlace(place);
  } catch (e) {
    return null;
  }
}

app.get('/api/estimate/distance', async (req, res) => {
  const { pickup, destination } = req.query;
  if (!pickup || !destination) {
    return res.status(400).json({ error: 'Pickup and destination are required.' });
  }
  try {
    const [a, b] = await Promise.all([geocodePlace(pickup), geocodePlace(destination)]);
    res.json({ distanceKm: Math.max(1, Math.round(haversineKm(a, b))) });
  } catch (err) {
    res.status(502).json({ error: (err.message || 'Could not calculate distance automatically') + ' — you can enter it manually.' });
  }
});

// Rate formula — deliberately NOT hardcoded per route. Every rate (the live
// estimate AND the sample chart) is derived from this one function using
// distance + material + weight, so there's a single source of truth.
const MATERIAL_RATE_TABLE = {
  'General Cargo':           { base: 5000, perKm: 35, perTon: 400 },
  'Fragile Goods':           { base: 6000, perKm: 42, perTon: 550 },
  'Perishable / Cold Chain': { base: 7000, perKm: 48, perTon: 600 },
  'Heavy Machinery':         { base: 8000, perKm: 55, perTon: 750 },
  'Hazardous Material':      { base: 9000, perKm: 60, perTon: 900 },
  'Livestock':               { base: 6500, perKm: 45, perTon: 500 },
};
const MIN_BARGAIN_REDUCTION = 10000; // ₹ — the maximum a shipper can bargain off the estimate

function calculateEstimatedRate(distanceKm, material, weightTons) {
  const r = MATERIAL_RATE_TABLE[material] || MATERIAL_RATE_TABLE['General Cargo'];
  const raw = r.base + (r.perKm * Number(distanceKm || 0)) + (r.perTon * Number(weightTons || 0));
  return Math.max(0, Math.round(raw / 100) * 100);
}

app.post('/api/estimate/calculate', (req, res) => {
  const distanceKm = Number(req.body.distanceKm);
  const weight = Number(req.body.weight);
  const material = req.body.material;
  if (!distanceKm || distanceKm <= 0) return res.status(400).json({ error: 'Enter a valid distance.' });
  if (!weight || weight <= 0) return res.status(400).json({ error: 'Enter a valid cargo weight.' });
  if (!MATERIAL_RATE_TABLE[material]) return res.status(400).json({ error: 'Select a valid material/cargo type.' });

  const estimatedRate = calculateEstimatedRate(distanceKm, material, weight);
  const minAllowedRate = Math.max(0, estimatedRate - MIN_BARGAIN_REDUCTION);

  // Sample rate chart — same material + weight, a spread of distances,
  // all computed live from the formula above (never hardcoded per route).
  const sampleDistances = Array.from(new Set([100, 250, 500, 750, 1000, 1500, Math.round(distanceKm)])).sort((a, b) => a - b);
  const rateChart = sampleDistances.map((d) => ({ distanceKm: d, estimatedRate: calculateEstimatedRate(d, material, weight) }));

  res.json({ distanceKm, material, weight, estimatedRate, minAllowedRate, rateChart });
});

// Reads the session token from the Authorization header ("Bearer <token>"),
// with a query-string fallback for the few plain GET requests (e.g. an
// <img> tag) that can't attach custom headers. Used instead of a cookie so
// the session lives in the browser tab's sessionStorage on the client side
// — a brand-new tab (or a pasted link opened in a new tab) has no token and
// must log in again, even in the same browser; a cookie would have been
// sent automatically to every tab, which is exactly what we don't want here.
function getBearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  return (req.query && req.query.token) || null;
}

// Reads the shipper's session for JSON API endpoints that don't have a
// :role URL param to key off of — same session store as every other
// shipper/broker/carrier endpoint, just checked inline here.
function getShipperSession(req) {
  const token = getBearerToken(req);
  const session = token && userSessions.get(token);
  return (session && session.role === 'shipper') ? session : null;
}

// Any logged-in shipper/broker/carrier, regardless of role — used by the
// Complaint form to auto-identify an existing user without asking them to
// re-type information the system already knows.
function getAnyUserSession(req) {
  const token = getBearerToken(req);
  return (token && userSessions.get(token)) || null;
}

app.post('/api/estimate/book', async (req, res) => {
  try {
    const session = getShipperSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a shipper first.' });
    const record = await Registration.findOne({ role: 'shipper', id: session.recordId }).lean();
    const { pickup, destination, pickupAddress, destAddress, distanceKm, material, weight, estimatedRate, requiredTruckType, assignmentMode, biddingWindowHours } = req.body;
    if (!pickup || !destination || !distanceKm || !material || !weight || !estimatedRate) {
      return res.status(400).json({ error: 'Missing estimate details — please get an estimate first.' });
    }
    const id = `BOOK-${Date.now()}`;
    const tokenNo = await generateUniqueToken();
    const created = await BookingRequest.create({
      id, kind: 'booking', tokenNo,
      shipperUsername: record && record.username, companyName: record && record.companyName,
      pickup, destination,
      pickupAddress: String(pickupAddress || '').trim(),
      destAddress: String(destAddress || '').trim(),
      distanceKm, material, weight,
      requiredTruckType: String(requiredTruckType || '').trim(),
      estimatedRate, requestedRate: estimatedRate,
      minAllowedRate: Math.max(0, Number(estimatedRate) - MIN_BARGAIN_REDUCTION),
      // ---------- Carrier Bidding System ----------
      // Shipper's own choice, made on the Post a Load screen (defaults to
      // 'bidding' there — see estimate.html/estimate.js). Anything other
      // than the literal string 'bidding' falls back to the existing
      // 'auto_match' behavior, so a malformed/omitted value can never
      // accidentally open a load to bidding.
      assignmentMode: assignmentMode === 'bidding' ? 'bidding' : 'auto_match',
      biddingDeadline: (assignmentMode === 'bidding' && Number(biddingWindowHours) > 0)
        ? new Date(Date.now() + Number(biddingWindowHours) * 60 * 60 * 1000)
        : null,
      tracking: {
        currentLocation: pickup,
        status: 'Booked',
        progressPercent: 0,
        remarks: 'Booking created — awaiting admin confirmation.',
        updatedAt: new Date(),
      },
    });
    // "Book Now" is an immediate booking at the shown estimate — there's
    // already an agreed rate the moment it's posted, so the Load Invoice
    // is generated right away (unlike a rate_request, which only gets its
    // invoice once a rate is actually finalized — see the accept flows
    // below for that case).
    await ensureLoadInvoice(created);
    // ---------- Admin approval gate (spec sections 1-3) ----------
    // Matching now waits for admin approval — same gate a rate_request
    // already had (tryAutoAssignLoad only ever ran there once `status`
    // became 'accepted'). A plain "Book Now" booking used to skip that
    // gate and auto-match immediately; that inconsistency is fixed here so
    // EVERY load — booking or rate request — goes through
    // POSTED (status: pending) -> ADMIN REVIEW -> APPROVED before a
    // driver/carrier is ever matched to it. See /api/rate-requests/:id/status
    // below, which is what actually calls tryAutoAssignLoad once an admin
    // accepts the load.
    notifyLoadPosted(created, record).catch((err) => console.error('notifyLoadPosted failed for', created.tokenNo, '—', err.message));
    res.json({ id, tokenNo });
  } catch (err) {
    console.error('POST /api/estimate/book failed:', err.message);
    res.status(500).json({ error: 'Could not create your booking right now. Please try again.' });
  }
});

// ---------- AI Match Preview (read-only) ----------
// Shows the shipper the same best-candidate the real matching engine
// (computeLoadMatches, defined further down this file — lib/matchingEngine.js
// under the hood) would pick — WITHOUT touching the database. Nothing here
// assigns a truck, reserves a driver, or creates any record; it's a pure
// preview so the "AI recommendation" screen can show real fleet data
// before the shipper commits to posting the load. The actual assignment
// still only happens inside tryAutoAssignLoad, triggered from
// /api/estimate/book exactly as before — this endpoint changes nothing
// about that existing pipeline, and reuses the exact same engine so the
// preview can never disagree with what actually gets matched a moment
// later at booking time.
app.post('/api/estimate/match-preview', async (req, res) => {
  try {
    const session = getShipperSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a shipper first.' });
    const { pickup, weight, requiredTruckType } = req.body;
    if (!pickup || !weight) return res.status(400).json({ error: 'Missing shipment details.' });
    const loadStub = { pickup, weight: Number(weight), requiredTruckType: String(requiredTruckType || '').trim() };

    const { eligible } = await computeLoadMatches(loadStub);

    if (!eligible.length) {
      return res.json({
        matched: false,
        reason: 'No verified, available truck currently meets this load\'s capacity, type, and documentation requirements.',
      });
    }

    const best = eligible[0];
    const pickupNorm = String(pickup).trim().toLowerCase();
    const truckLocNorm = String(best.currentLocation || '').trim().toLowerCase();
    const nearPickup = !!(pickupNorm && truckLocNorm && (truckLocNorm === pickupNorm || truckLocNorm.includes(pickupNorm) || pickupNorm.includes(truckLocNorm)));

    res.json({
      matched: true,
      matchScore: best.matchScore,
      truck: { vehicleNumber: best.vehicleNumber, truckType: best.truckType, capacityTons: best.capacityTons, currentLocation: best.currentLocation || '' },
      driver: { name: best.driverName },
      nearPickup,
      reasons: best.reasons,
      alternateCount: Math.max(0, eligible.length - 1),
    });
  } catch (err) {
    console.error('POST /api/estimate/match-preview failed:', err.message);
    res.status(500).json({ error: 'Could not run AI matching right now. Please try again.' });
  }
});

// Active carriers & brokers, shown to the shipper as the "Rate Request
// Listing" — real registered service providers, not fabricated data.
// Only public, non-sensitive fields are returned.
app.get('/api/estimate/providers', async (req, res) => {
  const session = getShipperSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a shipper first.' });
  const [carriers, brokers] = await Promise.all([
    Registration.find({ role: 'carrier', active: { $ne: false } })
      .select('username companyName contactPerson phoneNumber vehicleCapacity submittedAt')
      .sort({ submittedAt: -1 }).lean(),
    Registration.find({ role: 'broker', active: { $ne: false } })
      .select('username companyName contactPerson phoneNumber submittedAt')
      .sort({ submittedAt: -1 }).lean(),
  ]);
  const shape = (role) => (r) => ({
    role,
    username: r.username,
    companyName: r.companyName || r.contactPerson || r.username,
    contactPerson: r.contactPerson || '',
    phoneNumber: r.phoneNumber || '',
    vehicleCapacity: r.vehicleCapacity || '',
    submittedAt: r.submittedAt,
  });
  res.json({
    carriers: carriers.map(shape('carrier')),
    brokers: brokers.map(shape('broker')),
  });
});

app.post('/api/estimate/rate-request', async (req, res) => {
  try {
    const session = getShipperSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a shipper first.' });
    const record = await Registration.findOne({ role: 'shipper', id: session.recordId }).lean();
    const { pickup, destination, pickupAddress, destAddress, distanceKm, material, weight, estimatedRate, requestedRate, carrierUsername, brokerUsername, assignmentMode, biddingWindowHours } = req.body;
    if (!pickup || !destination || !distanceKm || !material || !weight || !estimatedRate || requestedRate === undefined) {
      return res.status(400).json({ error: 'Missing estimate details — please get an estimate first.' });
    }
    const minAllowedRate = Math.max(0, Number(estimatedRate) - MIN_BARGAIN_REDUCTION);
    // The shipper now types in their own rate directly (no auto-calculated
    // price is shown to them on this screen) — so the only server-side rule
    // left is "a valid number greater than zero". `estimatedRate`/
    // `minAllowedRate` are still computed and stored purely as internal
    // reference figures for Admin's table, not as a client-facing bound.
    const requested = Number(requestedRate);
    if (!requested || requested <= 0) {
      return res.status(400).json({ error: 'Enter a valid rate greater than zero.' });
    }

    // Optional: the shipper picked a listing from the Rate Request Listing
    // screen — attach that carrier/broker to the request right away (same
    // fields Admin's Tracking module already uses for assignment, so there
    // is only ever one place this relationship lives).
    let carrierUsernameToSave = '';
    let carrierCompanyNameToSave = '';
    if (carrierUsername) {
      const carrier = await Registration.findOne({ role: 'carrier', username: carrierUsername, active: { $ne: false } }).lean();
      if (!carrier) return res.status(400).json({ error: 'That carrier is no longer available — please pick another.' });
      carrierUsernameToSave = carrier.username;
      carrierCompanyNameToSave = carrier.companyName || carrier.contactPerson || carrier.username;
    }
    let brokerUsernameToSave = '';
    let brokerCompanyNameToSave = '';
    if (brokerUsername) {
      const broker = await Registration.findOne({ role: 'broker', username: brokerUsername, active: { $ne: false } }).lean();
      if (!broker) return res.status(400).json({ error: 'That broker is no longer available — please pick another.' });
      brokerUsernameToSave = broker.username;
      brokerCompanyNameToSave = broker.companyName || broker.contactPerson || broker.username;
    }

    const id = `RATE-${Date.now()}`;
    const tokenNo = await generateUniqueToken();
    const created = await BookingRequest.create({
      id, kind: 'rate_request', tokenNo,
      shipperUsername: record && record.username, companyName: record && record.companyName,
      pickup, destination,
      pickupAddress: String(pickupAddress || '').trim(),
      destAddress: String(destAddress || '').trim(),
      distanceKm, material, weight,
      estimatedRate: Number(estimatedRate), requestedRate: requested, minAllowedRate,
      carrierUsername: carrierUsernameToSave, carrierCompanyName: carrierCompanyNameToSave,
      brokerUsername: brokerUsernameToSave, brokerCompanyName: brokerCompanyNameToSave,
      // See the matching comment in /api/estimate/book above.
      assignmentMode: assignmentMode === 'bidding' ? 'bidding' : 'auto_match',
      biddingDeadline: (assignmentMode === 'bidding' && Number(biddingWindowHours) > 0)
        ? new Date(Date.now() + Number(biddingWindowHours) * 60 * 60 * 1000)
        : null,
      tracking: {
        currentLocation: pickup,
        status: 'Booked',
        progressPercent: 0,
        remarks: '',
        updatedAt: new Date(),
      },
    });
    // Confirms the write actually landed in MongoDB before telling the
    // shipper it succeeded — belt-and-braces on top of the try/catch below,
    // directly per "do not falsely show success if the database operation
    // failed".
    console.log('Rate request saved:', created.id, created.tokenNo, '— now visible to Admin > Rate Requests.');
    notifyLoadPosted(created, record).catch((err) => console.error('notifyLoadPosted failed for', created.tokenNo, '—', err.message));
    res.json({ id, tokenNo });
  } catch (err) {
    console.error('POST /api/estimate/rate-request failed:', err.message);
    res.status(500).json({ error: 'Could not submit your rate request right now. Please try again.' });
  }
});

app.get('/api/rate-requests', requireAdmin, async (req, res) => {
  try {
    const records = await BookingRequest.find().sort({ createdAt: -1 }).lean();
    res.json(records);
  } catch (err) {
    console.error('GET /api/rate-requests failed:', err.message);
    res.status(500).json({ error: 'Could not load rate requests right now. Please try again.' });
  }
});

// Shared by the id-keyed route below (existing admin UI) and the spec-
// shaped tokenNo-keyed aliases (PUT /api/loads/:token/approve|reject) —
// ONE place decides what "admin approves/rejects a load" actually does,
// so the two entry points can never disagree.
// ---------- Carrier Bidding System: open a load for bidding ----------
// The 'bidding' counterpart to tryAutoAssignLoad (defined further down —
// both are only ever invoked from the same two places: the admin-approval
// gate below, and the shipper's counter-rate acceptance). Does NOT touch
// tryAutoAssignLoad, MATCHED, or anything else on the auto-match path —
// see the assignmentMode comment on bookingRequestSchema.
const BIDDING_DEFAULT_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h if the shipper didn't pick a deadline
async function openLoadForBidding(load) {
  load.loadStage = 'BIDDING_OPEN';
  if (!load.biddingDeadline) load.biddingDeadline = new Date(Date.now() + BIDDING_DEFAULT_WINDOW_MS);
  load.biddingOpenedAt = new Date();
  syncTrackingStatusFromLoadStage(load, 'Open for carrier bidding.');
  await load.save();
  await ops.TrackingEvent.create({
    tokenNo: load.tokenNo, type: 'BIDDING_OPEN', label: 'Bidding Opened',
    notes: `Carriers can bid until ${load.biddingDeadline.toLocaleString()}.`,
    createdByRole: 'system', createdAt: new Date(),
  }).catch(() => {});
  notificationService.notify({
    userId: 'admin', userRole: 'admin', loadId: load.tokenNo, type: 'BIDDING_OPEN',
    title: 'Bidding opened', message: `Load ${load.tokenNo} is now open for carrier bidding (closes ${load.biddingDeadline.toLocaleString()}).`,
  }).catch(() => {});
  emitLoadUpdate(load.tokenNo, { loadStage: load.loadStage, biddingDeadline: load.biddingDeadline });
  return load;
}

async function applyLoadApprovalDecision(rec, status, reason, adminId) {
  if (['accepted', 'rejected'].includes(rec.status)) {
    const err = new Error(`This request is already ${rec.status} — no further action needed.`);
    err.status = 409;
    throw err;
  }
  const oldStatus = rec.status;
  rec.status = status;
  rec.rejectionReason = status === 'rejected' ? String(reason || '').trim() : '';
  // Admin accepting the shipper's own requested rate directly (Option A) —
  // that requested rate becomes the final agreed rate.
  if (status === 'accepted') rec.finalRate = rec.requestedRate;
  await rec.save();

  const shipper = rec.shipperUsername ? await Registration.findOne({ role: 'shipper', username: rec.shipperUsername }).lean() : null;

  if (status === 'accepted') {
    // The rate is now finalized — this is the "load is posted" moment for
    // a rate_request (a plain "booking" already generated its invoice at
    // creation time, since it has no negotiation step). This is ALSO now
    // the only point at which a booking's truck/driver matching begins —
    // see the admin-approval-gate comment in /api/estimate/book above.
    await ensureLoadInvoice(rec);
    if (rec.assignmentMode === 'bidding') {
      openLoadForBidding(rec).catch((err) => console.error('openLoadForBidding failed for', rec.tokenNo, '—', err.message));
    } else {
      tryAutoAssignLoad(rec).catch((err) => console.error('tryAutoAssignLoad failed for', rec.tokenNo, '—', err.message));
    }
    if (shipper) emailService.sendLoadApprovedEmail({ to: shipper.email, tokenNo: rec.tokenNo }).catch(() => {});
    if (shipper) notificationService.notify({ userId: shipper.id, userRole: 'shipper', loadId: rec.tokenNo, type: 'LOAD_APPROVED', title: 'Load approved', message: `Your load ${rec.tokenNo} has been approved.` }).catch(() => {});
    await ops.TrackingEvent.create({ tokenNo: rec.tokenNo, type: 'LOAD_APPROVED', label: 'Load Approved', createdByRole: 'admin', createdAt: new Date() }).catch(() => {});
  } else {
    if (shipper) emailService.sendLoadRejectedEmail({ to: shipper.email, tokenNo: rec.tokenNo, reason: rec.rejectionReason }).catch(() => {});
    if (shipper) notificationService.notify({ userId: shipper.id, userRole: 'shipper', loadId: rec.tokenNo, type: 'LOAD_REJECTED', title: 'Load rejected', message: `Your load ${rec.tokenNo} was rejected. Reason: ${rec.rejectionReason || 'Not specified.'}` }).catch(() => {});
    await ops.TrackingEvent.create({ tokenNo: rec.tokenNo, type: 'LOAD_REJECTED', label: 'Load Rejected', notes: rec.rejectionReason, createdByRole: 'admin', createdAt: new Date() }).catch(() => {});
  }
  logActivity({
    loadId: rec.tokenNo, userId: adminId || '', userRole: 'admin', action: status === 'accepted' ? 'LOAD_APPROVED' : 'LOAD_REJECTED',
    oldStatus, newStatus: rec.status, metadata: { reason: rec.rejectionReason || undefined },
  }).catch(() => {});
  return rec;
}

app.post('/api/rate-requests/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status, reason } = req.body;
    if (!['pending', 'accepted', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status must be pending, accepted, or rejected.' });
    }
    const rec = await BookingRequest.findOne({ id: req.params.id });
    if (!rec) return res.status(404).json({ error: 'Not found' });
    await applyLoadApprovalDecision(rec, status, reason, req.adminId);
    res.json({ id: rec.id, status: rec.status, rejectionReason: rec.rejectionReason, finalRate: rec.finalRate });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /api/rate-requests/:id/status failed:', err.message);
    res.status(500).json({ error: 'Could not update the request status right now. Please try again.' });
  }
});

// Spec-shaped aliases, keyed by Load ID (tokenNo) rather than the internal
// Mongo `id` — same underlying decision logic as the route above (see
// applyLoadApprovalDecision), just addressed the way spec section 28 asks
// for. Only 'accepted'/'rejected' make sense as an explicit approve/reject
// action (unlike the generic status route above, which also allows
// resetting back to 'pending').
app.put('/api/loads/:token/approve', requireAdmin, async (req, res) => {
  try {
    const rec = await BookingRequest.findOne({ tokenNo: req.params.token });
    if (!rec) return res.status(404).json({ error: 'Load not found.' });
    await applyLoadApprovalDecision(rec, 'accepted', '', req.adminId);
    res.json({ tokenNo: rec.tokenNo, status: rec.status, finalRate: rec.finalRate });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('PUT /api/loads/:token/approve failed:', err.message);
    res.status(500).json({ error: 'Could not approve this load right now. Please try again.' });
  }
});
app.put('/api/loads/:token/reject', requireAdmin, async (req, res) => {
  try {
    const rec = await BookingRequest.findOne({ tokenNo: req.params.token });
    if (!rec) return res.status(404).json({ error: 'Load not found.' });
    if (!req.body || !String(req.body.reason || '').trim()) {
      return res.status(400).json({ error: 'A rejection reason is required.' });
    }
    await applyLoadApprovalDecision(rec, 'rejected', req.body.reason, req.adminId);
    res.json({ tokenNo: rec.tokenNo, status: rec.status, rejectionReason: rec.rejectionReason });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('PUT /api/loads/:token/reject failed:', err.message);
    res.status(500).json({ error: 'Could not reject this load right now. Please try again.' });
  }
});

// Admin proposes its own rate on a shipper's rate request (Option B) — sent
// back to the same request/token, shown to the shipper on their Request
// page as "Admin Counter Rate", awaiting the shipper's Accept/Reject.
app.post('/api/rate-requests/:id/counter-offer', requireAdmin, async (req, res) => {
  try {
    const rate = Number(req.body.rate);
    if (!rate || rate <= 0) return res.status(400).json({ error: 'Enter a valid counter-offer rate.' });
    const rec = await BookingRequest.findOne({ id: req.params.id });
    if (!rec) return res.status(404).json({ error: 'Not found' });
    if (['accepted', 'rejected'].includes(rec.status)) {
      return res.status(409).json({ error: `This request is already ${rec.status} — no further action needed.` });
    }
    rec.adminOfferedRate = rate;
    rec.status = 'countered';
    await rec.save();
    res.json({ id: rec.id, status: rec.status, adminOfferedRate: rec.adminOfferedRate });
  } catch (err) {
    console.error('POST /api/rate-requests/:id/counter-offer failed:', err.message);
    res.status(500).json({ error: 'Could not send the counter rate right now. Please try again.' });
  }
});

// Admin marks an uploaded invoice as valid/invalid after reviewing it —
// purely a review flag; it doesn't gate anything on its own (the actual
// hard gate is "an invoice file must be present at all" before Picked Up,
// enforced in the tracking-update endpoint above).
app.post('/api/rate-requests/:id/verify-invoice', requireAdmin, async (req, res) => {
  try {
    const { valid } = req.body;
    if (typeof valid !== 'boolean') return res.status(400).json({ error: '"valid" must be true or false.' });
    const rec = await BookingRequest.findOne({ id: req.params.id });
    if (!rec) return res.status(404).json({ error: 'Not found' });
    if (!rec.invoicePath) return res.status(400).json({ error: 'No invoice has been uploaded for this request yet.' });
    rec.invoiceVerified = valid;
    await rec.save();
    res.json({ id: rec.id, invoiceVerified: rec.invoiceVerified });
  } catch (err) {
    console.error('POST /api/rate-requests/:id/verify-invoice failed:', err.message);
    res.status(500).json({ error: 'Could not update invoice verification right now. Please try again.' });
  }
});

// Shipper's response to Admin's counter rate — Accept locks in the final
// rate and marks the request Accepted; Reject closes it out as Rejected.
// Kept on the same request document (same id/tokenNo) — never a new record.
app.post('/api/my-bookings/:id/counter-response', async (req, res) => {
  const session = getShipperSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a shipper first.' });
  const { action } = req.body;
  if (!['accept', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Action must be accept or reject.' });
  }
  const record = await Registration.findOne({ role: 'shipper', id: session.recordId }).lean();
  const rec = await BookingRequest.findOne({ id: req.params.id });
  if (!rec || !record || rec.shipperUsername !== record.username) {
    return res.status(404).json({ error: 'Request not found.' });
  }
  if (rec.status !== 'countered') {
    return res.status(409).json({ error: 'There is no admin counter rate awaiting your response on this request.' });
  }
  if (action === 'accept') {
    rec.status = 'accepted';
    rec.finalRate = rec.adminOfferedRate;
  } else {
    rec.status = 'rejected';
    rec.rejectionReason = 'Shipper rejected the admin counter rate.';
  }
  await rec.save();
  // Same "load is posted" moment as the direct-accept path above — the
  // rate is now finalized, so the Load Invoice is generated here.
  if (action === 'accept') {
    await ensureLoadInvoice(rec);
    if (rec.assignmentMode === 'bidding') {
      openLoadForBidding(rec).catch((err) => console.error('openLoadForBidding failed for', rec.tokenNo, '—', err.message));
    } else {
      tryAutoAssignLoad(rec).catch((err) => console.error('tryAutoAssignLoad failed for', rec.tokenNo, '—', err.message));
    }
  }
  res.json({ id: rec.id, status: rec.status, finalRate: rec.finalRate, rejectionReason: rec.rejectionReason });
});

// Shipper uploads the invoice for a finalized load — required by Admin
// before the order can be marked "Picked Up" (truck loaded). Reuses the
// same /api/kyc/upload flow (type: 'invoice') to get a stored file path,
// then this endpoint links that path to the specific booking/rate request.
app.post('/api/my-bookings/:id/upload-invoice', async (req, res) => {
  try {
    const session = getShipperSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a shipper first.' });
    const { invoicePath } = req.body;
    if (!invoicePath || typeof invoicePath !== 'string' || !isKnownDocPath(invoicePath)) {
      return res.status(400).json({ error: 'Please upload the invoice file first.' });
    }
    const record = await Registration.findOne({ role: 'shipper', id: session.recordId }).lean();
    const rec = await BookingRequest.findOne({ id: req.params.id });
    if (!rec || !record || rec.shipperUsername !== record.username) {
      return res.status(404).json({ error: 'Request not found.' });
    }
    if (rec.status !== 'accepted') {
      return res.status(409).json({ error: 'The rate must be finalized (accepted) before uploading an invoice.' });
    }
    rec.invoicePath = invoicePath;
    rec.invoiceUploadedAt = new Date();
    rec.invoiceVerified = false; // any re-upload resets verification — admin must re-check the new file
    await rec.save();
    await claimOrderDocPath(invoicePath, rec.tokenNo);
    res.json({ id: rec.id, invoicePath: rec.invoicePath, invoiceUploadedAt: rec.invoiceUploadedAt });
  } catch (err) {
    console.error('POST /api/my-bookings/:id/upload-invoice failed:', err.message);
    res.status(500).json({ error: 'Could not save your invoice right now. Please try again.' });
  }
});
app.get('/api/my-bookings', async (req, res) => {
  const session = getShipperSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a shipper first.' });
  const record = await Registration.findOne({ role: 'shipper', id: session.recordId }).lean();
  const records = await BookingRequest.find({ shipperUsername: record && record.username }).sort({ createdAt: -1 }).lean();
  res.json(records);
});

// ---------- Order "flow stage" (Posted → Carrier/Driver Assigned →
// In Transit → Delivered → POD Uploaded → Invoice Generated) ----------
// Purely a derived/computed view for display — it does NOT replace or
// change the existing tracking.status enum (Booked/Confirmed/Picked Up/…/
// Delivered), which stays the one source of truth admin edits. This just
// maps that status (plus carrier assignment / POD / invoice presence) onto
// the higher-level flow the business actually thinks in, so the shipper,
// carrier, and admin UIs can all show the same stepper.
const FLOW_STEPS_DEF = [
  { key: 'posted', label: 'Posted' },
  { key: 'assigned', label: 'Carrier / Driver Assigned' },
  { key: 'in_transit', label: 'In Transit' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'pod_uploaded', label: 'POD Uploaded' },
  { key: 'invoice_generated', label: 'Invoice Generated' },
];
function computeFlowStage(order) {
  const trackingStatus = (order.tracking && order.tracking.status) || '';
  const doneMap = {
    posted: true,
    assigned: !!order.carrierUsername,
    in_transit: ['Picked Up', 'In Transit', 'Out for Delivery', 'Delayed', 'Delivered'].includes(trackingStatus),
    delivered: trackingStatus === 'Delivered',
    pod_uploaded: !!order.podPath,
    invoice_generated: !!order.transportInvoicePath,
  };
  const steps = FLOW_STEPS_DEF.map((s) => ({ ...s, done: !!doneMap[s.key] }));
  let currentIndex = -1;
  steps.forEach((s, i) => { if (s.done) currentIndex = i; });
  return { steps, currentIndex };
}

// ---------- Live Tracking (Shipper) ----------
// Shapes a raw BookingRequest doc into the payload the tracking dashboard
// needs — same source record used everywhere else, just trimmed down.
// Async (feedbackSubmitted needs one Feedback lookup by tokenNo, which is
// unique-indexed) — every call site below awaits it.
async function toTrackingSummary(r) {
  let feedbackSubmitted = false;
  if (r.loadStage === 'DELIVERED') {
    feedbackSubmitted = !!(await Feedback.exists({ tokenNo: r.tokenNo }));
  }
  return {
    tokenNo: r.tokenNo,
    kind: r.kind,
    status: r.status,
    pickup: r.pickup,
    destination: r.destination,
    distanceKm: r.distanceKm,
    material: r.material,
    weight: r.weight,
    companyName: r.companyName,
    carrierCompanyName: r.carrierCompanyName || '',
    brokerCompanyName: r.brokerCompanyName || '',
    createdAt: r.createdAt,
    tracking: r.tracking || {},
    invoicePath: r.invoicePath || '',
    invoiceUploadedAt: r.invoiceUploadedAt || null,
    invoiceVerified: !!r.invoiceVerified,
    loadInvoicePath: r.loadInvoicePath || '',
    podPath: r.podPath || '',
    podUploadedAt: r.podUploadedAt || null,
    podVerified: !!r.podVerified,
    podAiCheck: r.podAiCheck && r.podAiCheck.checkedAt ? {
      looksValid: r.podAiCheck.looksValid, confidence: r.podAiCheck.confidence,
      concerns: r.podAiCheck.concerns || [], summary: r.podAiCheck.summary || '',
    } : null,
    transportInvoicePath: r.transportInvoicePath || '',
    flow: computeFlowStage(r),
    // ---------- Post-trip feedback (see /api/tracking/order/:token/feedback) ----------
    loadStage: r.loadStage || '',
    loadStageLabel: statusMachine.STAGE_LABELS[r.loadStage] || r.loadStage || '',
    deliveredAt: r.deliveredAt || null,
    feedbackSubmitted,
    // ---------- Full load-lifecycle workflow additions ----------
    assignedDriverId: r.assignedDriverId || '',
    assignedTruckId: r.assignedTruckId || '',
    assignedBy: r.assignedBy || '',
    assignedAt: r.assignedAt || null,
    driverRejectedReason: r.driverRejectedReason || '',
    delay: r.delay || { active: false },
    deliveryReceiverName: r.deliveryReceiverName || '',
    deliveryReceiverPhone: r.deliveryReceiverPhone || '',
    deliveryNotes: r.deliveryNotes || '',
    deliveryConfirmedAt: r.deliveryConfirmedAt || null,
    podStatus: r.podStatus || 'pending',
    podRejectionReason: r.podRejectionReason || '',
    completedAt: r.completedAt || null,
    rejectionReason: r.rejectionReason || '',
  };
}

// Redacted view of a booking for the PUBLIC phone-number tracking lookup
// below — deliberately a much smaller field set than toTrackingSummary()
// (no invoice/POD paths, no company names, no financial figures) since
// this is reachable with no login at all, just a phone number. Enough to
// show "where is my shipment right now", nothing a visitor couldn't
// already infer from asking the shipper directly.
function toPublicTrackingSummary(r) {
  const t = r.tracking || {};
  return {
    tokenNo: r.tokenNo,
    pickup: r.pickup,
    destination: r.destination,
    material: r.material,
    weight: r.weight,
    createdAt: r.createdAt,
    status: t.status || 'Booked',
    currentLocation: t.currentLocation || '',
    remarks: t.remarks || '',
    updatedAt: t.updatedAt || null,
    flow: computeFlowStage(r),
  };
}

// ---------- Public tracking by phone number (no login required) ----------
// A second way in alongside the shipper-login-gated tracking above and the
// homepage's Token No. box (which stays exactly as it was — an
// illustrative demo, see public/assets/site-enhance.js LSTracker). This
// endpoint is REAL: it looks up actual shipments by the shipper's
// registered mobile number. Because it needs no login, the response is
// intentionally redacted (toPublicTrackingSummary above) and capped to the
// most recent 25 orders — enough for a visitor to check their own
// shipment's status without exposing invoices, POD, company details, or
// anyone else's account information.
app.get('/api/tracking/public/by-phone', async (req, res) => {
  try {
    const digits = String(req.query.phone || '').replace(/\D/g, '');
    if (digits.length < 7) {
      return res.status(400).json({ error: 'Enter at least the last 7 digits of your registered mobile number.' });
    }
    // Registration.phoneNumber is always stored as "+<countryCode><digits>"
    // (see normalizePhone) — matching on the DIGIT SUFFIX means a visitor
    // can type their number with or without the country code, and with or
    // without spaces/dashes, and it still matches.
    const suffixRe = new RegExp(escapeRegex(digits) + '$');
    const shippers = await Registration.find({ role: 'shipper', phoneNumber: suffixRe }).select('username').lean();
    if (!shippers.length) {
      return res.json({ found: false, orders: [] });
    }
    const usernames = shippers.map((s) => s.username);
    const records = await BookingRequest.find({ shipperUsername: { $in: usernames } }).sort({ createdAt: -1 }).limit(25).lean();
    res.json({ found: true, orders: records.map(toPublicTrackingSummary) });
  } catch (err) {
    // This route is reachable with no login at all, so — unlike most
    // routes in this file — it gets an explicit try/catch: a DB hiccup
    // should return a clean error to an anonymous visitor, not leave
    // their request hanging with no response.
    console.error('GET /api/tracking/public/by-phone failed:', err.message);
    res.status(503).json({ error: 'Could not look up shipments right now. Please try again in a moment.' });
  }
});

// All of the logged-in shipper's trackable orders — the list shown on
// the Live Tracking dashboard by default (before any search).
//
// IMPORTANT: this does NOT filter by `kind` or `status`. Both a "booking"
// and a "rate_request" get a Token No. and a tracking sub-object the
// moment they're created (see /api/estimate/book and
// /api/estimate/rate-request), and Admin's Tracking module lets Admin
// open and update either kind. Filtering this list down to only
// `kind: 'booking'` (or requiring `status: 'accepted'`) meant Admin's
// tracking updates on a rate request would never reach the shipper here —
// that mismatch was the actual root cause of "Admin updates tracking but
// Shipper's dashboard doesn't show it." `status` and `kind` describe the
// separate rate-negotiation workflow, not tracking eligibility.
app.get('/api/tracking/my-active', async (req, res) => {
  const session = getShipperSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a shipper first.' });
  const record = await Registration.findOne({ role: 'shipper', id: session.recordId }).lean();
  const records = await BookingRequest.find({
    shipperUsername: record && record.username,
  }).sort({ createdAt: -1 }).lean();
  res.json(await Promise.all(records.map(toTrackingSummary)));
});

// Search the shipper's own orders by Token/Order No. OR From→To city.
// Same fix as above — no kind/status gate.
app.get('/api/tracking/search', async (req, res) => {
  const session = getShipperSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a shipper first.' });
  const record = await Registration.findOne({ role: 'shipper', id: session.recordId }).lean();
  const { tokenNo, from, to } = req.query;
  const query = { shipperUsername: record && record.username };
  if (tokenNo && String(tokenNo).trim()) query.tokenNo = new RegExp(escapeRegex(String(tokenNo).trim()), 'i');
  if (from && String(from).trim()) query.pickup = new RegExp(escapeRegex(String(from).trim()), 'i');
  if (to && String(to).trim()) query.destination = new RegExp(escapeRegex(String(to).trim()), 'i');
  const records = await BookingRequest.find(query).sort({ createdAt: -1 }).lean();
  res.json(await Promise.all(records.map(toTrackingSummary)));
});

// Full live-tracking detail for one order — Token No. is the primary
// lookup key, scoped to the logged-in shipper's own bookings.
// Shared by both the shipper and admin order-detail routes: geocodes
// origin/destination, prefers real driver GPS over a geocoded location
// string for "current position" when available, and — new — surfaces the
// live-tracking metadata (speed/heading/accuracy/vehicle/staleness) an
// authorized viewer's map/UI needs, without either route recomputing this
// logic on its own.
async function attachLiveGpsSummary(summary, order) {
  const [originCoords, destCoords, currentCoords] = await Promise.all([
    geocodePlaceSafe(order.pickup),
    geocodePlaceSafe(order.destination),
    geocodePlaceSafe(order.tracking && order.tracking.currentLocation),
  ]);
  const lastGps = order.lastGps && order.lastGps.lat != null && order.lastGps.lng != null ? order.lastGps : null;
  const liveGpsCoords = lastGps ? { lat: lastGps.lat, lon: lastGps.lng } : null;
  const staleness = gpsValidation.classifyStaleness(lastGps && lastGps.updatedAt);
  let vehicleNumber = null;
  if (order.assignedTruckId) {
    const truck = await Truck.findOne({ id: order.assignedTruckId }).select('vehicleNumber').lean();
    vehicleNumber = truck && truck.vehicleNumber;
  }
  summary.mapCoords = { origin: originCoords, destination: destCoords, current: liveGpsCoords || currentCoords };
  summary.hasLiveGps = !!liveGpsCoords;
  summary.liveGps = lastGps ? {
    lat: lastGps.lat, lng: lastGps.lng, speedKph: lastGps.speedKph, headingDeg: lastGps.headingDeg,
    accuracy: lastGps.accuracy, altitude: lastGps.altitude, updatedAt: lastGps.updatedAt,
    vehicleNumber,
    trackingSessionActive: !!order.trackingSessionActive,
    status: !order.trackingSessionActive ? 'not_active' : staleness.status,
    staleMs: staleness.staleMs,
  } : {
    trackingSessionActive: !!order.trackingSessionActive,
    status: order.trackingSessionActive ? 'no_data' : 'not_active',
    staleMs: null,
  };
  return summary;
}

app.get('/api/tracking/order/:token', async (req, res) => {
  const session = getShipperSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a shipper first.' });
  const record = await Registration.findOne({ role: 'shipper', id: session.recordId }).lean();
  const order = await BookingRequest.findOne({ tokenNo: req.params.token, shipperUsername: record && record.username }).lean();
  if (!order) return res.status(404).json({ error: 'No order found for that Token No.' });
  const summary = await attachLiveGpsSummary(await toTrackingSummary(order), order);
  res.json(summary);
});

// ---------- Post-trip Customer Feedback ----------
// Triggered client-side the moment a shipper's Live Tracking page shows
// loadStage === 'DELIVERED' && !feedbackSubmitted (see toTrackingSummary
// above) — a "Rate your delivery" prompt. Always persisted server-side
// (never frontend-only, per spec): validated here, saved to the Feedback
// collection, and immediately folded into the driver's Trust Score so it
// affects future matching right away.
app.post('/api/tracking/order/:token/feedback', async (req, res) => {
  const session = getShipperSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a shipper first.' });
  const record = await Registration.findOne({ role: 'shipper', id: session.recordId }).lean();
  const load = await BookingRequest.findOne({ tokenNo: req.params.token, shipperUsername: record && record.username }).lean();
  if (!load) return res.status(404).json({ error: 'No order found for that Token No.' });
  if (load.loadStage !== 'DELIVERED') {
    return res.status(409).json({ error: 'Feedback can only be left once this shipment has been delivered.' });
  }
  if (!load.assignedDriverId) {
    return res.status(409).json({ error: 'No driver is linked to this shipment — feedback cannot be recorded.' });
  }
  // One feedback per trip — the schema's unique index on tokenNo is the
  // real guarantee (survives a race between two tabs); this check just
  // gives a friendlier error message on the common case.
  const already = await Feedback.exists({ tokenNo: load.tokenNo });
  if (already) return res.status(409).json({ error: 'Feedback has already been submitted for this delivery.' });

  const b = req.body || {};
  const rating = Number(b.rating);
  const boolFields = ['onTime', 'cargoHandling', 'communication', 'deliverySuccess', 'recommend'];
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Please provide a star rating from 1 to 5.' });
  }
  for (const f of boolFields) {
    if (typeof b[f] !== 'boolean') {
      return res.status(400).json({ error: `Please answer every question (missing "${f}").` });
    }
  }

  try {
    await Feedback.create({
      id: 'FB-' + Date.now() + '-' + crypto.randomInt(1000, 9999),
      tokenNo: load.tokenNo,
      driverId: load.assignedDriverId,
      truckId: load.assignedTruckId || '',
      shipperUsername: record && record.username,
      rating,
      onTime: b.onTime,
      cargoHandling: b.cargoHandling,
      communication: b.communication,
      deliverySuccess: b.deliverySuccess,
      recommend: b.recommend,
      comments: String(b.comments || '').slice(0, 1000),
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Feedback has already been submitted for this delivery.' });
    }
    console.error('Feedback save failed:', err.message);
    return res.status(500).json({ error: 'Could not save your feedback right now. Please try again.' });
  }

  // Save -> recalculate driver metrics -> update Trust Score -> update
  // profile -> feed into future matching, all in this one request per the
  // spec's required post-feedback pipeline.
  const trust = await recomputeDriverTrust(load.assignedDriverId);
  res.json({ ok: true, trustScore: trust ? trust.score : null });
});

// ---------- Admin Tracking Module (Shipper / Carrier / Broker sections) ----------

// Search shippers/carriers/brokers by username or company name. With no
// query, returns every registered account for that role (used to populate
// the initial list in each tab of the Admin Tracking module).
app.get('/api/admin/tracking/:role(shipper|carrier|broker)/search', requireAdmin, async (req, res) => {
  const role = req.params.role;
  const q = String(req.query.q || '').trim();
  const filter = { role };
  if (q) {
    const re = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ username: re }, { companyName: re }, { contactPerson: re }];
  }
  const records = await Registration.find(filter).select('-password -confirmPassword').sort({ submittedAt: -1 }).lean();
  res.json(records);
});

// Orders linked to a given shipper/carrier/broker (matched by username),
// with optional Token No. / From→To city search — the "selecting an
// account opens its orders" step of the Admin Tracking module.
const ROLE_ORDER_FIELD = { shipper: 'shipperUsername', carrier: 'carrierUsername', broker: 'brokerUsername' };
app.get('/api/admin/tracking/:role(shipper|carrier|broker)/:username/orders', requireAdmin, async (req, res) => {
  const field = ROLE_ORDER_FIELD[req.params.role];
  const query = { [field]: req.params.username };
  const { tokenNo, from, to } = req.query;
  if (tokenNo && String(tokenNo).trim()) query.tokenNo = new RegExp(escapeRegex(String(tokenNo).trim()), 'i');
  if (from && String(from).trim()) query.pickup = new RegExp(escapeRegex(String(from).trim()), 'i');
  if (to && String(to).trim()) query.destination = new RegExp(escapeRegex(String(to).trim()), 'i');
  const records = await BookingRequest.find(query).sort({ createdAt: -1 }).lean();
  res.json(records);
});

// Full order/tracking detail by Token No. — same one record used across
// every module, so admin always sees exactly what the shipper sees (plus
// the manual-update controls, rendered client-side).
app.get('/api/admin/tracking/order/:token', requireAdmin, async (req, res) => {
  const order = await BookingRequest.findOne({ tokenNo: req.params.token }).lean();
  if (!order) return res.status(404).json({ error: 'No order found for that Token No.' });
  const summary = await attachLiveGpsSummary({ ...order, flow: computeFlowStage(order) }, order);
  res.json(summary);
});

// Manual tracking update — the single place admin edits an order's live
// location/status/progress/remarks, and optionally (re)assigns a carrier
// and/or broker. Writes directly onto the existing BookingRequest doc
// (matched by its unique tokenNo), so there is never more than one
// tracking record per order — nothing else to keep in sync.
app.post('/api/admin/tracking/order/:token/update', requireAdmin, async (req, res) => {
  const order = await BookingRequest.findOne({ tokenNo: req.params.token });
  if (!order) return res.status(404).json({ error: 'No order found for that Token No.' });

  const { currentLocation, status, progressPercent, destination, remarks, vehicleInfo, carrierUsername, brokerUsername } = req.body;
  const allowedStatuses = ['Booked', 'Confirmed', 'Picked Up', 'In Transit', 'Out for Delivery', 'Delayed', 'Delivered'];

  if (!order.tracking) order.tracking = {};

  if (status !== undefined && status !== '') {
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid tracking status.' });
    }
    // Invoice must be uploaded (by the shipper) and present on file before
    // the truck can be marked as loaded/picked up — this is the actual
    // enforcement point for that requirement, right where the status
    // transition happens, so it can't be bypassed from the frontend.
    const pickedUpOrLater = ['Picked Up', 'In Transit', 'Out for Delivery', 'Delayed', 'Delivered'];
    if (pickedUpOrLater.includes(status) && !order.invoicePath) {
      return res.status(409).json({ error: 'The shipper has not uploaded an invoice for this load yet — it must be uploaded before the truck can be marked as loaded.' });
    }
    order.tracking.status = status;
  }
  if (currentLocation !== undefined) order.tracking.currentLocation = String(currentLocation).trim();
  if (remarks !== undefined) order.tracking.remarks = String(remarks).trim();
  if (vehicleInfo !== undefined) order.tracking.vehicleInfo = String(vehicleInfo).trim();
  if (progressPercent !== undefined && progressPercent !== '') {
    const p = Number(progressPercent);
    if (Number.isNaN(p) || p < 0 || p > 100) {
      return res.status(400).json({ error: 'Progress must be a number between 0 and 100.' });
    }
    order.tracking.progressPercent = p;
  }
  if (destination !== undefined && String(destination).trim()) {
    order.destination = String(destination).trim();
  }
  order.tracking.updatedAt = new Date();

  if (carrierUsername !== undefined) {
    if (carrierUsername) {
      const carrier = await Registration.findOne({ role: 'carrier', username: carrierUsername }).lean();
      if (!carrier) return res.status(400).json({ error: 'Unknown carrier username.' });
      order.carrierUsername = carrier.username;
      order.carrierCompanyName = carrier.companyName || carrier.contactPerson || carrier.username;
    } else {
      order.carrierUsername = '';
      order.carrierCompanyName = '';
    }
  }
  if (brokerUsername !== undefined) {
    if (brokerUsername) {
      const broker = await Registration.findOne({ role: 'broker', username: brokerUsername }).lean();
      if (!broker) return res.status(400).json({ error: 'Unknown broker username.' });
      order.brokerUsername = broker.username;
      order.brokerCompanyName = broker.companyName || broker.contactPerson || broker.username;
    } else {
      order.brokerUsername = '';
      order.brokerCompanyName = '';
    }
  }

  await order.save();
  res.json({ ...order.toObject(), flow: computeFlowStage(order) });
});

// Admin marks an uploaded POD as valid/invalid after reviewing it (spec
// section 13). `podVerified` (pre-existing boolean) is kept in sync
// alongside the new, richer `podStatus` so every existing screen that
// already reads podVerified keeps working unchanged. Approving is also
// the ONE thing that moves a load all the way to loadStage COMPLETED —
// the final step of the whole lifecycle (spec section 1's "LOAD
// COMPLETED"); rejecting clears podPath so the driver's POD-upload screen
// treats it as awaiting a fresh upload (spec section 13: "Allow driver to
// upload corrected POD").
async function podApprovalHandler(req, res) {
  try {
    const { valid } = req.body;
    if (typeof valid !== 'boolean') return res.status(400).json({ error: '"valid" must be true or false.' });
    const rec = await BookingRequest.findOne({ tokenNo: req.params.token });
    if (!rec) return res.status(404).json({ error: 'Not found' });
    if (!rec.podPath) return res.status(400).json({ error: 'No POD has been uploaded for this order yet.' });
    rec.podVerified = valid;
    rec.podRejectionReason = valid ? '' : String(req.body.reason || '').trim();
    rec.podStatus = valid ? 'approved' : 'rejected';

    const [driver, shipper] = await Promise.all([
      rec.assignedDriverId ? Driver.findOne({ id: rec.assignedDriverId }).lean() : null,
      rec.shipperUsername ? Registration.findOne({ role: 'shipper', username: rec.shipperUsername }).lean() : null,
    ]);
    const truck = rec.assignedTruckId ? await Truck.findOne({ id: rec.assignedTruckId }).lean() : null;

    if (valid) {
      rec.loadStage = 'COMPLETED';
      rec.completedAt = new Date();
      await rec.save();
      emailService.sendPODApprovedEmail({ to: shipper && shipper.email, tokenNo: rec.tokenNo }).catch(() => {});
      emailService.sendLoadCompletedShipperEmail({
        to: shipper && shipper.email, tokenNo: rec.tokenNo, driverName: driver && driver.name, vehicleNumber: truck && truck.vehicleNumber,
        pickup: rec.pickup, destination: rec.destination, deliveryDate: rec.deliveryConfirmedAt || rec.deliveredAt,
      }).catch(() => {});
      if (driver) emailService.sendLoadCompletedDriverEmail({ to: driver.email, tokenNo: rec.tokenNo }).catch(() => {});
      if (shipper) notificationService.notify({ userId: shipper.id, userRole: 'shipper', loadId: rec.tokenNo, type: 'POD_APPROVED', title: 'POD approved — load completed', message: `POD approved. Load ${rec.tokenNo} is completed.` }).catch(() => {});
      if (driver) notificationService.notify({ userId: driver.id, userRole: 'driver', loadId: rec.tokenNo, type: 'POD_APPROVED', title: 'POD approved — load completed', message: `Your POD for Load ${rec.tokenNo} was approved. Load completed.` }).catch(() => {});
      notificationService.notify({ userId: 'admin', userRole: 'admin', loadId: rec.tokenNo, type: 'LOAD_COMPLETED', title: 'Load completed', message: `Load ${rec.tokenNo} is now fully completed.` }).catch(() => {});
      await ops.TrackingEvent.create({ tokenNo: rec.tokenNo, type: 'POD_APPROVED', label: 'POD Approved', createdByRole: 'admin', createdAt: new Date() }).catch(() => {});
      await ops.TrackingEvent.create({ tokenNo: rec.tokenNo, type: 'LOAD_COMPLETED', label: 'Load Completed', createdByRole: 'admin', createdAt: new Date() }).catch(() => {});
      logActivity({ loadId: rec.tokenNo, userId: req.adminId || '', userRole: 'admin', action: 'POD_APPROVED', oldStatus: 'DELIVERED', newStatus: 'COMPLETED' }).catch(() => {});
    } else {
      // Clear the file reference so the driver's upload screen sees "no
      // POD on file yet" and can submit a corrected one — the load stays
      // at loadStage DELIVERED throughout (never silently reverted).
      rec.podPath = '';
      rec.podUploadedAt = null;
      await rec.save();
      if (driver) emailService.sendPODRejectedEmail({ to: driver.email, tokenNo: rec.tokenNo, reason: rec.podRejectionReason }).catch(() => {});
      emailService.sendPODRejectedEmail({ to: shipper && shipper.email, tokenNo: rec.tokenNo, reason: rec.podRejectionReason }).catch(() => {});
      if (driver) notificationService.notify({ userId: driver.id, userRole: 'driver', loadId: rec.tokenNo, type: 'POD_REJECTED', title: 'POD rejected', message: `Your POD for Load ${rec.tokenNo} was rejected. Reason: ${rec.podRejectionReason || 'Not specified.'} Please upload a corrected POD.` }).catch(() => {});
      if (shipper) notificationService.notify({ userId: shipper.id, userRole: 'shipper', loadId: rec.tokenNo, type: 'POD_REJECTED', title: 'POD rejected', message: `The POD for Load ${rec.tokenNo} was rejected and a corrected copy is being requested.` }).catch(() => {});
      await ops.TrackingEvent.create({ tokenNo: rec.tokenNo, type: 'POD_REJECTED', label: 'POD Rejected', notes: rec.podRejectionReason, createdByRole: 'admin', createdAt: new Date() }).catch(() => {});
      logActivity({ loadId: rec.tokenNo, userId: req.adminId || '', userRole: 'admin', action: 'POD_REJECTED', metadata: { reason: rec.podRejectionReason } }).catch(() => {});
    }
    emitLoadUpdate(rec.tokenNo, { loadStage: rec.loadStage, podStatus: rec.podStatus });
    res.json({ tokenNo: rec.tokenNo, podVerified: rec.podVerified, podRejectionReason: rec.podRejectionReason, podStatus: rec.podStatus, loadStage: rec.loadStage });
  } catch (err) {
    console.error('POD approval handler failed:', err.message);
    res.status(500).json({ error: 'Could not update POD verification right now. Please try again.' });
  }
}
app.post('/api/admin/tracking/order/:token/verify-pod', requireAdmin, podApprovalHandler);
// Spec-shaped aliases (section 28) — same handler, `valid` pinned per route.
app.put('/api/loads/:token/pod/approve', requireAdmin, (req, res) => { req.body = { ...req.body, valid: true }; return podApprovalHandler(req, res); });
app.put('/api/loads/:token/pod/reject', requireAdmin, (req, res) => {
  if (!req.body || !String(req.body.reason || '').trim()) return res.status(400).json({ error: 'A rejection reason is required.' });
  req.body = { ...req.body, valid: false };
  return podApprovalHandler(req, res);
});

// ---------- Admin override: complete a load without an approved POD ----------
// Explicit escape hatch for spec section 11 ("Do not allow a load to
// become fully completed without POD unless Admin explicitly overrides
// it") and section 23 ("Override status when necessary"). Requires a
// reason and is loudly recorded in the audit log — this is meant for rare
// operational exceptions, not routine use.
app.post('/api/admin/tracking/order/:token/override-complete', requireAdmin, async (req, res) => {
  try {
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to override completion without an approved POD.' });
    const rec = await BookingRequest.findOne({ tokenNo: req.params.token });
    if (!rec) return res.status(404).json({ error: 'Load not found.' });
    if (rec.loadStage === 'COMPLETED') return res.status(409).json({ error: 'This load is already completed.' });
    const oldStage = rec.loadStage;
    rec.loadStage = 'COMPLETED';
    rec.completedAt = new Date();
    rec.completedByOverride = true;
    rec.completedOverrideReason = reason;
    await rec.save();
    await ops.TrackingEvent.create({ tokenNo: rec.tokenNo, type: 'LOAD_COMPLETED', label: 'Load Completed (Admin Override)', notes: reason, createdByRole: 'admin', createdAt: new Date() }).catch(() => {});
    logActivity({ loadId: rec.tokenNo, userId: req.adminId || '', userRole: 'admin', action: 'LOAD_COMPLETED_OVERRIDE', oldStatus: oldStage, newStatus: 'COMPLETED', metadata: { reason } }).catch(() => {});
    emitLoadUpdate(rec.tokenNo, { loadStage: rec.loadStage });
    res.json({ ok: true, loadStage: rec.loadStage });
  } catch (err) {
    console.error('POST override-complete failed:', err.message);
    res.status(500).json({ error: 'Could not complete this load right now. Please try again.' });
  }
});

// Overview counts for the Admin Tracking landing page.
app.get('/api/admin/tracking/overview', requireAdmin, async (req, res) => {
  const [shippers, brokers, carriers, activeOrders] = await Promise.all([
    Registration.countDocuments({ role: 'shipper' }),
    Registration.countDocuments({ role: 'broker' }),
    Registration.countDocuments({ role: 'carrier' }),
    BookingRequest.countDocuments({ kind: 'booking', status: 'accepted' }),
  ]);
  res.json({ shippers, brokers, carriers, activeOrders });
});

// ---------- Admin Dashboard: load-lifecycle statistics (spec section 20) ----------
app.get('/api/admin/dashboard/stats', requireAdmin, async (req, res) => {
  try {
    const [
      totalLoads, pendingApproval, approved, driverAssigned, inTransit,
      delayed, delivered, podPending, completed, rejected,
    ] = await Promise.all([
      BookingRequest.countDocuments({}),
      BookingRequest.countDocuments({ status: 'pending' }),
      BookingRequest.countDocuments({ status: 'accepted' }),
      BookingRequest.countDocuments({ loadStage: { $in: ['ASSIGNED', 'DRIVER_ACCEPTED'] } }),
      BookingRequest.countDocuments({ loadStage: 'IN_TRANSIT' }),
      BookingRequest.countDocuments({ 'tracking.status': 'Delayed' }),
      BookingRequest.countDocuments({ loadStage: { $in: ['DELIVERED', 'COMPLETED'] } }),
      BookingRequest.countDocuments({ loadStage: 'DELIVERED', podStatus: { $in: ['pending', 'uploaded'] } }),
      BookingRequest.countDocuments({ loadStage: 'COMPLETED' }),
      BookingRequest.countDocuments({ status: 'rejected' }),
    ]);
    res.json({ totalLoads, pendingApproval, approved, driverAssigned, inTransit, delayed, delivered, podPending, completed, rejected });
  } catch (err) {
    console.error('GET /api/admin/dashboard/stats failed:', err.message);
    res.status(500).json({ error: 'Could not load dashboard statistics right now.' });
  }
});

// Recent activity feed (spec section 20) — the latest audit-log rows,
// newest first, formatted as short one-line strings ready to render.
app.get('/api/admin/activity', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const rows = await ops.ActivityLog.find({}).sort({ createdAt: -1 }).limit(limit).lean();
    res.json(rows);
  } catch (err) {
    console.error('GET /api/admin/activity failed:', err.message);
    res.status(500).json({ error: 'Could not load recent activity right now.' });
  }
});

// ---------- User Notification Preferences (spec section 17) ----------
// One shared shape/store for every role: Registration (shipper/broker/
// carrier — `strict:false`, so `notificationPrefs` just works as a plain
// sub-object) and Driver (schema below extends it explicitly). Categories
// match the spec exactly; every category defaults ON so nobody's email
// silently stops working after this rolls out, and — per spec ("critical
// transactional emails should remain enabled where appropriate") —
// assignmentUpdates/driverAssignment/importantNotifications are meant to
// stay on for most users even though they CAN be turned off here.
const DEFAULT_NOTIFICATION_PREFS = {
  loadMatches: true,
  truckMatches: true,
  assignmentUpdates: true,
  driverAssignment: true,
  loadStatusUpdates: true,
  importantNotifications: true,
};
function getNotificationPrefs(record) {
  return { ...DEFAULT_NOTIFICATION_PREFS, ...((record && record.notificationPrefs) || {}) };
}
/** true unless the recipient has explicitly turned this category off. */
function prefEnabled(record, key) {
  return getNotificationPrefs(record)[key] !== false;
}

app.get('/api/notification-preferences', async (req, res) => {
  const userSession = getAnyUserSession(req);
  if (!userSession) return res.status(401).json({ error: 'Please log in first.' });
  const Model = userSession.role === 'driver' ? Driver : Registration;
  const record = await Model.findOne({ id: userSession.recordId }).select('notificationPrefs').lean();
  res.json({ prefs: getNotificationPrefs(record) });
});

app.post('/api/notification-preferences', async (req, res) => {
  const userSession = getAnyUserSession(req);
  if (!userSession) return res.status(401).json({ error: 'Please log in first.' });
  const Model = userSession.role === 'driver' ? Driver : Registration;
  const incoming = req.body && req.body.prefs;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'prefs object is required.' });
  const next = { ...DEFAULT_NOTIFICATION_PREFS };
  Object.keys(DEFAULT_NOTIFICATION_PREFS).forEach((key) => {
    if (typeof incoming[key] === 'boolean') next[key] = incoming[key];
  });
  await Model.findOneAndUpdate({ id: userSession.recordId }, { notificationPrefs: next });
  res.json({ ok: true, prefs: next });
});

// ---------- Admin Email Log (email-notification-system spec section 16) ----------
// Lists every email attempt the notification system has made (see
// lib/emailQueue.js / lib/opsModels.js EmailLog), with filters for status/
// event type/date/recipient, and a "Retry" action for anything FAILED.
app.get('/api/admin/email-logs', requireAdmin, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.eventType) filter.eventType = req.query.eventType;
    if (req.query.email) filter.email = new RegExp(req.query.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const [rows, counts] = await Promise.all([
      ops.EmailLog.find(filter).sort({ createdAt: -1 }).limit(limit)
        .select('-html -text').lean(), // never ship rendered bodies to the list view — only what's needed to triage
      ops.EmailLog.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);
    const summary = counts.reduce((acc, c) => { acc[c._id || 'UNKNOWN'] = c.count; return acc; }, {});
    res.json({ rows, summary });
  } catch (err) {
    console.error('GET /api/admin/email-logs failed:', err.message);
    res.status(500).json({ error: 'Could not load the email log right now.' });
  }
});

app.post('/api/admin/email-logs/:id/retry', requireAdmin, async (req, res) => {
  try {
    const result = await emailQueue.retry(req.params.id);
    if (!result.ok) return res.status(409).json({ error: result.error });
    logActivity({ userId: req.adminId || '', userRole: 'admin', action: 'EMAIL_RETRY', metadata: { emailLogId: req.params.id } }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/admin/email-logs/:id/retry failed:', err.message);
    res.status(500).json({ error: 'Could not retry that email right now.' });
  }
});

// ---------- In-app Notification Center (spec sections 16-18) ----------
// One identity-resolution helper shared by all three routes below — works
// for an admin session (the shared 'admin' inbox) or any userSessions-based
// role (shipper/broker/carrier/driver), the same two session stores every
// other route in this file already uses.
function resolveNotificationIdentity(req) {
  const token = getBearerToken(req);
  if (!token) return null;
  if (sessions.has(token)) return { userId: 'admin', userRole: 'admin' };
  const session = userSessions.get(token);
  if (!session) return null;
  return { userId: session.recordId, userRole: session.role };
}
app.get('/api/notifications', async (req, res) => {
  const identity = resolveNotificationIdentity(req);
  if (!identity) return res.status(401).json({ error: 'Please log in first.' });
  const [items, unread] = await Promise.all([
    notificationService.listForUser(identity.userId, identity.userRole),
    notificationService.unreadCount(identity.userId, identity.userRole),
  ]);
  res.json({ notifications: items, unreadCount: unread });
});
app.put('/api/notifications/:id/read', async (req, res) => {
  const identity = resolveNotificationIdentity(req);
  if (!identity) return res.status(401).json({ error: 'Please log in first.' });
  const doc = await notificationService.markRead(req.params.id, identity.userId, identity.userRole);
  if (!doc) return res.status(404).json({ error: 'Notification not found.' });
  res.json({ ok: true });
});
app.put('/api/notifications/read-all', async (req, res) => {
  const identity = resolveNotificationIdentity(req);
  if (!identity) return res.status(401).json({ error: 'Please log in first.' });
  const result = await notificationService.markAllRead(identity.userId, identity.userRole);
  res.json({ ok: true, ...result });
});

// ---------- KYC photo capture (face photo + Aadhaar photo) ----------
// Photos are taken with the device camera in the browser (getUserMedia) and
// posted here as a JPEG data URL — no third-party image/OCR service is
// used, so there's no per-image cost ("coin"/"token") for this step.
// Files are written to a directory OUTSIDE the public static folder (not
// world-readable via a guessed URL) and are only ever served back through
// the admin-authenticated route below — brokers, carriers, other shippers,
// and unauthenticated visitors can never load these images.
const KYC_UPLOAD_DIR = path.join(__dirname, 'private-uploads', 'kyc');
fs.mkdirSync(KYC_UPLOAD_DIR, { recursive: true });
const KYC_FILENAME_RE = /^[a-zA-Z0-9_-]+\.(jpg|jpeg|png|pdf)$/;

app.post('/api/kyc/upload', async (req, res) => {
  const { type, imageBase64 } = req.body || {};
  // officePhoto: the Shipper's mandatory Office Photo (replaces the old
  // Selfie/face-photo requirement) — image only, same as face/Aadhaar
  // photos, never a PDF, since it has to actually be a photo.
  // profilePhoto: Broker's optional profile photo — image only, same
  // "must actually be a photo" rule as the other PHOTO_ONLY_TYPES.
  const PHOTO_ONLY_TYPES = ['face', 'aadharFront', 'aadharBack', 'officePhoto', 'profilePhoto'];
  // camera OR file upload, image or PDF. driverAadharFront/Back are the
  // driver's Aadhaar card photos (Carrier onboarding); driverRcPhoto/
  // driverDlPhoto are the vehicle Registration Certificate and the
  // driver's Driving Licence — all uploadable/viewable from the Carrier
  // account page. `pod` is the carrier's Proof of Delivery upload.
  // `loadingSlip` is the mandatory Loading Slip document for Carrier and
  // Broker registration.
  // panDocument/addressProof: Broker KYC documents (spec section 3) — image
  // or PDF, same as every other document type here.
  const DOCUMENT_TYPES = [
    'gstPhoto', 'msmePhoto', 'invoice', 'bankProof',
    'driverAadharFront', 'driverAadharBack', 'driverRcPhoto', 'driverDlPhoto',
    'pod', 'loadingSlip', 'panDocument', 'addressProof',
  ];
  if (![...PHOTO_ONLY_TYPES, ...DOCUMENT_TYPES].includes(type)) {
    return res.status(400).json({ error: 'Unrecognized upload type.' });
  }
  const isDocType = DOCUMENT_TYPES.includes(type);
  const imgMatch = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/.exec(imageBase64 || '');
  const pdfMatch = isDocType ? /^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/.exec(imageBase64 || '') : null;
  if (!imgMatch && !pdfMatch) {
    return res.status(400).json({ error: isDocType ? 'Please upload a valid image or PDF file.' : 'No valid photo captured — please try again.' });
  }
  const ext = pdfMatch ? 'pdf' : (imgMatch[1] === 'png' ? 'png' : 'jpg');
  const buffer = Buffer.from((pdfMatch ? pdfMatch[1] : imgMatch[2]), 'base64');
  if (buffer.length > 8 * 1024 * 1024) {
    return res.status(413).json({ error: 'File is too large (max 8MB).' });
  }
  const mimeType = pdfMatch ? 'application/pdf' : (imgMatch[1] === 'png' ? 'image/png' : 'image/jpeg');
  if (!fileStorageService.isInitialized()) {
    return res.status(503).json({ error: 'File storage is not ready yet. Please try again in a moment.' });
  }
  // Best-effort uploader identity: this endpoint is also used PRE-
  // registration (no account exists yet), so a session may not exist. When
  // one does (e.g. an already-registered broker re-uploading a KYC
  // document from their portal), the file is stamped as owned immediately
  // instead of waiting to be claimed later — see claimUploadedFilePath()
  // below for the claim-on-attach path used for anonymous uploads.
  const token = getBearerToken(req);
  const session = token && userSessions.get(token);
  try {
    const { fileId } = await fileStorageService.uploadBuffer({
      buffer,
      originalName: `${type}.${ext}`,
      mimeType,
      documentType: type,
      uploadedBy: session ? session.recordId : '',
      uploadedByRole: session ? session.role : '',
      userId: session ? session.recordId : '',
      ownerRole: session ? session.role : '',
    });
    await logActivity({
      userId: session ? session.recordId : '', userRole: session ? session.role : '',
      action: 'FILE_UPLOADED', metadata: { fileId, documentType: type, mimeType, size: buffer.length },
    });
    // Stored path points at the permanent, access-controlled file route —
    // stable forever, never a temporary local path or an expiring URL.
    res.json({ path: `/api/files/${fileId}` });
  } catch (err) {
    console.error('GridFS upload failed for type', type, '—', err.message);
    res.status(500).json({ error: 'Could not store the uploaded file right now. Please try again.' });
  }
});

// ---------- Permanent, access-controlled file retrieval (GridFS) ----------
// Single endpoint for every file uploaded through the pipeline above.
// Replaces reliance on a temporary local path or an expiring signed URL —
// this reference (`/api/files/<fileId>`) never changes and never expires
// for as long as the file exists in GridFS.
//
// Access rules (spec section 5):
//   - A logged-in user may view only files they own (FileMeta.userId) or
//     that are attached to an order they're a party to (invoicePath/podPath
//     — reuses the exact same canAccessOrderDocuments() check the existing
//     /api/orders/:token/document/:kind route uses, so the two can never
//     disagree about who's allowed to see an order's documents).
//   - An admin may always view (this is also how the Admin Portal's KYC
//     review previews/downloads work — see /api/admin/users/:userId/... below).
//   - Nobody else — a broker/carrier/shipper can never load another
//     account's private KYC documents by guessing a file id, and a bare
//     ObjectId is validated up front so this can't be used for path
//     traversal or to probe arbitrary GridFS internals.
async function resolveOrderAccessForFile(req, meta) {
  if (!meta.orderToken) return false;
  const order = await BookingRequest.findOne({ tokenNo: meta.orderToken }).lean();
  if (!order) return false;
  return canAccessOrderDocuments(req, order);
}
function isRequesterAdmin(req) {
  const token = getBearerToken(req);
  return !!(token && sessions.has(token));
}
// req.adminId is only ever set by the requireAdmin middleware — routes
// below that accept BOTH admins and regular users (like /api/files/:fileId)
// don't use that middleware, so this reads the admin id directly off the
// session store instead, for accurate audit-log attribution either way.
function requesterAdminId(req) {
  const token = getBearerToken(req);
  return (token && sessions.get(token)) || null;
}
function requesterUserId(req) {
  const token = getBearerToken(req);
  const session = token && userSessions.get(token);
  return session ? session.recordId : null;
}
app.get('/api/files/:fileId', async (req, res) => {
  const { fileId } = req.params;
  if (!fileStorageService.isValidFileId(fileId)) return res.status(400).send('Invalid file reference.');
  const meta = await fileStorageService.getFileMeta(fileId);
  if (!meta) return res.status(404).send('File not found.');
  const isAdmin = await isRequesterAdmin(req);
  const orderAccessGranted = (!isAdmin && meta.orderToken) ? await resolveOrderAccessForFile(req, meta) : false;
  const allowed = fileStorageService.checkFileAccess({
    meta, isAdmin, requesterUserId: requesterUserId(req), orderAccessGranted,
  });
  if (!allowed) return res.status(403).send('Not authorized to view this document.');
  try {
    const download = req.query.download === '1' || req.query.download === 'true';
    res.set('Content-Type', meta.mimeType || 'application/octet-stream');
    res.set('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${fileStorageService.sanitizeFilename(meta.originalName || meta.storedFilename)}"`);
    // Never let the browser or a proxy cache a private KYC/photo response.
    res.set('Cache-Control', 'no-store, private');
    const stream = fileStorageService.openDownloadStream(fileId);
    stream.on('error', (err) => {
      console.error('GridFS download stream error for', fileId, '—', err.message);
      if (!res.headersSent) res.status(404).send('File not found.');
    });
    stream.pipe(res);
    logActivity({
      userId: isAdmin ? (requesterAdminId(req) || 'admin') : (requesterUserId(req) || ''),
      userRole: isAdmin ? 'admin' : '',
      action: download ? 'FILE_DOWNLOADED' : 'FILE_PREVIEWED',
      metadata: { fileId, documentType: meta.documentType },
    }).catch(() => {});
  } catch (err) {
    console.error('File retrieval failed for', fileId, '—', err.message);
    res.status(404).send('File not found.');
  }
});

// Explicit kill-switch (spec's ADMIN_FILE_ACCESS_ENABLED) for the Admin
// Portal's file-review endpoints, on top of (never instead of) the
// requireAdmin session check every one of them already has. Defaults to
// enabled — set ADMIN_FILE_ACCESS_ENABLED=false to disable admin file
// review entirely for a deployment that wants that extra switch.
function requireAdminFileAccessEnabled(req, res, next) {
  if (process.env.ADMIN_FILE_ACCESS_ENABLED === 'false') {
    return res.status(503).json({ error: 'Admin file access is disabled on this deployment.' });
  }
  next();
}

// ---------- Admin Portal: User Registration & KYC Review (spec section 6) ----------
// Per-role list of document types a complete KYC review should show, used
// to report "Document not uploaded" for anything not yet on file — never
// invented/faked, always an honest gap list built from what's actually
// collected at registration for that role today.
const ADMIN_REVIEW_DOC_TYPES = {
  shipper: ['officePhoto', 'gstPhoto', 'msmePhoto', 'bankProof', 'loadingSlip'],
  broker: ['profilePhoto', 'panDocument', 'addressProof', 'gstPhoto', 'msmePhoto', 'bankProof', 'loadingSlip'],
  carrier: ['officePhoto', 'gstPhoto', 'msmePhoto', 'bankProof', 'loadingSlip', 'driverAadharFront', 'driverAadharBack', 'driverRcPhoto', 'driverDlPhoto'],
};
const DOCUMENT_TYPE_LABELS = {
  face: 'Selfie / Live Photo', aadharFront: 'Aadhaar (Front)', aadharBack: 'Aadhaar (Back)',
  officePhoto: 'Office Photo', profilePhoto: 'Profile Photo', selfiePhoto: 'Selfie / Live Photo',
  gstPhoto: 'GST Certificate', msmePhoto: 'MSME Certificate', invoice: 'Invoice',
  bankProof: 'Bank Proof', loadingSlip: 'Loading Slip', panDocument: 'PAN Card',
  addressProof: 'Address Proof', driverAadharFront: 'Driver Aadhaar (Front)',
  driverAadharBack: 'Driver Aadhaar (Back)', driverRcPhoto: 'Vehicle RC', driverDlPhoto: 'Driving Licence',
  documentPhoto: 'Vehicle Document', pod: 'Proof of Delivery', other: 'Document',
};

// Every document (GridFS-backed, un-deleted) currently on file for a given
// registered user, plus which of that role's expected document types are
// still missing — everything the Admin Portal's KYC review section needs in
// one call. Never fabricates a document that wasn't actually uploaded.
app.get('/api/admin/users/:userId/documents', requireAdmin, requireAdminFileAccessEnabled, async (req, res) => {
  try {
    const user = await Registration.findOne({ id: req.params.userId }).lean();
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const files = await FileMeta.find({ userId: user.id, isDeleted: false }).sort({ uploadedAt: -1 }).lean();
    const documents = files.map((f) => ({
      fileId: f.fileId,
      documentType: f.documentType,
      label: DOCUMENT_TYPE_LABELS[f.documentType] || f.documentType,
      originalName: f.originalName,
      mimeType: f.mimeType,
      size: f.size,
      uploadedAt: f.uploadedAt,
      verificationStatus: f.verificationStatus,
      verificationReason: f.verificationReason,
      previewUrl: `/api/files/${f.fileId}`,
      downloadUrl: `/api/files/${f.fileId}?download=1`,
    }));
    const presentTypes = new Set(documents.map((d) => d.documentType));
    const expectedTypes = ADMIN_REVIEW_DOC_TYPES[user.role] || [];
    const missingDocumentTypes = expectedTypes
      .filter((t) => !presentTypes.has(t))
      .map((t) => ({ documentType: t, label: DOCUMENT_TYPE_LABELS[t] || t }));
    res.json({
      user: {
        id: user.id,
        name: user.companyName || user.contactPerson || user.username,
        phone: user.mobileNumber || user.phoneNumber || '',
        email: user.email || '',
        role: user.role,
        registrationDate: user.submittedAt || user.createdAt,
        accountStatus: user.status || (user.active === false ? 'inactive' : 'active'),
        kycStatus: user.kycStatus || '',
      },
      documents,
      missingDocumentTypes,
    });
  } catch (err) {
    console.error('GET /api/admin/users/:userId/documents failed:', err.message);
    res.status(500).json({ error: 'Could not load documents right now.' });
  }
});

// The user's main "face" photo (profile photo / office photo / live selfie
// — whichever this role actually collects) in one call, streamed directly
// rather than redirected, so the Admin Portal can point a single <img>/<a>
// at it. Returns a clean 404 (never a broken image) when nothing has been
// uploaded yet.
const ADMIN_PHOTO_FIELD_BY_ROLE = { shipper: 'officePhotoPath', broker: 'profilePhotoPath', carrier: 'officePhotoPath' };
app.get('/api/admin/users/:userId/photo', requireAdmin, requireAdminFileAccessEnabled, async (req, res) => {
  try {
    const user = await Registration.findOne({ id: req.params.userId }).lean();
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const field = ADMIN_PHOTO_FIELD_BY_ROLE[user.role];
    const value = field && user[field];
    if (!value) return res.status(404).json({ error: 'No photo uploaded for this user.' });
    const fileId = fileStorageService.extractFileIdFromPath(value);
    if (fileId) {
      const meta = await fileStorageService.getFileMeta(fileId);
      if (!meta) return res.status(404).json({ error: 'Photo file could not be found.' });
      res.set('Content-Type', meta.mimeType || 'application/octet-stream');
      res.set('Cache-Control', 'no-store, private');
      const stream = fileStorageService.openDownloadStream(fileId);
      stream.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'Photo file could not be found.' }); });
      return stream.pipe(res);
    }
    // Legacy on-disk path — same disk+backup fallback as /admin/kyc-photo/:filename.
    const filename = String(value).replace('/admin/kyc-photo/', '').split('/').pop();
    if (!KYC_FILENAME_RE.test(filename)) return res.status(400).json({ error: 'Invalid photo reference.' });
    const filePath = path.join(KYC_UPLOAD_DIR, filename);
    if (fs.existsSync(filePath)) return res.sendFile(filePath);
    const backup = await kycFileStore.readFile(filename);
    if (!backup) return res.status(404).json({ error: 'Photo file could not be found — it may have been lost before durable backup shipped.' });
    res.set('Content-Type', backup.mimeType);
    res.send(backup.buffer);
  } catch (err) {
    console.error('GET /api/admin/users/:userId/photo failed:', err.message);
    res.status(500).json({ error: 'Could not load the photo right now.' });
  }
});

// Per-document review action — Approve / Reject / Request re-upload (spec
// section 6). Additive alongside the existing account-level kycStatus/
// bankVerificationStatus fields: this is finer-grained, per-file state.
app.patch('/api/admin/documents/:fileId/verify', requireAdmin, requireAdminFileAccessEnabled, async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!fileStorageService.isValidFileId(fileId)) return res.status(400).json({ error: 'Invalid file reference.' });
    const { status, reason } = req.body || {};
    if (!['APPROVED', 'REJECTED', 'REUPLOAD_REQUESTED'].includes(status)) {
      return res.status(400).json({ error: 'status must be APPROVED, REJECTED, or REUPLOAD_REQUESTED.' });
    }
    const meta = await fileStorageService.setVerificationStatus(fileId, { status, reason: reason || '', verifiedBy: req.adminId });
    if (!meta) return res.status(404).json({ error: 'Document not found.' });
    await logActivity({
      userId: req.adminId, userRole: 'admin', action: `DOCUMENT_${status}`,
      metadata: { fileId, documentType: meta.documentType, targetUserId: meta.userId, reason: reason || '' },
    });
    res.json({ ok: true, fileId, verificationStatus: meta.verificationStatus });
  } catch (err) {
    console.error('PATCH /api/admin/documents/:fileId/verify failed:', err.message);
    res.status(500).json({ error: 'Could not update verification status right now.' });
  }
});

// Soft delete / restore (spec section 8 — "soft deletion and recovery
// support"). A soft-deleted file is never served by /api/files/:fileId to
// anyone but an admin, but its bytes stay in GridFS so it can be restored.
app.post('/api/admin/documents/:fileId/delete', requireAdmin, requireAdminFileAccessEnabled, async (req, res) => {
  const { fileId } = req.params;
  if (!fileStorageService.isValidFileId(fileId)) return res.status(400).json({ error: 'Invalid file reference.' });
  const meta = await fileStorageService.softDeleteFile(fileId, { deletedBy: req.adminId });
  if (!meta) return res.status(404).json({ error: 'Document not found.' });
  await logActivity({ userId: req.adminId, userRole: 'admin', action: 'DOCUMENT_DELETED', metadata: { fileId, documentType: meta.documentType } });
  res.json({ ok: true });
});
app.post('/api/admin/documents/:fileId/restore', requireAdmin, requireAdminFileAccessEnabled, async (req, res) => {
  const { fileId } = req.params;
  if (!fileStorageService.isValidFileId(fileId)) return res.status(400).json({ error: 'Invalid file reference.' });
  const meta = await fileStorageService.restoreFile(fileId);
  if (!meta) return res.status(404).json({ error: 'Document not found.' });
  await logActivity({ userId: req.adminId, userRole: 'admin', action: 'DOCUMENT_RESTORED', metadata: { fileId, documentType: meta.documentType } });
  res.json({ ok: true });
});

// Admin-only image serving — requires the same admin session cookie as the
// rest of /admin/*. Filename is strictly validated to prevent path
// traversal since it comes straight from the URL.
app.get('/admin/kyc-photo/:filename', requireAdmin, async (req, res) => {
  const { filename } = req.params;
  if (!KYC_FILENAME_RE.test(filename)) {
    return res.status(400).send('Invalid filename.');
  }
  const filePath = path.join(KYC_UPLOAD_DIR, filename);
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }
  // Disk copy missing (deployment restart, ephemeral disk, etc.) — fall
  // back to the durable Mongo backup rather than 404ing (see
  // lib/kycFileStore.js). Also refreshes the disk cache best-effort so
  // the fast path is used again next time.
  const backup = await kycFileStore.readFile(filename);
  if (!backup) return res.status(404).send('Photo not found.');
  fs.writeFile(filePath, backup.buffer, () => { /* best-effort disk cache refresh */ });
  res.set('Content-Type', backup.mimeType);
  res.send(backup.buffer);
});

// Lets an account holder view their OWN KYC-style documents (face photo,
// Aadhaar/GST/MSME/bank proof, and for carriers: driver Aadhaar/RC/DL
// photos) without needing an admin session — admin can already view any of
// these via /admin/kyc-photo/:filename above. Scoped so nobody can view
// another account's documents by guessing a filename: the requester must
// be logged in as the exact account that has that filename stored against
// one of the fields below.
const SELF_VIEWABLE_DOC_FIELDS = [
  'facePhotoPath', 'aadharFrontPhotoPath', 'aadharBackPhotoPath',
  'officePhotoPath', 'gstPhotoPath', 'msmePhotoPath', 'bankProofPhotoPath',
  'driverAadharFrontPhotoPath', 'driverAadharBackPhotoPath',
  'driverRcPhotoPath', 'driverDlPhotoPath', 'loadingSlipPath',
  // Broker module additions.
  'panDocumentPath', 'addressProofPath', 'profilePhotoPath',
];
app.get('/api/my-documents/:filename', async (req, res) => {
  const token = getBearerToken(req);
  const session = token && userSessions.get(token);
  if (!session) return res.status(401).send('Please log in first.');
  const { filename } = req.params;
  if (!KYC_FILENAME_RE.test(filename)) return res.status(400).send('Invalid filename.');
  const record = await Registration.findOne({ role: session.role, id: session.recordId }).lean();
  if (!record) return res.status(404).send('Account not found.');
  const targetPath = `/admin/kyc-photo/${filename}`;
  const owns = SELF_VIEWABLE_DOC_FIELDS.some((f) => record[f] === targetPath);
  if (!owns) return res.status(403).send('Not authorized to view this document.');
  const filePath = path.join(KYC_UPLOAD_DIR, filename);
  if (fs.existsSync(filePath)) return res.sendFile(filePath);
  // Same durable-backup fallback as /admin/kyc-photo/:filename above.
  const backup = await kycFileStore.readFile(filename);
  if (!backup) return res.status(404).send('Document file not found.');
  fs.writeFile(filePath, backup.buffer, () => { /* best-effort disk cache refresh */ });
  res.set('Content-Type', backup.mimeType);
  res.send(backup.buffer);
});

// ---------- Auto-generated invoices (Load invoice + Transport invoice) ----------
// Both are produced entirely server-side with pdfkit — never uploaded by a
// person — and saved in their own private, non-static directory (same
// "outside the public folder" pattern as private-uploads/kyc above). Only
// the bare filename is ever stored on the order document; the bytes are
// served through the access-controlled /api/orders/:token/document/:kind
// route further below.
const INVOICE_DIR = path.join(__dirname, 'private-uploads', 'invoices');
fs.mkdirSync(INVOICE_DIR, { recursive: true });
const INVOICE_FILENAME_RE = /^[a-zA-Z0-9_-]+\.pdf$/;

// PDFKit's built-in Helvetica font has no glyph for ₹ (Indian Rupee sign) —
// it silently substitutes a broken fallback character instead of erroring.
// 'Rs.' is used here for exactly that reason; this only affects text drawn
// inside a generated PDF — nowhere else in the app needs this substitution.
function formatInr(n) {
  return 'Rs. ' + Number(n || 0).toLocaleString('en-IN');
}

// Load Smart's own remittance details — shown on outgoing invoices so the
// shipper knows where to pay. Configurable in one place; swap these for
// your real account before going live.
const LOAD_SMART_BANK_DETAILS = {
  accountName: 'Load Smart Pvt. Ltd.',
  bankName: 'HDFC Bank',
  accountNumber: '50100123456789',
  ifsc: 'HDFC0001234',
  branch: 'Connaught Place, New Delhi',
};

const INVOICE_DECLARATION = 'We hereby declare that this invoice shows the actual freight amount for the consignment described above and that all particulars stated are true and correct to the best of our knowledge. This is a system-generated invoice from Load Smart Pvt. Ltd. and does not require a physical signature.';

function writeInvoicePdf({ prefix, docTitle, invoiceNo, rows, totalLabel, totalValue, footerNote }) {
  return new Promise((resolve, reject) => {
    const filename = `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`;
    const filePath = path.join(INVOICE_DIR, filename);
    try {
      const doc = new PDFDocument({ margin: 50 });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      doc.fontSize(20).fillColor('#0e3a24').text('Load Smart Pvt. Ltd.', { align: 'left' });
      doc.fontSize(10).fillColor('#555').text('On-demand freight, moved right.', { align: 'left' });
      doc.moveDown(1.2);
      doc.fontSize(15).fillColor('#000').text(docTitle, { align: 'left' });
      doc.fontSize(10).fillColor('#555').text('Invoice No: ' + invoiceNo);
      doc.text('Date: ' + new Date().toLocaleDateString('en-IN'));
      doc.moveDown(1);

      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cccccc').stroke();
      doc.moveDown(0.6);

      doc.fontSize(11).fillColor('#000');
      rows.forEach(([label, value]) => {
        if (value === undefined || value === null || value === '') return;
        doc.font('Helvetica-Bold').text(label + ': ', { continued: true }).font('Helvetica').text(String(value));
      });

      doc.moveDown(1);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cccccc').stroke();
      doc.moveDown(0.6);
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#0e3a24').text(totalLabel + ': ' + formatInr(totalValue));

      if (footerNote) {
        doc.moveDown(1.5);
        doc.fontSize(9).font('Helvetica').fillColor('#888888').text(footerNote);
      }

      doc.end();
      stream.on('finish', () => resolve(filename));
      stream.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

// Generated the moment a load is posted / its rate is finalized — see the
// call sites in /api/estimate/book and the rate-request accept flows below.
// Pulls the shipper's own registration record (for Bill To) and the
// currently assigned truck (for Vehicle No./Type) — both already exist in
// this project, nothing new stored just for this document.
// Draws a simple bordered two-column (label/value) table at the given
// position and returns the y-coordinate just below it. Shared by the Load
// & Shipment Details table and the Bank/Payment Details table below so
// both look consistent.
function drawKeyValueTable(doc, { x, width, y, rows, labelWidth, headerBg }) {
  const rowHeight = 22;
  const padX = 8;
  let curY = y;
  if (headerBg) {
    doc.rect(x, curY, width, rowHeight).fill(headerBg.color);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(10)
      .text(headerBg.title || '', x + padX, curY + 6, { width: width - padX * 2 });
    curY += rowHeight;
  }
  rows.forEach(([label, value], i) => {
    if (value === undefined || value === null || value === '') return;
    const bg = i % 2 === 0 ? '#f7f5ee' : '#ffffff';
    doc.rect(x, curY, width, rowHeight).fillAndStroke(bg, '#e0ddd0');
    doc.fillColor('#333').font('Helvetica-Bold').fontSize(9.5)
      .text(String(label), x + padX, curY + 6, { width: labelWidth - padX });
    doc.fillColor('#000').font('Helvetica').fontSize(9.5)
      .text(String(value), x + labelWidth, curY + 6, { width: width - labelWidth - padX });
    curY += rowHeight;
  });
  return curY;
}

async function generateLoadInvoice(order) {
  const rate = order.finalRate || order.requestedRate || order.estimatedRate || 0;
  const shipper = order.shipperUsername
    ? await Registration.findOne({ role: 'shipper', username: order.shipperUsername }).lean()
    : null;
  const truck = order.assignedTruckId
    ? await Truck.findOne({ id: order.assignedTruckId }).lean()
    : null;

  return new Promise((resolve, reject) => {
    const filename = `LOADINV-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`;
    const filePath = path.join(INVOICE_DIR, filename);
    try {
      const doc = new PDFDocument({ margin: 50 });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);
      const pageLeft = 50, pageRight = 545, colGap = 20;
      const fullWidth = pageRight - pageLeft;
      const colWidth = (fullWidth - colGap) / 2;

      // ---- Header ----
      doc.fontSize(20).fillColor('#0e3a24').font('Helvetica-Bold').text('Load Smart Pvt. Ltd.');
      doc.fontSize(10).fillColor('#555').font('Helvetica').text('On-demand freight, moved right.');
      doc.moveDown(0.8);
      doc.fontSize(15).fillColor('#000').font('Helvetica-Bold').text('Load / Freight Booking Invoice');
      doc.fontSize(10).fillColor('#555').font('Helvetica')
        .text('Shipper Invoice No: INV-' + order.tokenNo)
        .text('LD Number: LD-' + order.tokenNo)
        .text('Date: ' + new Date().toLocaleDateString('en-IN'));
      doc.moveDown(0.8);
      doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).strokeColor('#cccccc').stroke();
      doc.moveDown(0.6);

      // ---- Bill To / Ship To (two columns) ----
      const sectionTop = doc.y;
      doc.fontSize(10).fillColor('#0e3a24').font('Helvetica-Bold').text('BILL TO', pageLeft, sectionTop, { width: colWidth });
      doc.fillColor('#000').font('Helvetica').fontSize(10);
      const billLines = [
        shipper && shipper.companyName ? shipper.companyName : (order.companyName || '—'),
        shipper && shipper.contactPerson ? 'Attn: ' + shipper.contactPerson : '',
        [shipper && shipper.district, shipper && shipper.state, shipper && shipper.pincode].filter(Boolean).join(', '),
        shipper && shipper.gstNumber ? 'GSTIN: ' + shipper.gstNumber : '',
        shipper && shipper.phoneNumber ? 'Phone: ' + shipper.phoneNumber : '',
      ].filter(Boolean);
      doc.text(billLines.join('\n'), pageLeft, doc.y, { width: colWidth });

      const shipToX = pageLeft + colWidth + colGap;
      doc.fontSize(10).fillColor('#0e3a24').font('Helvetica-Bold').text('SHIP TO', shipToX, sectionTop, { width: colWidth });
      doc.fillColor('#000').font('Helvetica').fontSize(10);
      const shipLines = [
        order.destination || '—',
        order.destAddress || '',
      ].filter(Boolean);
      doc.text(shipLines.join('\n'), shipToX, sectionTop + 14, { width: colWidth });

      // Bill To and Ship To can each run to a different number of lines —
      // always advance past whichever column is actually taller, or the
      // shorter column's text would overlap the divider/heading below it.
      const billBlockHeight = 14 + doc.heightOfString(billLines.join('\n') || ' ', { width: colWidth });
      const shipBlockHeight = 14 + doc.heightOfString(shipLines.join('\n') || ' ', { width: colWidth });
      doc.y = sectionTop + Math.max(billBlockHeight, shipBlockHeight) + 14;
      doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).strokeColor('#cccccc').stroke();
      doc.moveDown(0.6);

      // ---- Load & Shipment Details — real bordered table ----
      doc.fontSize(10).fillColor('#0e3a24').font('Helvetica-Bold').text('LOAD & SHIPMENT DETAILS', pageLeft, doc.y);
      doc.moveDown(0.3);
      const shipmentRows = [
        ['Token / Order No.', order.tokenNo],
        ['Consignment No.', 'CN-' + order.tokenNo],
        ['From', order.pickup],
        ['To', order.destination],
        ['Vehicle Number', truck ? truck.vehicleNumber : 'Not yet assigned'],
        ['Vehicle Type', truck ? truck.truckType : (order.requiredTruckType || '—')],
        ['Material', order.material],
        ['Weight (tons)', order.weight],
        ['Distance (km)', order.distanceKm],
      ];
      doc.y = drawKeyValueTable(doc, {
        x: pageLeft, y: doc.y, width: fullWidth, rows: shipmentRows, labelWidth: 160,
      });
      doc.x = pageLeft; // reset — PDFKit can otherwise carry the table's last explicit x across a page break
      doc.moveDown(0.8);

      // ---- Charges table — Description | Amount, with a highlighted
      // Total row so the amount owed is unmistakable at a glance ----
      doc.fontSize(10).fillColor('#0e3a24').font('Helvetica-Bold').text('CHARGES', pageLeft, doc.y);
      doc.moveDown(0.3);
      const chargeRowH = 24;
      const descColW = fullWidth * 0.72;
      const amtColW = fullWidth - descColW;
      let cy = doc.y;
      // Header row
      doc.rect(pageLeft, cy, fullWidth, chargeRowH).fill('#0e3a24');
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9.5)
        .text('DESCRIPTION', pageLeft + 8, cy + 7, { width: descColW - 8 })
        .text('AMOUNT', pageLeft + descColW, cy + 7, { width: amtColW - 8, align: 'right' });
      cy += chargeRowH;
      // Single freight line item
      const chargeDesc = 'Freight & transportation charges — ' + (order.pickup || '—') + ' to ' + (order.destination || '—');
      doc.rect(pageLeft, cy, fullWidth, chargeRowH).fillAndStroke('#ffffff', '#e0ddd0');
      doc.fillColor('#000').font('Helvetica').fontSize(9.5)
        .text(chargeDesc, pageLeft + 8, cy + 7, { width: descColW - 16 })
        .text(formatInr(rate), pageLeft + descColW, cy + 7, { width: amtColW - 8, align: 'right' });
      cy += chargeRowH;
      // Highlighted Total row — the single clearest "amount payable" line
      // on the whole document.
      doc.rect(pageLeft, cy, fullWidth, chargeRowH + 4).fill('#e8722c');
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(11)
        .text('TOTAL AMOUNT PAYABLE', pageLeft + 8, cy + 8, { width: descColW - 8 })
        .text(formatInr(rate), pageLeft + descColW, cy + 8, { width: amtColW - 8, align: 'right' });
      cy += chargeRowH + 4;
      doc.y = cy;
      doc.moveDown(0.8);

      // ---- Payment / Bank Details — same table style, with a highlighted
      // header so it's obviously the "how to pay" section ----
      doc.y = drawKeyValueTable(doc, {
        x: pageLeft, y: doc.y, width: fullWidth, labelWidth: 160,
        headerBg: { color: '#0e3a24', title: 'PAYMENT DETAILS — PAY TO THE ACCOUNT BELOW' },
        rows: [
          ['Amount Payable', formatInr(rate)],
          ['Account Name', LOAD_SMART_BANK_DETAILS.accountName],
          ['Bank Name', LOAD_SMART_BANK_DETAILS.bankName],
          ['Account Number', LOAD_SMART_BANK_DETAILS.accountNumber],
          ['IFSC Code', LOAD_SMART_BANK_DETAILS.ifsc],
          ['Branch', LOAD_SMART_BANK_DETAILS.branch],
        ],
      });
      doc.x = pageLeft; // reset — see note above the shipment details table
      doc.moveDown(0.8);

      // ---- Declaration ----
      doc.fontSize(10).fillColor('#0e3a24').font('Helvetica-Bold').text('DECLARATION', pageLeft, doc.y);
      doc.moveDown(0.3);
      doc.fontSize(9).fillColor('#555').font('Helvetica').text(INVOICE_DECLARATION, pageLeft, doc.y, { width: fullWidth });

      doc.moveDown(1.2);
      doc.fontSize(8).fillColor('#888').text('This invoice reflects the agreed freight rate and shipment details on file at the time it was generated. It is not a payment receipt.', pageLeft, doc.y, { width: fullWidth });

      doc.end();
      stream.on('finish', () => resolve(filename));
      stream.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

// Generated once the carrier uploads POD for a Delivered order — see
// POST /api/carrier/orders/:token/upload-pod below.
async function generateTransportInvoice(order) {
  const rate = order.finalRate || order.requestedRate || order.estimatedRate || 0;
  return writeInvoicePdf({
    prefix: 'TRANSINV',
    docTitle: 'Transport / Carrier Invoice',
    invoiceNo: 'TINV-' + order.tokenNo,
    rows: [
      ['Token / Order No.', order.tokenNo],
      ['Carrier', order.carrierCompanyName],
      ['Pickup', order.pickup],
      ['Destination', order.destination],
      ['Distance (km)', order.distanceKm],
      ['Delivered On', order.tracking && order.tracking.updatedAt ? new Date(order.tracking.updatedAt).toLocaleString('en-IN') : ''],
    ],
    totalLabel: 'Freight Payable to Carrier',
    totalValue: rate,
    footerNote: 'This invoice was generated automatically after Proof of Delivery (POD) was uploaded for this load. It reflects the agreed freight rate on file and is not a payment receipt.',
  });
}

// Idempotent helpers — safe to call from multiple places without ever
// generating (or storing) a second invoice for the same order.
async function ensureLoadInvoice(rec) {
  if (rec.loadInvoicePath) return;
  try {
    const filename = await generateLoadInvoice(rec);
    rec.loadInvoicePath = filename;
    rec.loadInvoiceGeneratedAt = new Date();
    await rec.save();
  } catch (err) {
    console.error('Auto load-invoice generation failed for', rec.tokenNo, '—', err.message);
  }
}
async function ensureTransportInvoice(rec) {
  if (rec.transportInvoicePath) return;
  try {
    const filename = await generateTransportInvoice(rec);
    rec.transportInvoicePath = filename;
    rec.transportInvoiceGeneratedAt = new Date();
    await rec.save();
  } catch (err) {
    console.error('Auto transport-invoice generation failed for', rec.tokenNo, '—', err.message);
  }
}

// ---------- Access-controlled document viewing (orders) ----------
// Single endpoint for every order-linked private document — the shipper's
// uploaded invoice, the carrier's uploaded POD, and the two auto-generated
// PDFs (load invoice, transport invoice). Access is limited to: the
// shipper who owns the order, the carrier assigned to the order, or a
// logged-in admin — matching who's allowed to act on each document
// elsewhere in this API. Supports the same "?token=" query fallback as
// every other private document route, so it works from a plain <a href>
// or window.open(), not just fetch().
const ORDER_DOC_CONFIG = {
  'shipper-invoice': { field: 'invoicePath', dir: KYC_UPLOAD_DIR, filenameRe: KYC_FILENAME_RE },
  'pod': { field: 'podPath', dir: KYC_UPLOAD_DIR, filenameRe: KYC_FILENAME_RE },
  'load-invoice': { field: 'loadInvoicePath', dir: INVOICE_DIR, filenameRe: INVOICE_FILENAME_RE },
  'transport-invoice': { field: 'transportInvoicePath', dir: INVOICE_DIR, filenameRe: INVOICE_FILENAME_RE },
};
async function canAccessOrderDocuments(req, order) {
  const token = getBearerToken(req);
  if (!token) return false;
  if (sessions.has(token)) return true; // any logged-in admin
  const session = userSessions.get(token);
  if (!session) return false;
  if (session.role === 'shipper') {
    const rec = await Registration.findOne({ role: 'shipper', id: session.recordId }).lean();
    return !!rec && rec.username === order.shipperUsername;
  }
  if (session.role === 'carrier') {
    const rec = await Registration.findOne({ role: 'carrier', id: session.recordId }).lean();
    return !!rec && rec.username === order.carrierUsername;
  }
  return false;
}
app.get('/api/orders/:token/document/:kind', async (req, res) => {
  const config = ORDER_DOC_CONFIG[req.params.kind];
  if (!config) return res.status(400).send('Unknown document type.');
  const isLoadInvoice = req.params.kind === 'load-invoice';
  // Transport invoice used to be generated once and cached to disk
  // (private-uploads/invoices), which made it vulnerable to exactly the
  // same "disk doesn't survive a restart" root cause as everything else in
  // this fix — but unlike a user-uploaded photo, its content is entirely
  // derivable from the order's own fields, so (like the load invoice) it's
  // simplest and most robust to just regenerate it fresh on every view
  // instead of migrating it into GridFS.
  const isTransportInvoice = req.params.kind === 'transport-invoice';
  const regenerates = isLoadInvoice || isTransportInvoice;
  // Regenerated documents need to .save() the new path, so they're fetched
  // as a real Mongoose document; every other document type is served
  // straight from its already-generated/uploaded file, so a lean read
  // is enough.
  const order = regenerates
    ? await BookingRequest.findOne({ tokenNo: req.params.token })
    : await BookingRequest.findOne({ tokenNo: req.params.token }).lean();
  if (!order) return res.status(404).send('Order not found.');
  const allowed = await canAccessOrderDocuments(req, order);
  if (!allowed) return res.status(403).send('Not authorized to view this document.');

  if (isLoadInvoice) {
    try {
      const filename = await generateLoadInvoice(order);
      // Best-effort cleanup of the previous file so private-uploads/invoices
      // doesn't grow unbounded — never blocks serving the freshly-made one.
      if (order.loadInvoicePath) {
        const oldFilename = String(order.loadInvoicePath).split('/').pop();
        if (INVOICE_FILENAME_RE.test(oldFilename)) {
          fs.unlink(path.join(INVOICE_DIR, oldFilename), () => { /* fine either way */ });
        }
      }
      order.loadInvoicePath = filename;
      order.loadInvoiceGeneratedAt = new Date();
      await order.save();
      return res.sendFile(path.join(INVOICE_DIR, filename));
    } catch (err) {
      console.error('On-demand load-invoice generation failed for', order.tokenNo, '—', err.message);
      return res.status(500).send('Could not generate the invoice right now. Please try again.');
    }
  }
  if (isTransportInvoice) {
    try {
      const filename = await generateTransportInvoice(order);
      if (order.transportInvoicePath) {
        const oldFilename = String(order.transportInvoicePath).split('/').pop();
        if (INVOICE_FILENAME_RE.test(oldFilename)) {
          fs.unlink(path.join(INVOICE_DIR, oldFilename), () => { /* fine either way */ });
        }
      }
      order.transportInvoicePath = filename;
      order.transportInvoiceGeneratedAt = new Date();
      await order.save();
      return res.sendFile(path.join(INVOICE_DIR, filename));
    } catch (err) {
      console.error('On-demand transport-invoice generation failed for', order.tokenNo, '—', err.message);
      return res.status(500).send('Could not generate the invoice right now. Please try again.');
    }
  }

  const storedValue = order[config.field];
  if (!storedValue) return res.status(404).send('Document not available yet.');
  // shipper-invoice/pod may now be stored in the new permanent GridFS
  // format — stream those directly instead of trying to resolve them as a
  // bare on-disk filename.
  const gridFsFileId = fileStorageService.extractFileIdFromPath(storedValue);
  if (gridFsFileId) {
    const meta = await fileStorageService.getFileMeta(gridFsFileId);
    if (!meta || meta.isDeleted) return res.status(404).send('Document file not found.');
    res.set('Content-Type', meta.mimeType || 'application/octet-stream');
    res.set('Cache-Control', 'no-store, private');
    const stream = fileStorageService.openDownloadStream(gridFsFileId);
    stream.on('error', () => { if (!res.headersSent) res.status(404).send('Document file not found.'); });
    return stream.pipe(res);
  }
  const filename = String(storedValue).split('/').pop();
  if (!config.filenameRe.test(filename)) return res.status(400).send('Invalid filename.');
  const filePath = path.join(config.dir, filename);
  if (fs.existsSync(filePath)) return res.sendFile(filePath);
  // Same durable-backup fallback as /admin/kyc-photo/:filename — only
  // applies to shipper-invoice/pod, which share KYC_UPLOAD_DIR and go
  // through kycFileStore at upload time.
  if (config.dir === KYC_UPLOAD_DIR) {
    const backup = await kycFileStore.readFile(filename);
    if (backup) {
      fs.writeFile(filePath, backup.buffer, () => { /* best-effort disk cache refresh */ });
      res.set('Content-Type', backup.mimeType);
      return res.send(backup.buffer);
    }
  }
  return res.status(404).send('Document file not found.');
});

// ---------- Carrier Portal: assigned loads + POD upload ----------
// Every endpoint below requires a logged-in CARRIER session and is scoped
// to orders where carrierUsername matches that carrier's own username — a
// carrier can never see or act on another carrier's orders.
function getCarrierSession(req) {
  const token = getBearerToken(req);
  const session = token && userSessions.get(token);
  return (session && session.role === 'carrier') ? session : null;
}

// Same inline pattern as getShipperSession/getCarrierSession above, for the
// Broker module's own JSON API endpoints (see the "Broker Portal" section
// further down this file).
function getBrokerSession(req) {
  const token = getBearerToken(req);
  const session = token && userSessions.get(token);
  return (session && session.role === 'broker') ? session : null;
}

// All orders currently assigned to the logged-in carrier — the list shown
// on the Carrier Portal's "My Loads" page.
app.get('/api/carrier/orders', async (req, res) => {
  const session = getCarrierSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a carrier first.' });
  const record = await Registration.findOne({ role: 'carrier', id: session.recordId }).lean();
  const records = await BookingRequest.find({ carrierUsername: record && record.username }).sort({ createdAt: -1 }).lean();
  res.json(await Promise.all(records.map(toTrackingSummary)));
});

// Single order's full detail, scoped to the logged-in carrier's own
// assignment — Token No. is the primary lookup key, same as every other
// order-detail route in this app.
app.get('/api/carrier/orders/:token', async (req, res) => {
  const session = getCarrierSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a carrier first.' });
  const record = await Registration.findOne({ role: 'carrier', id: session.recordId }).lean();
  const order = await BookingRequest.findOne({ tokenNo: req.params.token, carrierUsername: record && record.username }).lean();
  if (!order) return res.status(404).json({ error: 'No order found for that Token No. assigned to your account.' });
  res.json({ ...(await toTrackingSummary(order)), pickupAddress: order.pickupAddress || '', destAddress: order.destAddress || '' });
});

// Carrier uploads Proof of Delivery — only allowed once the order's
// tracking status is already "Delivered" (enforced here, not just hidden
// in the UI), matching the required flow: … Delivered → POD uploaded →
// Invoice generated. Successfully saving POD immediately and automatically
// generates the Transport Invoice — see ensureTransportInvoice() above.
// ---------- AI POD Vision Check ----------
// Runs once, fire-and-forget, right after a POD photo is saved — reads the
// file straight off disk (same KYC_UPLOAD_DIR every other private document
// in this app already uses, no new storage mechanism) and asks Claude
// vision two things a human reviewer would ask first: does this actually
// look like a delivery-proof photo (unloaded cargo, a signed receipt, a
// warehouse/site background — not a random/reused/blank image), and is the
// photo usable (in focus, not mostly black, not obviously cropped to hide
// something). This is a FAST PRE-CHECK, not a replacement for admin's own
// review — podVerified/podStatus are never touched by this function.
// Reads the raw bytes + mime type for a stored document path, regardless of
// whether it's in the new permanent GridFS format or the legacy on-disk
// format (falling back to the kycFileStore durable backup exactly like the
// serving routes above do). Shared by every AI pre-check that needs to look
// at a document's actual bytes (POD vision check, broker document review) —
// centralizing this means neither one can silently regress to
// "only ever reads from disk" the way runPodAiCheck originally did (a bug
// found and fixed during the GridFS migration: it had no fallback at all
// when the local disk copy was already gone).
async function readStoredDocBytes(pathValue) {
  const gridFsFileId = fileStorageService.extractFileIdFromPath(pathValue);
  if (gridFsFileId) {
    const meta = await fileStorageService.getFileMeta(gridFsFileId);
    if (!meta) return null;
    const buffer = await new Promise((resolve, reject) => {
      const chunks = [];
      try {
        const stream = fileStorageService.openDownloadStream(gridFsFileId);
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      } catch (err) { reject(err); }
    }).catch(() => null);
    if (!buffer) return null;
    return { buffer, mimeType: meta.mimeType };
  }
  const filename = String(pathValue || '').replace('/admin/kyc-photo/', '').split('/').pop();
  if (!filename || !KYC_FILENAME_RE.test(filename)) return null;
  const filePath = path.join(KYC_UPLOAD_DIR, filename);
  if (fs.existsSync(filePath)) {
    return { buffer: fs.readFileSync(filePath), mimeType: kycFileStore.mimeForFilename(filename) };
  }
  const backup = await kycFileStore.readFile(filename);
  return backup ? { buffer: backup.buffer, mimeType: backup.mimeType } : null;
}

async function runPodAiCheck(rec) {
  try {
    if (!aiService.isConfigured()) return; // silently a no-op — the rest of the POD flow doesn't depend on this
    // POD may be stored either in the new permanent GridFS format or the
    // legacy on-disk format — readStoredDocBytes() handles both, so this
    // pre-check no longer silently no-ops just because the local disk copy
    // is gone (the original bug this helper was introduced to fix).
    const doc = await readStoredDocBytes(rec.podPath);
    if (!doc || !/^image\/(png|jpeg)$/.test(doc.mimeType)) return; // PDF PODs aren't vision-checked today — a documented limitation, not a silent failure of anything the POD flow depends on
    const { buffer } = doc;
    const mediaType = doc.mimeType;
    const imageBase64 = buffer.toString('base64');
    const raw = await aiService.completeVision({
      system: 'You are a logistics operations assistant that quickly screens Proof-of-Delivery (POD) photos for a trucking marketplace. Be concise and specific. Do not invent details you cannot see in the image. Respond with ONLY a single valid JSON object, no markdown fences.',
      prompt: `This image was just uploaded as Proof of Delivery for load ${rec.tokenNo} (route: ${rec.pickup} to ${rec.destination}, material: ${rec.material}). Assess it and respond with JSON exactly like: {"looksValid": true|false, "confidence": "high"|"medium"|"low", "concerns": ["short phrase", ...], "summary": "one sentence"}. Set looksValid=false and list concerns if: the image doesn't look like real-world delivery evidence (e.g. a screenshot, a stock photo, a blank/mostly-black/mostly-white image), it's too blurry or dark to make out anything, or nothing in it suggests cargo/goods/a signed receipt/a delivery location. concerns should be empty if looksValid is true and the photo is clear.`,
      imageBase64, mediaType, maxTokens: 300,
    });
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    let result;
    try { result = { ok: true, data: JSON.parse(cleaned) }; } catch (e) { result = { ok: false, data: null }; }
    const fresh = await BookingRequest.findOne({ tokenNo: rec.tokenNo });
    if (!fresh) return;
    if (result.ok && result.data) {
      fresh.podAiCheck = {
        checkedAt: new Date(),
        looksValid: !!result.data.looksValid,
        confidence: String(result.data.confidence || ''),
        concerns: Array.isArray(result.data.concerns) ? result.data.concerns.slice(0, 8).map(String) : [],
        summary: String(result.data.summary || '').slice(0, 400),
        error: '',
      };
    } else {
      fresh.podAiCheck = { checkedAt: new Date(), looksValid: null, confidence: '', concerns: [], summary: '', error: "Couldn't parse the AI's response." };
    }
    await fresh.save();
    emitLoadUpdate(fresh.tokenNo, { podAiChecked: true });
  } catch (err) {
    console.error('runPodAiCheck failed for', rec.tokenNo, '—', err.message);
    await BookingRequest.updateOne({ tokenNo: rec.tokenNo }, { podAiCheck: { checkedAt: new Date(), looksValid: null, confidence: '', concerns: [], summary: '', error: err.message } }).catch(() => {});
  }
}

app.post('/api/carrier/orders/:token/upload-pod', async (req, res) => {
  try {
    const session = getCarrierSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a carrier first.' });
    const { podPath } = req.body;
    if (!podPath || typeof podPath !== 'string' || !isKnownDocPath(podPath)) {
      return res.status(400).json({ error: 'Please upload the POD file first.' });
    }
    const record = await Registration.findOne({ role: 'carrier', id: session.recordId }).lean();
    const rec = await BookingRequest.findOne({ tokenNo: req.params.token });
    if (!rec || !record || rec.carrierUsername !== record.username) {
      return res.status(404).json({ error: 'No order found for that Token No. assigned to your account.' });
    }
    const currentStatus = rec.tracking && rec.tracking.status;
    if (currentStatus !== 'Delivered') {
      return res.status(409).json({ error: 'POD can only be uploaded after the load has been marked Delivered.' });
    }
    rec.podPath = podPath;
    rec.podUploadedAt = new Date();
    rec.podVerified = false; // any re-upload resets verification — admin must re-check the new file
    rec.podRejectionReason = '';
    rec.podStatus = 'uploaded';
    await rec.save();
    await claimOrderDocPath(podPath, rec.tokenNo);
    await ensureTransportInvoice(rec);
    notifyPODUploaded(rec).catch((err) => console.error('notifyPODUploaded failed:', err.message));
    runPodAiCheck(rec).catch((err) => console.error('runPodAiCheck failed for', rec.tokenNo, '—', err.message));
    res.json(await toTrackingSummary(rec.toObject ? rec.toObject() : rec));
  } catch (err) {
    console.error('POST /api/carrier/orders/:token/upload-pod failed:', err.message);
    res.status(500).json({ error: 'Could not save the POD right now. Please try again.' });
  }
});

// ---------- Driver-facing POD upload (spec sections 11-12) ----------
// Same rules as the carrier upload above (only allowed once Delivered,
// resets verification on every upload) — this is the DRIVER's own version
// of it, scoped to their own driver session/assignment instead of a
// carrier account, and additionally captures the delivery-confirmation-
// style fields the spec asks POD to carry (receiver name, delivery date,
// notes) so a driver who skipped/needs to correct those at Deliver-time
// can still supply them here.
async function driverUploadPodHandler(req, res) {
  try {
    const session = getDriverSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in first.' });
    const { podPath, receiverName, receiverPhone, deliveryDate, deliveryNotes } = req.body || {};
    if (!podPath || typeof podPath !== 'string' || !isKnownDocPath(podPath)) {
      return res.status(400).json({ error: 'Please upload the POD file first.' });
    }
    const rec = await BookingRequest.findOne({ tokenNo: req.params.token, assignedDriverId: session.recordId });
    if (!rec) return res.status(404).json({ error: 'No load found for that Token No. assigned to you.' });
    if (rec.loadStage !== 'DELIVERED') {
      return res.status(409).json({ error: 'POD can only be uploaded after the load has been marked Delivered.' });
    }
    rec.podPath = podPath;
    rec.podUploadedAt = new Date();
    rec.podVerified = false;
    rec.podRejectionReason = '';
    rec.podStatus = 'uploaded';
    if (receiverName) rec.deliveryReceiverName = String(receiverName).trim();
    if (receiverPhone) rec.deliveryReceiverPhone = String(receiverPhone).trim();
    if (deliveryNotes) rec.deliveryNotes = String(deliveryNotes).trim();
    if (deliveryDate) rec.deliveryConfirmedAt = new Date(deliveryDate);
    await rec.save();
    await claimOrderDocPath(podPath, rec.tokenNo);
    await ensureTransportInvoice(rec);
    await notifyPODUploaded(rec);
    runPodAiCheck(rec).catch((err) => console.error('runPodAiCheck failed for', rec.tokenNo, '—', err.message));
    res.json(await toTrackingSummary(rec.toObject ? rec.toObject() : rec));
  } catch (err) {
    console.error('Driver POD upload failed:', err.message);
    res.status(500).json({ error: 'Could not save the POD right now. Please try again.' });
  }
}
app.post('/api/driver/loads/:token/pod', driverUploadPodHandler);
app.post('/api/loads/:token/pod', driverUploadPodHandler); // spec-shaped alias

async function notifyPODUploaded(rec) {
  const [shipper] = await Promise.all([
    rec.shipperUsername ? Registration.findOne({ role: 'shipper', username: rec.shipperUsername }).lean() : null,
  ]);
  emailService.sendPODUploadedEmail({ to: NOTIFY_TO_EMAIL, tokenNo: rec.tokenNo }).catch(() => {});
  notificationService.notify({ userId: 'admin', userRole: 'admin', loadId: rec.tokenNo, type: 'POD_UPLOADED', title: 'POD uploaded', message: `POD uploaded for Load ${rec.tokenNo} — awaiting your approval.` }).catch(() => {});
  if (shipper) notificationService.notify({ userId: shipper.id, userRole: 'shipper', loadId: rec.tokenNo, type: 'POD_UPLOADED', title: 'POD uploaded', message: `Proof of Delivery has been uploaded for Load ${rec.tokenNo}.` }).catch(() => {});
  smsBrokerForLoad(rec, (broker) => smsService.sendPodUploadedSms({ to: broker.mobileNumber, tokenNo: rec.tokenNo, userId: broker.id, userRole: 'broker' }));
  await ops.TrackingEvent.create({ tokenNo: rec.tokenNo, type: 'POD_UPLOADED', label: 'POD Uploaded', createdByRole: 'driver', createdAt: new Date() }).catch(() => {});
  await logActivity({ loadId: rec.tokenNo, action: 'POD_UPLOADED', newStatus: 'uploaded' });
}

// Carrier uploads/replaces their own Driver documents (Aadhaar front/back,
// RC photo, DL photo) any time after registration — same fields collected
// at signup (see /register/carrier), editable later from the Carrier
// account page. Each value must already be a path returned by
// /api/kyc/upload — this endpoint only ever links an already-uploaded file
// to the carrier's own record, never accepts raw file data itself.
app.post('/api/carrier/update-driver-documents', async (req, res) => {
  try {
    const session = getCarrierSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a carrier first.' });
    const record = await Registration.findOne({ role: 'carrier', id: session.recordId });
    if (!record) return res.status(404).json({ error: 'Account not found.' });
    const EDITABLE_DOC_FIELDS = ['driverAadharFrontPhotoPath', 'driverAadharBackPhotoPath', 'driverRcPhotoPath', 'driverDlPhotoPath'];
    const b = req.body || {};
    const changedPaths = [];
    EDITABLE_DOC_FIELDS.forEach((f) => {
      if (b[f] !== undefined && typeof b[f] === 'string' && isKnownDocPath(b[f])) {
        record[f] = b[f];
        changedPaths.push(b[f]);
      }
    });
    await record.save();
    await Promise.all(changedPaths.map((p) => {
      const fileId = fileStorageService.extractFileIdFromPath(p);
      return fileId ? fileStorageService.claimFileForUser(fileId, { userId: record.id, ownerRole: 'carrier' }).catch(() => {}) : null;
    }));
    const { password, confirmPassword, ...safeRecord } = record.toObject();
    res.json({ ok: true, record: safeRecord });
  } catch (err) {
    console.error('POST /api/carrier/update-driver-documents failed:', err.message);
    res.status(500).json({ error: 'Could not save your documents right now. Please try again.' });
  }
});

// ==================================================================
// Automated Truck/Driver Matching, Assignment & Live GPS Tracking
// ==================================================================
// Flow: Shipper posts a Load -> matching engine scores every available,
// verified Truck (+ its Driver) owned by any Carrier -> best match is
// assigned automatically -> Driver accepts from their own mobile-OTP
// dashboard -> Driver drives the pipeline through pickup/loading/transit
// -> GPS pings stream in over Socket.IO + are persisted for history ->
// Delivered frees the Truck/Driver and stops tracking automatically.
//
// This is layered ON TOP of the existing Carrier/Registration and
// BookingRequest (Load) models — a Carrier can now onboard many Trucks
// and many Drivers (see Truck/Driver schemas above) in addition to the
// single vehicle/driver captured at registration, which keeps working
// unchanged for existing accounts.

// ---------- Driver mobile-OTP login ----------
// No SMS gateway is configured anywhere in this project (there's no
// Twilio/MSG91/etc. credential in .env), so — exactly like the email OTP
// system above when SMTP isn't configured — the OTP is logged to the
// server console instead of actually being texted. Wire in a real SMS
// provider here (same shape as generateAndSendOtp for email) when one is
// available; nothing else in the flow needs to change.
const mobileOtpStore = new Map(); // mobile -> { otp, expiresAt, attempts, lastSentAt }
const MOBILE_OTP_TTL_MS = 2 * 60 * 1000;
const MOBILE_OTP_RESEND_COOLDOWN_MS = 30 * 1000;

async function generateAndSendMobileOtp(mobile) {
  const existing = mobileOtpStore.get(mobile);
  if (existing && Date.now() - existing.lastSentAt < MOBILE_OTP_RESEND_COOLDOWN_MS) {
    const waitSec = Math.ceil((MOBILE_OTP_RESEND_COOLDOWN_MS - (Date.now() - existing.lastSentAt)) / 1000);
    const err = new Error(`Please wait ${waitSec}s before requesting another OTP.`);
    err.status = 429;
    throw err;
  }
  const otp = String(crypto.randomInt(100000, 999999));
  mobileOtpStore.set(mobile, { otp, expiresAt: Date.now() + MOBILE_OTP_TTL_MS, attempts: 0, lastSentAt: Date.now() });
  console.log(`[DEV SMS to ${mobile}] Your Load Smart driver OTP is ${otp} (valid 2 minutes).`);
  return { sent: true, expiresInSeconds: MOBILE_OTP_TTL_MS / 1000 };
}

function verifyMobileOtp(mobile, otp) {
  const entry = mobileOtpStore.get(mobile);
  if (!entry) return { verified: false, error: 'No code was sent to this number. Please request a new OTP.' };
  if (Date.now() > entry.expiresAt) { mobileOtpStore.delete(mobile); return { verified: false, error: 'That OTP has expired. Please request a new one.' }; }
  entry.attempts += 1;
  if (entry.attempts > 5) { mobileOtpStore.delete(mobile); return { verified: false, error: 'Too many incorrect attempts. Please request a new OTP.' }; }
  if (entry.otp !== String(otp || '').trim()) return { verified: false, error: 'Incorrect OTP. Please try again.' };
  mobileOtpStore.delete(mobile);
  return { verified: true };
}

app.post('/api/driver/login/send-otp', async (req, res) => {
  const mobile = String(req.body.mobile || '').replace(/\D/g, '');
  if (!/^[0-9]{7,15}$/.test(mobile)) return res.status(400).json({ error: 'Enter a valid mobile number.' });
  const driver = await Driver.findOne({ mobileNumber: mobile }).lean();
  if (!driver) return res.status(404).json({ error: 'No driver account found for that mobile number. Ask your carrier to onboard you first.' });
  // Blocked/suspended drivers are stopped right at OTP request — no point
  // sending an OTP to an account that can never complete login.
  if (driver.blocked) return res.status(403).json({ error: 'Your driver account has been blocked. Please contact your carrier or Load Smart support.' });
  try {
    const result = await generateAndSendMobileOtp(mobile);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/driver/login/verify-otp', async (req, res) => {
  const mobile = String(req.body.mobile || '').replace(/\D/g, '');
  const { otp } = req.body;
  const result = verifyMobileOtp(mobile, otp);
  if (!result.verified) return res.status(400).json({ error: result.error });
  const driver = await Driver.findOne({ mobileNumber: mobile }).lean();
  if (!driver) return res.status(404).json({ error: 'Driver account not found.' });
  if (driver.blocked) return res.status(403).json({ error: 'Your driver account has been blocked. Please contact your carrier or Load Smart support.' });
  if (!driver.verified) return res.status(403).json({ error: 'Your driver account is awaiting verification by Admin.' });
  const token = crypto.randomBytes(24).toString('hex');
  // Driver sessions live in the exact same store as Shipper/Broker/Carrier
  // sessions — role: 'driver' never collides with Registration lookups
  // elsewhere (Registration only ever has shipper/broker/carrier roles).
  userSessions.set(token, { role: 'driver', recordId: driver.id });
  res.json({ token, driver: { id: driver.id, name: driver.name, mobileNumber: driver.mobileNumber } });
});

function getDriverSession(req) {
  const token = getBearerToken(req);
  const session = token && userSessions.get(token);
  return (session && session.role === 'driver') ? session : null;
}

// ---------- Truck onboarding (Carrier fleet) ----------
app.post('/api/carrier/trucks', async (req, res) => {
  const session = getCarrierSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a carrier first.' });
  const record = await Registration.findOne({ role: 'carrier', id: session.recordId }).lean();
  const b = req.body || {};
  const vehicleNumber = String(b.vehicleNumber || '').trim().toUpperCase();
  const truckType = String(b.truckType || '').trim();
  const capacityTons = Number(b.capacityTons);
  if (!vehicleNumber) return res.status(400).json({ error: 'Vehicle number is required.' });
  if (!truckType) return res.status(400).json({ error: 'Truck type is required.' });
  if (!Number.isFinite(capacityTons) || capacityTons <= 0) return res.status(400).json({ error: 'Enter a valid truck capacity (in tons).' });
  try {
    const truck = await Truck.create({
      id: `TRK-${Date.now()}`,
      carrierUsername: record.username,
      vehicleNumber,
      truckType,
      capacityTons,
      bodyType: String(b.bodyType || '').trim(),
      documentPhotoPath: (b.documentPhotoPath && isKnownDocPath(String(b.documentPhotoPath))) ? String(b.documentPhotoPath) : '',
      currentLocation: String(b.currentLocation || '').trim(),
    });
    res.json({ ok: true, truck });
    if (truck.documentPhotoPath) {
      const fileId = fileStorageService.extractFileIdFromPath(truck.documentPhotoPath);
      if (fileId) fileStorageService.claimFileForUser(fileId, { userId: record.id, ownerRole: 'carrier' }).catch(() => {});
    }
    // Fire-and-forget, strictly AFTER the truck is confirmed persisted and
    // the response has already gone out — never lets email/matching work
    // slow down or fail the "truck added" API call itself.
    notifyOnTruckPosted(truck, record).catch((err) => console.error('notifyOnTruckPosted failed for', truck.id, '—', err.message));
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'A truck with that vehicle number is already registered.' });
    console.error('POST /api/carrier/trucks failed:', err.message);
    res.status(500).json({ error: 'Could not add that truck right now. Please try again.' });
  }
});

// ---------- TruckCreated -> matching shippers + score-gated match emails (spec sections 3 & 6) ----------
// Two distinct things happen when a carrier adds a truck:
//   1. A broad "a matching truck is now available" alert to shippers whose
//      OPEN load's required truck type this truck satisfies (section 3) —
//      no scoring, just "you might want to know about this."
//   2. A precise, weighted-score match against those same open loads
//      (lib/matchingEngine.computeLoadTruckMatchScore) — only for loads
//      that score at/above the configurable "Possible Match" threshold
//      does BOTH the shipper and the carrier get the richer "Perfect/
//      Strong/Possible Match" pair of emails (section 6). Capped to the
//      best few loads so one newly-added truck can't fan out unbounded
//      matched-email volume.
const NEW_TRUCK_MATCH_SCAN_LIMIT = 50;
const NEW_TRUCK_MATCH_EMAIL_CAP = 5;
async function notifyOnTruckPosted(truck, carrierRecord) {
  // "Open" = posted and not yet handed to a specific truck/driver — once a
  // load has its own assignedTruckId it's no longer looking for a match.
  const openLoads = await BookingRequest.find({
    loadStage: { $in: ['POSTED', 'MATCHED'] },
    assignedTruckId: '',
    $or: [{ requiredTruckType: '' }, { requiredTruckType: new RegExp(`^${truck.truckType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }],
  }).sort({ createdAt: -1 }).limit(NEW_TRUCK_MATCH_SCAN_LIMIT).lean();
  if (!openLoads.length) return;

  const shipperUsernames = [...new Set(openLoads.map((l) => l.shipperUsername).filter(Boolean))];
  const shippers = await Registration.find({ role: 'shipper', username: { $in: shipperUsernames } }).select('id username email companyName notificationPrefs').lean();
  const shipperByUsername = new Map(shippers.map((s) => [s.username, s]));

  // ---- section 3: broad "matching truck available" alert ----
  // "Load Matches" preference (spec section 17) — this is about the
  // shipper's own load potentially matching a truck.
  const maskedVehicle = emailTemplates.maskVehicleNumber(truck.vehicleNumber);
  await Promise.all(openLoads.map((load) => {
    const shipper = shipperByUsername.get(load.shipperUsername);
    if (!shipper || !shipper.email || !prefEnabled(shipper, 'loadMatches')) return null;
    return emailService.sendShipperNewTruckMatchEmail({
      to: shipper.email, tokenNo: load.tokenNo, truckType: truck.truckType,
      vehicleNumberMasked: maskedVehicle, capacityTons: truck.capacityTons,
      currentLocation: truck.currentLocation, availableFrom: truck.createdAt,
    }).catch(() => {});
  }));

  // ---- section 6: precise, score-gated Perfect/Strong/Possible Match pair ----
  const scored = openLoads
    .map((load) => ({ load, result: matchingEngine.computeLoadTruckMatchScore(load, truck) }))
    .filter((x) => x.result.eligible && matchConfig.classifyMatchScore(x.result.score))
    .sort((a, b) => b.result.score - a.result.score)
    .slice(0, NEW_TRUCK_MATCH_EMAIL_CAP);

  await Promise.all(scored.map(async ({ load, result }) => {
    const shipper = shipperByUsername.get(load.shipperUsername);
    const tier = matchConfig.classifyMatchScore(result.score);
    const tierLabel = matchConfig.TIER_LABELS[tier];
    const reasonText = `A new truck was just added by ${carrierRecord.companyName || carrierRecord.username} that closely matches your load ${load.tokenNo} — ${tierLabel.toLowerCase()} (${result.score}/100).`;
    await Promise.all([
      shipper && shipper.email && prefEnabled(shipper, 'loadMatches') ? emailService.sendPerfectMatchShipperEmail({
        to: shipper.email, tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination,
        requiredTruckType: load.requiredTruckType, matchedTruckType: truck.truckType,
        carrierName: carrierRecord.companyName || carrierRecord.username, capacityTons: truck.capacityTons,
        currentLocation: truck.currentLocation, matchScore: result.score, matchTierLabel: tierLabel, reasonText,
      }).catch(() => {}) : null,
      carrierRecord.email && prefEnabled(carrierRecord, 'truckMatches') ? emailService.sendNewLoadMatchCarrierEmail({
        to: carrierRecord.email, tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination,
        material: load.material, weight: load.weight, requiredTruckType: load.requiredTruckType,
        pickupDateTime: load.pickupDateTime, estimatedRate: load.estimatedRate,
        matchScore: result.score, matchTierLabel: tierLabel,
        reasonText: `Your newly added truck ${maskedVehicle} closely matches load ${load.tokenNo} — ${tierLabel.toLowerCase()} (${result.score}/100).`,
      }).catch(() => {}) : null,
    ]);
  }));
}

app.get('/api/carrier/trucks', async (req, res) => {
  const session = getCarrierSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a carrier first.' });
  const record = await Registration.findOne({ role: 'carrier', id: session.recordId }).lean();
  const trucks = await Truck.find({ carrierUsername: record.username }).sort({ createdAt: -1 }).lean();
  res.json(trucks);
});

app.patch('/api/carrier/trucks/:id', async (req, res) => {
  const session = getCarrierSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a carrier first.' });
  const record = await Registration.findOne({ role: 'carrier', id: session.recordId }).lean();
  const truck = await Truck.findOne({ id: req.params.id, carrierUsername: record.username });
  if (!truck) return res.status(404).json({ error: 'Truck not found.' });
  const EDITABLE = ['truckType', 'capacityTons', 'bodyType', 'documentPhotoPath', 'currentLocation', 'status'];
  const ALLOWED_STATUS = ['available', 'maintenance']; // carrier can't force 'assigned'/'in_transit' — the system sets those
  EDITABLE.forEach((f) => {
    if (req.body[f] === undefined) return;
    if (f === 'status' && !ALLOWED_STATUS.includes(req.body.status)) return;
    if (f === 'documentPhotoPath' && req.body[f] && !isKnownDocPath(String(req.body[f]))) return;
    truck[f] = req.body[f];
  });
  await truck.save();
  if (req.body.documentPhotoPath) {
    const fileId = fileStorageService.extractFileIdFromPath(req.body.documentPhotoPath);
    if (fileId) fileStorageService.claimFileForUser(fileId, { userId: record.id, ownerRole: 'carrier' }).catch(() => {});
  }
  res.json({ ok: true, truck });
});

// ---------- Driver onboarding (Carrier fleet) ----------
app.post('/api/carrier/drivers', async (req, res) => {
  const session = getCarrierSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a carrier first.' });
  const record = await Registration.findOne({ role: 'carrier', id: session.recordId }).lean();
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const mobileNumber = String(b.mobileNumber || '').replace(/\D/g, '');
  const licenseNumber = String(b.licenseNumber || '').trim();
  if (!name) return res.status(400).json({ error: 'Driver name is required.' });
  if (!/^[0-9]{7,15}$/.test(mobileNumber)) return res.status(400).json({ error: 'Enter a valid driver mobile number.' });
  if (!licenseNumber) return res.status(400).json({ error: 'Driving licence number is required.' });
  const licenseExpiry = new Date(b.licenseExpiry);
  if (!b.licenseExpiry || Number.isNaN(licenseExpiry.getTime())) return res.status(400).json({ error: 'Enter a valid licence expiry date.' });
  if (licenseExpiry.getTime() < Date.now()) return res.status(400).json({ error: 'That licence has already expired.' });
  try {
    const driver = await Driver.create({
      id: `DRV-${Date.now()}`,
      carrierUsername: record.username,
      name, mobileNumber, licenseNumber, licenseExpiry,
    });
    res.json({ ok: true, driver });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'A driver with that mobile number is already registered.' });
    console.error('POST /api/carrier/drivers failed:', err.message);
    res.status(500).json({ error: 'Could not add that driver right now. Please try again.' });
  }
});

app.get('/api/carrier/drivers', async (req, res) => {
  const session = getCarrierSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a carrier first.' });
  const record = await Registration.findOne({ role: 'carrier', id: session.recordId }).lean();
  const drivers = await Driver.find({ carrierUsername: record.username }).sort({ createdAt: -1 }).lean();
  res.json(drivers);
});

// Associates a verified Driver with a verified Truck — both must belong to
// the same Carrier, both must be currently available, and a Driver already
// linked to another truck must be unlinked first (no implicit re-assign).
app.post('/api/carrier/trucks/:truckId/assign-driver', async (req, res) => {
  const session = getCarrierSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a carrier first.' });
  const record = await Registration.findOne({ role: 'carrier', id: session.recordId }).lean();
  const truck = await Truck.findOne({ id: req.params.truckId, carrierUsername: record.username });
  if (!truck) return res.status(404).json({ error: 'Truck not found.' });
  const driver = await Driver.findOne({ id: req.body.driverId, carrierUsername: record.username });
  if (!driver) return res.status(404).json({ error: 'Driver not found.' });
  if (!truck.verified) return res.status(400).json({ error: 'This truck must be verified by Admin before a driver can be assigned.' });
  if (!driver.verified) return res.status(400).json({ error: 'This driver must be verified by Admin before they can be assigned.' });
  if (truck.status !== 'available') return res.status(400).json({ error: 'This truck is not currently available.' });
  if (driver.status !== 'available') return res.status(400).json({ error: 'This driver is not currently available.' });
  if (driver.assignedTruckId && driver.assignedTruckId !== truck.id) {
    return res.status(409).json({ error: 'This driver is already linked to another truck. Unlink them first.' });
  }
  truck.assignedDriverId = driver.id;
  driver.assignedTruckId = truck.id;
  await truck.save();
  await driver.save();
  res.json({ ok: true, truck, driver });
});

// ---------- Matching engine ----------
// The actual eligibility filtering + weighted scoring lives in
// lib/matchingEngine.js — a pure, deterministic, DB-free module (see its
// header comment). Everything below is the thin DB-aware wrapper around
// it: fetching candidate pools, calling the engine, and persisting the
// result. Keeping the pure logic out of this file is what makes it
// unit-testable without a database (see test/matchingEngine.test.js) and
// is also the architectural boundary the spec requires: the AI chatbot
// below explains what this engine decides — it never recomputes it.

// Every truck in the fleet, together with its linked driver — NOT
// filtered down to "currently available" here, so the matching engine's
// phase-1 eligibility check can classify EVERY truck as ELIGIBLE or
// INELIGIBLE-with-a-specific-reason (busy, unverified, wrong type, under
// maintenance, ...). That richer "why wasn't this one picked" view is
// what the dispatcher Matching Dashboard and /api/loads/:loadId/matches
// need — a pool that silently drops ineligible trucks before they're ever
// seen can't explain a "no suitable match" result.
async function getLoadCandidatePool(load) {
  const trucks = await Truck.find({ assignedDriverId: { $ne: '' } }).lean();
  const driverIds = trucks.map((t) => t.assignedDriverId).filter(Boolean);
  const drivers = await Driver.find({ id: { $in: driverIds } }).lean();
  const driverById = new Map(drivers.map((d) => [d.id, d]));
  return trucks.map((t) => {
    let truck = t;
    // A truck already soft-reserved for THIS SAME load (status:'assigned',
    // load.assignedTruckId === t.id) would otherwise trip its own "must be
    // available" eligibility rule when re-ranking that load's own
    // match-details/approval screen. Exempt only that one truck, only for
    // this one ranking pass, by scoring a shallow clone — never mutates
    // the real DB record.
    if (load && load.assignedTruckId && t.id === load.assignedTruckId) {
      truck = { ...t, status: 'available' };
    }
    return { truck, driver: driverById.get(t.assignedDriverId) || null };
  });
}

// THE single source of truth for "who can take this load" — every screen
// and API that needs match candidates (dispatcher dashboard, the
// /api/loads/:loadId/matches endpoint, the auto-match background loop,
// the AI chatbot's FIND_MATCHES action) calls this same function so none
// of them can ever drift out of sync with each other or with the pure
// engine's rules.
async function computeLoadMatches(load) {
  const pairs = await getLoadCandidatePool(load);
  return matchingEngine.rankCandidates(load, pairs);
}

// Runs the matching engine for one load and, if a suitable candidate is
// found, RECOMMENDS it — atomically reserves the truck and moves the load
// to 'MATCHED' (AI Recommended) — but does NOT hand it to the driver yet.
// A human admin still has to approve the recommendation (see
// /api/admin/fleet/loads/:token/approve below) or explicitly assign a
// different candidate (see /api/admin/fleet/loads/:token/assign) before
// it becomes a real ASSIGNED offer the driver can see and accept. Safe to
// call more than once for the same load — a no-op once it's already
// matched/assigned.
async function tryAutoAssignLoad(load) {
  if (load.assignedTruckId) return { matched: true, alreadyAssigned: true };
  const { eligible } = await computeLoadMatches(load);
  load.matchAttempted = true;
  if (!eligible.length) {
    load.matchNote = 'No suitable truck and driver are currently available.';
    await load.save();
    return { matched: false };
  }
  const best = eligible[0];
  // Atomic, race-condition-safe reservation: the filter (id + status must
  // STILL be 'available') and the update happen as one indivisible Mongo
  // operation, so if two matching passes (e.g. the 60s background retry
  // loop and a manual "Retry match" click) both try to grab the same
  // truck at the same instant, only one of them can win — the loser gets
  // `null` back and simply retries against the next-best candidate on its
  // next pass, instead of silently double-booking the truck.
  const truckDoc = await Truck.findOneAndUpdate(
    { id: best.truckId, status: 'available' },
    { status: 'assigned' },
    { new: true }
  );
  if (!truckDoc) {
    load.matchNote = 'The best-matched truck was reserved by another process a moment ago — will retry automatically.';
    await load.save();
    return { matched: false, raced: true };
  }
  load.assignedTruckId = truckDoc.id;
  load.assignedDriverId = best.driverId;
  load.loadStage = 'MATCHED';
  load.matchNote = '';
  load.matchScore = best.matchScore;
  load.matchReasons = best.reasons;
  load.carrierUsername = truckDoc.carrierUsername;
  syncTrackingStatusFromLoadStage(load, `AI recommended truck ${truckDoc.vehicleNumber} — awaiting admin approval.`);
  await load.save();
  notificationService.notify({
    userId: 'admin', userRole: 'admin', loadId: load.tokenNo, type: 'MATCH_FOUND',
    title: 'AI match ready for approval', message: `Load ${load.tokenNo} was matched with truck ${truckDoc.vehicleNumber} — review it in Fleet > Pending Approvals.`,
  }).catch(() => {});
  // LoadMatched/TruckMatched (spec sections 4-5, "VERY IMPORTANT") — a real
  // match was just found by the engine above. Score it against the
  // configurable Perfect/Strong/Possible thresholds and, only if it clears
  // the bar, email BOTH the shipper and the carrier with distinct
  // subject/content each. Fire-and-forget: never lets this slow down or
  // fail the match/reservation that already succeeded above.
  notifyLoadTruckMatchFound(load, truckDoc).catch((err) => console.error('notifyLoadTruckMatchFound failed for', load.tokenNo, '—', err.message));
  emitLoadUpdate(load.tokenNo, { loadStage: load.loadStage, assignedTruckId: load.assignedTruckId, assignedDriverId: load.assignedDriverId });
  return { matched: true, pendingApproval: true, matchScore: best.matchScore };
}

// ---------- LoadMatched / TruckMatched score-gated match emails (spec sections 4-6) ----------
async function notifyLoadTruckMatchFound(load, truckDoc) {
  const result = matchingEngine.computeLoadTruckMatchScore(load, truckDoc);
  const tier = result.eligible ? matchConfig.classifyMatchScore(result.score) : null;
  if (!tier) return; // below the "Possible Match" floor — intentionally silent, per spec ("do NOT treat every truck as a perfect match")
  const tierLabel = matchConfig.TIER_LABELS[tier];
  const [shipper, carrier] = await Promise.all([
    load.shipperUsername ? Registration.findOne({ role: 'shipper', username: load.shipperUsername }).select('email companyName username notificationPrefs').lean() : null,
    truckDoc.carrierUsername ? Registration.findOne({ role: 'carrier', username: truckDoc.carrierUsername }).select('email companyName username notificationPrefs').lean() : null,
  ]);
  await Promise.all([
    shipper && shipper.email && prefEnabled(shipper, 'loadMatches') ? emailService.sendPerfectMatchShipperEmail({
      to: shipper.email, tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination,
      requiredTruckType: load.requiredTruckType, matchedTruckType: truckDoc.truckType,
      carrierName: (carrier && (carrier.companyName || carrier.username)) || 'A LoadSmart carrier',
      capacityTons: truckDoc.capacityTons, currentLocation: truckDoc.currentLocation,
      matchScore: result.score, matchTierLabel: tierLabel,
      reasonText: `Our matching engine found a ${tierLabel.toLowerCase()} for your load ${load.tokenNo} (${result.score}/100) — the required truck type, capacity, and location all line up well.`,
    }).catch(() => {}) : null,
    carrier && carrier.email && prefEnabled(carrier, 'truckMatches') ? emailService.sendNewLoadMatchCarrierEmail({
      to: carrier.email, tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination,
      material: load.material, weight: load.weight, requiredTruckType: load.requiredTruckType,
      pickupDateTime: load.pickupDateTime, estimatedRate: load.estimatedRate,
      matchScore: result.score, matchTierLabel: tierLabel,
      reasonText: `Your truck ${emailTemplates.maskVehicleNumber(truckDoc.vehicleNumber)} is a ${tierLabel.toLowerCase()} (${result.score}/100) for load ${load.tokenNo}.`,
    }).catch(() => {}) : null,
  ]);
}

// ---------- Driver Trust Score recompute (lib/trustScore.js) ----------
// Called after anything that should move a driver's trust standing: a
// completed trip (recency/confidence change even with no new feedback) or
// a freshly-submitted customer feedback. Reads the single source of truth
// (the Feedback collection + the driver's own operational counters),
// recomputes with the pure lib/trustScore.js engine, and caches the
// result onto the Driver document (trustScore/trustBreakdown) so every
// other screen can read it with a single field lookup. Also upserts one
// row into DriverTrustHistory for the current calendar month, powering
// the Driver Profile's trend chart.
async function recomputeDriverTrust(driverId) {
  const driver = await Driver.findOne({ id: driverId });
  if (!driver) return null;
  // Most-recent-first, per lib/trustScore.js's documented contract (recent
  // performance is weighted more heavily than old history).
  const recentFeedbacks = await Feedback.find({ driverId }).sort({ createdAt: -1 }).limit(50).lean();
  const result = trustScoreLib.computeTrustScore({
    completedTrips: Number(driver.completedTrips || 0),
    cancelledCount: Number(driver.cancelledCount || 0),
    recentFeedbacks,
  });
  driver.trustScore = result.score;
  // Flattened onto one object so both the matching engine
  // (trustBreakdown.onTimeRate) and the Driver Profile UI can read every
  // component with a single field lookup — no separate Feedback query.
  driver.trustBreakdown = {
    ...result.components, // customerRating, onTimeRate, completionRate, cancellationRate, recommendRate, complaintRate
    confidence: result.confidence,
    basedOnTrips: result.basedOnTrips,
    label: result.label,
  };
  await driver.save();
  const monthKey = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  await DriverTrustHistory.findOneAndUpdate(
    { driverId, monthKey },
    { driverId, monthKey, score: result.score, updatedAt: new Date() },
    { upsert: true }
  );
  return result;
}

// ---------- Admin: AI Recommendation Approval ----------
// The ONE manual decision point in the whole automated pipeline — admin
// reviews the AI's pick and either approves it (load moves to ASSIGNED,
// same state tryAutoAssignLoad used to jump to directly — the driver's
// dashboard picks it up from there exactly as before) or rejects it
// (truck/driver are released back to the pool and the load returns to
// POSTED so it can be matched again, either automatically on the next
// posting or via "Retry match" from the Unmatched Loads tab).
app.get('/api/admin/fleet/pending-approvals', requireAdmin, async (req, res) => {
  const loads = await BookingRequest.find({ loadStage: 'MATCHED' }).sort({ createdAt: -1 }).lean();
  const truckIds = loads.map((l) => l.assignedTruckId).filter(Boolean);
  const driverIds = loads.map((l) => l.assignedDriverId).filter(Boolean);
  const [trucks, drivers] = await Promise.all([
    Truck.find({ id: { $in: truckIds } }).lean(),
    Driver.find({ id: { $in: driverIds } }).lean(),
  ]);
  const truckById = new Map(trucks.map((t) => [t.id, t]));
  const driverById = new Map(drivers.map((d) => [d.id, d]));
  res.json(loads.map((l) => ({
    tokenNo: l.tokenNo, pickup: l.pickup, destination: l.destination, material: l.material,
    weight: l.weight, estimatedRate: l.estimatedRate, requiredTruckType: l.requiredTruckType,
    matchScore: l.matchScore, matchReasons: l.matchReasons,
    truck: truckById.get(l.assignedTruckId) || null,
    driver: driverById.get(l.assignedDriverId) || null,
    createdAt: l.createdAt,
  })));
});

// On-demand "View AI Matching Details" — the full Matching Dashboard data
// for this load: the recommended best match, every other eligible
// candidate ranked below it, and every ineligible truck WITH the specific
// reason it was excluded (never silently dropped — per spec, "no suitable
// match" must always be explainable). Read-only, recomputed fresh every
// call so it always reflects the fleet's current state.
//
// `candidates` is also included for backward compatibility with the
// existing Approvals-drawer table (views/admin/fleet.js) — same ranked
// list, flattened to the fields that table already renders.
app.get('/api/admin/fleet/loads/:token/match-details', requireAdmin, async (req, res) => {
  const load = await BookingRequest.findOne({ tokenNo: req.params.token }).lean();
  if (!load) return res.status(404).json({ error: 'Load not found.' });
  const { eligible, ineligible } = await computeLoadMatches(load);
  const candidates = eligible.map((c) => ({
    vehicleNumber: c.vehicleNumber, truckType: c.truckType, capacityTons: c.capacityTons,
    driverName: c.driverName, currentLocation: c.currentLocation || '',
    chosen: c.truckId === load.assignedTruckId,
    score: c.matchScore,
  }));
  res.json({
    loadId: load.tokenNo,
    weights: matchingEngine.MATCH_WEIGHTS,
    bestMatch: eligible[0] || null,
    otherMatches: eligible.slice(1),
    ineligible,
    candidates,
  });
});

// Spec-exact endpoint: GET /api/loads/:loadId/matches — same underlying
// engine as match-details above (kept as one shared computeLoadMatches()
// call so the two can never disagree), addressed by loadId/tokenNo
// directly per the spec's documented API shape. Used by the AI chatbot's
// FIND_MATCHES/SHOW_MATCHES actions and available for any future frontend
// that wants the plain "give me the matches for this load" contract.
app.get('/api/loads/:loadId/matches', requireAdmin, async (req, res) => {
  const load = await BookingRequest.findOne({ tokenNo: req.params.loadId }).lean();
  if (!load) return res.status(404).json({ error: 'Load not found.' });
  const { eligible, ineligible } = await computeLoadMatches(load);
  res.json({
    loadId: load.tokenNo,
    matches: eligible.map((c) => ({
      driverId: c.driverId,
      truckId: c.truckId,
      matchScore: c.matchScore,
      trustScore: c.trustScore,
      reasons: c.reasons,
    })),
    ineligible,
  });
});

// Shared by every route that moves a load to loadStage ASSIGNED (AI-match
// approval, dispatcher manual assignment) — sends the "you've been
// assigned" email to the driver (when they have one on file — see the
// optional Driver.email field) and the "a driver has been assigned to your
// load" email to the shipper, creates the matching in-app notifications,
// a TrackingEvent, and the audit log row. One function so all three entry
// points behave identically (spec section 4).
// Fire-and-forget SMS to whichever broker is actually involved with a load
// (the one who posted it, via postedByBrokerUsername, or — once a deal is
// won — the one who brokered it, via the pre-existing brokerUsername field)
// — a safe no-op for an ordinary shipper-direct load that has no broker at
// all, and a safe no-op when that broker has no phone number on file.
function smsBrokerForLoad(load, sendFn) {
  const brokerUsername = (load && (load.postedByBrokerUsername || load.brokerUsername)) || '';
  if (!brokerUsername) return;
  Registration.findOne({ role: 'broker', username: brokerUsername }).select('id mobileNumber').lean().then((broker) => {
    if (broker && broker.mobileNumber) sendFn(broker).catch(() => {});
  }).catch(() => {});
}

async function notifyDriverAssigned(load, adminId) {
  const [truck, driver, shipper] = await Promise.all([
    load.assignedTruckId ? Truck.findOne({ id: load.assignedTruckId }).lean() : null,
    load.assignedDriverId ? Driver.findOne({ id: load.assignedDriverId }).lean() : null,
    load.shipperUsername ? Registration.findOne({ role: 'shipper', username: load.shipperUsername }).lean() : null,
  ]);
  load.assignedBy = adminId ? `admin:${adminId}` : 'admin';
  load.assignedAt = new Date();

  if (driver && prefEnabled(driver, 'driverAssignment')) {
    emailService.sendDriverAssignedEmail({
      to: driver.email, tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination,
      material: load.material, weight: load.weight, vehicleNumber: truck && truck.vehicleNumber, companyName: load.companyName,
    }).catch(() => {});
    notificationService.notify({
      userId: driver.id, userRole: 'driver', loadId: load.tokenNo, type: 'DRIVER_ASSIGNED',
      title: 'New load assigned', message: `You have been assigned Load ${load.tokenNo}. Open your Driver Dashboard to accept or reject it.`,
    }).catch(() => {});
  }
  if (shipper && prefEnabled(shipper, 'assignmentUpdates')) {
    emailService.sendDriverAssignedShipperEmail({ to: shipper.email, tokenNo: load.tokenNo, driverName: driver && driver.name, vehicleNumber: truck && truck.vehicleNumber }).catch(() => {});
    notificationService.notify({
      userId: shipper.id, userRole: 'shipper', loadId: load.tokenNo, type: 'DRIVER_ASSIGNED',
      title: 'Driver assigned', message: `Driver ${driver ? driver.name : ''} has been assigned to your load ${load.tokenNo}.`.trim(),
    }).catch(() => {});
  }
  // Assignment confirmation for the CARRIER (spec section 7) — previously
  // only the driver and shipper were emailed here; the carrier whose
  // truck/driver just got booked is an equally interested party and gets
  // its own "Load Assignment Confirmed" email with the same clear status
  // vocabulary (ASSIGNED / CONFIRMED / DRIVER ASSIGNED / IN TRANSIT /
  // DELIVERED) used across the rest of this notification system.
  if (truck && truck.carrierUsername) {
    Registration.findOne({ role: 'carrier', username: truck.carrierUsername }).select('id email companyName username notificationPrefs').lean().then((carrier) => {
      if (!carrier || !carrier.email || !prefEnabled(carrier, 'assignmentUpdates')) return;
      emailService.sendAssignmentConfirmedCarrierEmail({
        to: carrier.email, tokenNo: load.tokenNo,
        shipperName: (shipper && (shipper.companyName || shipper.username)) || load.companyName,
        pickup: load.pickup, destination: load.destination,
        driverName: driver && driver.name, vehicleNumber: truck.vehicleNumber,
        statusLabel: 'ASSIGNED',
      }).catch(() => {});
      notificationService.notify({
        userId: carrier.id, userRole: 'carrier', loadId: load.tokenNo, type: 'ASSIGNMENT_CONFIRMED',
        title: 'Assignment confirmed', message: `Your truck ${truck.vehicleNumber} and driver were confirmed for Load ${load.tokenNo}.`,
      }).catch(() => {});
    }).catch(() => {});
  }
  notificationService.notify({
    userId: 'admin', userRole: 'admin', loadId: load.tokenNo, type: 'DRIVER_ASSIGNED',
    title: 'Assignment activity', message: `Driver ${driver ? driver.name : load.assignedDriverId} / truck ${truck ? truck.vehicleNumber : load.assignedTruckId} assigned to Load ${load.tokenNo}.`,
  }).catch(() => {});
  smsBrokerForLoad(load, (broker) => smsService.sendDriverAssignedSms({
    to: broker.mobileNumber, tokenNo: load.tokenNo, driverName: driver && driver.name, vehicleNumber: truck && truck.vehicleNumber,
    userId: broker.id, userRole: 'broker',
  }));
  ops.TrackingEvent.create({
    tokenNo: load.tokenNo, type: 'DRIVER_ASSIGNED', label: 'Driver / Carrier Assigned',
    notes: `${driver ? driver.name : ''} — ${truck ? truck.vehicleNumber : ''}`.trim(), createdByRole: 'admin', createdAt: new Date(),
  }).catch(() => {});
  logActivity({
    loadId: load.tokenNo, userId: adminId || '', userRole: 'admin', action: 'DRIVER_ASSIGNED',
    oldStatus: 'MATCHED/POSTED', newStatus: 'ASSIGNED',
    metadata: { driverId: load.assignedDriverId, truckId: load.assignedTruckId },
  }).catch(() => {});
}

app.post('/api/admin/fleet/loads/:token/approve', requireAdmin, async (req, res) => {
  const load = await BookingRequest.findOne({ tokenNo: req.params.token });
  if (!load) return res.status(404).json({ error: 'Load not found.' });
  if (load.loadStage !== 'MATCHED') return res.status(409).json({ error: `This load isn't awaiting approval right now (currently ${load.loadStage}).` });
  const truck = await Truck.findOne({ id: load.assignedTruckId }).lean();
  load.loadStage = 'ASSIGNED';
  syncTrackingStatusFromLoadStage(load, `Assignment approved — truck ${truck ? truck.vehicleNumber : ''} notified, awaiting driver acceptance.`);
  await notifyDriverAssigned(load, req.adminId);
  await load.save();
  emitLoadUpdate(load.tokenNo, { loadStage: load.loadStage });
  res.json({ ok: true, loadStage: load.loadStage });
});

app.post('/api/admin/fleet/loads/:token/reject', requireAdmin, async (req, res) => {
  const load = await BookingRequest.findOne({ tokenNo: req.params.token });
  if (!load) return res.status(404).json({ error: 'Load not found.' });
  if (load.loadStage !== 'MATCHED') return res.status(409).json({ error: `This load isn't awaiting approval right now (currently ${load.loadStage}).` });
  const [truck, driver] = await Promise.all([
    Truck.findOne({ id: load.assignedTruckId }),
    Driver.findOne({ id: load.assignedDriverId }),
  ]);
  if (truck) { truck.status = 'available'; await truck.save(); }
  if (driver && driver.status !== 'available') { /* driver was never marked busy at MATCHED stage — nothing to release */ }
  load.assignedTruckId = ''; load.assignedDriverId = '';
  load.matchScore = null; load.matchReasons = [];
  load.loadStage = 'POSTED';
  load.matchNote = String(req.body && req.body.reason || 'Admin rejected the AI-recommended match.');
  syncTrackingStatusFromLoadStage(load, 'Recommendation rejected by admin — searching for another match.');
  await load.save();
  logActivity({ loadId: load.tokenNo, userId: req.adminId || '', userRole: 'admin', action: 'MATCH_REJECTED', oldStatus: 'MATCHED', newStatus: 'POSTED', metadata: { reason: load.matchNote } }).catch(() => {});
  emitLoadUpdate(load.tokenNo, { loadStage: load.loadStage });
  res.json({ ok: true, loadStage: load.loadStage });
});

// Explicit dispatcher-driven assignment — distinct from `approve` above
// (which only rubber-stamps the AI's own #1 pick). A dispatcher choosing
// a SPECIFIC candidate off the Matching Dashboard — possibly NOT the AI's
// top recommendation — IS the human decision point the spec calls for, so
// this moves the load straight to ASSIGNED (skipping the MATCHED
// pending-approval step `approve` exists for). Re-validates the candidate
// against a freshly-recomputed match list at click time (never trusts
// what the dispatcher's screen showed a few seconds ago), and reserves
// the truck with the same atomic, race-safe findOneAndUpdate pattern used
// by the auto-match pipeline.
async function assignDriverHandler(req, res) {
  const truckId = String((req.body && req.body.truckId) || '').trim();
  const driverId = String((req.body && req.body.driverId) || '').trim();
  if (!truckId || !driverId) return res.status(400).json({ error: 'truckId and driverId are required.' });
  const load = await BookingRequest.findOne({ tokenNo: req.params.token });
  if (!load) return res.status(404).json({ error: 'Load not found.' });
  // DRIVER_REJECTED is included here so admin can reassign a load right
  // after a driver has explicitly turned it down (spec section 5: "Admin
  // should then be able to assign another driver").
  if (!['POSTED', 'MATCHED', 'DRIVER_REJECTED'].includes(load.loadStage)) {
    return res.status(409).json({ error: `This load already has a confirmed assignment (currently ${load.loadStage}).` });
  }
  const { eligible } = await computeLoadMatches(load);
  const candidate = eligible.find((c) => c.truckId === truckId && c.driverId === driverId);
  if (!candidate) {
    return res.status(409).json({ error: 'That truck/driver pair is no longer an eligible match for this load — please refresh and try again.' });
  }

  const alreadyReservedByThisLoad = load.assignedTruckId === truckId;
  let truckDoc;
  if (alreadyReservedByThisLoad) {
    truckDoc = await Truck.findOne({ id: truckId }).lean();
  } else {
    truckDoc = await Truck.findOneAndUpdate({ id: truckId, status: 'available' }, { status: 'assigned' }, { new: true });
    if (!truckDoc) {
      return res.status(409).json({ error: 'That truck was just reserved by someone else — please refresh and try again.' });
    }
    // Release whatever this load had soft-reserved before (e.g. the AI's
    // own auto-pick), now that the dispatcher is overriding it.
    if (load.assignedTruckId) {
      await Truck.updateOne({ id: load.assignedTruckId, status: 'assigned' }, { status: 'available' });
    }
  }

  load.assignedTruckId = truckDoc.id;
  load.assignedDriverId = driverId;
  load.loadStage = 'ASSIGNED';
  load.matchScore = candidate.matchScore;
  load.matchReasons = candidate.reasons;
  load.matchAttempted = true;
  load.matchNote = '';
  load.carrierUsername = truckDoc.carrierUsername;
  load.driverRejectedReason = ''; // clear any prior rejection note now that a fresh assignment is being made
  syncTrackingStatusFromLoadStage(load, `Dispatcher assigned truck ${truckDoc.vehicleNumber} — awaiting driver acceptance.`);
  await notifyDriverAssigned(load, req.adminId);
  await load.save();
  emitLoadUpdate(load.tokenNo, { loadStage: load.loadStage, assignedTruckId: load.assignedTruckId, assignedDriverId: load.assignedDriverId });
  res.json({ ok: true, loadStage: load.loadStage, matchScore: load.matchScore });
}
app.post('/api/admin/fleet/loads/:token/assign', requireAdmin, assignDriverHandler);
// Spec-shaped alias (POST /api/loads/:token/assign-driver) — same handler,
// same validation, same emails/notifications, just addressed the way spec
// section 28 asks for.
app.post('/api/loads/:token/assign-driver', requireAdmin, assignDriverHandler);

// Admin cancellation of a live (already-committed, ASSIGNED-or-later)
// assignment — distinct from `reject` above, which discards a not-yet-
// approved AI recommendation before any driver ever committed to it. A
// cancellation here means a driver DID commit and it's being pulled back,
// so it counts against the driver's all-time cancellation count (feeds
// the Trust Score's cancellation-rate component) the way a genuine
// operational cancellation should.
app.post('/api/admin/fleet/loads/:token/cancel', requireAdmin, async (req, res) => {
  const load = await BookingRequest.findOne({ tokenNo: req.params.token });
  if (!load) return res.status(404).json({ error: 'Load not found.' });
  const cancellableStages = ['ASSIGNED', 'DRIVER_ACCEPTED', 'ARRIVED_PICKUP', 'LOADING', 'LOADED', 'DEPARTED_PICKUP', 'IN_TRANSIT'];
  if (!cancellableStages.includes(load.loadStage)) {
    return res.status(409).json({ error: `This load isn't in a cancellable state right now (currently ${load.loadStage}).` });
  }
  const [truck, driver] = await Promise.all([
    load.assignedTruckId ? Truck.findOne({ id: load.assignedTruckId }) : null,
    load.assignedDriverId ? Driver.findOne({ id: load.assignedDriverId }) : null,
  ]);
  if (truck) { truck.status = 'available'; await truck.save(); }
  if (driver) {
    driver.status = 'available';
    driver.cancelledCount = Number(driver.cancelledCount || 0) + 1;
    await driver.save();
    await recomputeDriverTrust(driver.id);
  }
  load.assignedTruckId = '';
  load.assignedDriverId = '';
  load.matchScore = null;
  load.matchReasons = [];
  load.loadStage = 'POSTED';
  load.trackingSessionActive = false;
  load.matchNote = String((req.body && req.body.reason) || 'Cancelled by admin.');
  syncTrackingStatusFromLoadStage(load, 'Assignment cancelled by admin — searching for another match.');
  await load.save();
  logActivity({ loadId: load.tokenNo, userId: req.adminId || '', userRole: 'admin', action: 'ASSIGNMENT_CANCELLED', newStatus: 'POSTED', metadata: { reason: load.matchNote } }).catch(() => {});
  emitLoadUpdate(load.tokenNo, { loadStage: load.loadStage });
  res.json({ ok: true, loadStage: load.loadStage });
});

// ================================================================
// ---------- Carrier Bidding System ----------
// Load Approval -> Carrier Bidding -> LoadSmart Margin -> Shipper Bid
// Selection. Fully additive: nothing above this block changes for a load
// whose assignmentMode is (or defaults to) 'auto_match'. Every route below
// only ever touches loads with assignmentMode:'bidding' — enforced by
// checking loadStage === 'BIDDING_OPEN' (a stage only openLoadForBidding()
// ever sets), not by re-checking assignmentMode itself.
//
// SECURITY MODEL (spec section 16 — enforced here, never trusted from the
// frontend):
//   - carrierBidAmount is only ever readable by the carrier who placed it
//     and by admin. It is NEVER included in any shipper-facing response.
//   - marginAmount/marginType/marginValue are ONLY readable by admin. They
//     are NEVER included in any carrier- or shipper-facing response.
//   - finalShipperPrice is computed server-side ONLY (calculateLoadSmartPricing
//     in lib/biddingEngine.js) — no route ever accepts a client-supplied
//     price, margin, or "final" figure and persists it as-is.
// ================================================================

// Reads the carrier session for JSON API endpoints, same inline pattern as
// getShipperSession above (this app has no getBrokerSession/getCarrierSession
// shared helper usable outside the :role-param routes for carrier — see
// getCarrierSession further up the file; reused directly here).

// ---------- Carrier: browse & bid ----------

// Loads currently open for bidding — deliberately NOT filtered to "this
// carrier's truck types only" server-side (a carrier's fleet can change
// between viewing and bidding); truck compatibility is enforced for real
// at bid-submission time below, against the specific truck they pick.
app.get('/api/carrier/loads/available', async (req, res) => {
  try {
    const session = getCarrierSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a carrier first.' });
    const carrier = await Registration.findOne({ role: 'carrier', id: session.recordId }).lean();
    if (!carrier) return res.status(404).json({ error: 'Carrier account not found.' });

    const loads = await BookingRequest.find({ loadStage: 'BIDDING_OPEN' }).sort({ biddingOpenedAt: -1 }).lean();
    const tokenNos = loads.map((l) => l.tokenNo);
    const myBids = await bidding.Bid.find({ loadId: { $in: tokenNos }, carrierUsername: carrier.username } ).lean();
    const myBidByLoad = new Map(myBids.map((b) => [b.loadId, b]));

    res.json(loads.map((l) => {
      const mine = myBidByLoad.get(l.tokenNo);
      return {
        tokenNo: l.tokenNo, pickup: l.pickup, destination: l.destination,
        pickupAddress: l.pickupAddress, destAddress: l.destAddress,
        material: l.material, weight: l.weight, distanceKm: l.distanceKm,
        requiredTruckType: l.requiredTruckType, requiredBodyType: l.requiredBodyType,
        pickupDateTime: l.pickupDateTime, deliveryDeadline: l.deliveryDeadline,
        biddingDeadline: l.biddingDeadline,
        biddingExpired: !!(l.biddingDeadline && new Date(l.biddingDeadline).getTime() < Date.now()),
        shipperCompanyName: l.companyName || '',
        myBid: mine ? { id: mine.id, bidAmount: mine.bidAmount, status: mine.status, truckId: mine.truckId, vehicleNumber: mine.vehicleNumber } : null,
      };
    }));
  } catch (err) {
    console.error('GET /api/carrier/loads/available failed:', err.message);
    res.status(500).json({ error: 'Could not load available loads right now. Please try again.' });
  }
});

// Submit a bid — the one route that actually creates a Bid document.
// Every guard here is enforced server-side; the frontend form is a
// convenience, never the source of truth (spec section 16).
app.post('/api/carrier/loads/:token/bids', async (req, res) => {
  try {
    const session = getCarrierSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a carrier first.' });
    const carrier = await Registration.findOne({ role: 'carrier', id: session.recordId }).lean();
    if (!carrier) return res.status(404).json({ error: 'Carrier account not found.' });

    const load = await BookingRequest.findOne({ tokenNo: req.params.token });
    if (!load) return res.status(404).json({ error: 'Load not found.' });
    if (load.loadStage !== 'BIDDING_OPEN') {
      return res.status(409).json({ error: `This load isn't open for bidding right now (currently ${statusMachine.STAGE_LABELS[load.loadStage] || load.loadStage}).` });
    }
    if (load.biddingDeadline && new Date(load.biddingDeadline).getTime() < Date.now()) {
      return res.status(409).json({ error: 'The bidding deadline for this load has passed.' });
    }

    const bidAmount = Number(req.body.bidAmount);
    if (!Number.isFinite(bidAmount) || bidAmount <= 0) {
      return res.status(400).json({ error: 'Enter a valid bid amount greater than zero.' });
    }
    const truckId = String(req.body.truckId || '').trim();
    if (!truckId) return res.status(400).json({ error: 'Select which truck you are bidding with.' });
    const truck = await Truck.findOne({ id: truckId, carrierUsername: carrier.username }).lean();
    if (!truck) return res.status(404).json({ error: 'That truck was not found in your fleet.' });
    const eligibility = matchingEngine.checkTruckEligibility(
      { weight: load.weight, requiredTruckType: load.requiredTruckType, requiredBodyType: load.requiredBodyType },
      truck,
    );
    if (!eligibility.eligible) {
      return res.status(400).json({ error: 'This truck is not eligible for this load: ' + eligibility.reasons.join('; ') });
    }

    const existingActive = await bidding.Bid.findOne({ loadId: load.tokenNo, carrierUsername: carrier.username, status: { $in: ['SUBMITTED', 'SHORTLISTED'] } }).lean();
    if (existingActive) {
      return res.status(409).json({ error: 'You already have an active bid on this load. Withdraw it first if you want to submit a different one.' });
    }

    const bid = await bidding.Bid.create({
      id: `BID-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      loadId: load.tokenNo,
      carrierUsername: carrier.username,
      carrierCompanyName: carrier.companyName || carrier.username,
      truckId: truck.id, vehicleNumber: truck.vehicleNumber || '',
      driverId: truck.assignedDriverId || '',
      bidAmount,
      notes: String(req.body.notes || '').trim().slice(0, 500),
    });

    const shipper = load.shipperUsername ? await Registration.findOne({ role: 'shipper', username: load.shipperUsername }).lean() : null;
    await ops.TrackingEvent.create({
      tokenNo: load.tokenNo, type: 'BID_SUBMITTED', label: 'New Carrier Bid Received',
      createdByRole: 'carrier', createdByUsername: carrier.username, createdAt: new Date(),
    }).catch(() => {});
    notificationService.notify({
      userId: 'admin', userRole: 'admin', loadId: load.tokenNo, type: 'BID_SUBMITTED',
      title: 'New bid received', message: `${bid.carrierCompanyName} bid ₹${bidAmount} on load ${load.tokenNo}.`,
    }).catch(() => {});
    // Shipper is told a bid arrived, but NEVER the amount — only admin sees
    // carrier pricing (spec section 16).
    if (shipper) {
      notificationService.notify({
        userId: shipper.id, userRole: 'shipper', loadId: load.tokenNo, type: 'BID_SUBMITTED',
        title: 'New bid on your load', message: `A carrier submitted a new bid for load ${load.tokenNo}. Compare offers any time from My Loads > Bids.`,
      }).catch(() => {});
    }
    emitLoadUpdate(load.tokenNo, { newBid: true });
    res.json({ id: bid.id, status: bid.status });
  } catch (err) {
    console.error('POST /api/carrier/loads/:token/bids failed:', err.message);
    res.status(500).json({ error: 'Could not submit your bid right now. Please try again.' });
  }
});

// All of this carrier's own bids, across every load — their own amounts
// are fine to show here, this is their own data.
app.get('/api/carrier/bids', async (req, res) => {
  try {
    const session = getCarrierSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a carrier first.' });
    const carrier = await Registration.findOne({ role: 'carrier', id: session.recordId }).lean();
    if (!carrier) return res.status(404).json({ error: 'Carrier account not found.' });
    const bids = await bidding.Bid.find({ carrierUsername: carrier.username }).sort({ createdAt: -1 }).lean();
    const loads = await BookingRequest.find({ tokenNo: { $in: bids.map((b) => b.loadId) } })
      .select('tokenNo pickup destination loadStage winningBidId').lean();
    const loadByToken = new Map(loads.map((l) => [l.tokenNo, l]));
    res.json(bids.map((b) => ({
      id: b.id, loadId: b.loadId, bidAmount: b.bidAmount, status: b.status, notes: b.notes,
      truckId: b.truckId, vehicleNumber: b.vehicleNumber, createdAt: b.createdAt,
      acceptedAt: b.acceptedAt, rejectedAt: b.rejectedAt, rejectionReason: b.rejectionReason,
      load: loadByToken.get(b.loadId) ? { pickup: loadByToken.get(b.loadId).pickup, destination: loadByToken.get(b.loadId).destination, loadStage: loadByToken.get(b.loadId).loadStage } : null,
    })));
  } catch (err) {
    console.error('GET /api/carrier/bids failed:', err.message);
    res.status(500).json({ error: 'Could not load your bids right now. Please try again.' });
  }
});

// Withdraw an active bid.
app.delete('/api/carrier/bids/:bidId', async (req, res) => {
  try {
    const session = getCarrierSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a carrier first.' });
    const carrier = await Registration.findOne({ role: 'carrier', id: session.recordId }).lean();
    if (!carrier) return res.status(404).json({ error: 'Carrier account not found.' });
    const bid = await bidding.Bid.findOne({ id: req.params.bidId, carrierUsername: carrier.username });
    if (!bid) return res.status(404).json({ error: 'Bid not found.' });
    if (!['SUBMITTED', 'SHORTLISTED'].includes(bid.status)) {
      return res.status(409).json({ error: `This bid can't be withdrawn — it is already ${bid.status.toLowerCase()}.` });
    }
    bid.status = 'WITHDRAWN';
    bid.withdrawnAt = new Date();
    await bid.save();
    await ops.TrackingEvent.create({ tokenNo: bid.loadId, type: 'BID_WITHDRAWN', label: 'Carrier Withdrew Bid', createdByRole: 'carrier', createdByUsername: carrier.username, createdAt: new Date() }).catch(() => {});
    res.json({ ok: true, status: bid.status });
  } catch (err) {
    console.error('DELETE /api/carrier/bids/:bidId failed:', err.message);
    res.status(500).json({ error: 'Could not withdraw that bid right now. Please try again.' });
  }
});

// ---------- Shared: build the {truck, driver, finalShipperPrice} context biddingEngine.rankBidsForShipper needs ----------
async function buildBidRankingContext(bids, marginConfig) {
  const truckIds = bids.map((b) => b.truckId);
  const trucks = await Truck.find({ id: { $in: truckIds } }).lean();
  const truckById = new Map(trucks.map((t) => [t.id, t]));
  const driverIds = trucks.map((t) => t.assignedDriverId).filter(Boolean);
  const drivers = await Driver.find({ id: { $in: driverIds } }).lean();
  const driverById = new Map(drivers.map((d) => [d.id, d]));
  return bids
    .map((bid) => {
      const truck = truckById.get(bid.truckId);
      if (!truck) return null; // truck was deleted/reassigned since the bid was placed — skip, don't crash
      const driver = driverById.get(truck.assignedDriverId) || driverById.get(bid.driverId) || null;
      const priced = biddingEngine.calculateLoadSmartPricing({ carrierBidAmount: bid.bidAmount, marginConfig });
      return { bid, truck, driver, finalShipperPrice: priced.finalShipperPrice, pricing: priced };
    })
    .filter(Boolean);
}

// ---------- Shipper: view ranked bids & select a winner ----------

// Ranked offers for the shipper — finalShipperPrice + AI Match% + Trust
// Score ONLY. carrierBidAmount and every margin field are deliberately
// left out of this response entirely (not just hidden client-side).
app.get('/api/shipper/loads/:token/bids', async (req, res) => {
  try {
    const session = getShipperSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a shipper first.' });
    const shipper = await Registration.findOne({ role: 'shipper', id: session.recordId }).lean();
    const load = await BookingRequest.findOne({ tokenNo: req.params.token }).lean();
    if (!load || !shipper || load.shipperUsername !== shipper.username) {
      return res.status(404).json({ error: 'Load not found.' });
    }
    const bids = await bidding.Bid.find({ loadId: load.tokenNo, status: { $in: ['SUBMITTED', 'SHORTLISTED'] } }).lean();
    if (!bids.length) {
      return res.json({ loadStage: load.loadStage, biddingDeadline: load.biddingDeadline, offers: [] });
    }
    const marginConfig = await bidding.getMarginConfig();
    const context = await buildBidRankingContext(bids, marginConfig);
    const ranked = biddingEngine.rankBidsForShipper(load, context);
    res.json({
      loadStage: load.loadStage, biddingDeadline: load.biddingDeadline,
      offers: ranked.map((r) => ({
        bidId: r.bidId, rank: r.rank, finalShipperPrice: r.finalShipperPrice,
        aiMatchScore: r.aiMatchScore, trustScore: r.trustScore,
        truckType: r.truckType, bodyType: r.bodyType, capacityTons: r.capacityTons,
        currentLocation: r.currentLocation, submittedAt: r.submittedAt, notes: r.notes,
        carrierCompanyName: r.carrierCompanyName,
      })),
    });
  } catch (err) {
    console.error('GET /api/shipper/loads/:token/bids failed:', err.message);
    res.status(500).json({ error: 'Could not load bids right now. Please try again.' });
  }
});

// THE transactional accept-bid flow (spec: "must use a DB transaction to
// prevent two simultaneous accepts on the same load"). Two layers of
// protection, deliberately not just one:
//   1. A Mongo multi-document session transaction wraps every write below
//      — requires MongoDB running as a replica set (the default for
//      MongoDB Atlas and any modern production deployment; a single
//      standalone `mongod` does not support this — see MIGRATION.md).
//   2. Inside that transaction, the load and the bid are each claimed with
//      an ATOMIC conditional findOneAndUpdate (only succeeds if the load
//      is still BIDDING_OPEN / the bid is still SUBMITTED-or-SHORTLISTED)
//      — the same race-safe idiom already used by tryAutoAssignLoad's
//      truck reservation elsewhere in this file. This second layer is
//      what actually makes "two simultaneous accepts" impossible even
//      within the same transaction, and keeps working as a safety net on
//      its own if transactions are ever unavailable in a given deployment.
app.post('/api/shipper/loads/:token/bids/:bidId/accept', async (req, res) => {
  const session = getShipperSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a shipper first.' });
  const shipper = await Registration.findOne({ role: 'shipper', id: session.recordId }).lean();
  if (!shipper) return res.status(404).json({ error: 'Shipper account not found.' });
  const loadCheck = await BookingRequest.findOne({ tokenNo: req.params.token }).lean();
  if (!loadCheck || loadCheck.shipperUsername !== shipper.username) {
    return res.status(404).json({ error: 'Load not found.' });
  }

  const mongoSession = await mongoose.startSession();
  let result;
  try {
    await mongoSession.withTransaction(async () => {
      // Atomically claim the load itself FIRST, straight to its final
      // 'ASSIGNED' value (never an intermediate/invalid enum value) — this
      // single conditional write is what makes a second, concurrent accept
      // attempt on the SAME load fail cleanly (its own findOneAndUpdate
      // below will match zero documents, since loadStage is no longer
      // 'BIDDING_OPEN'), regardless of which bid it was trying to accept.
      const load = await BookingRequest.findOneAndUpdate(
        { tokenNo: req.params.token, loadStage: 'BIDDING_OPEN' },
        { loadStage: 'ASSIGNED', biddingClosedAt: new Date() },
        { new: true, session: mongoSession },
      );
      if (!load) {
        const err = new Error('This load is no longer open for bidding — someone may have already selected a carrier.');
        err.status = 409;
        throw err;
      }
      const acceptedBid = await bidding.Bid.findOneAndUpdate(
        { id: req.params.bidId, loadId: req.params.token, status: { $in: ['SUBMITTED', 'SHORTLISTED'] } },
        { status: 'ACCEPTED', acceptedAt: new Date() },
        { new: true, session: mongoSession },
      );
      if (!acceptedBid) {
        const err = new Error('That bid is no longer available — it may have been withdrawn or already decided.');
        err.status = 409;
        throw err;
      }
      const truckDoc = await Truck.findOneAndUpdate(
        { id: acceptedBid.truckId, status: 'available' },
        { status: 'assigned' },
        { new: true, session: mongoSession },
      );
      if (!truckDoc) {
        const err = new Error("That carrier's truck is no longer available. Please pick a different offer.");
        err.status = 409;
        throw err;
      }
      const marginConfig = await bidding.getMarginConfig();
      const pricing = biddingEngine.calculateLoadSmartPricing({ carrierBidAmount: acceptedBid.bidAmount, marginConfig });
      acceptedBid.marginType = pricing.marginType;
      acceptedBid.marginValue = pricing.marginValue;
      acceptedBid.marginAmount = pricing.marginAmount;
      acceptedBid.finalShipperPrice = pricing.finalShipperPrice;
      await acceptedBid.save({ session: mongoSession });

      // Every other still-active bid on this load loses.
      await bidding.Bid.updateMany(
        { loadId: req.params.token, status: { $in: ['SUBMITTED', 'SHORTLISTED'] }, id: { $ne: acceptedBid.id } },
        { status: 'REJECTED', rejectedAt: new Date(), rejectionReason: 'Another carrier was selected for this load.' },
        { session: mongoSession },
      );

      load.assignedTruckId = truckDoc.id;
      load.assignedDriverId = truckDoc.assignedDriverId || '';
      load.carrierUsername = acceptedBid.carrierUsername;
      load.carrierCompanyName = acceptedBid.carrierCompanyName;
      // Broker module addition: when the winning bid was placed by a
      // broker (submittedByRole === 'broker'), also stamp the existing
      // brokerUsername/brokerCompanyName assignment fields (the same ones
      // Admin's Tracking module already uses) so the broker's own
      // dashboard/shipments list picks this load up — purely additive, a
      // no-op ('' stays '') for every ordinary carrier-submitted bid.
      if (acceptedBid.submittedByRole === 'broker' && acceptedBid.brokerUsername) {
        load.brokerUsername = acceptedBid.brokerUsername;
        load.brokerCompanyName = acceptedBid.brokerCompanyName || load.brokerCompanyName;
      }
      load.winningBidId = acceptedBid.id;
      load.assignedBy = `shipper:${shipper.username}`;
      load.assignedAt = new Date();
      load.finalRate = pricing.finalShipperPrice;
      syncTrackingStatusFromLoadStage(load, `Carrier selected — ${acceptedBid.carrierCompanyName}.`);
      await load.save({ session: mongoSession });

      result = { load, acceptedBid, truckDoc, pricing };
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /api/shipper/loads/:token/bids/:bidId/accept failed:', err.message);
    // Transactions require a replica-set MongoDB deployment — surface that
    // specific case with an actionable message rather than a generic 500.
    if (/Transaction numbers are only allowed on a replica set|IllegalOperation/i.test(err.message || '')) {
      return res.status(500).json({ error: 'This action requires MongoDB to be running as a replica set (standard on MongoDB Atlas). Please contact support.' });
    }
    return res.status(500).json({ error: 'Could not accept that bid right now. Please try again.' });
  } finally {
    await mongoSession.endSession();
  }

  const { load, acceptedBid, truckDoc, pricing } = result;
  await ops.TrackingEvent.create({ tokenNo: load.tokenNo, type: 'CARRIER_SELECTED', label: 'Carrier Selected', notes: acceptedBid.carrierCompanyName, createdByRole: 'shipper', createdByUsername: shipper.username, createdAt: new Date() }).catch(() => {});
  await ops.TrackingEvent.create({ tokenNo: load.tokenNo, type: 'DRIVER_ASSIGNED', label: 'Driver / Carrier Assigned', createdByRole: 'system', createdAt: new Date() }).catch(() => {});
  logActivity({ loadId: load.tokenNo, userId: shipper.id, userRole: 'shipper', userName: shipper.companyName || shipper.username, action: 'BID_ACCEPTED', oldStatus: 'BIDDING_OPEN', newStatus: 'ASSIGNED', metadata: { bidId: acceptedBid.id, carrierUsername: acceptedBid.carrierUsername } }).catch(() => {});
  const [winningCarrier, driverDoc] = await Promise.all([
    Registration.findOne({ role: 'carrier', username: acceptedBid.carrierUsername }).lean(),
    load.assignedDriverId ? Driver.findOne({ id: load.assignedDriverId }).lean() : null,
  ]);
  if (winningCarrier && winningCarrier.email) {
    emailService.sendAssignmentConfirmedCarrierEmail({ to: winningCarrier.email, tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination }).catch(() => {});
  }
  notificationService.notify({ userId: shipper.id, userRole: 'shipper', loadId: load.tokenNo, type: 'CARRIER_SELECTED', title: 'Carrier selected', message: `You selected ${acceptedBid.carrierCompanyName} for load ${load.tokenNo}.` }).catch(() => {});
  if (winningCarrier) {
    notificationService.notify({ userId: winningCarrier.id, userRole: 'carrier', loadId: load.tokenNo, type: 'BID_ACCEPTED', title: 'Your bid was accepted!', message: `Your bid on load ${load.tokenNo} was accepted. Assign a driver if you haven't already.` }).catch(() => {});
    if (winningCarrier.mobileNumber) {
      smsService.sendBidAcceptedSms({ to: winningCarrier.mobileNumber, tokenNo: load.tokenNo, userId: winningCarrier.id, userRole: 'carrier' }).catch(() => {});
    }
  }
  // Broker module addition: the broker who placed the winning bid (if any)
  // gets their own notification too (spec section 6 "Receive notifications
  // when a bid is accepted").
  if (acceptedBid.submittedByRole === 'broker' && acceptedBid.brokerUsername) {
    const winningBroker = await Registration.findOne({ role: 'broker', username: acceptedBid.brokerUsername }).lean();
    if (winningBroker) {
      notificationService.notify({ userId: winningBroker.id, userRole: 'broker', loadId: load.tokenNo, type: 'BID_ACCEPTED', title: 'Your bid was accepted!', message: `Your bid on load ${load.tokenNo} was accepted by the shipper.` }).catch(() => {});
      if (winningBroker.mobileNumber) {
        smsService.sendBidAcceptedSms({ to: winningBroker.mobileNumber, tokenNo: load.tokenNo, userId: winningBroker.id, userRole: 'broker' }).catch(() => {});
      }
    }
  }
  // Broker Automation: reflect the real accept-bid outcome onto whichever
  // BrokerConnection this winning bid was placed for, if any — the
  // connection's status is never set to "approved" any other way (the
  // actual approval/assignment authority stays entirely with the shipper's
  // existing accept-bid flow above, completely unmodified).
  syncBrokerConnectionOnBidChange(acceptedBid.id, 'approved', 'The shipper accepted this offer.').catch((err) => console.error('syncBrokerConnectionOnBidChange failed:', err.message));
  notificationService.notify({ userId: 'admin', userRole: 'admin', loadId: load.tokenNo, type: 'CARRIER_SELECTED', title: 'Carrier selected by shipper', message: `Load ${load.tokenNo}: shipper selected ${acceptedBid.carrierCompanyName} (₹${acceptedBid.finalShipperPrice}).` }).catch(() => {});
  // Losing carriers (and losing brokers, same additive check).
  const losingBids = await bidding.Bid.find({ loadId: load.tokenNo, status: 'REJECTED', rejectedAt: { $ne: null } }).lean();
  await Promise.all(losingBids.map(async (lb) => {
    if (lb.submittedByRole === 'broker' && lb.brokerUsername) {
      const b = await Registration.findOne({ role: 'broker', username: lb.brokerUsername }).lean();
      if (b) notificationService.notify({ userId: b.id, userRole: 'broker', loadId: load.tokenNo, type: 'BID_REJECTED', title: 'Bid not selected', message: `Your bid on load ${load.tokenNo} was not selected — the shipper chose another offer.` }).catch(() => {});
      syncBrokerConnectionOnBidChange(lb.id, 'rejected', 'The shipper selected another offer.').catch((err) => console.error('syncBrokerConnectionOnBidChange failed:', err.message));
      return;
    }
    const c = await Registration.findOne({ role: 'carrier', username: lb.carrierUsername }).lean();
    if (c) notificationService.notify({ userId: c.id, userRole: 'carrier', loadId: load.tokenNo, type: 'BID_REJECTED', title: 'Bid not selected', message: `Your bid on load ${load.tokenNo} was not selected — the shipper chose another carrier.` }).catch(() => {});
  }));
  emitLoadUpdate(load.tokenNo, { loadStage: load.loadStage, assignedTruckId: load.assignedTruckId });
  res.json({ tokenNo: load.tokenNo, loadStage: load.loadStage, finalShipperPrice: pricing.finalShipperPrice });
});

// ---------- Admin: full visibility + close bidding + override-accept ----------

// Every bid on one load, WITH carrier bid amount + margin + final price —
// admin is the only role that ever sees all three (spec section 16).
app.get('/api/admin/loads/:token/bids', requireAdmin, async (req, res) => {
  try {
    const load = await BookingRequest.findOne({ tokenNo: req.params.token }).lean();
    if (!load) return res.status(404).json({ error: 'Load not found.' });
    const bids = await bidding.Bid.find({ loadId: load.tokenNo }).sort({ createdAt: -1 }).lean();
    const marginConfig = await bidding.getMarginConfig();
    const context = await buildBidRankingContext(bids.filter((b) => ['SUBMITTED', 'SHORTLISTED'].includes(b.status)), marginConfig);
    const contextByBidId = new Map(context.map((c) => [c.bid.id, c]));
    res.json({
      load: { tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination, loadStage: load.loadStage, biddingDeadline: load.biddingDeadline, winningBidId: load.winningBidId },
      bids: bids.map((b) => {
        const ctx = contextByBidId.get(b.id);
        const live = ctx ? biddingEngine.calculateLoadSmartPricing({ carrierBidAmount: b.bidAmount, marginConfig }) : null;
        return {
          id: b.id, carrierUsername: b.carrierUsername, carrierCompanyName: b.carrierCompanyName,
          truckId: b.truckId, vehicleNumber: b.vehicleNumber, bidAmount: b.bidAmount, notes: b.notes,
          status: b.status, createdAt: b.createdAt,
          // Accepted bids show their locked-in snapshot; still-active bids show a live indicative figure.
          marginType: b.status === 'ACCEPTED' ? b.marginType : (live && live.marginType),
          marginValue: b.status === 'ACCEPTED' ? b.marginValue : (live && live.marginValue),
          marginAmount: b.status === 'ACCEPTED' ? b.marginAmount : (live && live.marginAmount),
          finalShipperPrice: b.status === 'ACCEPTED' ? b.finalShipperPrice : (live && live.finalShipperPrice),
          aiMatchScore: ctx ? matchingEngine.scoreCandidate(load, ctx.truck, ctx.driver || {}).score : null,
          trustScore: ctx && ctx.driver && typeof ctx.driver.trustScore === 'number' ? ctx.driver.trustScore : null,
        };
      }),
    });
  } catch (err) {
    console.error('GET /api/admin/loads/:token/bids failed:', err.message);
    res.status(500).json({ error: 'Could not load bids right now. Please try again.' });
  }
});

// Admin closes bidding without a winner being chosen (e.g. deadline passed
// with no acceptable offers) — rejects every still-active bid and resets
// the load to POSTED so it can be re-opened for bidding or handed to
// auto-match instead.
app.post('/api/admin/loads/:token/close-bidding', requireAdmin, async (req, res) => {
  try {
    const load = await BookingRequest.findOne({ tokenNo: req.params.token });
    if (!load) return res.status(404).json({ error: 'Load not found.' });
    if (load.loadStage !== 'BIDDING_OPEN') {
      return res.status(409).json({ error: `This load isn't open for bidding right now (currently ${load.loadStage}).` });
    }
    await bidding.Bid.updateMany(
      { loadId: load.tokenNo, status: { $in: ['SUBMITTED', 'SHORTLISTED'] } },
      { status: 'REJECTED', rejectedAt: new Date(), rejectionReason: 'Bidding was closed by admin without a carrier being selected.' },
    );
    load.loadStage = 'POSTED';
    load.biddingClosedAt = new Date();
    syncTrackingStatusFromLoadStage(load, 'Bidding closed by admin — load reopened.');
    await load.save();
    await ops.TrackingEvent.create({ tokenNo: load.tokenNo, type: 'BIDDING_CLOSED', label: 'Bidding Closed', createdByRole: 'admin', createdAt: new Date() }).catch(() => {});
    logActivity({ loadId: load.tokenNo, userId: req.adminId || '', userRole: 'admin', action: 'BIDDING_CLOSED', oldStatus: 'BIDDING_OPEN', newStatus: 'POSTED' }).catch(() => {});
    emitLoadUpdate(load.tokenNo, { loadStage: load.loadStage });
    res.json({ ok: true, loadStage: load.loadStage });
  } catch (err) {
    console.error('POST /api/admin/loads/:token/close-bidding failed:', err.message);
    res.status(500).json({ error: 'Could not close bidding right now. Please try again.' });
  }
});

// ---------- Admin: LoadSmart Margin Settings ----------
app.get('/api/admin/margin-config', requireAdmin, async (req, res) => {
  try {
    const cfg = await bidding.getMarginConfig();
    res.json({
      marginType: cfg.marginType, marginValue: cfg.marginValue, minMargin: cfg.minMargin, maxMargin: cfg.maxMargin,
      updatedBy: cfg.updatedBy, updatedAt: cfg.updatedAt,
      history: (cfg.history || []).slice().reverse().slice(0, 50),
    });
  } catch (err) {
    console.error('GET /api/admin/margin-config failed:', err.message);
    res.status(500).json({ error: 'Could not load margin settings right now. Please try again.' });
  }
});
app.post('/api/admin/margin-config', requireAdmin, async (req, res) => {
  try {
    const { marginType, marginValue, minMargin, maxMargin, reason } = req.body;
    if (!biddingEngine.MARGIN_TYPES.includes(marginType)) {
      return res.status(400).json({ error: 'marginType must be FIXED or PERCENTAGE.' });
    }
    const value = Number(marginValue);
    if (!Number.isFinite(value) || value < 0) {
      return res.status(400).json({ error: 'Enter a valid, non-negative margin value.' });
    }
    const min = minMargin === '' || minMargin == null ? null : Number(minMargin);
    const max = maxMargin === '' || maxMargin == null ? null : Number(maxMargin);
    if (min != null && !Number.isFinite(min)) return res.status(400).json({ error: 'Minimum margin must be a number.' });
    if (max != null && !Number.isFinite(max)) return res.status(400).json({ error: 'Maximum margin must be a number.' });
    if (min != null && max != null && min > max) return res.status(400).json({ error: 'Minimum margin cannot be greater than maximum margin.' });

    const cfg = await bidding.getMarginConfig();
    cfg.history = cfg.history || [];
    cfg.history.push({ marginType: cfg.marginType, marginValue: cfg.marginValue, minMargin: cfg.minMargin, maxMargin: cfg.maxMargin, changedBy: req.adminId || '', changedAt: new Date(), reason: String((cfg._pendingChangeReason) || '') });
    cfg.marginType = marginType;
    cfg.marginValue = value;
    cfg.minMargin = min;
    cfg.maxMargin = max;
    cfg.updatedBy = req.adminId || '';
    cfg.updatedAt = new Date();
    await cfg.save();
    logActivity({ userId: req.adminId || '', userRole: 'admin', action: 'MARGIN_CONFIG_UPDATED', metadata: { marginType, marginValue: value, minMargin: min, maxMargin: max, reason: String(reason || '') } }).catch(() => {});
    res.json({ ok: true, marginType: cfg.marginType, marginValue: cfg.marginValue, minMargin: cfg.minMargin, maxMargin: cfg.maxMargin });
  } catch (err) {
    console.error('POST /api/admin/margin-config failed:', err.message);
    res.status(500).json({ error: 'Could not update margin settings right now. Please try again.' });
  }
});

// Loads with an active bidding round (or a very recently decided one) —
// data source for the Admin Bidding page's list view.
app.get('/api/admin/bidding/loads', requireAdmin, async (req, res) => {
  try {
    const loads = await BookingRequest.find({
      $or: [
        { loadStage: 'BIDDING_OPEN' },
        { assignmentMode: 'bidding', loadStage: { $in: ['ASSIGNED', 'DRIVER_ACCEPTED', 'ARRIVED_PICKUP', 'LOADING', 'LOADED', 'DEPARTED_PICKUP', 'IN_TRANSIT', 'REACHED_DESTINATION', 'UNLOADING', 'UNLOADING_COMPLETE', 'DELIVERED', 'COMPLETED'] }, winningBidId: { $ne: '' } },
      ],
    }).sort({ createdAt: -1 }).limit(200).lean();
    const counts = await bidding.Bid.aggregate([
      { $match: { loadId: { $in: loads.map((l) => l.tokenNo) } } },
      { $group: { _id: '$loadId', count: { $sum: 1 } } },
    ]);
    const countByLoad = new Map(counts.map((c) => [c._id, c.count]));
    res.json(loads.map((l) => ({
      tokenNo: l.tokenNo, pickup: l.pickup, destination: l.destination, loadStage: l.loadStage,
      biddingDeadline: l.biddingDeadline, winningBidId: l.winningBidId, companyName: l.companyName,
      bidCount: countByLoad.get(l.tokenNo) || 0,
    })));
  } catch (err) {
    console.error('GET /api/admin/bidding/loads failed:', err.message);
    res.status(500).json({ error: 'Could not load the bidding queue right now. Please try again.' });
  }
});

// ================================================================
// ---------- Real AI features (lib/aiService.js) ----------
// Every route below calls through the one aiService gateway, and every
// one of them catches AiNotConfiguredError the same way: a clear 503
// telling the admin/shipper/carrier AI isn't set up, never a crash. None
// of these routes are ever called automatically on page load (except the
// POD vision check, which is itself a single bounded call per upload, not
// per view) — they're all deliberately on-demand (a button click) so a
// deployment's AI spend is exactly proportional to how often a human
// actually asks for it.
function aiErrorResponse(res, err) {
  if (err instanceof aiService.AiNotConfiguredError || err.code === 'AI_NOT_CONFIGURED') {
    return res.status(503).json({ error: err.message, aiNotConfigured: true });
  }
  console.error('AI route failed:', err.message);
  return res.status(err.status || 500).json({ error: err.message || 'The AI request failed. Please try again.' });
}

// ---------- Feature 1: Admin Risk & Recommendation Copilot ----------
// Synthesizes structured signals this app ALREADY computes deterministically
// (AI Match breakdown from matchingEngine.scoreCandidate, Trust Score
// breakdown from trustScore.computeTrustScore, the bid price spread on this
// load) into a written judgment for a human admin — the LLM never decides a
// score or a price, it only explains and recommends on top of numbers this
// app already trusts and already computed the exact same way everywhere
// else (bidding.js's own displayed AI Match %/Trust Score come from the
// same source, so the copilot's narrative can never disagree with what the
// admin sees on screen).
app.post('/api/admin/ai/bid-assessment/:token/:bidId', requireAdmin, async (req, res) => {
  try {
    const load = await BookingRequest.findOne({ tokenNo: req.params.token }).lean();
    if (!load) return res.status(404).json({ error: 'Load not found.' });
    const bid = await bidding.Bid.findOne({ id: req.params.bidId, loadId: load.tokenNo }).lean();
    if (!bid) return res.status(404).json({ error: 'Bid not found.' });
    const [truck, otherBids] = await Promise.all([
      Truck.findOne({ id: bid.truckId }).lean(),
      bidding.Bid.find({ loadId: load.tokenNo, id: { $ne: bid.id } }).lean(),
    ]);
    const driver = truck && truck.assignedDriverId ? await Driver.findOne({ id: truck.assignedDriverId }).lean() : null;
    const marginConfig = await bidding.getMarginConfig();
    const pricing = biddingEngine.calculateLoadSmartPricing({ carrierBidAmount: bid.bidAmount, marginConfig });
    const aiMatch = truck ? matchingEngine.scoreCandidate(load, truck, driver || {}) : null;
    const activePrices = otherBids.filter((b) => ['SUBMITTED', 'SHORTLISTED'].includes(b.status)).map((b) => biddingEngine.calculateLoadSmartPricing({ carrierBidAmount: b.bidAmount, marginConfig }).finalShipperPrice);

    const context = {
      load: { tokenNo: load.tokenNo, route: `${load.pickup} -> ${load.destination}`, material: load.material, weightTons: load.weight, distanceKm: load.distanceKm, requiredTruckType: load.requiredTruckType || 'any' },
      thisBid: { carrier: bid.carrierCompanyName, carrierBidAmount: bid.bidAmount, marginAmount: pricing.marginAmount, finalShipperPrice: pricing.finalShipperPrice, notes: bid.notes || '(none)' },
      aiMatchScore: aiMatch ? aiMatch.score : null,
      aiMatchBreakdown: aiMatch ? aiMatch.breakdown : null,
      driverTrust: driver ? { score: driver.trustScore, label: (driver.trustBreakdown && driver.trustBreakdown.label) || null, completedTrips: driver.completedTrips || 0, cancelledCount: driver.cancelledCount || 0 } : null,
      competingActiveOfferCount: activePrices.length,
      competingPriceRange: activePrices.length ? { min: Math.min(...activePrices), max: Math.max(...activePrices) } : null,
    };
    const assessment = await aiService.completeJson({
      system: "You are an experienced freight/logistics operations risk analyst advising an admin at a trucking marketplace (LoadSmart) who is deciding whether to let a carrier's bid proceed. You're given already-computed, trustworthy structured data (AI match score, driver trust score, pricing) — never invent numbers, only reason about what's given. Be direct, concise, and specific to THIS bid.",
      prompt: `Assess this carrier bid and respond with JSON exactly like: {"recommendation": "ACCEPT"|"REVIEW"|"CAUTION", "assessment": "2-4 sentence plain-English summary", "concerns": ["short phrase", ...]}. Use CAUTION only for a genuinely concerning signal (e.g. low trust score, very low AI match, price far outside the competing range with no explanation). Data:\n${JSON.stringify(context, null, 2)}`,
      maxTokens: 500,
    });
    if (!assessment.ok) return res.status(502).json({ error: "The AI's response could not be parsed. Please try again.", raw: assessment.raw });
    res.json({ ...assessment.data, context });
  } catch (err) {
    aiErrorResponse(res, err);
  }
});

// Same idea, one level up: "should I approve this load's rate at all" —
// for the Rate Requests / Fleet Pending Approvals screens, before any
// carrier is even involved.
app.post('/api/admin/ai/load-assessment/:token', requireAdmin, async (req, res) => {
  try {
    const load = await BookingRequest.findOne({ tokenNo: req.params.token }).lean();
    if (!load) return res.status(404).json({ error: 'Load not found.' });
    const context = {
      load: { tokenNo: load.tokenNo, kind: load.kind, route: `${load.pickup} -> ${load.destination}`, material: load.material, weightTons: load.weight, distanceKm: load.distanceKm },
      pricing: { estimatedRate: load.estimatedRate, requestedRate: load.requestedRate, minAllowedRate: load.minAllowedRate, adminOfferedRate: load.adminOfferedRate },
      currentStatus: load.status,
      assignmentMode: load.assignmentMode,
      shipperCompanyName: load.companyName,
    };
    const assessment = await aiService.completeJson({
      system: 'You are a freight/logistics operations analyst advising an admin at a trucking marketplace (LoadSmart) who is deciding whether to approve a shipper\'s posted load / requested rate. Never invent numbers not given to you.',
      prompt: `Assess this load/rate request and respond with JSON exactly like: {"recommendation": "APPROVE"|"REVIEW"|"CAUTION", "assessment": "2-4 sentence plain-English summary", "concerns": ["short phrase", ...]}. A requestedRate far below estimatedRate/minAllowedRate is the main thing worth flagging here. Data:\n${JSON.stringify(context, null, 2)}`,
      maxTokens: 500,
    });
    if (!assessment.ok) return res.status(502).json({ error: "The AI's response could not be parsed. Please try again.", raw: assessment.raw });
    res.json({ ...assessment.data, context });
  } catch (err) {
    aiErrorResponse(res, err);
  }
});

// ---------- Feature 4: Proactive Delay Risk Narrator ----------
// On-demand, for a currently in-transit-or-later load: turns the existing
// tracking event history + deadline + the assigned driver's historical
// on-time rate into an early-warning narrative, instead of a shipper/admin
// having to mentally piece that together from a list of timestamps.
const DELAY_RISK_STAGES = ['ASSIGNED', 'DRIVER_ACCEPTED', 'ARRIVED_PICKUP', 'LOADING', 'LOADED', 'DEPARTED_PICKUP', 'IN_TRANSIT', 'REACHED_DESTINATION', 'UNLOADING', 'UNLOADING_COMPLETE'];
async function buildDelayRiskContext(load) {
  const [events, driver] = await Promise.all([
    ops.TrackingEvent.find({ tokenNo: load.tokenNo }).sort({ createdAt: 1 }).limit(50).lean(),
    load.assignedDriverId ? Driver.findOne({ id: load.assignedDriverId }).lean() : null,
  ]);
  return {
    load: { tokenNo: load.tokenNo, route: `${load.pickup} -> ${load.destination}`, loadStage: load.loadStage, loadStageLabel: statusMachine.STAGE_LABELS[load.loadStage] || load.loadStage },
    pickupDateTime: load.pickupDateTime, deliveryDeadline: load.deliveryDeadline, now: new Date(),
    existingDelayFlag: load.delay && load.delay.active ? { reason: load.delay.reason, reportedAt: load.delay.reportedAt } : null,
    driverOnTimeRate: driver && driver.trustBreakdown ? driver.trustBreakdown.onTimeRate : null,
    driverTrustScore: driver ? driver.trustScore : null,
    recentEvents: events.slice(-10).map((e) => ({ type: e.type, label: e.label, location: e.location, at: e.createdAt })),
  };
}
async function delayRiskHandler(req, res, load) {
  try {
    if (!DELAY_RISK_STAGES.includes(load.loadStage)) {
      return res.status(409).json({ error: 'Delay-risk assessment only applies once a load is assigned and moving.' });
    }
    const context = await buildDelayRiskContext(load);
    const assessment = await aiService.completeJson({
      system: 'You are a logistics operations analyst who reviews an in-progress shipment\'s tracking history and flags real delay risk early, in plain English, for a trucking marketplace. Never invent events not given to you.',
      prompt: `Assess this shipment's delay risk and respond with JSON exactly like: {"riskLevel": "LOW"|"MEDIUM"|"HIGH", "narrative": "2-4 sentence plain-English assessment", "suggestedAction": "one short sentence, or empty string if none needed"}. Consider: is it behind where it should be for the time elapsed, does the deliveryDeadline look at risk, does the driver's historical on-time rate raise concern, is there already a reported delay. Data:\n${JSON.stringify(context, null, 2)}`,
      maxTokens: 400,
    });
    if (!assessment.ok) return res.status(502).json({ error: "The AI's response could not be parsed. Please try again.", raw: assessment.raw });
    res.json(assessment.data);
  } catch (err) {
    aiErrorResponse(res, err);
  }
}
app.post('/api/admin/ai/delay-risk/:token', requireAdmin, async (req, res) => {
  const load = await BookingRequest.findOne({ tokenNo: req.params.token }).lean();
  if (!load) return res.status(404).json({ error: 'Load not found.' });
  await delayRiskHandler(req, res, load);
});
app.post('/api/tracking/order/:token/ai-delay-risk', async (req, res) => {
  const session = getShipperSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a shipper first.' });
  const shipper = await Registration.findOne({ role: 'shipper', id: session.recordId }).lean();
  const load = await BookingRequest.findOne({ tokenNo: req.params.token }).lean();
  if (!load || !shipper || load.shipperUsername !== shipper.username) return res.status(404).json({ error: 'Load not found.' });
  await delayRiskHandler(req, res, load);
});

// Driver Profile — trust score + full component breakdown + monthly trend
// history + linked truck + recent feedback, for the Admin Fleet page's
// Driver Profile drawer. Recomputes fresh from the Feedback collection
// (rather than trusting only the cached driver.trustScore snapshot) so it
// can never show a stale number even if some earlier recompute() call was
// missed.
app.get('/api/admin/fleet/drivers/:id/profile', requireAdmin, async (req, res) => {
  const driver = await Driver.findOne({ id: req.params.id }).lean();
  if (!driver) return res.status(404).json({ error: 'Driver not found.' });
  const recentFeedbacks = await Feedback.find({ driverId: driver.id }).sort({ createdAt: -1 }).limit(50).lean();
  const trust = trustScoreLib.computeTrustScore({
    completedTrips: Number(driver.completedTrips || 0),
    cancelledCount: Number(driver.cancelledCount || 0),
    recentFeedbacks,
  });
  const [truck, history] = await Promise.all([
    driver.assignedTruckId ? Truck.findOne({ id: driver.assignedTruckId }).lean() : null,
    DriverTrustHistory.find({ driverId: driver.id }).sort({ monthKey: 1 }).lean(),
  ]);
  res.json({
    driver,
    trust: {
      score: trust.score,
      label: trust.label,
      confidence: trust.confidence,
      basedOnTrips: trust.basedOnTrips,
      components: trust.components,
    },
    truck,
    history: history.map((h) => ({ monthKey: h.monthKey, score: h.score })),
    recentFeedbacks: recentFeedbacks.slice(0, 10).map((f) => ({
      rating: f.rating, onTime: f.onTime, deliverySuccess: f.deliverySuccess,
      cargoHandling: f.cargoHandling, communication: f.communication, recommend: f.recommend,
      comments: f.comments, createdAt: f.createdAt,
    })),
  });
});

// Keeps the pre-existing, admin-facing tracking.status enum in sync with
// the new automated loadStage pipeline, so nothing built earlier (Admin
// Tracking module, shipper Live Tracking page, computeFlowStage()) needs
// to change to understand this new flow.
function syncTrackingStatusFromLoadStage(load, remarks) {
  const map = {
    POSTED: 'Booked', MATCHED: 'Booked', BIDDING_OPEN: 'Booked', ASSIGNED: 'Confirmed', DRIVER_ACCEPTED: 'Confirmed',
    ARRIVED_PICKUP: 'Confirmed', LOADING: 'Confirmed', LOADED: 'Picked Up',
    IN_TRANSIT: 'In Transit', DELIVERED: 'Delivered',
  };
  load.tracking = load.tracking || {};
  load.tracking.status = map[load.loadStage] || load.tracking.status;
  if (remarks) load.tracking.remarks = remarks;
  load.tracking.updatedAt = new Date();
}

// ---------- Driver dashboard & pipeline actions ----------
// Whatever load is currently assigned to the logged-in driver (their
// mobile-OTP session already identifies them — they never type in a
// tracking ID, matching the "Driver ID -> Assigned Truck -> Assigned
// Load" requirement).
app.get('/api/driver/me', async (req, res) => {
  const session = getDriverSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in first.' });
  const driver = await Driver.findOne({ id: session.recordId }).lean();
  if (!driver) return res.status(404).json({ error: 'Driver account not found.' });
  const truck = driver.assignedTruckId ? await Truck.findOne({ id: driver.assignedTruckId }).lean() : null;
  // 'MATCHED' is deliberately excluded — that's an AI recommendation still
  // awaiting admin approval, not a real offer yet, so it stays invisible
  // to the driver until admin approves it (loadStage -> ASSIGNED).
  // 'DRIVER_REJECTED'/'COMPLETED' are excluded for the same reason as
  // 'DELIVERED' — no longer this driver's active load.
  const load = await BookingRequest.findOne({ assignedDriverId: driver.id, loadStage: { $nin: ['DELIVERED', 'MATCHED', 'DRIVER_REJECTED', 'COMPLETED'] } }).lean();
  res.json({ driver, truck, load });
});

// Notify shipper + admin about a manual trip update (spec sections 6-10) —
// shared by every branch of driverActionHandler below so the "who hears
// about this" rule lives in one place. `emailFn` is one of the
// lib/emailService.js functions; `extra` is spread into its args.
async function notifyTripUpdate({ load, shipper, emailFn, emailArgs, notifTitle, notifMessage, notifType }) {
  if (shipper && emailFn) emailFn({ to: shipper.email, tokenNo: load.tokenNo, ...emailArgs }).catch(() => {});
  if (shipper) {
    notificationService.notify({ userId: shipper.id, userRole: 'shipper', loadId: load.tokenNo, type: notifType, title: notifTitle, message: notifMessage }).catch(() => {});
  }
  notificationService.notify({ userId: 'admin', userRole: 'admin', loadId: load.tokenNo, type: notifType, title: notifTitle, message: notifMessage }).catch(() => {});
}

// The single mutation behind every "driver moves this load forward" call —
// used directly by /api/driver/loads/:token/action (existing driver
// dashboard) and by every spec-shaped alias below
// (/api/loads/:token/accept, /reject-assignment, /reach-destination,
// /unloading, /deliver) so there is exactly one implementation of what
// each action actually does. `action` comes from req.body.action for the
// generic route, or is pinned by the alias route itself.
async function driverActionHandler(req, res, forcedAction) {
  const session = getDriverSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in first.' });
  const action = forcedAction || (req.body && req.body.action);
  let transition;
  try {
    const load0 = await BookingRequest.findOne({ tokenNo: req.params.token, assignedDriverId: session.recordId }).select('loadStage').lean();
    if (!load0) return res.status(404).json({ error: 'No load found for that Token No. assigned to you.' });
    transition = statusMachine.assertTransition(load0.loadStage, action);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  // Delivery confirmation is REQUIRED before a load can move to DELIVERED
  // (spec section 11) — checked here, before any write, so a half-applied
  // transition can never happen.
  if (transition.requiresDeliveryConfirmation && !(req.body && req.body.confirmDelivery === true)) {
    return res.status(400).json({ error: 'Please confirm delivery (confirmDelivery: true) before marking this load as Delivered.' });
  }
  const load = await BookingRequest.findOne({ tokenNo: req.params.token, assignedDriverId: session.recordId });
  if (!load) return res.status(404).json({ error: 'No load found for that Token No. assigned to you.' });
  if (load.loadStage !== transition.from) {
    return res.status(409).json({ error: `This action isn't valid right now (load is currently ${statusMachine.STAGE_LABELS[load.loadStage] || load.loadStage}).` });
  }

  const oldStage = load.loadStage;
  load.loadStage = transition.to;
  load.delay = load.delay || {};
  load.delay.active = false; // any real action supersedes a prior delay flag

  const [driver, shipper] = await Promise.all([
    Driver.findOne({ id: load.assignedDriverId }),
    load.shipperUsername ? Registration.findOne({ role: 'shipper', username: load.shipperUsername }).lean() : null,
  ]);
  const truckForNotify = load.assignedTruckId ? await Truck.findOne({ id: load.assignedTruckId }) : null;

  if (action === 'accept') {
    load.driverAcceptedAt = new Date();
    // Driver has now actually committed — reflect that in the fleet's own
    // availability so a second load can't also be offered to them.
    if (driver) { driver.status = 'on_trip'; await driver.save(); }
    await notifyTripUpdate({
      load, shipper, emailFn: emailService.sendDriverAcceptedEmail, emailArgs: {},
      notifType: 'DRIVER_ACCEPTED', notifTitle: 'Driver accepted', notifMessage: `Driver accepted Load ${load.tokenNo}.`,
    });
    emailService.sendDriverAcceptedEmail({ to: NOTIFY_TO_EMAIL, tokenNo: load.tokenNo }).catch(() => {});
  } else if (action === 'reject') {
    // Release the truck back to the pool — the driver was never marked
    // busy at ASSIGNED stage (same as the existing admin /reject route for
    // an unapproved AI match), so there's nothing to release on the driver
    // side. Admin picks a new driver via /api/admin/fleet/loads/:token/assign
    // (now also accepts DRIVER_REJECTED as a valid starting stage).
    if (truckForNotify) { truckForNotify.status = 'available'; await truckForNotify.save(); }
    load.driverRejectedReason = String((req.body && req.body.reason) || '').trim();
    const reason = load.driverRejectedReason;
    await notifyTripUpdate({
      load, shipper, emailFn: emailService.sendDriverRejectedEmail, emailArgs: { reason },
      notifType: 'DRIVER_REJECTED', notifTitle: 'Driver rejected assignment', notifMessage: `The driver assigned to Load ${load.tokenNo} rejected the assignment. Please assign another driver.`,
    });
  } else if (action === 'depart') {
    // New milestone (manual digital trip tracking): truck has physically
    // left the pickup location. Deliberately does NOT touch
    // trackingSessionActive/GPS — that stays exclusively on 'start_trip'
    // below, one stage later, so the existing GPS-consent flow is unchanged.
    await notifyTripUpdate({
      load, shipper, emailFn: emailService.sendDepartedPickupEmail, emailArgs: { location: req.body && req.body.location },
      notifType: 'DEPARTED_PICKUP', notifTitle: 'Departed pickup', notifMessage: `Load ${load.tokenNo} has departed the pickup location.`,
    });
  } else if (action === 'start_trip') {
    load.trackingSessionActive = true;
    load.trackingStartedAt = new Date();
    if (truckForNotify) { truckForNotify.status = 'in_transit'; await truckForNotify.save(); }
    await notifyTripUpdate({
      load, shipper, emailFn: emailService.sendTripStartedEmail, emailArgs: { location: req.body && req.body.location },
      notifType: 'TRIP_STARTED', notifTitle: 'Trip started', notifMessage: `Load ${load.tokenNo} is now in transit.`,
    });
    smsBrokerForLoad(load, (broker) => smsService.sendShipmentDispatchedSms({
      to: broker.mobileNumber, tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination, userId: broker.id, userRole: 'broker',
    }));
  } else if (action === 'arrived') {
    await notifyTripUpdate({
      load, shipper, emailFn: emailService.sendPickupReachedEmail, emailArgs: { location: req.body && req.body.location },
      notifType: 'PICKUP_REACHED', notifTitle: 'Driver reached pickup', notifMessage: `The driver has reached the pickup location for Load ${load.tokenNo}.`,
    });
  } else if (action === 'reach_destination') {
    await notifyTripUpdate({
      load, shipper,
      emailFn: emailService.sendDestinationReachedEmail,
      emailArgs: { vehicleNumber: truckForNotify && truckForNotify.vehicleNumber, driverName: driver && driver.name, arrivalTime: new Date() },
      notifType: 'DESTINATION_REACHED', notifTitle: 'Reached destination', notifMessage: `Load ${load.tokenNo} has reached the destination.`,
    });
  } else if (action === 'start_unloading') {
    await notifyTripUpdate({
      load, shipper, emailFn: emailService.sendUnloadingStartedEmail, emailArgs: {},
      notifType: 'UNLOADING_STARTED', notifTitle: 'Unloading started', notifMessage: `Unloading has started for Load ${load.tokenNo}.`,
    });
  } else if (action === 'complete_unloading') {
    // New milestone (manual digital trip tracking): unloading is physically
    // finished — one step before the driver confirms delivery with receiver
    // details ('deliver' below, unchanged, still requires that confirmation).
    await notifyTripUpdate({
      load, shipper, emailFn: emailService.sendUnloadingCompletedEmail, emailArgs: {},
      notifType: 'UNLOADING_COMPLETED', notifTitle: 'Unloading completed', notifMessage: `Unloading has been completed for Load ${load.tokenNo}. Awaiting delivery confirmation.`,
    });
  } else if (action === 'deliver' || action === 'complete') {
    load.trackingSessionActive = false;
    load.trackingStoppedAt = new Date();
    load.deliveredAt = new Date();
    load.deliveryReceiverName = String((req.body && req.body.receiverName) || '').trim();
    load.deliveryReceiverPhone = String((req.body && req.body.receiverPhone) || '').trim();
    load.deliveryNotes = String((req.body && req.body.deliveryNotes) || '').trim();
    load.deliveryConfirmedAt = (req.body && req.body.deliveryDateTime) ? new Date(req.body.deliveryDateTime) : new Date();
    load.podStatus = 'pending';
    // Delivered -> free the truck and driver back up automatically, no
    // manual admin step required.
    if (truckForNotify) { truckForNotify.status = 'available'; await truckForNotify.save(); }
    if (driver) {
      driver.status = 'available';
      // All-time operational counter, independent of whether the shipper
      // ever leaves feedback — powers "127 Completed Trips" and feeds the
      // Trust Score's confidence-dampening factor even before any new
      // feedback arrives.
      driver.completedTrips = Number(driver.completedTrips || 0) + 1;
      await driver.save();
      // Recompute now (not just when feedback lands) so a driver's
      // confidence/trip-history factor stays accurate immediately —
      // feedback submission will trigger another recompute later that
      // additionally folds in the customer's rating.
      await recomputeDriverTrust(driver.id);
    }
    await notifyTripUpdate({
      load, shipper,
      emailFn: emailService.sendDeliveryCompletedEmail,
      emailArgs: { deliveryDate: load.deliveryConfirmedAt, receiverName: load.deliveryReceiverName },
      notifType: 'DELIVERED', notifTitle: 'Load delivered', notifMessage: `Load ${load.tokenNo} has been marked as delivered. A POD upload is now required to complete it.`,
    });
    smsBrokerForLoad(load, (broker) => smsService.sendShipmentDeliveredSms({ to: broker.mobileNumber, tokenNo: load.tokenNo, userId: broker.id, userRole: 'broker' }));
  }

  syncTrackingStatusFromLoadStage(load, transition.remarks);
  await load.save();
  await ops.TrackingEvent.create({
    tokenNo: load.tokenNo, type: transition.eventType, label: transition.eventLabel,
    location: (req.body && req.body.location) || '', lat: (req.body && req.body.lat) != null ? Number(req.body.lat) : null,
    lng: (req.body && req.body.lng) != null ? Number(req.body.lng) : null,
    notes: (req.body && req.body.notes) || '', photoPath: (req.body && req.body.photoPath) || '',
    createdByRole: 'driver', createdByName: driver ? driver.name : '', createdByUsername: driver ? driver.mobileNumber : '',
  }).catch((err) => console.error('TrackingEvent.create failed:', err.message));
  logActivity({
    loadId: load.tokenNo, userId: session.recordId, userRole: 'driver', userName: driver ? driver.name : '',
    action: `DRIVER_ACTION_${action.toUpperCase()}`, oldStatus: oldStage, newStatus: load.loadStage,
  }).catch(() => {});
  emitLoadUpdate(load.tokenNo, { loadStage: load.loadStage, trackingSessionActive: load.trackingSessionActive });
  res.json({ ok: true, loadStage: load.loadStage });
}

app.post('/api/driver/loads/:token/action', (req, res) => driverActionHandler(req, res));
// Spec-shaped aliases (section 28) — same handler, action pinned per route.
app.post('/api/loads/:token/accept', (req, res) => driverActionHandler(req, res, 'accept'));
app.post('/api/loads/:token/reject-assignment', (req, res) => driverActionHandler(req, res, 'reject'));
app.post('/api/loads/:token/reach-destination', (req, res) => driverActionHandler(req, res, 'reach_destination'));
app.post('/api/loads/:token/unloading', (req, res) => driverActionHandler(req, res, 'start_unloading'));
app.post('/api/loads/:token/deliver', (req, res) => driverActionHandler(req, res, 'deliver'));

// ---------- Checkpoint / generic location update (spec section 8) ----------
// Logged WITHOUT changing loadStage — a checkpoint is an informational
// ping along an already-in-progress load, not a new pipeline stage (see
// the mapping note at the top of lib/loadStatusMachine.js). Updates the
// existing tracking.currentLocation/remarks so the shipper's Live Tracking
// page reflects it immediately, same as an admin-entered location update
// always has.
async function checkpointHandler(req, res) {
  const session = getDriverSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in first.' });
  const { location, notes, photoPath, lat, lng } = req.body || {};
  if (!location || !String(location).trim()) {
    return res.status(400).json({ error: 'A location is required for a checkpoint update.' });
  }
  const load = await BookingRequest.findOne({ tokenNo: req.params.token, assignedDriverId: session.recordId });
  if (!load) return res.status(404).json({ error: 'No load found for that Token No. assigned to you.' });
  const [driver, shipper] = await Promise.all([
    Driver.findOne({ id: session.recordId }).lean(),
    load.shipperUsername ? Registration.findOne({ role: 'shipper', username: load.shipperUsername }).lean() : null,
  ]);
  load.tracking = load.tracking || {};
  load.tracking.currentLocation = String(location).trim();
  if (notes) load.tracking.remarks = String(notes).trim();
  load.tracking.updatedAt = new Date();
  await load.save();
  await ops.TrackingEvent.create({
    tokenNo: load.tokenNo, type: 'CHECKPOINT', label: 'Reached Checkpoint',
    location: String(location).trim(), lat: lat != null ? Number(lat) : null, lng: lng != null ? Number(lng) : null,
    notes: notes || '', photoPath: photoPath || '', createdByRole: 'driver', createdByName: driver ? driver.name : '',
  }).catch((err) => console.error('TrackingEvent.create (checkpoint) failed:', err.message));
  await notifyTripUpdate({
    load, shipper, emailFn: emailService.sendCheckpointUpdateEmail, emailArgs: { location, notes },
    notifType: 'CHECKPOINT', notifTitle: 'Checkpoint update', notifMessage: `Load ${load.tokenNo} reached ${location}.`,
  });
  logActivity({ loadId: load.tokenNo, userId: session.recordId, userRole: 'driver', userName: driver ? driver.name : '', action: 'CHECKPOINT', metadata: { location, notes } }).catch(() => {});
  emitLoadUpdate(load.tokenNo, { tracking: load.tracking });
  res.json({ ok: true, tracking: load.tracking });
}
app.post('/api/driver/loads/:token/checkpoint', checkpointHandler);
app.post('/api/loads/:token/tracking', checkpointHandler); // spec-shaped alias (generic trip-update POST)

// Shared authorization check for every GPS/tracking-related read: the
// owning shipper, the assigned carrier, or an admin (canAccessOrderDocuments,
// defined above) — PLUS the assigned driver themself, who isn't covered by
// that helper (it only knows about shipper/carrier/admin sessions). Used by
// every tracking-history/tracking-status route below so "who can see this
// load's location data" is decided in exactly one place.
async function canAccessLoadTracking(req, order) {
  const driverSession = getDriverSession(req);
  const isAssignedDriver = !!(driverSession && order.assignedDriverId === driverSession.recordId);
  return isAssignedDriver || canAccessOrderDocuments(req, order);
}

// GET the full chronological TrackingEvent history for a load — the data
// behind the "Load Details / Tracking" timeline (spec section 19) and the
// spec-shaped GET /api/loads/:token/tracking.
async function getTrackingHistoryHandler(req, res) {
  const order = await BookingRequest.findOne({ tokenNo: req.params.token }).lean();
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (!await canAccessLoadTracking(req, order)) return res.status(403).json({ error: "Not authorized to view this load's tracking history." });
  const events = await ops.TrackingEvent.find({ tokenNo: req.params.token }).sort({ createdAt: 1 }).lean();
  res.json(events);
}
app.get('/api/loads/:token/tracking', getTrackingHistoryHandler);

// GET a compact "is this load actively tracking, and how fresh is its last
// position" summary — the data behind the GPS status indicators in an
// authorized viewer's UI (live/stale/no-data, last-updated time, etc.),
// without needing to fetch (and re-derive this from) the full history.
app.get('/api/loads/:token/tracking-status', async (req, res) => {
  const order = await BookingRequest.findOne({ tokenNo: req.params.token }).lean();
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (!await canAccessLoadTracking(req, order)) return res.status(403).json({ error: "Not authorized to view this load's tracking status." });
  const lastGps = order.lastGps && order.lastGps.lat != null ? order.lastGps : null;
  const staleness = gpsValidation.classifyStaleness(lastGps && lastGps.updatedAt);
  res.json({
    tokenNo: order.tokenNo,
    loadStage: order.loadStage,
    trackingSessionActive: !!order.trackingSessionActive,
    trackingStartedAt: order.trackingStartedAt,
    trackingStoppedAt: order.trackingStoppedAt,
    lastGps,
    status: !order.trackingSessionActive ? 'not_active' : staleness.status, // 'not_active' | 'no_data' | 'live' | 'stale'
    staleMs: staleness.staleMs,
  });
});

// ---------- Delay reporting (spec section 9) ----------
async function delayHandler(req, res) {
  const session = getDriverSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in first.' });
  const { reason, currentLocation, expectedDelay, expectedDurationMinutes, notes, photoPath } = req.body || {};
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'A delay reason is required.' });
  }
  const load = await BookingRequest.findOne({ tokenNo: req.params.token, assignedDriverId: session.recordId });
  if (!load) return res.status(404).json({ error: 'No load found for that Token No. assigned to you.' });
  const [driver, shipper] = await Promise.all([
    Driver.findOne({ id: session.recordId }).lean(),
    load.shipperUsername ? Registration.findOne({ role: 'shipper', username: load.shipperUsername }).lean() : null,
  ]);
  load.delay = {
    active: true,
    reason: String(reason).trim(),
    currentLocation: String(currentLocation || '').trim(),
    expectedDurationMinutes: expectedDurationMinutes != null ? Number(expectedDurationMinutes) : null,
    notes: String(notes || '').trim(),
    photoPath: photoPath || '',
    reportedAt: new Date(),
  };
  // Overlay only — tracking.status becomes 'Delayed' (an existing enum
  // value) WITHOUT touching loadStage, so the load keeps its real place in
  // the pipeline; the next real driver action clears this automatically
  // (see driverActionHandler above) and re-syncs tracking.status from
  // loadStage as normal.
  load.tracking = load.tracking || {};
  load.tracking.status = 'Delayed';
  load.tracking.remarks = `Delayed: ${reason}`;
  if (currentLocation) load.tracking.currentLocation = String(currentLocation).trim();
  load.tracking.updatedAt = new Date();
  await load.save();
  const expectedDelayLabel = expectedDelay || (expectedDurationMinutes ? `${expectedDurationMinutes} minutes` : '');
  await ops.TrackingEvent.create({
    tokenNo: load.tokenNo, type: 'DELAYED', label: 'Delayed',
    location: String(currentLocation || '').trim(), notes: String(notes || reason || '').trim(), photoPath: photoPath || '',
    createdByRole: 'driver', createdByName: driver ? driver.name : '',
  }).catch((err) => console.error('TrackingEvent.create (delay) failed:', err.message));
  await notifyTripUpdate({
    load, shipper, emailFn: emailService.sendDelayNotificationEmail,
    emailArgs: { location: currentLocation, reason, expectedDelay: expectedDelayLabel },
    notifType: 'DELAYED', notifTitle: 'Load delayed', notifMessage: `Load ${load.tokenNo} has been delayed. Reason: ${reason}.`,
  });
  logActivity({ loadId: load.tokenNo, userId: session.recordId, userRole: 'driver', userName: driver ? driver.name : '', action: 'DELAY_REPORTED', newStatus: 'Delayed', metadata: { reason, currentLocation, expectedDurationMinutes } }).catch(() => {});
  emitLoadUpdate(load.tokenNo, { tracking: load.tracking });
  res.json({ ok: true, delay: load.delay, tracking: load.tracking });
}
app.post('/api/driver/loads/:token/delay', delayHandler);
app.post('/api/loads/:token/delay', delayHandler); // spec-shaped alias

// ---------- Live GPS ----------
// The driver's browser (Geolocation API — there's no native mobile app in
// this project; see the "web vs. native background tracking" note in the
// final delivery docs) posts here while trackingSessionActive is true.
// Each accepted ping is persisted for history AND pushed live over
// Socket.IO to anyone authorized to watch this load.
//
// Identity comes ENTIRELY from the authenticated session
// (getDriverSession -> session.recordId), never from a phone number or any
// other client-supplied identifier — the query below only ever matches a
// load that is BOTH this exact token AND already assigned to this exact
// driver, so a driver can neither spoof another driver's identity nor
// submit a location for a load that isn't theirs.
//
// A per-load in-memory "last accepted ping" cache backs the server-side
// throttle (lib/gpsValidation.shouldAcceptPing) — a second line of defense
// behind the client's own throttling, so a buggy or modified client can't
// flood TrackingPoint with near-duplicate rows. This is intentionally an
// in-memory Map (same pattern as the existing OTP cooldown store above) —
// losing it on a restart just means the very next ping after a restart is
// always accepted, which is harmless.
const lastAcceptedGpsByToken = new Map(); // tokenNo -> { point: {lat,lng}, at: number(ms) }
// Hard request-frequency guard, independent of the accept/store throttle
// below — this rejects a request BEFORE it ever touches the database, so a
// misbehaving/malicious client hammering the endpoint (bug or otherwise)
// can't generate load, not even read load. Deliberately tighter than
// gpsConfig.minIntervalMs (which governs what gets STORED, not what gets
// ACCEPTED as a request at all).
const GPS_MIN_REQUEST_GAP_MS = 250;
const lastGpsRequestAtByToken = new Map(); // tokenNo -> ms

app.post('/api/driver/loads/:token/gps', async (req, res) => {
  const session = getDriverSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in first.' });

  const requestNow = Date.now();
  const lastRequestAt = lastGpsRequestAtByToken.get(req.params.token);
  if (lastRequestAt && requestNow - lastRequestAt < GPS_MIN_REQUEST_GAP_MS) {
    return res.status(429).json({ error: 'Too many location updates — please slow down.' });
  }
  lastGpsRequestAtByToken.set(req.params.token, requestNow);

  const validation = gpsValidation.validateGpsPoint(req.body || {});
  if (!validation.valid) {
    return res.status(400).json({ error: `Invalid GPS reading: ${validation.reason}` });
  }
  const { lat, lng, accuracy, speedKph, headingDeg, altitude, deviceTimestamp } = validation.point;

  const load = await BookingRequest.findOne({ tokenNo: req.params.token, assignedDriverId: session.recordId });
  if (!load) return res.status(404).json({ error: 'No load found for that Token No. assigned to you.' });
  if (!load.trackingSessionActive) {
    return res.status(409).json({ error: 'Tracking is not active for this load right now.' });
  }

  const now = Date.now();
  const prev = lastAcceptedGpsByToken.get(load.tokenNo);
  const throttleDecision = gpsValidation.shouldAcceptPing({
    prevPoint: prev && prev.point, prevAt: prev && prev.at,
    nextPoint: { lat, lng }, nextAt: now,
  });
  if (!throttleDecision.accept) {
    // Not an error from the driver's point of view — just "nothing new to
    // record yet". 202 (Accepted, no-op) keeps the client's retry/queue
    // logic simple: any non-2xx means "try again later", any 2xx means
    // "this one is done, move on."
    return res.status(202).json({ ok: true, stored: false, reason: throttleDecision.reason });
  }

  const point = {
    lat, lng, speedKph, headingDeg, accuracy, altitude,
    deviceTimestamp: deviceTimestamp || null,
    updatedAt: new Date(),
  };
  load.lastGps = point;
  await load.save();
  await TrackingPoint.create({
    tokenNo: load.tokenNo, truckId: load.assignedTruckId, driverId: load.assignedDriverId,
    lat, lng, speedKph, headingDeg, accuracy, altitude, deviceTimestamp: deviceTimestamp || null,
  });
  if (load.assignedTruckId) {
    await Truck.updateOne({ id: load.assignedTruckId }, { currentLat: lat, currentLng: lng }).catch((err) => console.error('Truck currentLat/Lng update failed:', err.message));
  }
  lastAcceptedGpsByToken.set(load.tokenNo, { point: { lat, lng }, at: now });

  // Backward-compatible generic push (existing clients listening for
  // 'load:update' with a `gps` key keep working unchanged) PLUS a focused,
  // dedicated event for anything built against this improved system.
  emitLoadUpdate(load.tokenNo, { gps: point });
  emitTrackingLocation(load.tokenNo, {
    ...point,
    vehicleNumber: load.assignedTruckId ? (await Truck.findOne({ id: load.assignedTruckId }).select('vehicleNumber').lean().catch(() => null))?.vehicleNumber : undefined,
  });
  res.json({ ok: true, stored: true, point });
});

// Full historical route for a delivered (or in-progress) load — same
// access rule as every other order document: the owning shipper, the
// assigned carrier, or an admin. Supports optional `since`/`until` (ISO
// timestamps) and `limit` so the browser is never handed an unbounded
// number of points (spec: "reasonable loading limits for large histories").
app.get('/api/orders/:token/tracking-history', async (req, res) => {
  const order = await BookingRequest.findOne({ tokenNo: req.params.token }).lean();
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (!await canAccessLoadTracking(req, order)) return res.status(403).json({ error: 'Not authorized to view this load\'s tracking history.' });

  const cfg = gpsConfig.getGpsConfig();
  const requestedLimit = Number(req.query.limit);
  const limit = Math.min(
    Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : cfg.defaultHistoryPoints,
    cfg.maxHistoryPoints
  );
  const filter = { tokenNo: req.params.token };
  if (req.query.since || req.query.until) {
    filter.createdAt = {};
    if (req.query.since) filter.createdAt.$gte = new Date(req.query.since);
    if (req.query.until) filter.createdAt.$lte = new Date(req.query.until);
  }
  // Fetch newest-first so a hard `limit` keeps the MOST RECENT points (the
  // relevant ones for "where has it been recently"), then reverse back to
  // chronological order for the client to draw as a polyline.
  const totalCount = await TrackingPoint.countDocuments(filter);
  const pointsDesc = await TrackingPoint.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
  const points = pointsDesc.reverse();
  res.json({ points, totalCount, returned: points.length, truncated: totalCount > points.length, limit });
});

// ---------- Admin: Fleet verification ----------
app.get('/api/admin/fleet/trucks', requireAdmin, async (req, res) => {
  res.json(await Truck.find({}).sort({ createdAt: -1 }).lean());
});
app.get('/api/admin/fleet/drivers', requireAdmin, async (req, res) => {
  res.json(await Driver.find({}).sort({ createdAt: -1 }).lean());
});
// Loads the automatic matching engine already tried and couldn't place —
// backs the Admin Fleet page's "Unmatched Loads" tab (with a manual Retry
// button, since /api/admin/fleet/loads/:token/retry-match already exists
// below for exactly this).
app.get('/api/admin/fleet/unmatched-loads', requireAdmin, async (req, res) => {
  const loads = await BookingRequest.find({ loadStage: 'POSTED', matchAttempted: true }).sort({ createdAt: -1 }).lean();
  res.json(loads);
});
app.post('/api/admin/fleet/trucks/:id/verify', requireAdmin, async (req, res) => {
  const truck = await Truck.findOne({ id: req.params.id });
  if (!truck) return res.status(404).json({ error: 'Truck not found.' });
  truck.verified = !!req.body.verified;
  await truck.save();
  res.json({ ok: true, truck });
});
app.post('/api/admin/fleet/drivers/:id/verify', requireAdmin, async (req, res) => {
  const driver = await Driver.findOne({ id: req.params.id });
  if (!driver) return res.status(404).json({ error: 'Driver not found.' });
  driver.verified = !!req.body.verified;
  await driver.save();
  res.json({ ok: true, driver });
});
// Manual override — used only when the automated matching engine found no
// suitable pair (per the required "no suitable truck/driver" fallback);
// lets Admin pick a specific truck the same way the retry loop would.
app.post('/api/admin/fleet/loads/:token/retry-match', requireAdmin, async (req, res) => {
  const load = await BookingRequest.findOne({ tokenNo: req.params.token });
  if (!load) return res.status(404).json({ error: 'Load not found.' });
  const result = await tryAutoAssignLoad(load);
  res.json(result);
});

// ---------- Socket.IO (live tracking push) ----------
// One room per Token No. — the shipper's Live Tracking page and the Admin
// Tracking page both just `socket.emit('join', { tokenNo })` on load and
// receive 'load:update' events from then on. No socket-level auth beyond
// knowing the Token No. itself (same trust level as the existing polling
// endpoints, which is an acceptable simplification for this project — a
// production system would authenticate the socket handshake too).
let io = null;
function initSocketIO(httpServer) {
  const { Server } = require('socket.io');
  io = new Server(httpServer, { cors: { origin: '*' } });
  io.on('connection', (socket) => {
    socket.on('join', ({ tokenNo }) => {
      if (tokenNo) socket.join('load:' + tokenNo);
    });
  });
}
function emitLoadUpdate(tokenNo, payload) {
  if (io) io.to('load:' + tokenNo).emit('load:update', { tokenNo, ...payload });
}
// Dedicated, focused GPS event — same room (no private data is exposed
// beyond that room; a browser only receives this after explicitly joining
// with a specific tokenNo it already knows, same trust model as
// 'load:update'). Kept separate from the generic 'load:update' envelope so
// a listener that only cares about map-marker movement doesn't have to
// inspect every stage-change/POD/delay push to find the rare one that also
// happens to carry `gps`.
function emitTrackingLocation(tokenNo, point) {
  if (io) io.to('load:' + tokenNo).emit('tracking:location', { tokenNo, ...point });
}

// Background retry: loads that failed to match immediately (no suitable
// truck/driver at post time) are retried periodically as the fleet
// changes, per "allow the system to retry matching when new trucks/
// drivers become available" — no manual admin action required.
setInterval(async () => {
  try {
    const waiting = await BookingRequest.find({ loadStage: 'POSTED', assignedTruckId: '' }).limit(25);
    for (const load of waiting) {
      await tryAutoAssignLoad(load);
    }
  } catch (err) {
    console.error('Matching retry loop failed:', err.message);
  }
}, 60 * 1000);

/**
 * Saves a registration submission to MongoDB.
 * Returns a generated reference ID.
 */
// ---------- Claim-on-attach: assigning ownership of anonymously-uploaded
// files (spec section 4 / "ownership at upload time") ----------
// /api/kyc/upload can be called BEFORE an account exists (the pre-
// registration flow), so a freshly uploaded file has no owner yet. Once the
// record that actually references it is saved, this scans every `...Path`
// field in the payload for a `/api/files/<fileId>` reference and claims it
// for that account — see fileStorageService.claimFileForUser for why this
// is safe (it refuses to reassign a file someone else already owns).
// A stored document path is valid in either the new permanent GridFS
// format (`/api/files/<fileId>`) or the legacy on-disk format
// (`/admin/kyc-photo/<filename>`, still accepted so old clients/records and
// anything already in flight keep working) — every route that gates on
// "does this look like a real uploaded-file path" should accept both.
function isKnownDocPath(value) {
  if (typeof value !== 'string') return false;
  return value.startsWith('/admin/kyc-photo/') || !!fileStorageService.extractFileIdFromPath(value);
}

// Claims a new-format order-scoped document (shipper invoice / POD) for the
// order it was just attached to — no-ops cleanly for legacy-format paths
// (nothing to claim) or invalid input. See fileStorageService.claimFileForOrder.
async function claimOrderDocPath(pathValue, orderToken) {
  const fileId = fileStorageService.extractFileIdFromPath(pathValue);
  if (!fileId || !orderToken) return;
  try {
    await fileStorageService.claimFileForOrder(fileId, { orderToken });
  } catch (err) {
    console.error('claimOrderDocPath failed for', orderToken, '—', err.message);
  }
}

async function claimUploadedDocsInPayload(payload, { userId, ownerRole }) {
  if (!payload || !userId) return;
  const keys = Object.keys(payload).filter((k) => /Path$/i.test(k) && typeof payload[k] === 'string');
  for (const k of keys) {
    const fileId = fileStorageService.extractFileIdFromPath(payload[k]);
    if (!fileId) continue;
    try {
      await fileStorageService.claimFileForUser(fileId, { userId, ownerRole });
    } catch (err) {
      console.error('claimUploadedDocsInPayload failed for field', k, '—', err.message);
    }
  }
}

async function saveSubmission(role, payload, opts = {}) {
  const id = `${role.toUpperCase()}-${Date.now()}`;
  // Shipper & Carrier now choose their own username at registration
  // (already validated + uniqueness-checked by the route handler before
  // this is ever called) — Broker still gets one server-generated below,
  // unchanged from before.
  if (opts.username) {
    try {
      await Registration.create({ id, role, active: true, ...payload, username: opts.username });
      await claimUploadedDocsInPayload(payload, { userId: id, ownerRole: role });
      notifyNewAccount(role, id, { ...payload, username: opts.username }).catch((err) => console.error('notifyNewAccount error:', err.message));
      return { id, username: opts.username };
    } catch (err) {
      if (err.code === 11000) {
        const dupErr = new Error('That username was just taken by someone else — please choose another.');
        dupErr.code = 'username_taken';
        throw dupErr;
      }
      throw err;
    }
  }
  // Username is server-generated (never trust/accept one from the client)
  // so it's guaranteed unique and can't be picked to collide with another
  // account. Retry once on the rare unique-index race.
  for (let attempt = 0; attempt < 3; attempt++) {
    const username = await generateUniqueUsername(role);
    try {
      // Never persist raw passwords in a real system — this demo keeps
      // things simple, but flag it clearly for anyone reading the code.
      await Registration.create({ id, role, active: true, ...payload, username });
      await claimUploadedDocsInPayload(payload, { userId: id, ownerRole: role });
      // Fire-and-forget: don't make the registrant wait on the email round-trip.
      notifyNewAccount(role, id, { ...payload, username }).catch((err) => console.error('notifyNewAccount error:', err.message));
      return { id, username };
    } catch (err) {
      if (err.code === 11000 && attempt < 2) continue; // username collision — retry with a fresh one
      throw err;
    }
  }
}

/**
 * Returns the list of extra admins created via the "Add Admin" screen.
 * The fixed super admin is NOT stored here — it's always valid separately.
 */
async function getAdmins() {
  return Admin.find({}).lean();
}

async function isValidAdmin(id, password) {
  if (id === SUPER_ADMIN_ID && password === SUPER_ADMIN_PASSWORD) return true;
  const admin = await Admin.findOne({ id, password });
  return !!admin;
}

/**
 * Route guard for the admin JSON API (registrations, rate-requests,
 * tracking, settings, etc). Reads the session token from the Authorization
 * header — the admin page itself (/admin/*) is served openly and does its
 * own client-side session check via sessionStorage, since a browser can't
 * attach a custom header to a plain page navigation.
 */
function requireAdmin(req, res, next) {
  const token = getBearerToken(req);
  if (token && sessions.has(token)) {
    req.adminId = sessions.get(token);
    return next();
  }
  return res.status(401).json({ error: 'Not logged in as admin.' });
}

/**
 * Returns every registration record on file for a role (shipper/broker/carrier).
 */
async function getRecords(role) {
  return Registration.find({ role }).lean();
}

/**
 * Finds a registration record for a role by matching the username/password
 * that were captured during registration ("Login account details" section).
 */
async function findUserRecord(role, username, password) {
  return Registration.findOne({ role, username, password }).lean();
}

// NOTE: there is no server-side "requireUser" gate on /portal/:role pages
// anymore. Session tokens live in the browser tab's sessionStorage (not a
// cookie), so a plain page GET can't prove who's asking — the page is
// served openly and /assets/auth.js checks sessionStorage on load, bouncing
// to /login/:role immediately if there's no token in *this* tab. Every
// JSON API call the page makes is still protected via getShipperSession()
// above, which checks the Authorization header on each request.

// =====================================================================
// ---------- Broker Portal (Complete Broker Portal, KYC, real AI) ----------
// Every route below is scoped to the LOGGED-IN broker's own session
// (getBrokerSession) and their own username/id — a broker can never read
// or act on another broker's profile, documents, loads, bids, or
// notifications. Reuses the existing bidding engine, matching engine,
// notification service, email service, and AI service — nothing here is a
// second, competing system.
// =====================================================================

function brokerRecordSafe(record) {
  if (!record) return null;
  const { password, confirmPassword, ...safe } = record;
  return safe;
}

app.get('/api/broker/profile', async (req, res) => {
  const session = getBrokerSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
  const record = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
  if (!record) return res.status(404).json({ error: 'Broker account not found.' });
  res.json(brokerRecordSafe(record));
});

// Profile fields a broker may edit themselves — documents/KYC status/role/
// username/password are deliberately NOT in this list (those go through
// their own dedicated, more carefully-guarded endpoints below).
const BROKER_EDITABLE_PROFILE_FIELDS = ['contactPerson', 'mobileNumber', 'companyName'];
app.patch('/api/broker/profile', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const record = await Registration.findOne({ role: 'broker', id: session.recordId });
    if (!record) return res.status(404).json({ error: 'Broker account not found.' });
    const b = req.body || {};
    BROKER_EDITABLE_PROFILE_FIELDS.forEach((f) => {
      if (b[f] !== undefined) record[f] = String(b[f]).trim();
    });
    if (b.address && typeof b.address === 'object') {
      record.address = {
        addressLine: String(b.address.addressLine ?? record.address?.addressLine ?? '').trim(),
        city: String(b.address.city ?? record.address?.city ?? '').trim(),
        state: String(b.address.state ?? record.address?.state ?? '').trim(),
        pincode: String(b.address.pincode ?? record.address?.pincode ?? '').trim(),
      };
    }
    // Opportunity Radar preferences (spec section 7A) — editable any time,
    // independent of KYC status.
    if (b.loadPreferences && typeof b.loadPreferences === 'object') {
      const p = b.loadPreferences;
      const asStrArray = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 20) : undefined);
      record.loadPreferences = {
        preferredOrigins: asStrArray(p.preferredOrigins) || record.loadPreferences?.preferredOrigins || [],
        preferredDestinations: asStrArray(p.preferredDestinations) || record.loadPreferences?.preferredDestinations || [],
        preferredTruckTypes: asStrArray(p.preferredTruckTypes) || record.loadPreferences?.preferredTruckTypes || [],
        preferredLoadCategories: asStrArray(p.preferredLoadCategories) || record.loadPreferences?.preferredLoadCategories || [],
      };
    }
    await record.save();
    res.json({ ok: true, record: brokerRecordSafe(record.toObject()) });
  } catch (err) {
    console.error('PATCH /api/broker/profile failed:', err.message);
    res.status(500).json({ error: 'Could not update your profile right now. Please try again.' });
  }
});

// ---------- Broker KYC ----------
app.get('/api/broker/kyc', async (req, res) => {
  const session = getBrokerSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
  const record = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
  if (!record) return res.status(404).json({ error: 'Broker account not found.' });
  res.json({
    kycStatus: record.kycStatus || 'DRAFT',
    kycRejectionReason: record.kycRejectionReason || '',
    kycDocumentsRequested: record.kycDocumentsRequested || '',
    kycSubmittedAt: record.kycSubmittedAt || null,
    kycReviewedAt: record.kycReviewedAt || null,
    hasGST: !!record.hasGST, hasMSME: !!record.hasMSME,
    missingDocuments: brokerService.missingKycDocuments(record),
    aiDocumentReviews: record.aiDocumentReviews || [],
    aiKycReview: record.aiKycReview || null,
    documents: {
      panDocumentPath: record.panDocumentPath || '',
      gstPhotoPath: record.gstPhotoPath || '',
      msmePhotoPath: record.msmePhotoPath || '',
      addressProofPath: record.addressProofPath || '',
      bankProofPhotoPath: record.bankProofPhotoPath || '',
      profilePhotoPath: record.profilePhotoPath || '',
    },
  });
});

// Lets a broker attach a freshly-uploaded document (already stored via the
// existing POST /api/kyc/upload) to a specific field on their own record —
// used both at first registration time (see /register/broker above) and
// afterwards (e.g. replacing an expired document, or responding to an
// Admin "please provide more documents" request). Re-validates the same
// conditional GST/MSME/PAN rules so a broker can never end up with a
// half-valid combination (e.g. hasGST=true but no gstNumber) through this
// side door either.
const BROKER_DOCUMENT_FIELD_MAP = {
  gst: 'gstPhotoPath', msme: 'msmePhotoPath', pan: 'panDocumentPath',
  address: 'addressProofPath', bank: 'bankProofPhotoPath', profile: 'profilePhotoPath',
};
app.post('/api/broker/documents', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const record = await Registration.findOne({ role: 'broker', id: session.recordId });
    if (!record) return res.status(404).json({ error: 'Broker account not found.' });
    const { documentType, path: docPath, gstNumber, msmeNumber } = req.body || {};
    const field = BROKER_DOCUMENT_FIELD_MAP[String(documentType || '').toLowerCase()];
    if (!field) return res.status(400).json({ error: 'Unknown document type. Use gst, msme, pan, address, bank, or profile.' });
    if (!docPath || !isKnownDocPath(String(docPath))) {
      return res.status(400).json({ error: 'Please upload the file first (POST /api/kyc/upload), then attach it here.' });
    }
    if (documentType === 'gst') {
      if (gstNumber !== undefined) {
        if (!brokerService.isValidGST(gstNumber)) return res.status(400).json({ error: 'invalid_gst' });
        record.gstNumber = brokerService.normalizeGST(gstNumber);
        record.gstVerified = true;
      }
      record.hasGST = true;
    }
    if (documentType === 'msme') {
      if (msmeNumber !== undefined) {
        if (!brokerService.isValidMsme(msmeNumber)) return res.status(400).json({ error: 'invalid_msme' });
        record.msmeNumber = String(msmeNumber).trim();
      }
      record.hasMSME = true;
    }
    record[field] = docPath;
    // A new document invalidates any prior KYC rejection — resubmitted for
    // review, same "back to pending" convention as the Shipper resubmit flow.
    if (record.kycStatus === 'REJECTED') {
      record.kycStatus = 'SUBMITTED';
      record.kycRejectionReason = '';
      record.kycSubmittedAt = new Date();
    }
    await record.save();
    const brokerDocFileId = fileStorageService.extractFileIdFromPath(docPath);
    if (brokerDocFileId) fileStorageService.claimFileForUser(brokerDocFileId, { userId: record.id, ownerRole: 'broker' }).catch(() => {});
    if (['gst', 'msme', 'pan'].includes(documentType)) {
      const aiType = documentType.toUpperCase();
      runBrokerDocumentReview(record.id, aiType, docPath).catch((err) => console.error('Broker doc AI review failed:', err.message));
    }
    logActivity({ userId: record.id, userRole: 'broker', userName: record.companyName || record.contactPerson || record.username, action: 'KYC_DOCUMENT_UPLOADED', metadata: { documentType } }).catch(() => {});
    res.json({ ok: true, record: brokerRecordSafe(record.toObject()) });
  } catch (err) {
    console.error('POST /api/broker/documents failed:', err.message);
    res.status(500).json({ error: 'Could not save that document right now. Please try again.' });
  }
});

// Explicit "submit KYC for review" action — moves DRAFT/REJECTED into
// SUBMITTED once the broker believes their documents are complete. Safe to
// call even when already SUBMITTED/PENDING_REVIEW (idempotent).
app.post('/api/broker/kyc/submit', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const record = await Registration.findOne({ role: 'broker', id: session.recordId });
    if (!record) return res.status(404).json({ error: 'Broker account not found.' });
    if (record.kycStatus === 'APPROVED') {
      return res.status(409).json({ error: 'Your KYC is already approved.' });
    }
    const missing = brokerService.missingKycDocuments(record).filter((m) => !m.includes('(optional'));
    if (missing.length) {
      return res.status(400).json({ error: 'Please upload all required documents first.', missingDocuments: missing });
    }
    record.kycStatus = 'SUBMITTED';
    record.kycRejectionReason = '';
    record.kycSubmittedAt = new Date();
    await record.save();
    notificationService.notify({ userId: 'admin', userRole: 'admin', type: 'BROKER_KYC_SUBMITTED', title: 'Broker KYC submitted', message: `${record.companyName || record.contactPerson || record.username} submitted their KYC for review.` }).catch(() => {});
    res.json({ ok: true, kycStatus: record.kycStatus });
  } catch (err) {
    console.error('POST /api/broker/kyc/submit failed:', err.message);
    res.status(500).json({ error: 'Could not submit your KYC right now. Please try again.' });
  }
});

// One documented, protected way to fetch a specific KYC document's viewer
// URL by a stable short id (rather than the internal field name) — the
// actual bytes are still only ever served through the existing
// authorization-protected /api/my-documents/:filename route.
app.get('/api/broker/documents/:id', async (req, res) => {
  const session = getBrokerSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
  const record = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
  if (!record) return res.status(404).json({ error: 'Broker account not found.' });
  const field = BROKER_DOCUMENT_FIELD_MAP[String(req.params.id || '').toLowerCase()];
  if (!field) return res.status(404).json({ error: 'Unknown document id.' });
  const value = record[field];
  if (!value) return res.status(404).json({ error: 'No document uploaded for this type yet.' });
  res.json({ documentType: req.params.id, path: value });
});

// ---------- Broker dashboard ----------
async function computeBrokerDashboard(broker) {
  const [assignedLoads, myBids, openComplaints] = await Promise.all([
    BookingRequest.find({ brokerUsername: broker.username }).lean(),
    bidding.Bid.find({ submittedByRole: 'broker', brokerUsername: broker.username }).lean(),
    Complaint.countDocuments({ username: broker.username, status: 'open' }),
  ]);
  const tokenSet = new Set([...assignedLoads.map((l) => l.tokenNo), ...myBids.map((b) => b.loadId)]);
  const terminalStages = new Set(['COMPLETED']);
  const activeLoads = assignedLoads.filter((l) => !terminalStages.has(l.loadStage) && l.loadStage !== 'DELIVERED');
  const completedLoads = assignedLoads.filter((l) => l.loadStage === 'COMPLETED');
  const pendingRequests = myBids.filter((b) => ['SUBMITTED', 'SHORTLISTED'].includes(b.status));
  const acceptedRequests = myBids.filter((b) => b.status === 'ACCEPTED');
  const cancelledCount = myBids.filter((b) => ['WITHDRAWN', 'REJECTED'].includes(b.status)).length;
  const delayedCount = assignedLoads.filter((l) => l.delay && l.delay.active).length;

  const cards = {
    totalLoadsHandled: tokenSet.size,
    activeLoads: activeLoads.length,
    pendingRequests: pendingRequests.length,
    acceptedLoads: acceptedRequests.length,
    completedLoads: completedLoads.length,
    // Brokerage/commission tracking is not part of the existing pricing
    // engine (only LoadSmart's own carrier-side margin exists) — shown
    // honestly as unavailable rather than a fabricated number.
    totalBrokerageCommission: null,
    totalBrokerageCommissionNote: 'No data yet — brokerage commission tracking is not part of the pricing engine yet.',
    kycStatus: broker.kycStatus || 'DRAFT',
    reliabilityScore: (completedLoads.length + cancelledCount) > 0
      ? Math.round((completedLoads.length / (completedLoads.length + cancelledCount)) * 100)
      : null,
    reliabilityNote: (completedLoads.length + cancelledCount) > 0 ? null : 'No data yet',
  };

  const openLoads = await BookingRequest.find({ loadStage: 'BIDDING_OPEN' }).sort({ biddingOpenedAt: -1 }).limit(50).lean();
  const openTokens = openLoads.map((l) => l.tokenNo);
  const bidCounts = await bidding.Bid.aggregate([
    { $match: { loadId: { $in: openTokens }, status: { $in: ['SUBMITTED', 'SHORTLISTED'] } } },
    { $group: { _id: '$loadId', count: { $sum: 1 } } },
  ]);
  const bidCountByLoad = new Map(bidCounts.map((c) => [c._id, c.count]));
  const loadsForRadar = openLoads.map((l) => ({ ...l, bidCount: bidCountByLoad.get(l.tokenNo) || 0 }));
  const preferences = broker.loadPreferences || {};
  const preferencesConfigured = ['preferredOrigins', 'preferredDestinations', 'preferredTruckTypes', 'preferredLoadCategories']
    .some((k) => Array.isArray(preferences[k]) && preferences[k].length);
  const opportunities = brokerService.scoreOpportunities(preferences, loadsForRadar).slice(0, 10).map((o) => {
    const load = loadsForRadar.find((l) => l.tokenNo === o.tokenNo);
    return {
      tokenNo: o.tokenNo, score: o.score, reasons: o.reasons,
      pickup: load?.pickup, destination: load?.destination, material: load?.material,
      weight: load?.weight, requiredTruckType: load?.requiredTruckType,
      pickupDateTime: load?.pickupDateTime, biddingDeadline: load?.biddingDeadline,
    };
  });

  const riskIndicators = brokerService.computeRiskIndicators(broker, {
    cancelledCount, completedCount: completedLoads.length, delayedCount, openComplaints,
  });

  const [activityLogRows, trackingRows, notifRows] = await Promise.all([
    ops.ActivityLog.find({ userId: broker.id }).sort({ createdAt: -1 }).limit(40).lean(),
    ops.TrackingEvent.find({ tokenNo: { $in: [...tokenSet] } }).sort({ createdAt: -1 }).limit(40).lean(),
    notificationService.listForUser(broker.id, 'broker', { limit: 20 }),
  ]);
  const timeline = brokerService.buildActivityTimeline([
    ...activityLogRows.map((r) => ({ at: r.createdAt, label: r.action, detail: r.metadata ? JSON.stringify(r.metadata).slice(0, 160) : '', source: 'activity' })),
    ...trackingRows.map((r) => ({ at: r.createdAt, label: r.label, detail: r.notes || r.location || '', source: 'tracking' })),
    ...notifRows.map((n) => ({ at: n.createdAt, label: n.title, detail: n.message, source: 'notification' })),
  ]).slice(0, 60);

  return { cards, opportunities, preferencesConfigured, riskIndicators, timeline };
}

app.get('/api/broker/dashboard', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const dashboard = await computeBrokerDashboard(broker);
    res.json(dashboard);
  } catch (err) {
    console.error('GET /api/broker/dashboard failed:', err.message);
    res.status(500).json({ error: 'Could not load your dashboard right now. Please try again.' });
  }
});

// =====================================================================
// ---------- Broker: Post New Load (broker-originated loads) ----------
// =====================================================================
// A broker can post a REAL load of their own (often on behalf of a client
// who has no LoadSmart shipper account) — reuses the SAME BookingRequest
// model the shipper-posted flow uses (never a second, incompatible load
// schema — see the "Broker-posted loads" fields added to
// bookingRequestSchema above), so every downstream feature that already
// understands a BookingRequest (matching, bidding, tracking, KYC-gated
// bidding, notifications) keeps working on these loads unchanged.
//
// Lifecycle: DRAFT (private, broker can still edit/cancel freely) --[open
// bidding]--> POSTED + loadStage:BIDDING_OPEN (visible to every carrier on
// the existing Load Board, biddable through the existing bidding system,
// completely unchanged) --[carrier's bid accepted, OR broker connects a
// carrier directly]--> normal loadStage pipeline from there on, exactly
// like a shipper-posted load. Posting a load NEVER marks it assigned by
// itself (spec: "Do not mark a load as assigned merely because it was
// posted").
app.post('/api/broker/loads', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    if (broker.kycStatus !== 'APPROVED') {
      return res.status(403).json({ error: 'Your KYC must be approved by admin before you can post a load.' });
    }
    const { valid, errors } = brokerLoadPosting.validateBrokerLoadPosting(req.body || {});
    if (!valid) return res.status(400).json({ error: 'Please fix the highlighted fields.', fieldErrors: errors });

    const b = req.body;
    const id = `BLOAD-${Date.now()}`;
    const tokenNo = await generateUniqueToken();
    const created = await BookingRequest.create({
      id, kind: 'booking', tokenNo,
      // No real shipper account is required for a broker-posted load — see
      // the schema comment on postedByRole/postedByBrokerUsername above.
      shipperUsername: '', companyName: String(b.shipperCompanyName || b.companyName || '').trim(),
      pickup: String(b.pickup).trim(), destination: String(b.destination).trim(),
      pickupAddress: String(b.pickupAddress || '').trim(), destAddress: String(b.destAddress || '').trim(),
      distanceKm: b.distanceKm ? Number(b.distanceKm) : undefined,
      material: String(b.material).trim(), weight: Number(b.weight),
      requiredTruckType: String(b.requiredTruckType).trim(), requiredBodyType: String(b.requiredBodyType || '').trim(),
      estimatedRate: b.budgetRate ? Number(b.budgetRate) : undefined,
      pickupDateTime: b.pickupDateTime ? new Date(b.pickupDateTime) : null,
      deliveryDeadline: b.deliveryDeadline ? new Date(b.deliveryDeadline) : null,
      numberOfTrucks: Number(b.numberOfTrucks) || 1,
      budgetRate: b.budgetRate !== undefined && b.budgetRate !== '' ? Number(b.budgetRate) : null,
      loadingInstructions: String(b.loadingInstructions || '').trim().slice(0, 1000),
      unloadingInstructions: String(b.unloadingInstructions || '').trim().slice(0, 1000),
      specialRequirements: String(b.specialRequirements || '').trim().slice(0, 1000),
      contactPerson: String(b.contactPerson).trim(),
      contactPhone: String(b.contactPhone).trim(),
      advancePaymentRequired: !!b.advancePaymentRequired,
      advancePaymentPercent: b.advancePaymentRequired && b.advancePaymentPercent ? Number(b.advancePaymentPercent) : null,
      requiredDocuments: Array.isArray(b.requiredDocuments) ? b.requiredDocuments.map(String).slice(0, 20) : [],
      postedByRole: 'broker',
      postedByBrokerUsername: broker.username,
      postedByBrokerCompanyName: broker.companyName || broker.username,
      brokerLoadStatus: 'DRAFT',
      loadStage: 'POSTED',
      assignmentMode: 'bidding',
      tracking: { currentLocation: String(b.pickup).trim(), status: 'Booked', progressPercent: 0, remarks: 'Load posted by broker — not yet open to carriers.', updatedAt: new Date() },
    });

    // Audit log + notification only after the DB save above has actually
    // succeeded (spec: "Add an audit log entry" / "Trigger SMS notification
    // ... only after the database save succeeds").
    logActivity({ loadId: created.tokenNo, userId: broker.id, userRole: 'broker', userName: broker.companyName || broker.username, action: 'BROKER_LOAD_POSTED', newStatus: 'DRAFT' }).catch(() => {});
    notificationService.notify({ userId: broker.id, userRole: 'broker', loadId: created.tokenNo, type: 'LOAD_POSTED', title: 'Load posted', message: `Your load ${created.tokenNo} (${created.pickup} → ${created.destination}) has been saved as a draft. Open it for bidding when you're ready.` }).catch(() => {});
    if (broker.mobileNumber) {
      smsService.sendLoadPostedSms({ to: broker.mobileNumber, tokenNo: created.tokenNo, pickup: created.pickup, destination: created.destination, userId: broker.id, userRole: 'broker' }).catch(() => {});
    }
    res.json({ ok: true, tokenNo: created.tokenNo, brokerLoadStatus: created.brokerLoadStatus });
  } catch (err) {
    console.error('POST /api/broker/loads failed:', err.message);
    res.status(500).json({ error: 'Could not post that load right now. Please try again.' });
  }
});

// The broker's OWN posted loads (any brokerLoadStatus) — separate from the
// open-marketplace GET /api/broker/loads below (which only ever shows
// loadStage:BIDDING_OPEN loads from ANY origin). This is what the Load
// Board's "My Posted Loads" section reads.
app.get('/api/broker/loads/mine', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const filter = { postedByBrokerUsername: broker.username };
    if (req.query.status) filter.brokerLoadStatus = String(req.query.status).toUpperCase();
    const loads = await BookingRequest.find(filter).sort({ createdAt: -1 }).lean();
    const tokenNos = loads.map((l) => l.tokenNo);
    const bidCounts = await bidding.Bid.aggregate([
      { $match: { loadId: { $in: tokenNos }, status: { $in: ['SUBMITTED', 'SHORTLISTED', 'ACCEPTED'] } } },
      { $group: { _id: '$loadId', count: { $sum: 1 } } },
    ]).catch(() => []);
    const bidCountByLoad = new Map(bidCounts.map((b) => [b._id, b.count]));
    res.json(loads.map((l) => ({
      tokenNo: l.tokenNo, pickup: l.pickup, destination: l.destination, material: l.material, weight: l.weight,
      requiredTruckType: l.requiredTruckType, requiredBodyType: l.requiredBodyType,
      pickupDateTime: l.pickupDateTime, deliveryDeadline: l.deliveryDeadline, budgetRate: l.budgetRate,
      numberOfTrucks: l.numberOfTrucks, brokerLoadStatus: l.brokerLoadStatus, loadStage: l.loadStage,
      biddingDeadline: l.biddingDeadline,
      biddingExpired: !!(l.biddingDeadline && new Date(l.biddingDeadline).getTime() < Date.now()),
      bidCount: bidCountByLoad.get(l.tokenNo) || 0,
      canEdit: brokerLoadPosting.canEditBrokerLoad(l), canCancel: brokerLoadPosting.canCancelBrokerLoad(l),
      createdAt: l.createdAt,
    })));
  } catch (err) {
    console.error('GET /api/broker/loads/mine failed:', err.message);
    res.status(500).json({ error: 'Could not load your posted loads right now. Please try again.' });
  }
});

app.patch('/api/broker/loads/:token', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const load = await BookingRequest.findOne({ tokenNo: req.params.token, postedByBrokerUsername: broker.username });
    if (!load) return res.status(404).json({ error: 'Load not found.' });
    if (!brokerLoadPosting.canEditBrokerLoad(load)) {
      return res.status(409).json({ error: 'This load can no longer be edited — it has already been opened to carriers.' });
    }
    const merged = { ...load.toObject(), ...req.body };
    const { valid, errors } = brokerLoadPosting.validateBrokerLoadPosting(merged);
    if (!valid) return res.status(400).json({ error: 'Please fix the highlighted fields.', fieldErrors: errors });
    const editable = ['pickup', 'destination', 'pickupAddress', 'destAddress', 'material', 'weight', 'requiredTruckType', 'requiredBodyType', 'numberOfTrucks', 'budgetRate', 'loadingInstructions', 'unloadingInstructions', 'specialRequirements', 'contactPerson', 'contactPhone', 'advancePaymentRequired', 'advancePaymentPercent', 'requiredDocuments', 'pickupDateTime', 'deliveryDeadline'];
    editable.forEach((field) => {
      if (req.body[field] === undefined) return;
      if (['pickupDateTime', 'deliveryDeadline'].includes(field)) load[field] = req.body[field] ? new Date(req.body[field]) : null;
      else load[field] = req.body[field];
    });
    await load.save();
    logActivity({ loadId: load.tokenNo, userId: broker.id, userRole: 'broker', userName: broker.companyName || broker.username, action: 'BROKER_LOAD_EDITED' }).catch(() => {});
    res.json({ ok: true, tokenNo: load.tokenNo });
  } catch (err) {
    console.error('PATCH /api/broker/loads/:token failed:', err.message);
    res.status(500).json({ error: 'Could not update that load right now. Please try again.' });
  }
});

app.post('/api/broker/loads/:token/open-bidding', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const load = await BookingRequest.findOne({ tokenNo: req.params.token, postedByBrokerUsername: broker.username });
    if (!load) return res.status(404).json({ error: 'Load not found.' });
    if (load.brokerLoadStatus !== 'DRAFT') {
      return res.status(409).json({ error: `This load is already ${load.brokerLoadStatus.toLowerCase()}.` });
    }
    load.brokerLoadStatus = 'POSTED';
    if (req.body && Number(req.body.biddingWindowHours) > 0) {
      load.biddingDeadline = new Date(Date.now() + Number(req.body.biddingWindowHours) * 60 * 60 * 1000);
    }
    await openLoadForBidding(load); // reuses the EXACT same helper the shipper flow uses — never a second bidding-open code path
    logActivity({ loadId: load.tokenNo, userId: broker.id, userRole: 'broker', userName: broker.companyName || broker.username, action: 'BROKER_LOAD_OPENED_FOR_BIDDING', newStatus: 'BIDDING_OPEN' }).catch(() => {});
    notifyLoadPosted(load, { username: broker.username, companyName: broker.companyName, email: broker.email }).catch(() => {});
    if (broker.mobileNumber) {
      smsService.sendLoadApprovedSms({ to: broker.mobileNumber, tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination, userId: broker.id, userRole: 'broker' }).catch(() => {});
    }
    res.json({ ok: true, tokenNo: load.tokenNo, loadStage: load.loadStage, biddingDeadline: load.biddingDeadline });
  } catch (err) {
    console.error('POST /api/broker/loads/:token/open-bidding failed:', err.message);
    res.status(500).json({ error: 'Could not open that load for bidding right now. Please try again.' });
  }
});

app.patch('/api/broker/loads/:token/cancel', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const load = await BookingRequest.findOne({ tokenNo: req.params.token, postedByBrokerUsername: broker.username });
    if (!load) return res.status(404).json({ error: 'Load not found.' });
    if (!brokerLoadPosting.canCancelBrokerLoad(load)) {
      return res.status(409).json({ error: 'This load can no longer be cancelled — it already has a carrier/driver committed to it.' });
    }
    load.brokerLoadStatus = 'CANCELLED';
    load.cancelledAt = new Date();
    load.cancelledReason = String((req.body && req.body.reason) || '').trim().slice(0, 300);
    // Close bidding (if it was open) without inventing a new loadStage value
    // — an expired biddingDeadline is already the existing, everywhere-
    // understood signal this app uses for "no longer open" (see
    // brokerAutomation.canBrokerConnect's load_expired check and the Load
    // Board's own biddingExpired flag).
    if (load.loadStage === 'BIDDING_OPEN') load.biddingDeadline = new Date(Date.now() - 1000);
    await load.save();
    logActivity({ loadId: load.tokenNo, userId: broker.id, userRole: 'broker', userName: broker.companyName || broker.username, action: 'BROKER_LOAD_CANCELLED' }).catch(() => {});
    res.json({ ok: true, tokenNo: load.tokenNo, brokerLoadStatus: load.brokerLoadStatus });
  } catch (err) {
    console.error('PATCH /api/broker/loads/:token/cancel failed:', err.message);
    res.status(500).json({ error: 'Could not cancel that load right now. Please try again.' });
  }
});

// Read-only bid list for a broker's OWN posted load (the broker stands in
// for the shipper on a load they posted themselves) — ranked with the same
// engine the real shipper-facing ranked-offers view uses, so the numbers
// can never disagree. Deliberately does NOT add an accept/reject action
// here: actual acceptance stays exclusively on the existing, carefully
// transactional shipper accept-bid flow (out of scope for this pass — see
// the final report's "remaining limitations").
app.get('/api/broker/loads/:token/bids', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const load = await BookingRequest.findOne({ tokenNo: req.params.token, postedByBrokerUsername: broker.username }).lean();
    if (!load) return res.status(404).json({ error: 'Load not found.' });
    const bids = await bidding.Bid.find({ loadId: load.tokenNo, status: { $in: ['SUBMITTED', 'SHORTLISTED'] } }).lean();
    if (!bids.length) return res.json({ offers: [] });
    const marginConfig = await bidding.getMarginConfig();
    const context = await buildBidRankingContext(bids, marginConfig);
    const ranked = biddingEngine.rankBidsForShipper(load, context);
    res.json({ offers: ranked.map((r) => ({ rank: r.rank, bidId: r.bidId, carrierCompanyName: r.carrierCompanyName, finalShipperPrice: r.finalShipperPrice, aiMatchScore: r.aiMatchScore, trustScore: r.trustScore, truckType: r.truckType, capacityTons: r.capacityTons })) });
  } catch (err) {
    console.error('GET /api/broker/loads/:token/bids failed:', err.message);
    res.status(500).json({ error: 'Could not load bids for that load right now. Please try again.' });
  }
});

// ---------- Broker: browse loads + eligible carrier/truck options ----------
app.get('/api/broker/loads', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });

    const filter = { loadStage: 'BIDDING_OPEN' };
    const loads = await BookingRequest.find(filter).sort({ biddingOpenedAt: -1 }).lean();
    const { origin, destination, truckType, minWeight, maxWeight, fromDate, toDate } = req.query;
    let filtered = loads;
    if (origin) filtered = filtered.filter((l) => (l.pickup || '').toLowerCase().includes(String(origin).toLowerCase()));
    if (destination) filtered = filtered.filter((l) => (l.destination || '').toLowerCase().includes(String(destination).toLowerCase()));
    if (truckType) filtered = filtered.filter((l) => (l.requiredTruckType || '').toLowerCase().includes(String(truckType).toLowerCase()));
    if (minWeight) filtered = filtered.filter((l) => Number(l.weight) >= Number(minWeight));
    if (maxWeight) filtered = filtered.filter((l) => Number(l.weight) <= Number(maxWeight));
    if (fromDate) filtered = filtered.filter((l) => l.pickupDateTime && new Date(l.pickupDateTime) >= new Date(fromDate));
    if (toDate) filtered = filtered.filter((l) => l.pickupDateTime && new Date(l.pickupDateTime) <= new Date(toDate));

    const tokenNos = filtered.map((l) => l.tokenNo);
    const myBids = await bidding.Bid.find({ loadId: { $in: tokenNos }, submittedByRole: 'broker', brokerUsername: broker.username }).lean();
    const myBidByLoad = new Map(myBids.map((b) => [b.loadId, b]));

    res.json(filtered.map((l) => ({
      tokenNo: l.tokenNo, pickup: l.pickup, destination: l.destination,
      material: l.material, weight: l.weight, distanceKm: l.distanceKm,
      requiredTruckType: l.requiredTruckType, requiredBodyType: l.requiredBodyType,
      pickupDateTime: l.pickupDateTime, deliveryDeadline: l.deliveryDeadline,
      biddingDeadline: l.biddingDeadline,
      biddingExpired: !!(l.biddingDeadline && new Date(l.biddingDeadline).getTime() < Date.now()),
      shipperCompanyName: l.companyName || '',
      myBid: myBidByLoad.get(l.tokenNo) ? {
        id: myBidByLoad.get(l.tokenNo).id, status: myBidByLoad.get(l.tokenNo).status, bidAmount: myBidByLoad.get(l.tokenNo).bidAmount,
      } : null,
    })));
  } catch (err) {
    console.error('GET /api/broker/loads failed:', err.message);
    res.status(500).json({ error: 'Could not load available loads right now. Please try again.' });
  }
});

app.get('/api/broker/loads/:token', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const load = await BookingRequest.findOne({ tokenNo: req.params.token }).lean();
    if (!load) return res.status(404).json({ error: 'Load not found.' });
    // Eligible carrier/truck options (spec section 6, point 4) — real,
    // currently verified+available trucks that satisfy this load's own
    // weight/type/body requirements, via the SAME eligibility check the
    // Carrier Bidding flow already uses (never a second, separate rule set).
    const candidateTrucks = await Truck.find({ verified: true, status: 'available' }).lean();
    const eligibleTrucks = candidateTrucks
      .map((t) => ({ truck: t, eligibility: matchingEngine.checkTruckEligibility({ weight: load.weight, requiredTruckType: load.requiredTruckType, requiredBodyType: load.requiredBodyType }, t) }))
      .filter((x) => x.eligibility.eligible)
      .slice(0, 25)
      .map((x) => ({ id: x.truck.id, vehicleNumber: x.truck.vehicleNumber, truckType: x.truck.truckType, bodyType: x.truck.bodyType, capacityTons: x.truck.capacityTons, currentLocation: x.truck.currentLocation, carrierUsername: x.truck.carrierUsername }));
    res.json({
      tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination,
      pickupAddress: load.pickupAddress, destAddress: load.destAddress,
      material: load.material, weight: load.weight, distanceKm: load.distanceKm,
      requiredTruckType: load.requiredTruckType, requiredBodyType: load.requiredBodyType,
      pickupDateTime: load.pickupDateTime, deliveryDeadline: load.deliveryDeadline,
      loadStage: load.loadStage, biddingDeadline: load.biddingDeadline,
      shipperCompanyName: load.companyName || '',
      eligibleTrucks,
    });
  } catch (err) {
    console.error('GET /api/broker/loads/:token failed:', err.message);
    res.status(500).json({ error: 'Could not load that load right now. Please try again.' });
  }
});

// ---------- Broker: bids ----------
app.get('/api/broker/bids', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const filter = { submittedByRole: 'broker', brokerUsername: broker.username };
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const bids = await bidding.Bid.find(filter).sort({ createdAt: -1 }).lean();
    const loads = await BookingRequest.find({ tokenNo: { $in: bids.map((b) => b.loadId) } }).select('tokenNo pickup destination loadStage').lean();
    const loadByToken = new Map(loads.map((l) => [l.tokenNo, l]));
    res.json(bids.map((b) => ({
      id: b.id, loadId: b.loadId, bidAmount: b.bidAmount, status: b.status, notes: b.notes,
      truckId: b.truckId, vehicleNumber: b.vehicleNumber, createdAt: b.createdAt,
      acceptedAt: b.acceptedAt, rejectedAt: b.rejectedAt, rejectionReason: b.rejectionReason, withdrawnAt: b.withdrawnAt,
      load: loadByToken.get(b.loadId) ? { pickup: loadByToken.get(b.loadId).pickup, destination: loadByToken.get(b.loadId).destination, loadStage: loadByToken.get(b.loadId).loadStage } : null,
    })));
  } catch (err) {
    console.error('GET /api/broker/bids failed:', err.message);
    res.status(500).json({ error: 'Could not load your bids right now. Please try again.' });
  }
});

/**
 * Shared broker-bid-placement logic — used by POST /api/broker/bids (a
 * broker bidding with ANY eligible verified truck platform-wide, the
 * original Broker Portal behavior) AND by the new Broker Automation
 * connection workflow (POST /api/broker/connections/:id/bid, which places
 * a bid for a specific carrier's truck already validated by
 * brokerAutomation.canBrokerConnect). Kept as ONE function so both entry
 * points can never disagree on eligibility, duplicate-bid prevention, or
 * what gets written to the Bid record — extracted from the original inline
 * route body without changing any of its behavior.
 *
 * Throws an Error with `.status` set on any validation failure (mirrors the
 * existing inline route's res.status(...) calls) — callers should catch and
 * respond with `{error: err.message}` at `err.status`.
 */
async function placeBrokerBid({ broker, load, truckId, bidAmount, notes }) {
  if (broker.kycStatus !== 'APPROVED') {
    const err = new Error('Your KYC must be approved by admin before you can submit bids.');
    err.status = 403; throw err;
  }
  if (load.loadStage !== 'BIDDING_OPEN') {
    const err = new Error(`This load isn't open for bidding right now (currently ${statusMachine.STAGE_LABELS[load.loadStage] || load.loadStage}).`);
    err.status = 409; throw err;
  }
  if (load.biddingDeadline && new Date(load.biddingDeadline).getTime() < Date.now()) {
    const err = new Error('The bidding deadline for this load has passed.');
    err.status = 409; throw err;
  }
  if (!Number.isFinite(bidAmount) || bidAmount <= 0) {
    const err = new Error('Enter a valid bid amount greater than zero.');
    err.status = 400; throw err;
  }
  if (!truckId) {
    const err = new Error('Select an eligible truck to bid with (see /api/broker/loads/:token for options).');
    err.status = 400; throw err;
  }
  const truck = await Truck.findOne({ id: truckId, verified: true, status: 'available' }).lean();
  if (!truck) {
    const err = new Error('That truck is not available right now — please pick a different one.');
    err.status = 404; throw err;
  }
  const eligibility = matchingEngine.checkTruckEligibility({ weight: load.weight, requiredTruckType: load.requiredTruckType, requiredBodyType: load.requiredBodyType }, truck);
  if (!eligibility.eligible) {
    const err = new Error('This truck is not eligible for this load: ' + eligibility.reasons.join('; '));
    err.status = 400; throw err;
  }
  const existingActive = await bidding.Bid.findOne({ loadId: load.tokenNo, submittedByRole: 'broker', brokerUsername: broker.username, status: { $in: ['SUBMITTED', 'SHORTLISTED'] } }).lean();
  if (existingActive) {
    const err = new Error('You already have an active bid on this load. Withdraw it first if you want to submit a different one.');
    err.status = 409; throw err;
  }
  const truckCarrier = await Registration.findOne({ role: 'carrier', username: truck.carrierUsername }).lean();
  const bid = await bidding.Bid.create({
    id: `BID-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    loadId: load.tokenNo,
    submittedByRole: 'broker',
    brokerUsername: broker.username,
    brokerCompanyName: broker.companyName || broker.contactPerson || broker.username,
    carrierUsername: truck.carrierUsername,
    carrierCompanyName: `${broker.companyName || broker.contactPerson || broker.username} (via broker, carrier: ${truckCarrier?.companyName || truck.carrierUsername})`,
    truckId: truck.id, vehicleNumber: truck.vehicleNumber || '',
    driverId: truck.assignedDriverId || '',
    bidAmount,
    notes: String(notes || '').trim().slice(0, 500),
  });
  await ops.TrackingEvent.create({ tokenNo: load.tokenNo, type: 'BID_SUBMITTED', label: 'New Broker Bid Received', createdByRole: 'broker', createdByUsername: broker.username, createdAt: new Date() }).catch(() => {});
  notificationService.notify({ userId: 'admin', userRole: 'admin', loadId: load.tokenNo, type: 'BID_SUBMITTED', title: 'New broker bid received', message: `${bid.brokerCompanyName} bid ₹${bidAmount} on load ${load.tokenNo}.` }).catch(() => {});
  const shipper = load.shipperUsername ? await Registration.findOne({ role: 'shipper', username: load.shipperUsername }).lean() : null;
  if (shipper) {
    notificationService.notify({ userId: shipper.id, userRole: 'shipper', loadId: load.tokenNo, type: 'BID_SUBMITTED', title: 'New bid on your load', message: `A new offer arrived for load ${load.tokenNo}. Compare offers any time from My Loads > Bids.` }).catch(() => {});
  }
  emitLoadUpdate(load.tokenNo, { newBid: true });
  logActivity({ loadId: load.tokenNo, userId: broker.id, userRole: 'broker', userName: broker.companyName || broker.contactPerson, action: 'BID_SUBMITTED', newStatus: 'SUBMITTED' }).catch(() => {});
  if (broker.mobileNumber) {
    smsService.sendBidSubmittedSms({ to: broker.mobileNumber, tokenNo: load.tokenNo, bidAmount, userId: broker.id, userRole: 'broker' }).catch(() => {});
  }
  return { bid, truck, shipper };
}

app.post('/api/broker/bids', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const tokenNo = String(req.body.tokenNo || '').trim();
    const load = await BookingRequest.findOne({ tokenNo });
    if (!load) return res.status(404).json({ error: 'Load not found.' });
    const truckId = String(req.body.truckId || '').trim();
    const bidAmount = Number(req.body.bidAmount);
    const { bid } = await placeBrokerBid({ broker, load, truckId, bidAmount, notes: req.body.notes });
    res.json({ id: bid.id, status: bid.status });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /api/broker/bids failed:', err.message);
    res.status(500).json({ error: 'Could not submit your bid right now. Please try again.' });
  }
});

app.patch('/api/broker/bids/:id/withdraw', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const bid = await bidding.Bid.findOne({ id: req.params.id, submittedByRole: 'broker', brokerUsername: broker.username });
    if (!bid) return res.status(404).json({ error: 'Bid not found.' });
    if (!['SUBMITTED', 'SHORTLISTED'].includes(bid.status)) {
      return res.status(409).json({ error: `This bid can't be withdrawn — it is already ${bid.status.toLowerCase()}.` });
    }
    bid.status = 'WITHDRAWN';
    bid.withdrawnAt = new Date();
    await bid.save();
    await ops.TrackingEvent.create({ tokenNo: bid.loadId, type: 'BID_WITHDRAWN', label: 'Broker Withdrew Bid', createdByRole: 'broker', createdByUsername: broker.username, createdAt: new Date() }).catch(() => {});
    // Broker Automation: a withdrawn bid also cancels whichever connection
    // request it was placed for, if any (see POST /api/broker/connections/:id/bid).
    syncBrokerConnectionOnBidChange(bid.id, 'cancelled', 'The broker withdrew their bid.').catch((err) => console.error('syncBrokerConnectionOnBidChange failed:', err.message));
    res.json({ ok: true, status: bid.status });
  } catch (err) {
    console.error('PATCH /api/broker/bids/:id/withdraw failed:', err.message);
    res.status(500).json({ error: 'Could not withdraw that bid right now. Please try again.' });
  }
});

// =====================================================================
// ---------- Broker Automation: Carrier discovery, Saved Loads, Smart ----------
// ---------- Truck Matching, and Shipper Connection requests           ----------
// =====================================================================
// Shipper -> Load -> Broker -> Carrier -> Truck/Driver. Every route below
// is scoped to the logged-in broker's own session (getBrokerSession) and
// reuses the existing Truck/Driver/BookingRequest/Bid models, the existing
// matchingEngine/biddingEngine, and the existing notification/email
// services — this is additive automation on top of the Broker Portal
// above, never a second competing bidding/matching system. Saving a load
// or matching a truck NEVER changes the load's real loadStage; only the
// existing shipper accept-bid flow (unchanged, see
// POST /api/shipper/loads/:token/bids/:bidId/accept above) can actually
// assign a carrier to a load.

/** Keeps a BrokerConnection's status in sync with the real outcome of the Bid it's linked to (see acceptBidTransactional and the withdraw route above) — never overwrites an already-terminal connection. */
async function syncBrokerConnectionOnBidChange(bidId, newStatus, note) {
  if (!bidId) return;
  const connection = await brokerAutomationModels.BrokerConnection.findOne({ bidId });
  if (!connection) return;
  if (['approved', 'rejected', 'cancelled', 'expired'].includes(connection.status)) return;
  connection.status = newStatus;
  connection.statusHistory.push({ status: newStatus, at: new Date(), note: note || '' });
  connection.updatedAt = new Date();
  await connection.save();
}

/** Safe fields only — never a password/confirmPassword, regardless of caller. */
function carrierPublicSummary(record) {
  return {
    id: record.id, username: record.username,
    companyName: record.companyName || record.contactPerson || record.username,
    mobileNumber: record.mobileNumber || record.phoneNumber || '',
    city: (record.address && record.address.city) || record.city || '',
    status: record.status,
  };
}

/** Average of a carrier's own linked drivers' cached trustScore — never a fabricated per-company score; null (never 0) when the carrier has no drivers on file yet, so the UI can show "—" instead of implying a real (bad) score. */
function averageCarrierTrustScore(driversForCarrier) {
  if (!driversForCarrier || !driversForCarrier.length) return null;
  const sum = driversForCarrier.reduce((acc, d) => acc + (typeof d.trustScore === 'number' ? d.trustScore : 70), 0);
  return Math.round(sum / driversForCarrier.length);
}

// ---------- 1. Carrier discovery (for "Select a Carrier" in the Broker workspace, ----------
// ---------- and the dedicated Carrier Connect page's search + filters)   ----------
// Deliberately its OWN authenticated, minimal-fields endpoint rather than
// reusing the existing GET /api/public/:role (that route is unauthenticated
// and returns full raw Registration documents, including the password
// field — fine for its own original purpose, but not something new code
// should build on for a browser-facing carrier picker).
app.get('/api/broker/carriers', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const filter = { role: 'carrier', active: { $ne: false } };
    // "Filter by verified status" — defaults to the existing safe behavior
    // (accepted carriers only) unless the broker explicitly asks to also
    // see unverified ones.
    if (req.query.includeUnverified !== 'true') filter.status = 'accepted';
    const search = String(req.query.search || req.query.q || '').trim();
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ companyName: re }, { username: re }, { contactPerson: re }, { 'address.city': re }];
    }
    const carriers = await Registration.find(filter).limit(200).lean();
    const usernames = carriers.map((c) => c.username);
    const [trucks, drivers, myConnections] = await Promise.all([
      Truck.find({ carrierUsername: { $in: usernames } }).lean(),
      Driver.find({ carrierUsername: { $in: usernames } }).lean(),
      brokerAutomationModels.CarrierConnection.find({ brokerUsername: broker.username, carrierUsername: { $in: usernames } }).lean().catch(() => []),
    ]);
    const trucksByCarrier = new Map();
    trucks.forEach((t) => { if (!trucksByCarrier.has(t.carrierUsername)) trucksByCarrier.set(t.carrierUsername, []); trucksByCarrier.get(t.carrierUsername).push(t); });
    const driversByCarrier = new Map();
    drivers.forEach((d) => { if (!driversByCarrier.has(d.carrierUsername)) driversByCarrier.set(d.carrierUsername, []); driversByCarrier.get(d.carrierUsername).push(d); });
    const connectionByCarrier = new Map(myConnections.map((c) => [c.carrierUsername, c]));

    const truckTypeFilter = String(req.query.truckType || '').trim().toLowerCase();
    const minCapacity = req.query.minCapacity ? Number(req.query.minCapacity) : null;
    const route = String(req.query.route || '').trim().toLowerCase();
    const availableOnly = req.query.availableOnly === 'true';
    const minTrustScore = req.query.minTrustScore ? Number(req.query.minTrustScore) : null;

    let results = carriers.map((c) => {
      const carrierTrucks = trucksByCarrier.get(c.username) || [];
      const carrierDrivers = driversByCarrier.get(c.username) || [];
      const trustScore = averageCarrierTrustScore(carrierDrivers);
      const truckTypes = [...new Set(carrierTrucks.map((t) => t.truckType).filter(Boolean))];
      const hasAvailableTruck = carrierTrucks.some((t) => t.status === 'available');
      const maxCapacity = carrierTrucks.length ? Math.max(...carrierTrucks.map((t) => Number(t.capacityTons) || 0)) : null;
      const conn = connectionByCarrier.get(c.username);
      return {
        ...carrierPublicSummary(c),
        truckCount: carrierTrucks.length,
        truckTypes,
        maxCapacityTons: maxCapacity,
        hasAvailableTruck,
        trustScore,
        verified: c.status === 'accepted',
        connectionStatus: conn ? conn.status : null,
      };
    });

    if (truckTypeFilter) results = results.filter((c) => c.truckTypes.some((t) => t.toLowerCase().includes(truckTypeFilter)));
    if (minCapacity) results = results.filter((c) => c.maxCapacityTons !== null && c.maxCapacityTons >= minCapacity);
    if (availableOnly) results = results.filter((c) => c.hasAvailableTruck);
    if (minTrustScore) results = results.filter((c) => c.trustScore !== null && c.trustScore >= minTrustScore);
    if (route) {
      results = results.filter((c) => {
        const carrierTrucks = trucksByCarrier.get(c.username) || [];
        return (c.city || '').toLowerCase().includes(route) || carrierTrucks.some((t) => (t.currentLocation || '').toLowerCase().includes(route));
      });
    }

    res.json(results.slice(0, 100));
  } catch (err) {
    console.error('GET /api/broker/carriers failed:', err.message);
    res.status(500).json({ error: 'Could not load carriers right now. Please try again.' });
  }
});

// Full profile for one carrier — "View profile" action on a carrier card.
// Same safe-fields contract as the list endpoint, plus the carrier's real
// fleet (never another carrier's data, never a password).
app.get('/api/broker/carriers/:id', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const carrier = await Registration.findOne({ role: 'carrier', id: req.params.id }).lean();
    if (!carrier) return res.status(404).json({ error: 'Carrier not found.' });
    const [trucks, drivers, connection] = await Promise.all([
      Truck.find({ carrierUsername: carrier.username }).lean(),
      Driver.find({ carrierUsername: carrier.username }).lean(),
      brokerAutomationModels.CarrierConnection.findOne({ brokerUsername: broker.username, carrierUsername: carrier.username }).lean().catch(() => null),
    ]);
    res.json({
      ...carrierPublicSummary(carrier),
      trustScore: averageCarrierTrustScore(drivers),
      verified: carrier.status === 'accepted',
      connectionStatus: connection ? connection.status : null,
      trucks: trucks.map((t) => ({ id: t.id, vehicleNumber: t.vehicleNumber, truckType: t.truckType, bodyType: t.bodyType, capacityTons: t.capacityTons, status: t.status, verified: t.verified, currentLocation: t.currentLocation })),
      driverCount: drivers.length,
    });
  } catch (err) {
    console.error('GET /api/broker/carriers/:id failed:', err.message);
    res.status(500).json({ error: 'Could not load that carrier right now. Please try again.' });
  }
});

// =====================================================================
// ---------- Carrier Connect: broker<->carrier networking/roster ----------
// =====================================================================
// A GENERAL, load-independent relationship — "add this carrier to my
// network" — deliberately separate from BrokerConnection above (which
// tracks one specific load+truck+shipper workflow instance). See
// lib/brokerAutomationModels.js's CarrierConnection schema comment.
app.post('/api/broker/carrier-connections', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const carrierId = String(req.body.carrierId || '').trim();
    const carrier = await Registration.findOne({ role: 'carrier', id: carrierId }).lean();
    if (!carrier) return res.status(404).json({ error: 'Carrier not found.' });
    if (carrier.active === false || carrier.status !== 'accepted') {
      return res.status(409).json({ error: 'That carrier is not currently active/verified.' });
    }
    const existing = await brokerAutomationModels.CarrierConnection.findOne({
      brokerUsername: broker.username, carrierUsername: carrier.username, status: { $in: ['PENDING', 'ACCEPTED'] },
    }).lean();
    if (existing) return res.status(409).json({ error: `You already have a ${existing.status.toLowerCase()} connection with this carrier.` });

    let connection;
    try {
      connection = await brokerAutomationModels.CarrierConnection.create({
        id: `CCONN-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        brokerId: broker.id, brokerUsername: broker.username, brokerCompanyName: broker.companyName || broker.username,
        carrierId: carrier.id, carrierUsername: carrier.username, carrierCompanyName: carrier.companyName || carrier.username,
        message: String(req.body.message || '').trim().slice(0, 300),
      });
    } catch (err) {
      if (err.code === 11000) return res.status(409).json({ error: 'You already have an active connection request with this carrier.' });
      throw err;
    }
    logActivity({ userId: broker.id, userRole: 'broker', userName: broker.companyName || broker.username, action: 'CARRIER_CONNECTION_REQUESTED', metadata: { carrierId: carrier.id } }).catch(() => {});
    // In-app notification + SMS only here — the existing
    // sendCarrierConnectionRequestEmail template is specifically about a
    // LOAD connection (it always names a Load ID); this general,
    // load-independent roster request is covered by the notification
    // center + SMS instead of stretching that load-shaped template.
    notificationService.notify({ userId: carrier.id, userRole: 'carrier', type: 'CARRIER_CONNECTION_REQUESTED', title: 'New connection request', message: `${broker.companyName || broker.username} would like to connect with you on LoadSmart.` }).catch(() => {});
    if (carrier.mobileNumber) smsService.sendCarrierConnectionRequestSms({ to: carrier.mobileNumber, tokenNo: connection.id, carrierCompanyName: carrier.companyName, userId: carrier.id, userRole: 'carrier' }).catch(() => {});
    res.json(connection.toObject());
  } catch (err) {
    console.error('POST /api/broker/carrier-connections failed:', err.message);
    res.status(500).json({ error: 'Could not send that connection request right now. Please try again.' });
  }
});

// List — from the broker's side (their own sent requests + roster) by
// default; a carrier can also see requests addressed to them by passing
// their own carrier session instead (same route, role-scoped both ways).
app.get('/api/broker/carrier-connections', async (req, res) => {
  try {
    const brokerSession = getBrokerSession(req);
    const carrierSession = !brokerSession ? getCarrierSession(req) : null;
    if (!brokerSession && !carrierSession) return res.status(401).json({ error: 'Please log in first.' });
    let filter;
    if (brokerSession) {
      const broker = await Registration.findOne({ role: 'broker', id: brokerSession.recordId }).lean();
      if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
      filter = { brokerUsername: broker.username };
    } else {
      const carrier = await Registration.findOne({ role: 'carrier', id: carrierSession.recordId }).lean();
      if (!carrier) return res.status(404).json({ error: 'Carrier account not found.' });
      filter = { carrierUsername: carrier.username };
    }
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const rows = await brokerAutomationModels.CarrierConnection.find(filter).sort({ createdAt: -1 }).lean();
    res.json(rows);
  } catch (err) {
    console.error('GET /api/broker/carrier-connections failed:', err.message);
    res.status(500).json({ error: 'Could not load connections right now. Please try again.' });
  }
});

// PATCH — a broker may only CANCEL their own request; a carrier may only
// ACCEPT or REJECT a request addressed to them. Never the other way
// around, and never a status this app doesn't recognize.
app.patch('/api/broker/carrier-connections/:id', async (req, res) => {
  try {
    const brokerSession = getBrokerSession(req);
    const carrierSession = !brokerSession ? getCarrierSession(req) : null;
    if (!brokerSession && !carrierSession) return res.status(401).json({ error: 'Please log in first.' });
    const requestedStatus = String(req.body.status || '').toUpperCase();
    const connection = await brokerAutomationModels.CarrierConnection.findOne({ id: req.params.id });
    if (!connection) return res.status(404).json({ error: 'Connection not found.' });
    if (connection.status !== 'PENDING') return res.status(409).json({ error: `This connection is already ${connection.status}.` });

    if (brokerSession) {
      const broker = await Registration.findOne({ role: 'broker', id: brokerSession.recordId }).lean();
      if (!broker || connection.brokerUsername !== broker.username) return res.status(403).json({ error: 'Not authorized for this connection.' });
      if (requestedStatus !== 'CANCELLED') return res.status(400).json({ error: 'A broker may only cancel their own pending connection request.' });
    } else {
      const carrier = await Registration.findOne({ role: 'carrier', id: carrierSession.recordId }).lean();
      if (!carrier || connection.carrierUsername !== carrier.username) return res.status(403).json({ error: 'Not authorized for this connection.' });
      if (!['ACCEPTED', 'REJECTED'].includes(requestedStatus)) return res.status(400).json({ error: 'A carrier may only accept or reject a connection request addressed to them.' });
    }
    connection.status = requestedStatus;
    connection.respondedAt = new Date();
    connection.updatedAt = new Date();
    await connection.save();
    logActivity({ userRole: brokerSession ? 'broker' : 'carrier', action: 'CARRIER_CONNECTION_STATUS_CHANGED', newStatus: requestedStatus, metadata: { connectionId: connection.id } }).catch(() => {});

    // Notify the OTHER party of the outcome.
    if (requestedStatus === 'ACCEPTED' || requestedStatus === 'REJECTED') {
      const broker = await Registration.findOne({ role: 'broker', username: connection.brokerUsername }).lean();
      if (broker) {
        notificationService.notify({ userId: broker.id, userRole: 'broker', type: `CARRIER_CONNECTION_${requestedStatus}`, title: `Carrier ${requestedStatus === 'ACCEPTED' ? 'accepted' : 'declined'} your connection request`, message: `${connection.carrierCompanyName} ${requestedStatus === 'ACCEPTED' ? 'accepted' : 'declined'} your connection request.` }).catch(() => {});
        if (broker.mobileNumber) {
          const fn = requestedStatus === 'ACCEPTED' ? smsService.sendCarrierConnectionAcceptedSms : smsService.sendCarrierConnectionRejectedSms;
          fn({ to: broker.mobileNumber, entityId: connection.id, brokerCompanyName: broker.companyName, carrierCompanyName: connection.carrierCompanyName, userId: broker.id, userRole: 'broker' }).catch(() => {});
        }
      }
    }
    res.json(connection.toObject());
  } catch (err) {
    console.error('PATCH /api/broker/carrier-connections/:id failed:', err.message);
    res.status(500).json({ error: 'Could not update that connection right now. Please try again.' });
  }
});

// ---------- Invite a specific carrier to bid on a specific load ----------
// Deliberately does NOT itself create a bid — it only notifies the carrier
// that they're welcome to submit one through the normal, existing carrier
// bidding flow (POST /api/carrier/loads/:token/bids or the broker's own
// POST /api/broker/bids on the carrier's behalf, both unchanged).
app.post('/api/broker/loads/:token/invite-carrier', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const load = await BookingRequest.findOne({ tokenNo: req.params.token }).lean();
    if (!load) return res.status(404).json({ error: 'Load not found.' });
    if (load.loadStage !== 'BIDDING_OPEN') return res.status(409).json({ error: `This load is not currently open for bidding (${load.loadStage}).` });
    const carrierId = String(req.body.carrierId || '').trim();
    const carrier = await Registration.findOne({ role: 'carrier', id: carrierId }).lean();
    if (!carrier) return res.status(404).json({ error: 'Carrier not found.' });
    if (carrier.active === false || carrier.status !== 'accepted') return res.status(409).json({ error: 'That carrier is not currently active/verified.' });

    let invite;
    try {
      invite = await brokerAutomationModels.LoadCarrierInvite.create({
        id: `INV-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        brokerId: broker.id, brokerUsername: broker.username,
        loadId: load.tokenNo, carrierId: carrier.id, carrierUsername: carrier.username, carrierCompanyName: carrier.companyName || carrier.username,
      });
    } catch (err) {
      if (err.code === 11000) return res.status(409).json({ error: 'You already invited this carrier to bid on this load.' });
      throw err;
    }
    logActivity({ loadId: load.tokenNo, userId: broker.id, userRole: 'broker', userName: broker.companyName || broker.username, action: 'CARRIER_INVITED_TO_BID', metadata: { carrierId: carrier.id } }).catch(() => {});
    // Deliberately its own eventType (CARRIER_INVITED_TO_BID), distinct
    // from BrokerConnection's CARRIER_CONNECTION_REQUESTED email — both can
    // legitimately happen for the same broker+carrier+load without one
    // silently deduping the other via the shared idempotencyKey
    // (eventType+entityId+recipient) lib/emailQueue.js enforces.
    notificationService.notify({ userId: carrier.id, userRole: 'carrier', loadId: load.tokenNo, type: 'CARRIER_INVITED_TO_BID', title: 'Invited to bid', message: `${broker.companyName || broker.username} invited you to bid on load ${load.tokenNo} (${load.pickup} → ${load.destination}).` }).catch(() => {});
    if (carrier.mobileNumber) smsService.sendCarrierInvitedToBidSms({ to: carrier.mobileNumber, tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination, userId: carrier.id, userRole: 'carrier' }).catch(() => {});
    res.json(invite.toObject());
  } catch (err) {
    console.error('POST /api/broker/loads/:token/invite-carrier failed:', err.message);
    res.status(500).json({ error: 'Could not send that invitation right now. Please try again.' });
  }
});

// ---------- 2. Smart Truck Matching, scoped to one carrier ----------
// GET /api/broker/carriers/:carrierId/trucks — that carrier's OWN fleet
// only. Pass ?loadToken=<tokenNo> to also rank/score each truck against a
// specific load (reusing matchingEngine, same engine every other match
// score in this app comes from) — without it, this just lists the fleet.
app.get('/api/broker/carriers/:carrierId/trucks', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const carrier = await Registration.findOne({ role: 'carrier', id: req.params.carrierId }).lean();
    if (!carrier) return res.status(404).json({ error: 'Carrier not found.' });
    const trucks = await Truck.find({ carrierUsername: carrier.username }).lean();
    const driverIds = trucks.map((t) => t.assignedDriverId).filter(Boolean);
    const drivers = await Driver.find({ id: { $in: driverIds } }).lean();
    const driverById = new Map(drivers.map((d) => [d.id, d]));

    const loadToken = String(req.query.loadToken || '').trim();
    if (!loadToken) {
      // Plain fleet listing — real fields only, no invented score/availability.
      return res.json({
        carrier: carrierPublicSummary(carrier),
        trucks: trucks.map((t) => ({
          truckId: t.id, vehicleNumber: t.vehicleNumber, truckType: t.truckType, bodyType: t.bodyType,
          capacityTons: t.capacityTons, status: t.status, complianceStatus: t.verified ? 'verified' : 'unverified',
          currentLocation: t.currentLocation || '',
          driverName: t.assignedDriverId && driverById.get(t.assignedDriverId) ? driverById.get(t.assignedDriverId).name : '',
        })),
      });
    }
    const load = await BookingRequest.findOne({ tokenNo: loadToken }).lean();
    if (!load) return res.status(404).json({ error: 'Load not found.' });
    const { eligible, ineligible } = brokerAutomation.findSuitableTrucksForCarrier(load, carrier.username, trucks, driverById);
    res.json({
      carrier: carrierPublicSummary(carrier),
      load: { tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination, requiredTruckType: load.requiredTruckType, weight: load.weight },
      matches: eligible,
      ineligible,
      message: eligible.length ? null : 'No suitable truck found. Try another Carrier or adjust the requirements.',
    });
  } catch (err) {
    console.error('GET /api/broker/carriers/:carrierId/trucks failed:', err.message);
    res.status(500).json({ error: 'Could not load that carrier\'s fleet right now. Please try again.' });
  }
});

// ---------- 3. AI-Powered Broker Recommendations ----------
// Load-centric: "for this load, who's the best carrier+truck right now,
// platform-wide" (spec section 4). Deterministic, rule-based
// (matchingEngine.scoreCandidate) — there is no separate LLM-based matching
// model in this app to call, so this IS the "AI matching" the rest of the
// app already relies on for every other ranked-match feature (Carrier
// Bidding's AI Match %, the dispatcher auto-match engine). Never fabricates
// a carrier/truck that doesn't actually exist or isn't actually eligible.
app.get('/api/broker/load-matches/:loadId', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const load = await BookingRequest.findOne({ tokenNo: req.params.loadId }).lean();
    if (!load) return res.status(404).json({ error: 'Load not found.' });
    const trucks = await Truck.find({ verified: true, status: 'available' }).lean();
    const carrierUsernames = [...new Set(trucks.map((t) => t.carrierUsername))];
    const [carriers, drivers] = await Promise.all([
      Registration.find({ role: 'carrier', username: { $in: carrierUsernames } }).lean(),
      Driver.find({ id: { $in: trucks.map((t) => t.assignedDriverId).filter(Boolean) } }).lean(),
    ]);
    const carrierByUsername = new Map(carriers.map((c) => [c.username, c]));
    const driverById = new Map(drivers.map((d) => [d.id, d]));
    const candidates = trucks
      .filter((t) => carrierByUsername.has(t.carrierUsername)) // only carriers that are real, on-file accounts
      .map((t) => ({
        truck: t,
        driver: t.assignedDriverId ? (driverById.get(t.assignedDriverId) || null) : null,
        carrierUsername: t.carrierUsername,
        carrierCompanyName: carrierByUsername.get(t.carrierUsername).companyName || t.carrierUsername,
      }));
    const { best, missingInfo, consideredCount } = brokerAutomation.recommendBestCarrierForLoad(load, candidates);
    res.json({
      tokenNo: load.tokenNo, consideredCount,
      bestCarrier: best,
      missingInfo,
      message: best ? null : 'No suitable truck found. Try another Carrier or adjust the requirements.',
    });
  } catch (err) {
    console.error('GET /api/broker/load-matches/:loadId failed:', err.message);
    res.status(500).json({ error: 'Could not compute recommendations for that load right now. Please try again.' });
  }
});

// Carrier-centric recommendation (spec section 4: "For each Carrier,
// recommend suitable available loads / trucks / route opportunities").
app.get('/api/broker/carriers/:carrierId/recommendations', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const carrier = await Registration.findOne({ role: 'carrier', id: req.params.carrierId }).lean();
    if (!carrier) return res.status(404).json({ error: 'Carrier not found.' });
    const [trucks, openLoads] = await Promise.all([
      Truck.find({ carrierUsername: carrier.username }).lean(),
      BookingRequest.find({ loadStage: 'BIDDING_OPEN' }).sort({ biddingOpenedAt: -1 }).limit(100).lean(),
    ]);
    const driverIds = trucks.map((t) => t.assignedDriverId).filter(Boolean);
    const drivers = await Driver.find({ id: { $in: driverIds } }).lean();
    const driverById = new Map(drivers.map((d) => [d.id, d]));
    const recommendations = brokerAutomation.recommendLoadsForCarrier(carrier.username, trucks, driverById, openLoads);
    res.json({ carrier: carrierPublicSummary(carrier), recommendations });
  } catch (err) {
    console.error('GET /api/broker/carriers/:carrierId/recommendations failed:', err.message);
    res.status(500).json({ error: 'Could not compute recommendations for that carrier right now. Please try again.' });
  }
});

// =====================================================================
// ---------- Load Matching (dedicated tab) ----------
// =====================================================================
// Works even when the external AI provider is unavailable — everything
// below is the SAME deterministic, rule-based engine either way (spec:
// "Do not falsely claim that the result was generated by AI when it was
// generated by rule-based matching"). If lib/aiService.js is ever wired to
// re-rank these results with a real model, it must ADD an `aiAssisted`
// flag rather than replace this response shape, so the deterministic
// result always remains available as the fallback spec section 4 requires.

// Panel A — "Match loads to my preferred routes": reuses
// brokerService.scoreOpportunities (the exact same engine that already
// powers the Overview tab's Opportunity Radar) so the two views can never
// disagree about which loads best fit this broker.
app.get('/api/broker/load-matching/loads', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const openLoads = await BookingRequest.find({ loadStage: 'BIDDING_OPEN' }).sort({ biddingOpenedAt: -1 }).limit(100).lean();
    const scored = brokerService.scoreOpportunities(broker.loadPreferences, openLoads);
    const loadByToken = new Map(openLoads.map((l) => [l.tokenNo, l]));
    const preferencesConfigured = !!(broker.loadPreferences && (
      (broker.loadPreferences.preferredOrigins || []).length ||
      (broker.loadPreferences.preferredDestinations || []).length ||
      (broker.loadPreferences.preferredTruckTypes || []).length ||
      (broker.loadPreferences.preferredLoadCategories || []).length
    ));
    res.json({
      preferencesConfigured,
      matches: scored.map((s) => {
        const l = loadByToken.get(s.tokenNo);
        return l ? { tokenNo: l.tokenNo, pickup: l.pickup, destination: l.destination, material: l.material, weight: l.weight, requiredTruckType: l.requiredTruckType, pickupDateTime: l.pickupDateTime, biddingDeadline: l.biddingDeadline, score: s.score, reasons: s.reasons } : null;
      }).filter(Boolean),
    });
  } catch (err) {
    console.error('GET /api/broker/load-matching/loads failed:', err.message);
    res.status(500).json({ error: 'Could not compute load matches right now. Please try again.' });
  }
});

// Panel B — "Match trucks/carriers to a selected load": the weighted
// (origin 25 / destination 25 / truck type 15 / capacity 15 / availability
// 10 / verification 5 / trust 5) engine in lib/brokerAutomation.js, run
// across every real, currently-known truck (not just one carrier's fleet —
// this is the broker actively shopping the whole marketplace for a load).
app.get('/api/broker/load-matching/carriers/:loadId', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const load = await BookingRequest.findOne({ tokenNo: req.params.loadId }).lean();
    if (!load) return res.status(404).json({ error: 'Load not found.' });
    const trucks = await Truck.find({}).lean();
    const carrierUsernames = [...new Set(trucks.map((t) => t.carrierUsername))];
    const [carriers, drivers] = await Promise.all([
      Registration.find({ role: 'carrier', username: { $in: carrierUsernames } }).lean(),
      Driver.find({ id: { $in: trucks.map((t) => t.assignedDriverId).filter(Boolean) } }).lean(),
    ]);
    const carrierByUsername = new Map(carriers.map((c) => [c.username, c]));
    const driverById = new Map(drivers.map((d) => [d.id, d]));
    const driversByCarrier = new Map();
    drivers.forEach((d) => { if (!driversByCarrier.has(d.carrierUsername)) driversByCarrier.set(d.carrierUsername, []); driversByCarrier.get(d.carrierUsername).push(d); });

    const results = trucks
      .filter((t) => carrierByUsername.has(t.carrierUsername)) // only real, on-file carrier accounts — never a fabricated carrier
      .map((t) => {
        const carrier = carrierByUsername.get(t.carrierUsername);
        const driver = t.assignedDriverId ? driverById.get(t.assignedDriverId) : null;
        const carrierTrustScore = averageCarrierTrustScore(driversByCarrier.get(t.carrierUsername));
        const { score, breakdown, explanation } = brokerAutomation.computeBrokerLoadMatchScore(load, t, driver, { trustScore: carrierTrustScore });
        return {
          carrierId: carrier.id, carrierUsername: carrier.username, carrierCompanyName: carrier.companyName || carrier.username,
          carrierVerified: carrier.status === 'accepted', carrierTrustScore,
          truckId: t.id, vehicleNumber: t.vehicleNumber, truckType: t.truckType, bodyType: t.bodyType || '',
          capacityTons: t.capacityTons, currentLocation: t.currentLocation || '', truckStatus: t.status, truckVerified: t.verified,
          driverName: driver ? driver.name : '',
          matchScore: score, breakdown, explanation,
        };
      })
      .filter((r) => r.matchScore > 0) // hard-ineligible pairs (score 0) are never "recommended"
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, 30);

    res.json({
      tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination, requiredTruckType: load.requiredTruckType, weight: load.weight,
      weights: brokerAutomation.BROKER_LOAD_MATCH_WEIGHTS,
      matches: results,
      message: results.length ? null : 'No suitable truck found. Try another load or adjust the requirements.',
    });
  } catch (err) {
    console.error('GET /api/broker/load-matching/carriers/:loadId failed:', err.message);
    res.status(500).json({ error: 'Could not compute carrier matches for that load right now. Please try again.' });
  }
});

// ---------- 4. Saved Loads ("Save for Carrier" / Shortlist) ----------
app.post('/api/broker/saved-loads', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const carrierId = String(req.body.carrierId || '').trim();
    const tokenNo = String(req.body.tokenNo || req.body.loadId || '').trim();
    if (!carrierId || !tokenNo) return res.status(400).json({ error: 'carrierId and tokenNo are required.' });
    const [carrier, load] = await Promise.all([
      Registration.findOne({ role: 'carrier', id: carrierId }).lean(),
      BookingRequest.findOne({ tokenNo }).lean(),
    ]);
    if (!carrier) return res.status(404).json({ error: 'Carrier not found.' });
    if (!load) return res.status(404).json({ error: 'Load not found.' });
    let saved;
    try {
      saved = await brokerAutomationModels.BrokerSavedLoad.create({
        id: `BSL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        brokerId: broker.id, brokerUsername: broker.username,
        carrierId: carrier.id, carrierUsername: carrier.username, carrierCompanyName: carrier.companyName || carrier.username,
        loadId: load.tokenNo,
        loadSnapshot: {
          pickup: load.pickup, destination: load.destination, material: load.material,
          weight: load.weight, requiredTruckType: load.requiredTruckType, shipperCompanyName: load.companyName || '',
        },
        notes: String(req.body.notes || '').trim().slice(0, 500),
        savedByUsername: broker.username,
      });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({ error: 'You already saved this load for this carrier.' });
      }
      throw err;
    }
    logActivity({ loadId: load.tokenNo, userId: broker.id, userRole: 'broker', userName: broker.companyName || broker.username, action: 'LOAD_SAVED_FOR_CARRIER', metadata: { carrierId: carrier.id } }).catch(() => {});
    notificationService.notify({ userId: carrier.id, userRole: 'carrier', loadId: load.tokenNo, type: 'LOAD_SAVED_FOR_CARRIER', title: 'A broker saved a load for you', message: `${broker.companyName || broker.username} shortlisted load ${load.tokenNo} (${load.pickup} → ${load.destination}) for you.` }).catch(() => {});
    if (carrier.email) {
      emailService.sendLoadSavedForCarrierEmail({ to: carrier.email, carrierName: carrier.companyName || carrier.contactPerson, tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination, brokerCompanyName: broker.companyName || broker.username, requiredTruckType: load.requiredTruckType }).catch(() => {});
    }
    res.json(saved.toObject());
  } catch (err) {
    console.error('POST /api/broker/saved-loads failed:', err.message);
    res.status(500).json({ error: 'Could not save that load right now. Please try again.' });
  }
});

app.get('/api/broker/saved-loads', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const filter = { brokerUsername: broker.username };
    if (req.query.carrierId) filter.carrierId = String(req.query.carrierId);
    if (req.query.status) filter.status = String(req.query.status);
    const rows = await brokerAutomationModels.BrokerSavedLoad.find(filter).sort({ createdAt: -1 }).lean();
    // Live loadStage — a saved load never changes on its own, but the
    // underlying load might have moved on since it was saved (e.g. another
    // party's bid was already accepted) — surfaced here, never hidden.
    const loads = await BookingRequest.find({ tokenNo: { $in: rows.map((r) => r.loadId) } }).select('tokenNo loadStage').lean();
    const stageByToken = new Map(loads.map((l) => [l.tokenNo, l.loadStage]));
    res.json(rows.map((r) => ({ ...r, liveLoadStage: stageByToken.get(r.loadId) || null })));
  } catch (err) {
    console.error('GET /api/broker/saved-loads failed:', err.message);
    res.status(500).json({ error: 'Could not load your saved loads right now. Please try again.' });
  }
});

app.patch('/api/broker/saved-loads/:id', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const row = await brokerAutomationModels.BrokerSavedLoad.findOne({ id: req.params.id, brokerUsername: broker.username });
    if (!row) return res.status(404).json({ error: 'Saved load not found.' });
    const { status, notes } = req.body || {};
    if (status !== undefined) {
      if (!brokerAutomationModels.BROKER_SAVED_LOAD_STATUSES.includes(status)) {
        return res.status(400).json({ error: 'Invalid status.' });
      }
      row.status = status;
    }
    if (notes !== undefined) row.notes = String(notes).trim().slice(0, 500);
    row.updatedAt = new Date();
    await row.save();
    res.json(row.toObject());
  } catch (err) {
    console.error('PATCH /api/broker/saved-loads/:id failed:', err.message);
    res.status(500).json({ error: 'Could not update that saved load right now. Please try again.' });
  }
});

app.delete('/api/broker/saved-loads/:id', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const row = await brokerAutomationModels.BrokerSavedLoad.findOneAndDelete({ id: req.params.id, brokerUsername: broker.username });
    if (!row) return res.status(404).json({ error: 'Saved load not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/broker/saved-loads/:id failed:', err.message);
    res.status(500).json({ error: 'Could not remove that saved load right now. Please try again.' });
  }
});

// ---------- 5. Shipper Connection workflow ----------
// POST creates the connection request (spec section 3, steps 1-6) and
// notifies both the shipper and the carrier — it deliberately does NOT
// place a bid or touch the load's loadStage by itself (spec: "Do not
// automatically accept a load, assign a truck..."). A real monetary offer
// is a separate, explicit next step: POST /api/broker/connections/:id/bid.
app.post('/api/broker/connections', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    if (broker.kycStatus !== 'APPROVED') {
      return res.status(403).json({ error: 'Your KYC must be approved by admin before you can request a Shipper connection.' });
    }
    const carrierId = String(req.body.carrierId || '').trim();
    const tokenNo = String(req.body.tokenNo || req.body.loadId || '').trim();
    const truckId = String(req.body.truckId || '').trim();
    const [carrier, load, truck] = await Promise.all([
      Registration.findOne({ role: 'carrier', id: carrierId }).lean(),
      BookingRequest.findOne({ tokenNo }).lean(),
      Truck.findOne({ id: truckId }).lean(),
    ]);
    const existingActiveConnection = await brokerAutomationModels.BrokerConnection.findOne({
      brokerUsername: broker.username, loadId: tokenNo, carrierId,
      status: { $in: ['pending', 'shipper_notified', 'carrier_notified', 'negotiating'] },
    }).lean();
    const check = brokerAutomation.canBrokerConnect({ carrier, load, truck, existingActiveConnection });
    if (!check.ok) return res.status(409).json({ error: check.reason, code: check.code });

    const shipper = await Registration.findOne({ role: 'shipper', username: load.shipperUsername }).lean();
    const now = new Date();
    const connection = await brokerAutomationModels.BrokerConnection.create({
      id: `CONN-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      brokerId: broker.id, brokerUsername: broker.username, brokerCompanyName: broker.companyName || broker.username,
      carrierId: carrier.id, carrierUsername: carrier.username, carrierCompanyName: carrier.companyName || carrier.username,
      loadId: load.tokenNo,
      shipperId: shipper ? shipper.id : '', shipperUsername: load.shipperUsername || '', shipperCompanyName: load.companyName || (shipper && shipper.companyName) || '',
      truckId: truck.id, vehicleNumber: truck.vehicleNumber || '',
      status: 'shipper_notified',
      shipperNotifiedAt: now, carrierNotifiedAt: now,
      notes: String(req.body.notes || '').trim().slice(0, 500),
      statusHistory: [
        { status: 'pending', at: now, note: 'Connection requested by broker.' },
        { status: 'shipper_notified', at: now, note: 'Shipper and carrier notified.' },
      ],
    });

    logActivity({ loadId: load.tokenNo, userId: broker.id, userRole: 'broker', userName: broker.companyName || broker.username, action: 'SHIPPER_CONNECTION_REQUESTED', metadata: { carrierId: carrier.id, truckId: truck.id } }).catch(() => {});
    if (shipper) {
      notificationService.notify({ userId: shipper.id, userRole: 'shipper', loadId: load.tokenNo, type: 'SHIPPER_CONNECTION_REQUESTED', title: 'A broker requested a carrier connection', message: `${broker.companyName || broker.username} requested to connect carrier ${carrier.companyName || carrier.username} to your load ${load.tokenNo}.` }).catch(() => {});
      if (shipper.email) {
        emailService.sendShipperConnectionRequestEmail({ to: shipper.email, tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination, carrierCompanyName: carrier.companyName || carrier.username, brokerCompanyName: broker.companyName || broker.username }).catch(() => {});
      }
    }
    notificationService.notify({ userId: carrier.id, userRole: 'carrier', loadId: load.tokenNo, type: 'CARRIER_CONNECTION_REQUESTED', title: 'A broker requested a Shipper connection', message: `${broker.companyName || broker.username} is connecting you with a load (${load.tokenNo}: ${load.pickup} → ${load.destination}).` }).catch(() => {});
    if (carrier.email) {
      emailService.sendCarrierConnectionRequestEmail({ to: carrier.email, carrierName: carrier.companyName || carrier.contactPerson, tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination, shipperCompanyName: load.companyName, brokerCompanyName: broker.companyName || broker.username }).catch(() => {});
    }
    notificationService.notify({ userId: 'admin', userRole: 'admin', loadId: load.tokenNo, type: 'SHIPPER_CONNECTION_REQUESTED', title: 'Broker requested a Shipper connection', message: `${broker.companyName || broker.username} requested to connect ${carrier.companyName || carrier.username} with load ${load.tokenNo}.` }).catch(() => {});

    res.json(connection.toObject());
  } catch (err) {
    console.error('POST /api/broker/connections failed:', err.message);
    res.status(500).json({ error: 'Could not create that connection request right now. Please try again.' });
  }
});

app.get('/api/broker/connections', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const filter = { brokerUsername: broker.username };
    if (req.query.carrierId) filter.carrierId = String(req.query.carrierId);
    if (req.query.status) filter.status = String(req.query.status);
    const rows = await brokerAutomationModels.BrokerConnection.find(filter).sort({ createdAt: -1 }).lean();
    const [loads, bids] = await Promise.all([
      BookingRequest.find({ tokenNo: { $in: rows.map((r) => r.loadId) } }).select('tokenNo pickup destination loadStage biddingDeadline').lean(),
      bidding.Bid.find({ id: { $in: rows.map((r) => r.bidId).filter(Boolean) } }).lean(),
    ]);
    const loadByToken = new Map(loads.map((l) => [l.tokenNo, l]));
    const bidById = new Map(bids.map((b) => [b.id, b]));
    res.json(rows.map((r) => {
      const load = loadByToken.get(r.loadId);
      const bid = r.bidId ? bidById.get(r.bidId) : null;
      return {
        ...r,
        displayStatus: brokerAutomation.resolveConnectionDisplayStatus(r, { load, bid }),
        load: load ? { pickup: load.pickup, destination: load.destination, loadStage: load.loadStage } : null,
        bid: bid ? { id: bid.id, status: bid.status, bidAmount: bid.bidAmount } : null,
      };
    }));
  } catch (err) {
    console.error('GET /api/broker/connections failed:', err.message);
    res.status(500).json({ error: 'Could not load your connections right now. Please try again.' });
  }
});

app.get('/api/broker/connections/:id', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const row = await brokerAutomationModels.BrokerConnection.findOne({ id: req.params.id, brokerUsername: broker.username }).lean();
    if (!row) return res.status(404).json({ error: 'Connection not found.' });
    const [load, bid] = await Promise.all([
      BookingRequest.findOne({ tokenNo: row.loadId }).select('tokenNo pickup destination loadStage biddingDeadline material weight').lean(),
      row.bidId ? bidding.Bid.findOne({ id: row.bidId }).lean() : null,
    ]);
    res.json({ ...row, displayStatus: brokerAutomation.resolveConnectionDisplayStatus(row, { load, bid }), load, bid: bid ? { id: bid.id, status: bid.status, bidAmount: bid.bidAmount, notes: bid.notes } : null });
  } catch (err) {
    console.error('GET /api/broker/connections/:id failed:', err.message);
    res.status(500).json({ error: 'Could not load that connection right now. Please try again.' });
  }
});

// Starts (or, if the prior one was withdrawn, restarts) the actual
// bid/negotiation for an existing connection — reuses the exact same
// placeBrokerBid() logic (and therefore the exact same eligibility,
// duplicate-bid, and KYC rules) as the original Broker Portal's own
// POST /api/broker/bids, just pre-filled from the connection's own
// already-validated truck/load.
app.post('/api/broker/connections/:id/bid', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const connection = await brokerAutomationModels.BrokerConnection.findOne({ id: req.params.id, brokerUsername: broker.username });
    if (!connection) return res.status(404).json({ error: 'Connection not found.' });
    if (['approved', 'rejected', 'cancelled', 'expired'].includes(connection.status)) {
      return res.status(409).json({ error: `This connection is already ${connection.status} — a new bid can't be placed on it.` });
    }
    const load = await BookingRequest.findOne({ tokenNo: connection.loadId });
    if (!load) return res.status(404).json({ error: 'Load not found.' });
    const bidAmount = Number(req.body.bidAmount);
    const { bid } = await placeBrokerBid({ broker, load, truckId: connection.truckId, bidAmount, notes: req.body.notes });
    connection.bidId = bid.id;
    connection.status = 'negotiating';
    connection.statusHistory.push({ status: 'negotiating', at: new Date(), note: `Broker placed an offer of ₹${bidAmount}.` });
    connection.updatedAt = new Date();
    await connection.save();
    const [shipperRec, carrierRec] = await Promise.all([
      connection.shipperUsername ? Registration.findOne({ role: 'shipper', username: connection.shipperUsername }).lean() : null,
      Registration.findOne({ role: 'carrier', id: connection.carrierId }).lean(),
    ]);
    if (shipperRec && shipperRec.email) {
      emailService.sendConnectionStatusChangedEmail({ to: shipperRec.email, toRole: 'shipper', tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination, status: 'negotiating', note: `${connection.brokerCompanyName} placed an offer on behalf of ${connection.carrierCompanyName} for load ${load.tokenNo}.` }).catch(() => {});
    }
    if (carrierRec && carrierRec.email) {
      emailService.sendConnectionStatusChangedEmail({ to: carrierRec.email, toRole: 'carrier', tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination, status: 'negotiating', note: `Your broker placed an offer of ₹${bidAmount} for load ${load.tokenNo}.` }).catch(() => {});
    }
    res.json(connection.toObject());
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('POST /api/broker/connections/:id/bid failed:', err.message);
    res.status(500).json({ error: 'Could not place that offer right now. Please try again.' });
  }
});

// The only status transition a broker may make directly is cancelling their
// own connection request — approval/rejection/expiry are always derived
// from the real shipper accept-bid decision or the real bidding deadline,
// never set directly by the broker (spec: "Actual acceptance, assignment,
// and financial commitments must follow the existing approval and
// permission rules").
app.patch('/api/broker/connections/:id/status', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const requestedStatus = String(req.body.status || '').trim();
    if (requestedStatus !== 'cancelled') {
      return res.status(400).json({ error: 'A broker may only cancel a connection request directly; every other status change follows the shipper\'s own accept/reject decision or the bidding deadline.' });
    }
    const connection = await brokerAutomationModels.BrokerConnection.findOne({ id: req.params.id, brokerUsername: broker.username });
    if (!connection) return res.status(404).json({ error: 'Connection not found.' });
    if (['approved', 'rejected', 'cancelled', 'expired'].includes(connection.status)) {
      return res.status(409).json({ error: `This connection is already ${connection.status}.` });
    }
    if (connection.bidId) {
      const bid = await bidding.Bid.findOne({ id: connection.bidId });
      if (bid && ['SUBMITTED', 'SHORTLISTED'].includes(bid.status)) {
        bid.status = 'WITHDRAWN';
        bid.withdrawnAt = new Date();
        await bid.save();
        await ops.TrackingEvent.create({ tokenNo: bid.loadId, type: 'BID_WITHDRAWN', label: 'Broker Withdrew Bid', createdByRole: 'broker', createdByUsername: broker.username, createdAt: new Date() }).catch(() => {});
      }
    }
    connection.status = 'cancelled';
    connection.statusHistory.push({ status: 'cancelled', at: new Date(), note: String(req.body.note || 'Cancelled by broker.').slice(0, 300) });
    connection.updatedAt = new Date();
    await connection.save();
    res.json(connection.toObject());
  } catch (err) {
    console.error('PATCH /api/broker/connections/:id/status failed:', err.message);
    res.status(500).json({ error: 'Could not update that connection right now. Please try again.' });
  }
});

// ---------- Broker: My Shipments (loads they're attached to) ----------
// "Attached to" means either of the two ways a broker is genuinely tied to
// a real shipment: `brokerUsername` (the broker who actually brokered the
// winning deal — set by the accept-bid transaction/admin assignment) OR
// `postedByBrokerUsername` (a load the broker posted themselves). Scoped
// strictly to the logged-in broker's own username — never another
// broker's shipment data (spec: "Do not expose another broker's private
// shipment data").
const BROKER_SHIPMENT_FILTERS = {
  active: (l) => !['COMPLETED', 'DELIVERED'].includes(l.loadStage) && l.brokerLoadStatus !== 'CANCELLED',
  awaiting_carrier: (l) => ['POSTED', 'MATCHED', 'BIDDING_OPEN'].includes(l.loadStage),
  awaiting_payment: (l) => l.advancePaymentRequired && !l.advancePaymentReceivedAt,
  dispatched: (l) => ['DEPARTED_PICKUP', 'IN_TRANSIT'].includes(l.loadStage),
  in_transit: (l) => l.loadStage === 'IN_TRANSIT',
  delivered: (l) => ['DELIVERED', 'COMPLETED'].includes(l.loadStage),
  pod_pending: (l) => l.podStatus === 'pending' || l.podStatus === 'uploaded',
  completed: (l) => l.loadStage === 'COMPLETED',
  cancelled: (l) => l.brokerLoadStatus === 'CANCELLED',
};
app.get('/api/broker/shipments', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    let loads = await BookingRequest.find({
      $or: [{ brokerUsername: broker.username }, { postedByBrokerUsername: broker.username }],
    }).sort({ createdAt: -1 }).limit(200).lean();

    const filterKey = String(req.query.filter || '').trim();
    if (filterKey && BROKER_SHIPMENT_FILTERS[filterKey]) loads = loads.filter(BROKER_SHIPMENT_FILTERS[filterKey]);

    const truckIds = loads.map((l) => l.assignedTruckId).filter(Boolean);
    const driverIds = loads.map((l) => l.assignedDriverId).filter(Boolean);
    const [trucks, drivers, events] = await Promise.all([
      Truck.find({ id: { $in: truckIds } }).select('id vehicleNumber').lean(),
      Driver.find({ id: { $in: driverIds } }).select('id name').lean(),
      ops.TrackingEvent.find({ tokenNo: { $in: loads.map((l) => l.tokenNo) } }).sort({ createdAt: 1 }).lean(),
    ]);
    const truckById = new Map(trucks.map((t) => [t.id, t]));
    const driverById = new Map(drivers.map((d) => [d.id, d]));
    const eventsByToken = new Map();
    events.forEach((e) => {
      if (!eventsByToken.has(e.tokenNo)) eventsByToken.set(e.tokenNo, []);
      eventsByToken.get(e.tokenNo).push({ at: e.createdAt, label: e.label, type: e.type, location: e.location });
    });

    res.json(loads.map((l) => ({
      tokenNo: l.tokenNo, pickup: l.pickup, destination: l.destination, material: l.material, weight: l.weight,
      shipperCompanyName: l.companyName || '', carrierCompanyName: l.carrierCompanyName || '',
      driverName: l.assignedDriverId && driverById.get(l.assignedDriverId) ? driverById.get(l.assignedDriverId).name : '',
      vehicleNumber: l.assignedTruckId && truckById.get(l.assignedTruckId) ? truckById.get(l.assignedTruckId).vehicleNumber : '',
      loadStage: l.loadStage, loadStageLabel: statusMachine.STAGE_LABELS[l.loadStage] || l.loadStage,
      brokerLoadStatus: l.brokerLoadStatus,
      paymentStatus: l.invoiceVerified ? 'invoiced' : 'pending',
      advancePaymentRequired: !!l.advancePaymentRequired,
      advancePaymentStatus: l.advancePaymentRequired ? (l.advancePaymentReceivedAt ? 'received' : 'pending') : 'not_required',
      trackingStatus: l.tracking?.status || '',
      podStatus: l.podStatus,
      updatedAt: l.tracking?.updatedAt || l.createdAt,
      deliveredAt: l.deliveredAt, completedAt: l.completedAt, delay: l.delay,
      timeline: eventsByToken.get(l.tokenNo) || [],
    })));
  } catch (err) {
    console.error('GET /api/broker/shipments failed:', err.message);
    res.status(500).json({ error: 'Could not load your shipments right now. Please try again.' });
  }
});

// Minimal admin action so "Advance payment received" is a REAL, explicit
// event (never inferred) — the SMS/notification list this Broker Portal
// upgrade adds a trigger for (see smsService.sendAdvancePaymentReceivedSms).
app.patch('/api/admin/loads/:token/advance-payment', requireAdmin, async (req, res) => {
  try {
    const load = await BookingRequest.findOne({ tokenNo: req.params.token });
    if (!load) return res.status(404).json({ error: 'Load not found.' });
    if (load.advancePaymentReceivedAt) return res.status(409).json({ error: 'Advance payment was already marked received for this load.' });
    load.advancePaymentReceivedAt = new Date();
    await load.save();
    logActivity({ loadId: load.tokenNo, userRole: 'admin', action: 'ADVANCE_PAYMENT_RECEIVED', metadata: { amount: req.body && req.body.amount } }).catch(() => {});
    const recipients = [];
    if (load.shipperUsername) recipients.push({ role: 'shipper', username: load.shipperUsername });
    if (load.carrierUsername) recipients.push({ role: 'carrier', username: load.carrierUsername });
    if (load.postedByBrokerUsername) recipients.push({ role: 'broker', username: load.postedByBrokerUsername });
    const users = await Registration.find({ $or: recipients.map((r) => ({ role: r.role, username: r.username })) }).lean();
    users.forEach((u) => {
      notificationService.notify({ userId: u.id, userRole: u.role, loadId: load.tokenNo, type: 'ADVANCE_PAYMENT_RECEIVED', title: 'Advance payment received', message: `Advance payment has been received for load ${load.tokenNo}.` }).catch(() => {});
      if (u.mobileNumber) smsService.sendAdvancePaymentReceivedSms({ to: u.mobileNumber, tokenNo: load.tokenNo, amount: req.body && req.body.amount, userId: u.id, userRole: u.role }).catch(() => {});
    });
    res.json({ ok: true, advancePaymentReceivedAt: load.advancePaymentReceivedAt });
  } catch (err) {
    console.error('PATCH /api/admin/loads/:token/advance-payment failed:', err.message);
    res.status(500).json({ error: 'Could not record the advance payment right now. Please try again.' });
  }
});

// Thin, explicit alias over the existing generic Notification Center API
// (spec section 11's suggested endpoint list) — GET/PUT /api/notifications
// already works for a broker session via resolveNotificationIdentity, this
// just gives it the documented broker-specific URL too.
app.get('/api/broker/notifications', async (req, res) => {
  const session = getBrokerSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
  const [items, unread] = await Promise.all([
    notificationService.listForUser(session.recordId, 'broker'),
    notificationService.unreadCount(session.recordId, 'broker'),
  ]);
  res.json({ notifications: items, unreadCount: unread });
});

// ---------- Broker AI Assistant + AI Document Review ----------
// Tiny in-memory rate limiter (spec section 13 "Rate limiting for AI
// endpoints if supported") — consistent with this project's existing
// in-memory Map pattern (OTP store, sessions) rather than adding a new
// dependency for it.
const aiRateLimitStore = new Map(); // key -> { count, windowStart }
const AI_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const AI_RATE_LIMIT_MAX = 10;
function checkAiRateLimit(key) {
  const now = Date.now();
  const entry = aiRateLimitStore.get(key);
  if (!entry || now - entry.windowStart > AI_RATE_LIMIT_WINDOW_MS) {
    aiRateLimitStore.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= AI_RATE_LIMIT_MAX) return false;
  entry.count += 1;
  return true;
}

// The data-access "repo" the AI tool executor is bound to — every function
// here takes the broker's OWN record (never a client-supplied id) and reads
// only that broker's own data. See lib/brokerAiTools.js for the tool
// definitions + the safety contract these implement.
function buildBrokerAiRepo() {
  return {
    async getProfile(broker) {
      return {
        contactPerson: broker.contactPerson, companyName: broker.companyName, brokerType: broker.brokerType,
        mobileNumber: broker.mobileNumber, email: broker.email, address: broker.address,
        hasGST: !!broker.hasGST, hasMSME: !!broker.hasMSME, kycStatus: broker.kycStatus,
        loadPreferences: broker.loadPreferences || {},
      };
    },
    async getKycStatus(broker) {
      const record = await Registration.findOne({ role: 'broker', id: broker.id }).lean();
      return {
        kycStatus: record.kycStatus, kycRejectionReason: record.kycRejectionReason,
        kycDocumentsRequested: record.kycDocumentsRequested,
        missingDocuments: brokerService.missingKycDocuments(record),
      };
    },
    async getAvailableLoads(broker, filters) {
      const loads = await BookingRequest.find({ loadStage: 'BIDDING_OPEN' }).sort({ biddingOpenedAt: -1 }).limit(30).lean();
      let filtered = loads;
      if (filters.origin) filtered = filtered.filter((l) => (l.pickup || '').toLowerCase().includes(String(filters.origin).toLowerCase()));
      if (filters.destination) filtered = filtered.filter((l) => (l.destination || '').toLowerCase().includes(String(filters.destination).toLowerCase()));
      if (filters.truckType) filtered = filtered.filter((l) => (l.requiredTruckType || '').toLowerCase().includes(String(filters.truckType).toLowerCase()));
      return filtered.slice(0, 15).map((l) => ({ tokenNo: l.tokenNo, pickup: l.pickup, destination: l.destination, material: l.material, weight: l.weight, requiredTruckType: l.requiredTruckType, pickupDateTime: l.pickupDateTime, biddingDeadline: l.biddingDeadline }));
    },
    async getBids(broker, filters) {
      const filter = { submittedByRole: 'broker', brokerUsername: broker.username };
      if (filters.status) filter.status = String(filters.status).toUpperCase();
      const bids = await bidding.Bid.find(filter).sort({ createdAt: -1 }).limit(30).lean();
      return bids.map((b) => ({ id: b.id, loadId: b.loadId, status: b.status, bidAmount: b.bidAmount, createdAt: b.createdAt }));
    },
    async getActiveShipments(broker) {
      const loads = await BookingRequest.find({ brokerUsername: broker.username, loadStage: { $nin: ['COMPLETED'] } }).sort({ createdAt: -1 }).limit(30).lean();
      return loads.map((l) => ({ tokenNo: l.tokenNo, pickup: l.pickup, destination: l.destination, loadStage: l.loadStage, trackingStatus: l.tracking?.status, delayActive: !!(l.delay && l.delay.active) }));
    },
    async getNotifications(broker) {
      const items = await notificationService.listForUser(broker.id, 'broker', { limit: 15 });
      return items.map((n) => ({ title: n.title, message: n.message, read: n.read, createdAt: n.createdAt }));
    },
    async getLoadSummary(broker, tokenNo) {
      const load = await BookingRequest.findOne({ tokenNo }).lean();
      if (!load) return null;
      // Only expose full detail when this broker is actually involved with
      // the load (assigned/bid on it) OR it's a currently open public
      // opportunity — never another party's private booking detail.
      const myBid = await bidding.Bid.findOne({ loadId: tokenNo, submittedByRole: 'broker', brokerUsername: broker.username }).lean();
      const involved = load.brokerUsername === broker.username || !!myBid || load.loadStage === 'BIDDING_OPEN';
      if (!involved) return null;
      return {
        tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination, material: load.material,
        weight: load.weight, loadStage: load.loadStage, trackingStatus: load.tracking?.status,
        requiredTruckType: load.requiredTruckType, biddingDeadline: load.biddingDeadline,
        myBidStatus: myBid ? myBid.status : null,
      };
    },
    async getBidComparison(broker, tokenNo) {
      const load = await BookingRequest.findOne({ tokenNo }).lean();
      if (!load) return null;
      const owns = load.brokerUsername === broker.username || await bidding.Bid.exists({ loadId: tokenNo, submittedByRole: 'broker', brokerUsername: broker.username });
      if (!owns) return null;
      const bids = await bidding.Bid.find({ loadId: tokenNo, status: { $in: ['SUBMITTED', 'SHORTLISTED'] } }).lean();
      if (!bids.length) return { offers: [] };
      const marginConfig = await bidding.getMarginConfig();
      const context = await buildBidRankingContext(bids, marginConfig);
      const ranked = biddingEngine.rankBidsForShipper(load, context);
      // Same privacy rule as the shipper-facing ranked-offers endpoint —
      // never a competitor's raw bid amount or margin, even to a broker.
      return { offers: ranked.map((r) => ({ rank: r.rank, finalShipperPrice: r.finalShipperPrice, aiMatchScore: r.aiMatchScore, trustScore: r.trustScore, truckType: r.truckType, capacityTons: r.capacityTons })) };
    },
  };
}

// Cheap, unauthenticated-rate-limit-free check so the frontend can learn
// "is AI even configured" ONCE per page load and show one clear banner
// immediately — never by hitting /ai/chat repeatedly and burning through
// the rate limit just to find out the answer is always going to be 503.
app.get('/api/broker/ai/status', (req, res) => {
  const session = getBrokerSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
  res.json({ aiConfigured: aiService.isConfigured(), supportedFallbackQuestions: brokerAiFallback.SUPPORTED_QUESTIONS });
});

app.post('/api/broker/ai/chat', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    if (!checkAiRateLimit('broker-chat:' + session.recordId)) {
      return res.status(429).json({ error: 'Too many AI requests — please wait a minute and try again.' });
    }
    const broker = await Registration.findOne({ role: 'broker', id: session.recordId }).lean();
    if (!broker) return res.status(404).json({ error: 'Broker account not found.' });
    const message = String(req.body.message || '').trim().slice(0, 1000);
    if (!message) return res.status(400).json({ error: 'Please type a message.' });
    const history = Array.isArray(req.body.history) ? req.body.history.slice(-10).map((h) => ({ role: h.role, text: String(h.text || '').slice(0, 1000) })) : [];
    const repo = buildBrokerAiRepo();

    // ---------- AI unavailable / AI fails: deterministic fallback ----------
    // Spec section 7: "Automatically switch the assistant's supported
    // questions to deterministic answers where possible" — never repeatedly
    // calling the (known-broken) real AI endpoint again, never a bare 503
    // for a question this app can genuinely answer from real data.
    if (!aiService.isConfigured()) {
      const fallback = await brokerAiFallback.answerDeterministically({ broker, repo, message });
      if (fallback.matched) {
        return res.json({ reply: fallback.reply, aiAvailable: false, source: 'rule-based' });
      }
      return res.json({
        reply: `AI Assistant is currently unavailable. I can still answer these with Smart Rule Matching: ${brokerAiFallback.SUPPORTED_QUESTIONS.join(' / ')}`,
        aiAvailable: false, source: 'rule-based', unsupported: true,
      });
    }

    try {
      const { text, toolCalls } = await brokerAiTools.runBrokerAssistant({ broker, repo, history, message });
      return res.json({ reply: text, toolsUsed: toolCalls.map((t) => t.name), aiAvailable: true, source: 'ai' });
    } catch (aiErr) {
      // A configured provider that still fails mid-request (timeout, 5xx,
      // an invalid/revoked key surfacing only at call time) degrades to the
      // SAME deterministic fallback rather than surfacing a raw error —
      // "Do not repeatedly retry failed 503 requests" applies here too:
      // this is one fallback attempt, not a retry loop.
      if (aiErr instanceof aiService.AiNotConfiguredError) {
        // shouldn't happen given the isConfigured() check above, but handled
        // defensively so this path can never throw past the fallback.
      } else {
        console.error('Broker AI chat: live AI call failed, falling back to rule-based —', aiErr.message);
      }
      const fallback = await brokerAiFallback.answerDeterministically({ broker, repo, message });
      if (fallback.matched) {
        return res.json({ reply: fallback.reply, aiAvailable: false, source: 'rule-based', aiError: true });
      }
      return res.status(aiErr.status || 503).json({
        error: 'The AI assistant is temporarily unavailable and this question needs it. Please try again in a moment, or ask one of the quick options below.',
        aiAvailable: false,
      });
    }
  } catch (err) {
    console.error('POST /api/broker/ai/chat failed:', err.message);
    res.status(err.status || 500).json({ error: 'The AI assistant could not respond right now. Please try again.' });
  }
});

app.post('/api/broker/ai/document-review', async (req, res) => {
  try {
    const session = getBrokerSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in as a broker first.' });
    if (!checkAiRateLimit('broker-doc-review:' + session.recordId)) {
      return res.status(429).json({ error: 'Too many AI requests — please wait a minute and try again.' });
    }
    const record = await Registration.findOne({ role: 'broker', id: session.recordId });
    if (!record) return res.status(404).json({ error: 'Broker account not found.' });
    const documentType = String(req.body.documentType || '').toUpperCase();
    if (!['GST', 'MSME', 'PAN'].includes(documentType)) {
      return res.status(400).json({ error: 'documentType must be GST, MSME, or PAN.' });
    }
    const pathField = { GST: 'gstPhotoPath', MSME: 'msmePhotoPath', PAN: 'panDocumentPath' }[documentType];
    const docPath = record[pathField];
    if (!docPath) return res.status(404).json({ error: `No ${documentType} document on file yet.` });
    await runBrokerDocumentReview(record.id, documentType, docPath);
    const updated = await Registration.findOne({ id: record.id }).lean();
    const result = (updated.aiDocumentReviews || []).find((r) => r.documentType === documentType);
    res.json({ ok: true, result: result || null });
  } catch (err) {
    console.error('POST /api/broker/ai/document-review failed:', err.message);
    res.status(500).json({ error: 'Could not run the document review right now. Please try again.' });
  }
});

// =====================================================================
// ---------- Admin: Broker management ----------
// =====================================================================
app.get('/api/admin/brokers', requireAdmin, async (req, res) => {
  try {
    const filter = { role: 'broker' };
    if (req.query.kycStatus) filter.kycStatus = req.query.kycStatus;
    let records = await Registration.find(filter).sort({ submittedAt: -1 }).lean();
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q) {
      records = records.filter((r) => [r.username, r.companyName, r.contactPerson, r.email, r.mobileNumber, r.gstNumber, r.msmeNumber]
        .some((v) => v && String(v).toLowerCase().includes(q)));
    }
    res.json(records.map(brokerRecordSafe));
  } catch (err) {
    console.error('GET /api/admin/brokers failed:', err.message);
    res.status(500).json({ error: 'Could not load brokers right now. Please try again.' });
  }
});

app.get('/api/admin/brokers/:id', requireAdmin, async (req, res) => {
  try {
    const record = await Registration.findOne({ id: req.params.id, role: 'broker' }).lean();
    if (!record) return res.status(404).json({ error: 'Broker not found.' });
    const dashboard = await computeBrokerDashboard(record);
    res.json({ ...brokerRecordSafe(record), dashboard });
  } catch (err) {
    console.error('GET /api/admin/brokers/:id failed:', err.message);
    res.status(500).json({ error: 'Could not load that broker right now. Please try again.' });
  }
});

app.patch('/api/admin/brokers/:id/kyc-status', requireAdmin, async (req, res) => {
  try {
    const { status, reason } = req.body || {};
    if (!brokerService.KYC_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${brokerService.KYC_STATUSES.join(', ')}.` });
    }
    if (status === 'REJECTED' && !String(reason || '').trim()) {
      return res.status(400).json({ error: 'A rejection reason is required.' });
    }
    const rec = await Registration.findOne({ id: req.params.id, role: 'broker' });
    if (!rec) return res.status(404).json({ error: 'Broker not found.' });
    const previousStatus = rec.kycStatus;
    if (previousStatus === status) {
      // No-op change — respond OK but skip re-notifying (spec: "Do not send
      // duplicate notifications").
      return res.json({ id: rec.id, kycStatus: rec.kycStatus, unchanged: true });
    }
    rec.kycStatus = status;
    rec.kycRejectionReason = status === 'REJECTED' ? String(reason).trim() : '';
    rec.kycReviewedAt = new Date();
    // Keep the legacy `status` field in sync so every existing screen that
    // reads it (admin's original accept/reject table, etc.) shows the same
    // outcome.
    rec.status = brokerService.kycStatusToAccountStatus(status);
    rec.rejectionReason = status === 'REJECTED' ? String(reason).trim() : '';
    await rec.save();

    logActivity({ userId: req.adminId || '', userRole: 'admin', userName: rec.companyName || rec.contactPerson || rec.username, action: 'BROKER_KYC_STATUS_CHANGED', oldStatus: previousStatus, newStatus: status, metadata: { brokerId: rec.id } }).catch(() => {});
    const titleByStatus = {
      APPROVED: 'Your KYC has been approved!', REJECTED: 'Your KYC was rejected',
      PENDING_REVIEW: 'Your KYC is under review', SUBMITTED: 'Your KYC was received',
    };
    const messageByStatus = {
      APPROVED: 'Your broker account is fully verified. You can now submit bids on available loads.',
      REJECTED: `Your KYC was rejected: ${rec.kycRejectionReason}`,
      PENDING_REVIEW: 'Admin is reviewing your documents.',
      SUBMITTED: 'Your KYC documents were received.',
    };
    notificationService.notify({
      userId: rec.id, userRole: 'broker', type: 'BROKER_KYC_STATUS_CHANGED',
      title: titleByStatus[status] || 'KYC status updated', message: messageByStatus[status] || `Your KYC status is now ${status}.`,
    }).catch(() => {});
    if (rec.email) {
      emailService.sendBrokerKycStatusEmail({
        to: rec.email, brokerName: rec.companyName || rec.contactPerson || rec.username,
        kycStatus: status, reason: rec.kycRejectionReason,
      }).catch((err) => console.error('sendBrokerKycStatusEmail failed:', err.message));
    }
    res.json({ id: rec.id, kycStatus: rec.kycStatus, status: rec.status });
  } catch (err) {
    console.error('PATCH /api/admin/brokers/:id/kyc-status failed:', err.message);
    res.status(500).json({ error: 'Could not update KYC status right now. Please try again.' });
  }
});

app.post('/api/admin/brokers/:id/request-documents', requireAdmin, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!String(message || '').trim()) return res.status(400).json({ error: 'Please describe what documents are needed.' });
    const rec = await Registration.findOne({ id: req.params.id, role: 'broker' });
    if (!rec) return res.status(404).json({ error: 'Broker not found.' });
    const trimmed = String(message).trim().slice(0, 500);
    if (rec.kycDocumentsRequested === trimmed) {
      // Same request already on file — skip the duplicate notification.
      return res.json({ ok: true, unchanged: true });
    }
    rec.kycDocumentsRequested = trimmed;
    rec.kycStatus = rec.kycStatus === 'APPROVED' ? rec.kycStatus : 'PENDING_REVIEW';
    rec.status = brokerService.kycStatusToAccountStatus(rec.kycStatus);
    await rec.save();
    logActivity({ userId: req.adminId || '', userRole: 'admin', action: 'BROKER_DOCUMENTS_REQUESTED', metadata: { brokerId: rec.id, message: trimmed } }).catch(() => {});
    notificationService.notify({ userId: rec.id, userRole: 'broker', type: 'DOCUMENTS_REQUESTED', title: 'Admin requested more documents', message: trimmed }).catch(() => {});
    if (rec.email) {
      emailService.sendBrokerDocumentsRequestedEmail({
        to: rec.email, brokerName: rec.companyName || rec.contactPerson || rec.username, message: trimmed,
      }).catch((err) => console.error('sendBrokerDocumentsRequestedEmail failed:', err.message));
    }
    if (rec.mobileNumber) {
      smsService.sendAdminRequestedDocumentsSms({ to: rec.mobileNumber, docs: trimmed, userId: rec.id, userRole: 'broker' }).catch(() => {});
    }
    res.json({ ok: true, kycStatus: rec.kycStatus });
  } catch (err) {
    console.error('POST /api/admin/brokers/:id/request-documents failed:', err.message);
    res.status(500).json({ error: 'Could not send that request right now. Please try again.' });
  }
});

// Admin document viewer, by the same short document ids the broker's own
// GET /api/broker/documents/:id uses — still requires an admin session, and
// still only ever redirects to the same protected /admin/kyc-photo route.
app.get('/api/admin/brokers/:id/documents/:documentId', requireAdmin, async (req, res) => {
  const record = await Registration.findOne({ id: req.params.id, role: 'broker' }).lean();
  if (!record) return res.status(404).json({ error: 'Broker not found.' });
  const field = BROKER_DOCUMENT_FIELD_MAP[String(req.params.documentId || '').toLowerCase()];
  if (!field || !record[field]) return res.status(404).json({ error: 'Document not found.' });
  res.json({ documentType: req.params.documentId, path: record[field] });
});

// ---------- Page route: Broker Dashboard ----------
// Broker functionality is always on — Settings.brokerVisible only ever
// controls a purely cosmetic front-page toggle (see the removed hero-card
// hiding logic in public/index.js) and must never gate a real broker route.
app.get('/broker-dashboard', async (req, res) => {
  res.sendFile(path.join(PORTAL_VIEWS_DIR, 'broker-dashboard.html'));
});

// ---------- Page routes ----------

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/register/shipper', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'register', 'shipper.html'));
});

app.get('/register/broker', async (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'register', 'broker.html'));
});

app.get('/register/carrier', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'register', 'carrier.html'));
});

// ---------- Form submission routes ----------

app.post('/register/shipper', async (req, res) => {
  const b = req.body;
  const fullPhone = normalizePhone(b.countryCode, b.phoneNumber);
  if (!isValidPhoneForCountry(b.countryCode, b.phoneNumber)) {
    return res.status(400).json({ error: 'invalid_phone' });
  }
  // Aadhaar is never collected from Shippers — PAN is the sole, mandatory
  // identity document for this role. (Aadhaar is still collected
  // elsewhere in the app, but only for a Carrier's DRIVER — never for the
  // Shipper or the Carrier company account itself.)
  if (!isValidPAN(b.panNumber)) {
    return res.status(400).json({ error: 'invalid_pan' });
  }
  if (b.gstNumber && !isValidGST(b.gstNumber)) {
    return res.status(400).json({ error: 'invalid_gst' });
  }
  if (!isValidPassword(b.password)) {
    return res.status(400).json({ error: 'invalid_password' });
  }
  if (!isEmailVerified(b.emailVerifyToken, b.email)) {
    return res.status(400).json({ error: 'email_not_verified' });
  }
  // "One account per email" — checked again here (in addition to the
  // earlier, friendlier pre-check in /api/email-otp/send) so this is
  // actually enforced at the moment the account is created, not just at
  // OTP-request time.
  if (await isEmailAlreadyRegistered(b.email)) {
    return res.status(409).json({ error: 'email_registered' });
  }
  if (!isValidUsername(b.username)) {
    return res.status(400).json({ error: 'invalid_username' });
  }
  if (await isUsernameTaken(b.username)) {
    return res.status(409).json({ error: 'username_taken' });
  }
  // Office Photo is the Shipper's one mandatory location photo — replaces
  // the old Selfie/face-photo requirement entirely. Must be an actual
  // image file (enforced at upload time in /api/kyc/upload's
  // PHOTO_ONLY_TYPES, which never allows a PDF for this type).
  if (!b.officePhotoPath) {
    return res.status(400).json({ error: 'office_photo_required' });
  }
  // Shippers are never asked for bank details at all — unlike Carrier and
  // Broker (where bank details fund payouts/settlements), a Shipper never
  // receives money through this platform, so there's nothing to validate
  // or collect here. validateBankDetails() is intentionally NOT called.
  const chosenUsername = String(b.username).trim();
  const payload = {
    ...b,
    phoneNumber: fullPhone,
    gstNumber: normalizeGST(b.gstNumber),
    panVerified: isValidPAN(b.panNumber),
    gstVerified: isValidGST(b.gstNumber),
    emailVerified: true,
  };
  // GST Certificate vs MSME Certificate is an either/or choice — the
  // frontend only ever shows one upload widget at a time based on which
  // the shipper picked, but enforce it server-side too rather than trust
  // that alone.
  if (payload.gstPhotoPath && payload.msmePhotoPath) {
    payload.msmePhotoPath = '';
  }
  delete payload.countryCode;
  delete payload.emailVerifyToken;
  delete payload.username; // pulled out separately as chosenUsername above
  // Defense in depth: Aadhaar fields are no longer present anywhere in the
  // Shipper registration form, but strip them here too in case anything
  // upstream (an old cached page, a direct API call) still sends them.
  delete payload.aadharNumber;
  delete payload.aadharVerified;
  delete payload.aadharFrontPhotoPath;
  delete payload.aadharBackPhotoPath;
  // Defense in depth: the old Selfie/face-photo field is no longer part of
  // the Shipper form either (replaced by officePhotoPath above) — strip it
  // in case anything upstream still sends it.
  delete payload.facePhotoPath;
  // Defense in depth: bank fields are no longer part of the Shipper form —
  // strip them here too in case anything upstream still sends them, so a
  // Shipper account can never end up with bank data on file.
  delete payload.bankAccountHolder;
  delete payload.bankAccountNumber;
  delete payload.bankIfsc;
  delete payload.bankName;
  delete payload.bankBranch;
  delete payload.bankAccountType;
  delete payload.bankProofPhotoPath;
  delete payload.bankVerificationStatus;
  delete payload.bankRejectionReason;
  try {
    const { id, username } = await saveSubmission('shipper', payload, { username: chosenUsername });
    sendRegistrationConfirmationEmail(b.email, { username, role: 'shipper' })
      .catch((err) => console.error('sendRegistrationConfirmationEmail error:', err.message));
    res.json({ ok: true, redirectTo: `/success.html?type=Shipper&id=${id}&username=${username}` });
  } catch (err) {
    if (err.code === 'username_taken') {
      return res.status(409).json({ error: 'username_taken' });
    }
    console.error('POST /register/shipper failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---------- Broker registration (Complete Broker Portal spec) ----------
// GST and MSME are each INDEPENDENTLY OPTIONAL — a broker is never rejected
// merely for not having one (or either). PAN is the one mandatory identity
// document, since a broker with neither GST nor MSME would otherwise have
// no verifiable business document on file at all. Bank details stay
// mandatory, unchanged from before (the existing Admin Bank KYC
// verification screen already depends on every Broker record having them).
// All conditional-validation logic lives in lib/brokerService.js so it's
// unit-testable without spinning up this whole server (see
// test/brokerValidation.test.js).
app.post('/register/broker', async (req, res) => {
  const b = req.body || {};

  if (!isValidPassword(b.password)) {
    return res.status(400).json({ error: 'invalid_password' });
  }
  if (!isEmailVerified(b.emailVerifyToken, b.email)) {
    return res.status(400).json({ error: 'email_not_verified' });
  }
  if (await isEmailAlreadyRegistered(b.email)) {
    return res.status(409).json({ error: 'email_registered' });
  }
  if (!isValidUsername(b.username)) {
    return res.status(400).json({ error: 'invalid_username' });
  }
  if (await isUsernameTaken(b.username)) {
    return res.status(409).json({ error: 'username_taken' });
  }

  const address = {
    addressLine: String((b.address && b.address.addressLine) || b.addressLine || '').trim(),
    city: String((b.address && b.address.city) || b.city || '').trim(),
    state: String((b.address && b.address.state) || b.state || '').trim(),
    pincode: String((b.address && b.address.pincode) || b.pincode || '').trim(),
  };
  const hasGST = b.hasGST === true || b.hasGST === 'true';
  const hasMSME = b.hasMSME === true || b.hasMSME === 'true';
  const validation = brokerService.validateBrokerRegistration({ ...b, address, hasGST, hasMSME });
  if (!validation.valid) {
    // First error's machine-readable `code` mirrors this route's existing
    // ?error=<code> convention so the frontend's error-message map keeps
    // working unchanged; `errors` (the full list) is included too so the
    // form can highlight every invalid field at once, not just the first.
    return res.status(400).json({ error: validation.errors[0].code, errors: validation.errors });
  }

  const chosenUsername = String(b.username).trim();
  const payload = {
    contactPerson: String(b.contactPerson || b.fullName || '').trim(),
    mobileNumber: String(b.mobileNumber || '').trim(),
    brokerType: String(b.brokerType || '').trim().toLowerCase(),
    companyName: String(b.brokerType || '').toLowerCase() === 'company' ? String(b.companyName || '').trim() : '',
    address,
    hasGST,
    gstNumber: hasGST ? brokerService.normalizeGST(b.gstNumber) : '',
    gstVerified: hasGST ? brokerService.isValidGST(b.gstNumber) : false,
    gstPhotoPath: hasGST ? String(b.gstDocumentPath || b.gstPhotoPath || '') : '',
    hasMSME,
    msmeNumber: hasMSME ? String(b.msmeNumber || '').trim() : '',
    msmePhotoPath: hasMSME ? String(b.msmeDocumentPath || b.msmePhotoPath || '') : '',
    panNumber: String(b.panNumber || '').trim().toUpperCase(),
    panVerified: brokerService.isValidPAN(b.panNumber),
    panDocumentPath: String(b.panDocumentPath || ''),
    addressProofPath: String(b.addressProofPath || ''),
    profilePhotoPath: String(b.profilePhotoPath || ''),
    // Kept for backward compatibility with the pre-existing Broker form
    // field (now optional) — never blocks registration either way.
    loadingSlipPath: String(b.loadingSlipPath || ''),
    licenseNumber: String(b.licenseNumber || ''),
    bankAccountHolder: String(b.bankAccountHolder || '').trim(),
    bankAccountNumber: String(b.bankAccountNumber || '').trim(),
    bankIfsc: String(b.bankIfsc || '').trim().toUpperCase(),
    bankName: String(b.bankName || '').trim(),
    bankBranch: String(b.bankBranch || '').trim(),
    bankAccountType: b.bankAccountType,
    bankProofPhotoPath: String(b.bankProofPhotoPath || ''),
    emailVerified: true,
    email: b.email,
    password: b.password,
    // Registration is only reachable once every mandatory document is
    // already on file (validateBrokerRegistration above), so it starts
    // life already SUBMITTED — an admin still has to move it to APPROVED.
    kycStatus: 'SUBMITTED',
    kycSubmittedAt: new Date(),
  };
  try {
    const { id, username } = await saveSubmission('broker', payload, { username: chosenUsername });
    sendRegistrationConfirmationEmail(b.email, { username, role: 'broker' })
      .catch((err) => console.error('sendRegistrationConfirmationEmail error:', err.message));
    logActivity({ userId: id, userRole: 'broker', userName: payload.companyName || payload.contactPerson || username, action: 'BROKER_REGISTERED', newStatus: 'SUBMITTED' }).catch(() => {});
    // Advisory AI document review (spec section 9) — fire-and-forget, never
    // blocks or fails the registration response either way.
    if (hasGST && payload.gstPhotoPath) {
      runBrokerDocumentReview(id, 'GST', payload.gstPhotoPath).catch((err) => console.error('Broker GST AI review failed:', err.message));
    }
    if (hasMSME && payload.msmePhotoPath) {
      runBrokerDocumentReview(id, 'MSME', payload.msmePhotoPath).catch((err) => console.error('Broker MSME AI review failed:', err.message));
    }
    if (payload.panDocumentPath) {
      runBrokerDocumentReview(id, 'PAN', payload.panDocumentPath).catch((err) => console.error('Broker PAN AI review failed:', err.message));
    }
    res.json({ ok: true, redirectTo: `/success.html?type=Broker&id=${id}&username=${username}` });
  } catch (err) {
    if (err.code === 'username_taken') {
      return res.status(409).json({ error: 'username_taken' });
    }
    console.error('POST /register/broker failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---------- Broker AI document review: run + persist onto the record ----------
// Looks up the stored file (disk, falling back to the durable Mongo copy —
// same lookup every other protected document route already uses), runs the
// advisory-only vision check, and upserts the result into
// aiDocumentReviews[] (by documentType) + recomputes the aiKycReview
// rollup. Never throws — a failure here must never block registration, a
// document re-upload, or an admin's review screen.
async function runBrokerDocumentReview(registrationId, documentType, documentPath) {
  try {
    const doc = await readStoredDocBytes(documentPath);
    if (!doc || !/^image\/(png|jpeg)$/.test(doc.mimeType)) return; // PDFs: skip silently, same as brokerDocReview's own guard
    const imageBase64DataUrl = `data:${doc.mimeType};base64,${doc.buffer.toString('base64')}`;
    const result = await brokerDocReview.reviewBrokerDocument({ documentType, imageBase64DataUrl });

    const rec = await Registration.findOne({ id: registrationId, role: 'broker' });
    if (!rec) return;
    const existing = (rec.aiDocumentReviews || []).filter((r) => r.documentType !== documentType);
    const updated = [...existing, result];
    rec.aiDocumentReviews = updated;
    const confidences = updated.map((r) => Number(r.confidence) || 0);
    rec.aiKycReview = {
      status: 'reviewed',
      confidence: confidences.length ? Math.round((confidences.reduce((a, c) => a + c, 0) / confidences.length) * 100) / 100 : 0,
      summary: updated.map((r) => `${r.documentType}: ${r.summary}`).join(' '),
      concerns: updated.flatMap((r) => r.concerns || []),
      reviewedAt: new Date(),
    };
    await rec.save();
  } catch (err) {
    console.error('runBrokerDocumentReview failed for', registrationId, documentType, '—', err.message);
  }
}

app.post('/register/carrier', async (req, res) => {
  const b = req.body;
  // Business registration is either/or between GST and MSME — the Carrier
  // must provide at least one, complete with its number AND its scanned
  // document, but never both are required. Whichever `businessDocType`
  // the frontend radio was set to tells us which one to validate.
  const businessDocType = String(b.businessDocType || '').trim().toLowerCase();
  if (businessDocType !== 'gst' && businessDocType !== 'msme') {
    return res.status(400).json({ error: 'business_doc_type_required' });
  }
  if (businessDocType === 'gst') {
    if (!isValidGST(b.gstNumber)) {
      return res.status(400).json({ error: 'invalid_gst' });
    }
    if (!b.gstPhotoPath) {
      return res.status(400).json({ error: 'gst_doc_required' });
    }
  } else {
    if (!isValidMsme(b.msmeNumber)) {
      return res.status(400).json({ error: 'invalid_msme' });
    }
    if (!b.msmePhotoPath) {
      return res.status(400).json({ error: 'msme_doc_required' });
    }
  }
  if (!isValidPassword(b.password)) {
    return res.status(400).json({ error: 'invalid_password' });
  }
  // Same email-OTP verification required of every other account
  // (Shipper's is the original implementation — see /api/email-otp/send +
  // /api/email-otp/verify above). The OTP is always sent to, and verified
  // against, the exact email the Carrier typed into this form — there is
  // no other way to obtain a valid emailVerifyToken for a given address.
  if (!isEmailVerified(b.emailVerifyToken, b.email)) {
    return res.status(400).json({ error: 'email_not_verified' });
  }
  // "One account per email" — checked again here (in addition to the
  // earlier, friendlier pre-check in /api/email-otp/send) so this is
  // actually enforced at the moment the account is created, not just at
  // OTP-request time.
  if (await isEmailAlreadyRegistered(b.email)) {
    return res.status(409).json({ error: 'email_registered' });
  }
  if (!isValidUsername(b.username)) {
    return res.status(400).json({ error: 'invalid_username' });
  }
  if (await isUsernameTaken(b.username)) {
    return res.status(409).json({ error: 'username_taken' });
  }
  // Aadhaar is requested ONLY for the DRIVER here — the carrier/company
  // account itself has no Aadhaar requirement at all (its identity is
  // covered by GST/business details, same as every other role). The
  // driver is an individual person operating the truck, so their Aadhaar
  // — both the number AND a scanned photo of the card — is what's
  // actually collected and verified.
  if (!isValidAadhaarFormat(b.driverAadharNumber)) {
    return res.status(400).json({ error: 'invalid_driver_aadhaar' });
  }
  if (!b.driverAadharFrontPhotoPath || !b.driverAadharBackPhotoPath) {
    return res.status(400).json({ error: 'driver_aadhaar_doc_required' });
  }
  // Loading Slip is a mandatory document for Carrier registration.
  if (!b.loadingSlipPath) {
    return res.status(400).json({ error: 'loading_slip_required' });
  }
  const bankError = validateBankDetails(b);
  if (bankError) {
    return res.status(400).json({ error: bankError });
  }
  const chosenUsername = String(b.username).trim();
  const payload = { ...b, emailVerified: true, gstVerified: businessDocType === 'gst' ? isValidGST(b.gstNumber) : false };
  // Whichever of GST/MSME wasn't the chosen type shouldn't be saved with a
  // stray value/document left over from switching the radio before submit
  // — enforce the either/or server-side too, not just trust the frontend.
  if (businessDocType === 'gst') {
    payload.gstNumber = normalizeGST(b.gstNumber);
    payload.msmeNumber = '';
    payload.msmePhotoPath = '';
  } else {
    payload.msmeNumber = String(b.msmeNumber || '').trim();
    payload.gstNumber = '';
    payload.gstPhotoPath = '';
  }
  delete payload.emailVerifyToken;
  delete payload.username; // pulled out separately as chosenUsername above
  try {
    const { id, username } = await saveSubmission('carrier', payload, { username: chosenUsername });
    sendRegistrationConfirmationEmail(b.email, { username, role: 'carrier' })
      .catch((err) => console.error('sendRegistrationConfirmationEmail error:', err.message));
    res.json({ ok: true, redirectTo: `/success.html?type=Carrier&id=${id}&username=${username}` });
  } catch (err) {
    if (err.code === 'username_taken') {
      return res.status(409).json({ error: 'username_taken' });
    }
    console.error('POST /register/carrier failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---------- Simple admin/read-back API ----------
// GET /api/registrations/:role  -> view all submissions for a role as JSON
// Protected: only usable by a logged-in admin (the admin pages fetch this via cookie auth).
// Lightweight "am I still logged in" check for the admin pages' client-side
// session guard (the pages themselves are served openly — see the note
// above requireAdmin — so this is what actually confirms the token in
// sessionStorage is still valid before showing any admin content).
app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ adminId: req.adminId });
});

app.get('/api/registrations/:role', requireAdmin, async (req, res) => {
  const role = req.params.role;
  const allowed = ['shipper', 'broker', 'carrier'];
  if (!allowed.includes(role)) {
    return res.status(404).json({ error: 'Unknown role. Use shipper, broker, or carrier.' });
  }
  const records = await getRecords(role);
  res.json(records);
});

// Toggle a single registration's active/inactive status.
app.post('/api/registrations/:role/:id/toggle', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const rec = await Registration.findOne({ id });
  if (!rec) return res.status(404).json({ error: 'Not found' });
  rec.active = !rec.active;
  await rec.save();
  res.json({ id: rec.id, active: rec.active });
});

// Admin Lock/Unlock Update control (Shipper Portal — Update Profile Button
// spec): toggles whether this shipper is allowed to self-update their
// account details. Enforced server-side in POST /api/shipper/update-profile
// below — this is the actual security boundary, not just a UI switch.
app.post('/api/registrations/:role/:id/update-lock', requireAdmin, async (req, res) => {
  const { role, id } = req.params;
  const { locked } = req.body;
  if (typeof locked !== 'boolean') {
    return res.status(400).json({ error: '"locked" must be true or false.' });
  }
  const rec = await Registration.findOne({ role, id });
  if (!rec) return res.status(404).json({ error: 'Not found' });
  rec.updateLocked = locked;
  await rec.save();
  res.json({ id: rec.id, updateLocked: rec.updateLocked });
});

// Admin reviews the bank details against the uploaded proof document —
// works for any role, since Bank Details + Bank KYC is collected
// identically at registration for Shipper/Broker/Carrier. Moves the
// status from "pending" to either "verified" or "rejected" (with a
// mandatory reason, same pattern as the existing KYC/account rejection
// flows elsewhere in the app).
app.post('/api/registrations/:role/:id/bank-verify', requireAdmin, async (req, res) => {
  try {
    const { role, id } = req.params;
    const { status, reason } = req.body;
    if (!['verified', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Status must be verified, rejected, or pending.' });
    }
    if (status === 'rejected' && !String(reason || '').trim()) {
      return res.status(400).json({ error: 'Please provide a reason for rejecting the bank details.' });
    }
    const rec = await Registration.findOne({ role, id });
    if (!rec) return res.status(404).json({ error: 'Not found' });
    if (!rec.bankProofPhotoPath) {
      return res.status(400).json({ error: 'No bank proof document on file to verify.' });
    }
    rec.bankVerificationStatus = status;
    rec.bankRejectionReason = status === 'rejected' ? String(reason).trim() : '';
    await rec.save();
    res.json({ id: rec.id, bankVerificationStatus: rec.bankVerificationStatus, bankRejectionReason: rec.bankRejectionReason });
  } catch (err) {
    console.error('POST /api/registrations/:role/:id/bank-verify failed:', err.message);
    res.status(500).json({ error: 'Could not update bank verification right now. Please try again.' });
  }
});

// Admin KYC/approval decision — accepted / rejected / pending.
// Shown back to the account holder on their own portal page via /api/me.
app.post('/api/registrations/:role/:id/status', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status, reason } = req.body;
  if (!['pending', 'accepted', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status must be pending, accepted, or rejected.' });
  }
  // A rejection reason is mandatory whenever an admin rejects an account —
  // it's shown back to the account holder on their portal page.
  if (status === 'rejected' && !String(reason || '').trim()) {
    return res.status(400).json({ error: 'A rejection reason is required.' });
  }
  const rec = await Registration.findOne({ id });
  if (!rec) return res.status(404).json({ error: 'Not found' });
  rec.status = status;
  rec.rejectionReason = status === 'rejected' ? String(reason).trim() : '';
  // Broker module addition: this generic endpoint predates the richer
  // kycStatus workflow (see /api/admin/brokers/:id/kyc-status below) — keep
  // the two in sync for broker records so using either admin screen can
  // never leave them disagreeing.
  if (rec.role === 'broker') {
    rec.kycStatus = brokerService.accountStatusToKycStatus(status);
    rec.kycRejectionReason = status === 'rejected' ? String(reason).trim() : '';
    rec.kycReviewedAt = new Date();
  }
  await rec.save();
  res.json({ id: rec.id, status: rec.status, rejectionReason: rec.rejectionReason });
});

// Public endpoint — only active records, used by the front page.
// Broker records are always included, same as every other role — this must
// never be gated behind the cosmetic Settings.brokerVisible toggle.
app.get('/api/public/:role(shipper|broker|carrier)', async (req, res) => {
  const role = req.params.role;
  const records = await Registration.find({ role, active: { $ne: false } }).lean();
  res.json(records);
});

// Site-wide settings (currently just the broker visibility master switch).
app.get('/api/settings', requireAdmin, async (req, res) => {
  const settings = await getSettings();
  res.json(settings);
});

// Public (no login) version — only exposes brokerVisible, used by the front page nav.
app.get('/api/settings/public', async (req, res) => {
  const settings = await getSettings();
  res.json({ brokerVisible: settings.brokerVisible });
});

app.post('/api/settings/toggle-broker', requireAdmin, async (req, res) => {
  const settings = await getSettings();
  settings.brokerVisible = !settings.brokerVisible;
  await settings.save();
  res.json(settings);
});

// ---------- User Complaints (Services > Complaint) ----------
// Public endpoint — anyone can submit, logged in or not. If a valid session
// is present, username/userType are taken from THAT session (never from
// the request body), so a logged-in person can't spoof someone else's
// username, and doesn't have to retype info the system already has.
app.post('/api/complaints', async (req, res) => {
  const { message } = req.body || {};
  let { email } = req.body || {};
  email = String(email || '').trim().toLowerCase();
  if (!String(message || '').trim()) {
    return res.status(400).json({ error: 'Please describe the problem you\'re facing.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  const session = getAnyUserSession(req);
  let username = '';
  let userType = 'new';
  if (session) {
    const record = await Registration.findOne({ role: session.role, id: session.recordId }).lean();
    username = (record && record.username) || '';
    userType = 'existing';
  }

  const id = `CMP-${Date.now()}`;
  await Complaint.create({
    id, username, userType, email, message: String(message).trim(),
  });
  res.json({ ok: true, id });
});

// Admin-only — lists every submitted complaint for the User Complaints screen.
app.get('/api/complaints', requireAdmin, async (req, res) => {
  const complaints = await Complaint.find().sort({ createdAt: -1 }).lean();
  res.json(complaints);
});

// Admin-only — mark a complaint resolved/open.
app.post('/api/complaints/:id/status', requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['open', 'resolved'].includes(status)) {
    return res.status(400).json({ error: 'Status must be open or resolved.' });
  }
  const rec = await Complaint.findOne({ id: req.params.id });
  if (!rec) return res.status(404).json({ error: 'Not found' });
  rec.status = status;
  await rec.save();
  res.json({ id: rec.id, status: rec.status });
});

// ---------- AI Logistics Chatbot ----------
// Public endpoint — no login required, since the whole point of the
// homepage chatbot is to help a visitor who hasn't registered yet.
//
// This is a small rule-based responder today, but it's written as the
// same request/response CONTRACT a real LLM-backed assistant would use,
// so swapping the body of `resolveChatReply()` for a call to Claude /
// OpenAI / Gemini / a custom logistics model later is a one-function
// change — nothing on the frontend (services/chatService in
// public/assets/site-enhance.js) needs to change at all.
//
//   Request:  { message: string, conversation: [{role, content}, ...] }
//   Response: { message: string, action?: 'TRACK_SHIPMENT'|'OPEN_QUOTE'|
//               'SHOW_SERVICES'|'CONTACT_SUPPORT', payload?: object }
//
// IMPORTANT: if/when a real provider is wired in, its API key must be
// read from process.env (e.g. process.env.ANTHROPIC_API_KEY /
// process.env.OPENAI_API_KEY — see .env.example) and used ONLY in this
// server-side handler. Never send that key to, or read it from, the
// browser.
function resolveChatReply(message) {
  const msg = String(message || '').toLowerCase();
  const trackingMatch = String(message || '').match(/\bLS\d{6,}\b/i);

  if (/track|where.*(shipment|order|package|load)|shipment.*status/.test(msg)) {
    return {
      message: trackingMatch
        ? `I can help you track ${trackingMatch[0].toUpperCase()}. Opening the tracking widget for you now.`
        : "I can help you track a shipment — enter your Token/Consignment number in the tracking box and I'll pull up its live status.",
      action: 'TRACK_SHIPMENT',
      payload: trackingMatch ? { trackingId: trackingMatch[0].toUpperCase() } : {},
    };
  }
  if (/quote|cost|price|how much|charge|rate/.test(msg)) {
    return {
      message: "Freight cost depends on route, cargo type, weight and truck size. I've opened our quote calculator — fill in pickup, destination and cargo details for an instant estimate.",
      action: 'OPEN_QUOTE',
      payload: {},
    };
  }
  if (/deliver|eta|arrive|when will/.test(msg)) {
    return {
      message: 'Delivery estimates depend on your specific shipment. Try the Track Shipment box with your Token/Order number, or use the quote calculator to see estimated transit time for a new booking.',
      action: 'TRACK_SHIPMENT',
      payload: {},
    };
  }
  if (/service|offer|what.*(do you|can you)|full truck|part load|cold chain|warehous/.test(msg)) {
    return {
      message: 'We offer Full Truck Load, Part Load, Express Delivery, Last Mile Delivery, Warehousing, Container Transport and Cold Chain Logistics. Scrolling you to our services now.',
      action: 'SHOW_SERVICES',
      payload: {},
    };
  }
  if (/support|agent|human|talk to (someone|support|a person)|help me|complaint|problem/.test(msg)) {
    return {
      message: "Sure — I've opened our Contact panel with a direct number to the Load Smart team. You can also file a complaint from the Services menu if something went wrong.",
      action: 'CONTACT_SUPPORT',
      payload: {},
    };
  }
  if (/^(hi|hello|hey)\b|good (morning|afternoon|evening)/.test(msg)) {
    return { message: "Hello! I'm the Load Smart logistics assistant. I can help you track a shipment, get a freight quote, check delivery estimates, or connect you with support — what do you need?" };
  }
  return {
    message: 'I can help with tracking a shipment, freight quotes, delivery estimates, our services, or connecting you to support. Try one of the quick options below, or ask me in your own words.',
  };
}

// ---------- Feature 3: real, tool-grounded AI for the public chatbot ----------
// This is the "one-function change" the comment above always promised —
// resolveChatReply() above stays completely unchanged (it's now the
// fail-soft fallback for when AI isn't configured, or the AI call itself
// fails). When aiService.isConfigured(), the public chatbot instead calls a
// real Claude model WITH a tool it can actually invoke against this app's
// real data — grounded the same way resolveAdminChatReply() below is
// grounded against computeLoadMatches(): the model is never allowed to
// invent a shipment's status, it can only report what the tool actually
// returned from the database (same toPublicTrackingSummary() shape and the
// same phone-suffix-match privacy rule as the existing public
// /api/tracking/public/by-phone endpoint — nothing new is exposed).
const CHAT_TOOLS = [{
  name: 'track_shipment',
  description: "Look up a shipment's current live status by its Token/Consignment number (format like LS1234567890) or by the visitor's registered mobile phone number (returns their recent shipments). Use this whenever the visitor asks about tracking, a shipment's status, or where their order is.",
  input_schema: {
    type: 'object',
    properties: {
      tokenNo: { type: 'string', description: 'A Token/Consignment number like LS1234567890, if the visitor gave one.' },
      phone: { type: 'string', description: "The visitor's registered mobile number (any format/spacing), if they gave one instead of a token." },
    },
  },
}];
async function executeChatTool(name, input) {
  if (name !== 'track_shipment') return { error: `Unknown tool "${name}".` };
  if (input && input.tokenNo) {
    const load = await BookingRequest.findOne({ tokenNo: String(input.tokenNo).trim().toUpperCase() }).lean();
    return load ? { found: true, orders: [toPublicTrackingSummary(load)] } : { found: false };
  }
  if (input && input.phone) {
    const digits = String(input.phone).replace(/\D/g, '');
    if (digits.length < 7) return { found: false, error: 'Need at least the last 7 digits of the phone number.' };
    const suffixRe = new RegExp(escapeRegex(digits) + '$');
    const shippers = await Registration.find({ role: 'shipper', phoneNumber: suffixRe }).select('username').lean();
    if (!shippers.length) return { found: false };
    const usernames = shippers.map((s) => s.username);
    const records = await BookingRequest.find({ shipperUsername: { $in: usernames } }).sort({ createdAt: -1 }).limit(10).lean();
    return { found: true, orders: records.map(toPublicTrackingSummary) };
  }
  return { found: false, error: 'Need a Token No. or a phone number to look up.' };
}
async function resolveChatReplyAI(message, conversation) {
  const history = (Array.isArray(conversation) ? conversation : []).slice(-8).map((t) => ({
    role: t && t.role === 'assistant' ? 'assistant' : 'user',
    content: String((t && t.content) || '').slice(0, 1000),
  }));
  const messages = [...history, { role: 'user', content: message }];
  const { text, toolCalls } = await aiService.completeWithTools({
    system: 'You are the Load Smart logistics assistant on the company\'s public homepage, talking to a visitor who may not be registered yet. Load Smart offers Full Truck Load, Part Load, Express Delivery, Last Mile Delivery, Warehousing, Container Transport and Cold Chain Logistics. Be concise (2-4 sentences), friendly, and helpful. Use the track_shipment tool whenever the visitor asks about a shipment, an order, a tracking status, gives a Token No., or gives a phone number to check. Never invent or guess a shipment\'s status — only report exactly what the tool returned, and say plainly if nothing was found. If asked about pricing, explain that cost depends on route/cargo/weight/truck size and suggest the quote calculator. If they want a human, point them to the Contact panel.',
    messages,
    tools: CHAT_TOOLS,
    executeTool: executeChatTool,
    maxTokens: 400,
  });
  const trackCall = toolCalls.find((t) => t.name === 'track_shipment');
  const found = trackCall && trackCall.result && trackCall.result.found && trackCall.result.orders && trackCall.result.orders[0];
  return found
    ? { message: text, action: 'TRACK_SHIPMENT', payload: { trackingId: found.tokenNo } }
    : { message: text || 'I can help with tracking a shipment, freight quotes, delivery estimates, our services, or connecting you to support.' };
}

// ---------- AI Chatbot: Admin Matching integration ----------
// Everything below only runs for a verified ADMIN session — anonymous/
// public callers (the homepage chatbot) never reach this code and keep
// using resolveChatReply() above, completely unchanged.
//
// Architecture boundary (spec): this function EXPLAINS and TRIGGERS
// controlled UI actions on top of the real matching engine/database. It
// NEVER recomputes a match score itself (always calls computeLoadMatches,
// the exact same function the REST endpoints and the background
// auto-match loop use) and NEVER invents a driver/truck/load — every
// fact returned comes from a real query, and "I couldn't find that" is
// the honest answer when a lookup comes back empty. Sensitive actions
// (ASSIGN_DRIVER) only ever return a CONFIRMATION REQUEST — the actual
// mutation happens exclusively through a human clicking Confirm, which
// calls the real POST /api/admin/fleet/loads/:token/assign endpoint
// directly. The AI itself never writes to the database.
const LOAD_TOKEN_RE = /\bLS\d{6,}\b/i;

// Follow-up questions ("why was Raj selected?", "show me other options")
// don't repeat the load's Token No. — scan the conversation history
// (most recent first) for the last one mentioned, so the assistant can
// stay on the same load without the frontend contract needing a new
// field.
function findLoadTokenInConversation(message, conversation) {
  const direct = String(message || '').match(LOAD_TOKEN_RE);
  if (direct) return direct[0].toUpperCase();
  const history = Array.isArray(conversation) ? conversation.slice().reverse() : [];
  for (const turn of history) {
    const m = String((turn && turn.content) || '').match(LOAD_TOKEN_RE);
    if (m) return m[0].toUpperCase();
  }
  return null;
}

function formatMatchLine(c) {
  return `${c.driverName} (${c.vehicleNumber}) — ${c.matchScore}% match, trust score ${c.trustScore}/100`;
}

async function resolveAdminChatReply(message, conversation) {
  const msg = String(message || '').toLowerCase();
  const loadToken = findLoadTokenInConversation(message, conversation);

  // "find the best truck/driver for LD102" / "find a match" / "who's suitable"
  if (/find|best (truck|driver|match)|suitable (truck|driver)/.test(msg)) {
    if (!loadToken) return { message: 'Which load should I find a match for? Give me its Token No. (e.g. LS1234567890).' };
    const load = await BookingRequest.findOne({ tokenNo: loadToken }).lean();
    if (!load) return { message: `I couldn't find a load with Token No. ${loadToken}.` };
    const { eligible, ineligible } = await computeLoadMatches(load);
    if (!eligible.length) {
      return {
        message: `No truck/driver currently meets every requirement for ${loadToken} (checked ${ineligible.length} candidate${ineligible.length === 1 ? '' : 's'}, none eligible). Try again shortly, expand the pickup window, or contact dispatch.`,
        action: 'SHOW_MATCHES',
        payload: { loadId: loadToken, matches: [], ineligible },
      };
    }
    const best = eligible[0];
    return {
      message: `Best match for ${loadToken}: ${formatMatchLine(best)}. ${best.reasons.slice(0, 3).join('; ')}.${eligible.length > 1 ? ` ${eligible.length - 1} other option(s) also qualify — ask me to show other options.` : ''}`,
      action: 'SHOW_MATCHES',
      payload: { loadId: loadToken, matches: eligible, ineligible },
    };
  }

  // "why did you select Raj?" / "explain the match" / "why this driver"
  if (/why|explain|reason/.test(msg) && loadToken) {
    const load = await BookingRequest.findOne({ tokenNo: loadToken }).lean();
    if (!load) return { message: `I couldn't find a load with Token No. ${loadToken}.` };
    const { eligible } = await computeLoadMatches(load);
    const best = eligible[0];
    if (!best) return { message: `No eligible candidate has been found for ${loadToken}, so nothing has been recommended yet.` };
    return {
      message: `${best.driverName} (${best.vehicleNumber}) was recommended for ${loadToken} with a ${best.matchScore}% match score: ${best.reasons.join('; ')}.`,
      action: 'SHOW_MATCHES',
      payload: { loadId: loadToken, matches: eligible },
    };
  }

  // "show me other options" / "other matches" / "alternatives"
  if (/other (option|match|candidate)|alternative/.test(msg) && loadToken) {
    const load = await BookingRequest.findOne({ tokenNo: loadToken }).lean();
    if (!load) return { message: `I couldn't find a load with Token No. ${loadToken}.` };
    const { eligible } = await computeLoadMatches(load);
    const rest = eligible.slice(1);
    if (!rest.length) {
      return { message: `There's only one eligible candidate for ${loadToken} right now.`, action: 'SHOW_MATCHES', payload: { loadId: loadToken, matches: eligible } };
    }
    return {
      message: `Other suitable matches for ${loadToken}: ${rest.map(formatMatchLine).join(' | ')}.`,
      action: 'SHOW_MATCHES',
      payload: { loadId: loadToken, matches: eligible },
    };
  }

  // "assign the best driver to LS..." / "assign Raj to LS..."
  if (/assign/.test(msg) && loadToken) {
    const load = await BookingRequest.findOne({ tokenNo: loadToken }).lean();
    if (!load) return { message: `I couldn't find a load with Token No. ${loadToken}.` };
    if (!['POSTED', 'MATCHED'].includes(load.loadStage)) {
      return { message: `${loadToken} already has a confirmed assignment (currently ${load.loadStage}).` };
    }
    const { eligible } = await computeLoadMatches(load);
    if (!eligible.length) return { message: `There's no eligible truck/driver to assign to ${loadToken} right now.` };
    // A named driver mentioned in the message wins; otherwise default to
    // the top-ranked recommendation.
    let candidate = eligible.find((c) => c.driverName && msg.includes(String(c.driverName).toLowerCase()));
    if (!candidate) candidate = eligible[0];
    return {
      message: `Assign ${candidate.driverName} (${candidate.vehicleNumber}, ${candidate.matchScore}% match) to ${loadToken}? This will reserve the truck immediately — please confirm.`,
      action: 'ASSIGN_DRIVER',
      payload: {
        loadId: loadToken, truckId: candidate.truckId, driverId: candidate.driverId,
        driverName: candidate.driverName, vehicleNumber: candidate.vehicleNumber, matchScore: candidate.matchScore,
        requiresConfirmation: true,
      },
    };
  }

  // "show driver Raj" / "driver profile for D102"
  if (/driver/.test(msg) && !/assign/.test(msg)) {
    const nameMatch = msg.match(/driver\s+([a-z][a-z .]{1,40})/i);
    let driver = null;
    if (nameMatch && nameMatch[1]) {
      driver = await Driver.findOne({ name: new RegExp(escapeRegex(nameMatch[1].trim()), 'i') }).lean();
    }
    if (!driver && loadToken) {
      const load = await BookingRequest.findOne({ tokenNo: loadToken }).lean();
      if (load && load.assignedDriverId) driver = await Driver.findOne({ id: load.assignedDriverId }).lean();
    }
    if (driver) {
      return {
        message: `${driver.name} — Trust Score ${driver.trustScore}/100 (${trustScoreLib.trustLabel(driver.trustScore)}), ${driver.completedTrips || 0} completed trips.`,
        action: 'SHOW_DRIVER',
        payload: { driverId: driver.id },
      };
    }
    return { message: "Which driver? Give me a name, or a load's Token No. and I'll look up its assigned driver." };
  }

  // "show truck for LS..." / "which truck is on LS..."
  if (/truck/.test(msg) && loadToken) {
    const load = await BookingRequest.findOne({ tokenNo: loadToken }).lean();
    const truck = load && load.assignedTruckId ? await Truck.findOne({ id: load.assignedTruckId }).lean() : null;
    if (truck) {
      return {
        message: `${truck.vehicleNumber} — ${truck.truckType}, ${truck.capacityTons}t, currently ${truck.status}.`,
        action: 'SHOW_TRUCK',
        payload: { truckId: truck.id },
      };
    }
    return { message: `${loadToken} doesn't have a truck assigned yet.` };
  }

  // "show LS..." / "open LS..." / "status of LS..."
  if (loadToken && /show|open|details|status/.test(msg)) {
    const load = await BookingRequest.findOne({ tokenNo: loadToken }).lean();
    if (!load) return { message: `I couldn't find a load with Token No. ${loadToken}.` };
    return {
      message: `${loadToken}: ${load.pickup} → ${load.destination}, ${load.weight} ton, currently ${load.loadStage}.`,
      action: 'SHOW_LOAD',
      payload: { loadId: loadToken },
    };
  }

  return null; // no admin-specific intent matched — fall through to the public responder
}

app.post('/api/chat', async (req, res) => {
  const message = String((req.body && req.body.message) || '').slice(0, 1000);
  if (!message.trim()) {
    return res.status(400).json({ error: 'A message is required.' });
  }
  const conversation = Array.isArray(req.body && req.body.conversation) ? req.body.conversation : [];
  // Admin-authenticated callers (the Fleet page's own AI assistant) get
  // the matching-aware resolver above, layered on top of the SAME public
  // /api/chat contract and endpoint — no duplicate route, per the "reuse
  // existing API conventions" requirement. Anonymous/public visitors (the
  // homepage chatbot) never trigger it and keep the original behavior.
  const bearerToken = getBearerToken(req);
  const isAdmin = !!(bearerToken && sessions.has(bearerToken));
  if (isAdmin) {
    try {
      const adminReply = await resolveAdminChatReply(message, conversation);
      if (adminReply) return res.json(adminReply);
    } catch (err) {
      console.error('Admin chat resolver failed:', err.message);
      // fall through to the public responder rather than erroring out
    }
  }
  // Real AI, when configured, replaces only the PUBLIC fallback path above
  // — resolveAdminChatReply() (already real-data-grounded, non-LLM) is
  // untouched. Any failure of the AI call (no key, network error, timeout,
  // provider error) falls straight back to the original rule-based
  // resolveChatReply() rather than ever erroring out to the visitor.
  if (aiService.isConfigured()) {
    try {
      return res.json(await resolveChatReplyAI(message, conversation));
    } catch (err) {
      console.error('AI chat resolver failed, falling back to rule-based replies:', err.message);
    }
  }
  const reply = resolveChatReply(message);
  res.json(reply);
});

// ---------- Footer newsletter signup ----------
// Best-effort — logged server-side so it's a real network round trip
// rather than a client-only fake, but deliberately doesn't add a new
// Mongoose model/collection for a single-field signup list. Wire this up
// to an actual mailing-list provider (Mailchimp/SendGrid/etc.) by
// replacing the console.log below with that provider's API call, again
// keeping any provider API key in process.env server-side only.
app.post('/api/newsletter', (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  console.log(`Newsletter signup: ${email}`);
  res.json({ ok: true });
});

// ---------- User Flow / Cookie Consent tracking ----------
// Public endpoint — anyone can send an event, logged in or not (that's the
// whole point: an anonymous visitor's session and cookie-consent choice
// must be recordable without ever requiring a login). Identity (userId/
// username/userType) is resolved server-side from the Authorization
// header when present — NEVER trusted from the request body, so a client
// can't spoof being a different user.
app.post('/api/track', async (req, res) => {
  const b = req.body || {};
  const sessionId = String(b.sessionId || '').trim();
  const eventType = String(b.eventType || '').trim();
  if (!sessionId || !eventType) {
    return res.status(400).json({ error: 'sessionId and eventType are required.' });
  }

  let userId = '';
  let username = '';
  let userType = 'anonymous';
  const token = getBearerToken(req);
  if (token) {
    const uSession = userSessions.get(token);
    if (uSession) {
      userId = uSession.recordId;
      userType = uSession.role;
      try {
        const record = await Registration.findOne({ role: uSession.role, id: uSession.recordId }).select('username').lean();
        username = (record && record.username) || '';
      } catch (e) { /* best-effort — event is still recorded without a username */ }
    } else if (sessions.has(token)) {
      userType = 'admin';
      username = sessions.get(token);
    }
  }

  try {
    await UserFlow.create({
      sessionId,
      userId, username, userType,
      eventType,
      action: String(b.action || '').slice(0, 100),
      page: String(b.page || '').slice(0, 100),
      route: String(b.route || '').slice(0, 200),
      previousPage: String(b.previousPage || '').slice(0, 100),
      metadata: sanitizeTrackingMetadata(b.metadata),
      // Server-side timestamp, per spec — never trusts a client-supplied time.
      timestamp: new Date(),
    });
    res.json({ ok: true });
  } catch (err) {
    // Tracking must never break the actual site — log server-side and
    // still respond 200 so the frontend doesn't retry-storm or surface an
    // error to the person for a non-essential background call.
    console.error('User-flow tracking write failed:', err.message);
    res.json({ ok: false });
  }
});

// Admin-only — one row per session, summarizing its journey. Built from the
// USER-FLOW collection itself (no separate "sessions" table to keep in
// sync) via aggregation: first/last page, last action, start/last-activity
// timestamps, and a total event count.
app.get('/api/admin/user-flow/sessions', requireAdmin, async (req, res) => {
  const results = await UserFlow.aggregate([
    { $sort: { timestamp: 1 } },
    { $group: {
        _id: '$sessionId',
        username: { $last: '$username' },
        userType: { $last: '$userType' },
        firstPage: { $first: '$page' },
        lastPage: { $last: '$page' },
        lastEventType: { $last: '$eventType' },
        lastAction: { $last: '$action' },
        sessionStart: { $min: '$timestamp' },
        lastActivity: { $max: '$timestamp' },
        eventCount: { $sum: 1 },
        loggedOut: { $max: { $cond: [{ $eq: ['$eventType', 'SESSION_END'] }, 1, 0] } },
      } },
    { $sort: { lastActivity: -1 } },
    { $limit: 300 },
  ]);
  res.json(results.map((s) => ({
    sessionId: s._id,
    username: s.username, userType: s.userType,
    firstPage: s.firstPage, lastPage: s.lastPage,
    lastEventType: s.lastEventType, lastAction: s.lastAction,
    sessionStart: s.sessionStart, lastActivity: s.lastActivity,
    eventCount: s.eventCount, loggedOut: !!s.loggedOut,
  })));
});

// Admin-only — full chronological timeline for one session.
app.get('/api/admin/user-flow/:sessionId', requireAdmin, async (req, res) => {
  const events = await UserFlow.find({ sessionId: req.params.sessionId }).sort({ timestamp: 1 }).lean();
  res.json(events);
});

// ---------- Admin portal ----------

app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'login.html'));
});

app.post('/admin/login', async (req, res) => {
  const { adminId, password } = req.body;
  if (!adminId || !password) {
    return res.status(400).json({ error: 'Please enter both the admin ID and password.' });
  }
  if (!(await isValidAdmin(adminId, password))) {
    return res.status(401).json({ error: 'Incorrect admin ID or password.' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, adminId);
  res.json({ token });
});

// Client calls this (with the Authorization header) when the admin clicks
// Log out — invalidates the token server-side. Clearing the token out of
// this tab's sessionStorage happens on the client right after.
app.post('/admin/logout', (req, res) => {
  const token = getBearerToken(req);
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

app.get('/admin/dashboard', (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'dashboard.html'));
});

// Shared list view for Shipper / Broker / Carrier — role gets injected into the template.
app.get('/admin/:role(shipper|broker|carrier)', (req, res) => {
  const role = req.params.role;
  const titleMap = { shipper: 'Shippers', broker: 'Brokers', carrier: 'Carriers' };
  const template = fs.readFileSync(path.join(VIEWS_DIR, 'list.html'), 'utf-8');
  const rendered = template
    .replace(/{{ROLE_TITLE}}/g, titleMap[role])
    .replace(/{{ROLE}}/g, role);
  res.send(rendered);
});

app.get('/admin/tracking', (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'tracking.html'));
});

app.get('/admin/fleet', (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'fleet.html'));
});

app.get('/admin/rate-requests', (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'rate-requests.html'));
});

app.get('/admin/bidding', (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'bidding.html'));
});

app.get('/admin/margin-settings', (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'margin-settings.html'));
});

app.get('/admin/complaints', (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'complaints.html'));
});

app.get('/admin/email-notifications', (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'email-notifications.html'));
});

app.get('/admin/user-flow', (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'user-flow.html'));
});

app.get('/admin/add-admin', (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'add-admin.html'));
});

app.post('/admin/add-admin', requireAdmin, async (req, res) => {
  const { newAdminId, newAdminPassword } = req.body;
  if (!newAdminId || !newAdminPassword) {
    return res.status(400).json({ error: 'Please fill in both the admin ID and password.' });
  }
  const existing = await Admin.findOne({ id: newAdminId });
  const alreadyExists = newAdminId === SUPER_ADMIN_ID || !!existing;
  if (alreadyExists) {
    return res.status(409).json({ error: 'That admin ID is already in use. Choose a different one.' });
  }
  await Admin.create({
    id: newAdminId,
    password: newAdminPassword,
    createdAt: new Date(),
    createdBy: req.adminId,
  });
  res.json({ ok: true });
});

// ---------- Shipper / Broker / Carrier account portal ----------
// Lets someone who already registered log in with the username/password they
// set up, and see the details on file for their account.

app.get('/login/:role(shipper|broker|carrier)', async (req, res) => {
  const role = req.params.role;
  const titleMap = { shipper: 'Shipper', broker: 'Broker', carrier: 'Carrier' };
  const template = fs.readFileSync(path.join(PORTAL_VIEWS_DIR, 'login.html'), 'utf-8');
  const rendered = template
    .replace(/{{ROLE_TITLE}}/g, titleMap[role])
    .replace(/{{ROLE}}/g, role);
  res.send(rendered);
});

app.post('/login/:role(shipper|broker|carrier)', async (req, res) => {
  const role = req.params.role;
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Please enter both username and password.' });
  }
  const record = await findUserRecord(role, username, password);
  if (!record) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  userSessions.set(token, { role, recordId: record.id });
  res.json({ token, role });
});

// Pages below are served openly (no server-side gate) — the token lives in
// this browser tab's sessionStorage, not a cookie, so a plain page GET
// can't prove who's asking. /assets/auth.js checks sessionStorage on load
// and bounces to /login/:role immediately if there's no token in this tab;
// every JSON API call the page makes afterwards is still protected via
// getShipperSession(), which checks the Authorization header.
app.get('/portal/:role(shipper|broker|carrier)', (req, res) => {
  const role = req.params.role;
  const titleMap = { shipper: 'Shipper', broker: 'Broker', carrier: 'Carrier' };
  const template = fs.readFileSync(path.join(PORTAL_VIEWS_DIR, 'details.html'), 'utf-8');
  const rendered = template
    .replace(/{{ROLE_TITLE}}/g, titleMap[role])
    .replace(/{{ROLE}}/g, role);
  res.send(rendered);
});

app.get('/portal/:role(shipper)/estimate', (req, res) => {
  res.sendFile(path.join(PORTAL_VIEWS_DIR, 'estimate.html'));
});

app.get('/portal/:role(shipper)/live-tracking', (req, res) => {
  res.sendFile(path.join(PORTAL_VIEWS_DIR, 'live-tracking.html'));
});

app.get('/portal/:role(shipper)/requests', (req, res) => {
  res.sendFile(path.join(PORTAL_VIEWS_DIR, 'requests.html'));
});

app.get('/portal/:role(carrier)/loads', (req, res) => {
  res.sendFile(path.join(PORTAL_VIEWS_DIR, 'carrier-loads.html'));
});

app.get('/portal/:role(carrier)/fleet', (req, res) => {
  res.sendFile(path.join(PORTAL_VIEWS_DIR, 'carrier-fleet.html'));
});

app.get('/portal/:role(carrier)/bidding', (req, res) => {
  res.sendFile(path.join(PORTAL_VIEWS_DIR, 'carrier-bidding.html'));
});

app.get('/portal/:role(shipper)/bids', (req, res) => {
  res.sendFile(path.join(PORTAL_VIEWS_DIR, 'shipper-bids.html'));
});

// Driver dashboard is its own standalone area (not under /portal/:role
// since a Driver is not a Registration-based role like Shipper/Broker/
// Carrier — they log in with mobile+OTP instead, see /api/driver/login/*).
app.get('/driver/login', (req, res) => {
  res.sendFile(path.join(PORTAL_VIEWS_DIR, 'driver-login.html'));
});
app.get('/driver/dashboard', (req, res) => {
  res.sendFile(path.join(PORTAL_VIEWS_DIR, 'driver-dashboard.html'));
});

// Returns the logged-in user's own registration record (minus password fields).
// Also doubles as the client-side session-guard's validation call — if this
// 401s, /assets/auth.js clears the token and bounces to /login/:role.
app.get('/api/me', async (req, res) => {
  const token = getBearerToken(req);
  const session = token && userSessions.get(token);
  if (!session) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  const record = await Registration.findOne({ role: session.role, id: session.recordId }).lean();
  if (!record) {
    return res.status(404).json({ error: 'Account record not found.' });
  }
  const { password, confirmPassword, ...safeRecord } = record;
  res.json({ ...safeRecord, role: session.role });
});

// Lets a shipper whose account was REJECTED correct their registration
// details and resubmit for Admin review. Reuses the same Registration
// record (no duplicate account) and the same PAN/GST validators as the
// original registration form. Only allowed while status is "rejected" —
// once accepted, this endpoint refuses (accounts are edited through
// re-registration/admin support after that point, unchanged from today's
// behaviour).
app.post('/api/shipper/update-registration', async (req, res) => {
  const session = getShipperSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a shipper first.' });
  const record = await Registration.findOne({ role: 'shipper', id: session.recordId });
  if (!record) return res.status(404).json({ error: 'Account not found.' });
  if (record.status !== 'rejected') {
    return res.status(403).json({ error: 'You can only edit your details while your account status is Rejected.' });
  }

  const b = req.body || {};
  if (b.panNumber && !isValidPAN(b.panNumber)) {
    return res.status(400).json({ error: 'That PAN number is not in a valid format.' });
  }
  if (b.gstNumber && !isValidGST(b.gstNumber)) {
    return res.status(400).json({ error: 'That GST number is not valid (format/checksum check failed).' });
  }
  if (b.phoneNumber && !/^[0-9]{7,15}$/.test(String(b.phoneNumber).replace(/\D/g, ''))) {
    return res.status(400).json({ error: 'Enter a valid phone number (digits only).' });
  }

  // Aadhaar is never collected from Shippers anywhere, including here —
  // PAN is the sole identity document for this role.
  const editableFields = [
    'companyName', 'contactPerson', 'phoneNumber', 'pincode', 'district',
    'state', 'area', 'pickupAddress', 'gstNumber', 'businessDetail',
    'panNumber',
  ];
  editableFields.forEach((f) => {
    if (b[f] !== undefined) record[f] = String(b[f]).trim();
  });
  if (b.gstNumber !== undefined) record.gstNumber = normalizeGST(b.gstNumber);
  if (b.panNumber !== undefined) record.panVerified = isValidPAN(b.panNumber);
  if (b.gstNumber !== undefined) record.gstVerified = isValidGST(b.gstNumber);

  // Back to "pending" so Admin sees it in their review queue again.
  record.status = 'pending';
  record.rejectionReason = '';
  await record.save();

  const { password, confirmPassword, ...safeRecord } = record.toObject();
  res.json({ ok: true, record: safeRecord });
});

// New "Update" button flow (Shipper Portal Update Profile spec) — lets a
// shipper whose account is NOT rejected update their details, separate
// from the resubmit-after-rejection flow above (which is untouched and
// still only for status === 'rejected'). Gated by two independent server-
// side checks so neither can be bypassed from the frontend:
//   1. status !== 'rejected'   (rejected accounts must use Admin support)
//   2. updateLocked !== true   (admin's per-shipper Lock/Unlock Update switch)
// Unlike the resubmit flow, this does NOT reset status back to "pending" —
// it's a profile update, not a re-review request.
app.post('/api/shipper/update-profile', async (req, res) => {
  const session = getShipperSession(req);
  if (!session) return res.status(401).json({ error: 'Please log in as a shipper first.' });
  const record = await Registration.findOne({ role: 'shipper', id: session.recordId });
  if (!record) return res.status(404).json({ error: 'Account not found.' });
  if (record.status === 'rejected') {
    return res.status(403).json({ error: 'Your account is Rejected — updating your profile is not available. Please contact support.' });
  }
  if (record.updateLocked) {
    return res.status(403).json({ error: 'Profile updates have been locked by the admin team for your account. Please contact support.' });
  }

  const b = req.body || {};
  if (b.panNumber && !isValidPAN(b.panNumber)) {
    return res.status(400).json({ error: 'That PAN number is not in a valid format.' });
  }
  if (b.gstNumber && !isValidGST(b.gstNumber)) {
    return res.status(400).json({ error: 'That GST number is not valid (format/checksum check failed).' });
  }
  if (b.phoneNumber && !/^[0-9]{7,15}$/.test(String(b.phoneNumber).replace(/\D/g, ''))) {
    return res.status(400).json({ error: 'Enter a valid phone number (digits only).' });
  }

  // Aadhaar is intentionally NOT editable through this flow — it's shown
  // masked (****1234) everywhere in the shipper UI, including this form,
  // so there's no real value here to safely resubmit as-is. Changing an
  // Aadhaar number is handled through Admin/support, not self-service.
  const editableFields = [
    'companyName', 'contactPerson', 'phoneNumber', 'pincode', 'district',
    'state', 'area', 'pickupAddress', 'gstNumber', 'businessDetail', 'panNumber',
  ];
  editableFields.forEach((f) => {
    if (b[f] !== undefined) record[f] = String(b[f]).trim();
  });
  if (b.gstNumber !== undefined) record.gstNumber = normalizeGST(b.gstNumber);
  if (b.panNumber !== undefined) record.panVerified = isValidPAN(b.panNumber);
  if (b.gstNumber !== undefined) record.gstVerified = isValidGST(b.gstNumber);

  await record.save();

  const { password, confirmPassword, ...safeRecord } = record.toObject();
  res.json({ ok: true, record: safeRecord });
});

app.post('/logout/:role(shipper|broker|carrier)', (req, res) => {
  const token = getBearerToken(req);
  if (token) userSessions.delete(token);
  res.json({ ok: true });
});

// ---------- 404 fallback ----------
app.use((req, res) => {
  res.status(404).send('Page not found.');
});

// ---------- Start server (http.Server wraps Express so Socket.IO can
// share the same port for live GPS tracking — see the "Live Tracking"
// section above) ----------
const httpServer = require('http').createServer(app);
initSocketIO(httpServer);
httpServer.listen(PORT, () => {
  console.log(`Load Smart server running at http://localhost:${PORT}`);
});
