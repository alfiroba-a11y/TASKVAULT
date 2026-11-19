import { createServer } from 'node:http';
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
let mongoose = null, Payment = null, User = null, Video = null, Withdrawal = null, databaseReady = false, databaseError = 'MongoDB is not configured.';
try {
  ({ default: mongoose } = await import('mongoose'));
  const paymentSchema = new mongoose.Schema({
    reference: { type: String, required: true, unique: true, index: true }, amount: { type: Number, required: true },
    phoneLast4: String, status: { type: String, required: true, index: true }, createdAt: { type: Date, default: Date.now },
    checkoutId: String, merchantRequestId: String, customerMessage: String, failure: String, receipt: String, paidAt: Date
  }, { collection: 'payments', versionKey: false });
  Payment = mongoose.model('TaskVaultPayment', paymentSchema);
  const userSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true }, email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordSalt: { type: String, required: true }, passwordHash: { type: String, required: true }, referralCode: { type: String, required: true, unique: true },
    referredBy: String, status: { type: String, default: 'Active' }, humanVerified: { type: Boolean, default: false }, humanVerifiedAt: Date, balance: { type: Number, default: 0 }, earned: { type: Number, default: 0 },
    points: { type: Number, default: 100 }, streak: { type: Number, default: 0 }, checkinDate: String, referrals: { type: Number, default: 0 },
    completedTasks: { type: [String], default: [] }, completedVideos: { type: [String], default: [] }, completedQuizzes: { type: [String], default: [] }, shareDate: String,
    activity: { type: [mongoose.Schema.Types.Mixed], default: [{ icon: '🎉', title: 'Welcome to Task Vault', meta: 'Just now', amount: '+ 100 points' }] },
    createdAt: { type: Date, default: Date.now }
  }, { collection: 'members', versionKey: false });
  User = mongoose.model('TaskVaultMember', userSchema);
  const videoSchema = new mongoose.Schema({
    title: { type: String, required: true, trim: true }, description: { type: String, default: '' }, videoUrl: { type: String, required: true },
    watchReward: { type: Number, required: true, min: 0 }, quizReward: { type: Number, default: 0, min: 0 },
    questions: { type: [{ prompt: String, answer: String }], default: [] }, status: { type: String, default: 'Draft' }, createdAt: { type: Date, default: Date.now }
  }, { collection: 'videos', versionKey: false });
  Video = mongoose.model('TaskVaultVideo', videoSchema);
  const withdrawalSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true }, memberName: String, method: String, destination: String,
    amount: Number, status: { type: String, default: 'Pending', index: true }, createdAt: { type: Date, default: Date.now }, processedAt: Date
  }, { collection: 'withdrawals', versionKey: false });
  Withdrawal = mongoose.model('TaskVaultWithdrawal', withdrawalSchema);
  mongoose.connection.on('connected', () => { databaseReady = true; databaseError = null; console.log(`MongoDB connected (${process.env.MONGO_DB_NAME || 'task_vault'})`); });
  mongoose.connection.on('disconnected', () => { databaseReady = false; databaseError = 'MongoDB disconnected.'; console.warn(databaseError); });
  mongoose.connection.on('error', error => { databaseReady = false; databaseError = error.message; console.error('MongoDB connection error:', error.message); });
  if (process.env.MONGO_URI) connectMongo();
  else console.warn('MONGO_URI is not set. Starting in degraded mode; payment persistence is disabled.');
} catch (error) {
  databaseError = `MongoDB driver unavailable: ${error.message}`;
  console.error(`${databaseError} App will start in degraded mode; payment persistence is disabled.`);
}
async function connectMongo() {
  if (!mongoose || !process.env.MONGO_URI || mongoose.connection.readyState !== 0) return;
  try {
    await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGO_DB_NAME || 'task_vault', serverSelectionTimeoutMS: 8000 });
    databaseReady = true; databaseError = null;
  } catch (error) {
    databaseReady = false; databaseError = error.message;
    console.error('MongoDB unavailable; keeping the web app online in degraded mode:', error.message);
  }
}
const reconnectTimer = setInterval(() => { if (mongoose && !databaseReady && mongoose.connection.readyState === 0) connectMongo(); }, 30000);
reconnectTimer.unref();
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
function requireDatabase(res) { if (databaseReady && Payment) return true; json(res, 503, { error: 'Payment data is temporarily unavailable. The app is online and will retry MongoDB.', detail: databaseError }); return false; }
function requireModels(res, model) { if (databaseReady && model) return true; json(res, 503, { error: 'Account and rewards data are temporarily unavailable. Please try again shortly.' }); return false; }
const sessionSecret = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
function signedToken(data) { const payload = Buffer.from(JSON.stringify(data)).toString('base64url'); return `${payload}.${createHmac('sha256', sessionSecret).update(payload).digest('base64url')}`; }
function readToken(req, cookieName) {
  const raw = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!raw) return null;
  const [payload, signature] = decodeURIComponent(raw).split('.'); if (!payload || !signature) return null;
  const expected = createHmac('sha256', sessionSecret).update(payload).digest(); let got;
  try { got = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString()); return data.exp > Date.now() ? data : null; } catch { return null; }
}
function setSession(res, req, name, data) {
  const secure = process.env.PUBLIC_BASE_URL?.startsWith('https://') || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(signedToken({ ...data, exp: Date.now() + 1000 * 60 * 60 * 24 * 14 }))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600${secure ? '; Secure' : ''}`);
}
function clearSession(res, req, name) { const secure = process.env.PUBLIC_BASE_URL?.startsWith('https://') || req.headers['x-forwarded-proto'] === 'https'; res.setHeader('Set-Cookie', `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`); }
const categories = ['Survey', 'Discovery', 'Lifestyle', 'Shopping', 'Learning', 'Entertainment', 'Community', 'Technology', 'Travel', 'Food'];
const taskTitles = [
  'Explore a new mobile wallet','Tell us your weekend plans','Discover a local coffee brand','Try a short product finder','Share your streaming picks','Explore a greener commute','Vote on a new app feature','Browse a home essentials collection','Complete a five question survey','Discover a new music playlist',
  'Compare two everyday products','Tell us how you shop online','Explore a digital learning app','Choose your favorite snack','Try a quick travel quiz','Review a new landing page','Share your favorite local spots','Discover a wellness routine','Explore a new budgeting tip','Choose the best package design',
  'Tell us about your morning routine','Browse a curated book list','Try a three minute knowledge quiz','Discover a new food delivery idea','Vote for a community event','Explore a mobile network offer','Choose your preferred checkout','Tell us your home style','Try a product matching quiz','Discover a local fashion label',
  'Explore a new fitness feature','Share your favorite podcasts','Browse a digital savings guide','Choose a travel destination','Tell us what matters in a phone','Discover an eco friendly product','Try a quick brand recall quiz','Explore a local business directory','Choose your ideal work setup','Share your cooking preferences',
  'Browse a curated gift guide','Explore a new calendar app','Tell us your preferred payment method','Choose a weekend activity','Discover a home care product','Try a short language challenge','Vote on a new delivery option','Explore a personal finance article','Share your favorite sports','Choose a new design concept',
  'Discover a simple skincare routine','Browse a local events page','Try a five minute market survey','Explore a useful productivity tip','Choose your preferred travel bag','Tell us about your shopping habits','Discover a new recipe collection','Vote on a mobile app layout','Explore a community learning group','Share what makes an ad memorable',
  'Find a product in a digital catalog','Explore a neighborhood service','Tell us what you value in a bank','Choose a home office upgrade','Try a quick entertainment poll','Discover a local restaurant menu','Share your reading preferences','Explore a digital safety checklist','Choose your favorite product color','Complete a short customer experience survey'
];
const TASKS = taskTitles.map((title, i) => ({ id: `task-${String(i + 1).padStart(2, '0')}`, title, category: categories[i % categories.length], amount: [0.12, 0.18, 0.25, 0.30, 0.45, 0.60, 0.75][i % 7], duration: `${2 + (i % 6)} min`, icon: ['📝', '🔎', '✨', '🛍️', '💡', '🎯', '🌱', '📱', '🎧', '🌍'][i % 10], desc: `A short sponsored ${categories[i % categories.length].toLowerCase()} activity. Explore the content and complete the task to receive the listed reward.` }));
const nairobiDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
function publicMember(user) { return { id: user._id, name: user.name, email: user.email, status: user.status, humanVerified: Boolean(user.humanVerified), balance: user.balance, earned: user.earned, points: user.points, streak: user.streak, referrals: user.referrals, referralCode: user.referralCode, checkinDate: user.checkinDate || null, completedTasks: user.completedTasks, completedVideos: user.completedVideos, completedQuizzes: user.completedQuizzes, activity: user.activity.slice(-20).reverse() }; }
function requireHuman(user, res) { if (user.humanVerified) return true; json(res, 403, { error: 'Complete the face scan before using earning features.' }); return false; }
const money = n => `$${Number(n).toFixed(2)}`;
function award(user, amount, points, icon, title) { user.balance = Number((user.balance + amount).toFixed(2)); user.earned = Number((user.earned + amount).toFixed(2)); user.points += points; user.activity.push({ icon, title, meta: 'Just now', amount: `+ ${amount ? money(amount) : `${points} points`}` }); user.activity = user.activity.slice(-30); }
async function body(req, max = 10000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new Error('Request too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function normalizePhone(input) {
  let p = String(input || '').replace(/[\s()+-]/g, '');
  if (p.startsWith('0')) p = `254${p.slice(1)}`;
  if (p.startsWith('7') || p.startsWith('1')) p = `254${p}`;
  return /^254[17]\d{8}$/.test(p) ? p : null;
}
const limits = new Map();
function limited(ip) {
  const now = Date.now(), old = limits.get(ip) || { at: now, count: 0 };
  if (now - old.at > 60000) { old.at = now; old.count = 0; }
  old.count++; limits.set(ip, old); return old.count > 5;
}
async function initiatePrompt({ amount, phone, reference }) {
  const callback = String(process.env.HASHPAY_WEBHOOK_URL || `${process.env.PUBLIC_BASE_URL || ''}/webhooks/hashpay`).replace(/\/$/, '');
  const response = await fetch('https://api.hashback.co.ke/initiatestk', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: process.env.HASHPAY_API_KEY, account_id: process.env.HASHPAY_ACCOUNT_ID, amount: String(amount), msisdn: phone, reference, ...(callback ? { callback_webhook: callback } : {}) }),
    signal: AbortSignal.timeout(20000)
  });
  const result = await response.json().catch(() => ({}));
  const accepted = result.success === true || result.success === 'true' || String(result.ResponseCode) === '0';
  if (!response.ok || !accepted) throw new Error(result.message || result.ResponseDescription || 'HashPay did not accept the prompt.');
  return result;
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const publicBaseUrl = process.env.PUBLIC_BASE_URL || '';
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (publicBaseUrl.startsWith('https://') && forwardedProto === 'http' && !['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname !== '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      const secureUrl = new URL(req.url, publicBaseUrl);
      res.writeHead(308, { Location: secureUrl.toString(), 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      if (!requireModels(res, User)) return;
      const token = readToken(req, 'tv_session'), user = token?.uid ? await User.findById(token.uid) : null;
      if (!user || user.status !== 'Active') return json(res, 401, { error: 'Sign in to view member tasks.' });
      if (!requireHuman(user, res)) return;
      return json(res, 200, TASKS);
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      if (!requireModels(res, User)) return;
      const token = readToken(req, 'tv_session'); const user = token?.uid ? await User.findById(token.uid) : null;
      return json(res, 200, { user: user && user.status === 'Active' ? publicMember(user) : null });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/verify-human') {
      if (!requireModels(res, User)) return;
      const token = readToken(req, 'tv_session'), user = token?.uid ? await User.findById(token.uid) : null;
      if (!user || user.status !== 'Active') return json(res, 401, { error: 'Sign in before verifying your account.' });
      user.humanVerified = true; user.humanVerifiedAt = new Date(); await user.save();
      return json(res, 200, { user: publicMember(user) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/signup') {
      if (!requireModels(res, User)) return;
      const input = JSON.parse((await body(req)).toString('utf8'));
      const name = String(input.name || '').trim().slice(0, 80), email = String(input.email || '').trim().toLowerCase(), password = String(input.password || '');
      if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) return json(res, 400, { error: 'Enter your name, a valid email, and a password of at least 8 characters.' });
      if (await User.findOne({ email })) return json(res, 409, { error: 'An account with that email already exists. Sign in instead.' });
      const salt = randomBytes(16).toString('hex'), passwordHash = scryptSync(password, salt, 64).toString('hex');
      let referralCode = randomBytes(4).toString('hex').toUpperCase();
      while (await User.exists({ referralCode })) referralCode = randomBytes(4).toString('hex').toUpperCase();
      const refCode = String(input.referralCode || '').trim().toUpperCase();
      const user = await User.create({ name, email, passwordSalt: salt, passwordHash, referralCode, balance: 0, earned: 0, points: 0, streak: 0, referrals: 0, activity: [] });
      const inviter = refCode ? await User.findOne({ referralCode: refCode, status: 'Active' }) : null;
      if (inviter && String(inviter._id) !== String(user._id)) {
        inviter.referrals++; award(inviter, 0.78, 78, '🤝', `Referral joined: ${name}`); await inviter.save();
        user.referredBy = inviter.referralCode; award(user, 0, 100, '🎉', 'Referral signup bonus'); await user.save();
      }
      setSession(res, req, 'tv_session', { uid: String(user._id) });
      return json(res, 201, { user: publicMember(user) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      if (!requireModels(res, User)) return;
      const input = JSON.parse((await body(req)).toString('utf8')), email = String(input.email || '').trim().toLowerCase(), user = await User.findOne({ email });
      const hash = user ? scryptSync(String(input.password || ''), user.passwordSalt, 64) : Buffer.alloc(64);
      const expected = user ? Buffer.from(user.passwordHash, 'hex') : Buffer.alloc(64);
      if (!user || hash.length !== expected.length || !timingSafeEqual(hash, expected) || user.status !== 'Active') return json(res, 401, { error: 'Email or password is incorrect.' });
      setSession(res, req, 'tv_session', { uid: String(user._id) }); return json(res, 200, { user: publicMember(user) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') { clearSession(res, req, 'tv_session'); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/api/rewards/checkin') {
      if (!requireModels(res, User)) return;
      const token = readToken(req, 'tv_session'), user = token?.uid ? await User.findById(token.uid) : null;
      if (!user || user.status !== 'Active') return json(res, 401, { error: 'Sign in to claim your daily check-in.' });
      if (!requireHuman(user, res)) return;
      const today = nairobiDate(); if (user.checkinDate === today) return json(res, 409, { error: 'You have already checked in today.' });
      const yesterday = nairobiDate(new Date(Date.now() - 86400000)); user.streak = user.checkinDate === yesterday ? user.streak + 1 : 1; user.checkinDate = today;
      award(user, 0.10, 10, '📅', 'Daily check-in bonus'); await user.save(); return json(res, 200, { user: publicMember(user) });
    }
    if (req.method === 'POST' && url.pathname === '/api/rewards/share') {
      if (!requireModels(res, User)) return;
      const token = readToken(req, 'tv_session'), user = token?.uid ? await User.findById(token.uid) : null;
      if (!user || user.status !== 'Active') return json(res, 401, { error: 'Sign in to share and earn.' });
      if (!requireHuman(user, res)) return;
      const input = JSON.parse((await body(req)).toString('utf8')), network = String(input.network || '');
      if (!['WhatsApp', 'Facebook', 'Instagram'].includes(network)) return json(res, 400, { error: 'Choose a supported social network.' });
      const today = nairobiDate(); if (user.shareDate === today) return json(res, 409, { error: 'Your share reward has already been claimed today.' });
      user.shareDate = today; award(user, 0.20, 20, '↗️', `Shared on ${network}`); await user.save(); return json(res, 200, { user: publicMember(user) });
    }
    const taskComplete = url.pathname.match(/^\/api\/rewards\/tasks\/([\w-]+)\/complete$/);
    if (req.method === 'POST' && taskComplete) {
      if (!requireModels(res, User)) return;
      const token = readToken(req, 'tv_session'), user = token?.uid ? await User.findById(token.uid) : null;
      if (!user || user.status !== 'Active') return json(res, 401, { error: 'Sign in to complete tasks.' });
      if (!requireHuman(user, res)) return;
      const task = TASKS.find(item => item.id === taskComplete[1]); if (!task) return json(res, 404, { error: 'Task not found.' });
      if (user.completedTasks.includes(task.id)) return json(res, 409, { error: 'You have already completed this task.' });
      user.completedTasks.push(task.id); award(user, task.amount, Math.round(task.amount * 100), task.icon, `Completed ${task.title}`); await user.save();
      return json(res, 200, { user: publicMember(user), task });
    }
    if (req.method === 'GET' && url.pathname === '/api/videos') {
      if (!requireModels(res, Video)) return;
      const token = readToken(req, 'tv_session'), user = token?.uid ? await User.findById(token.uid) : null;
      if (!user || user.status !== 'Active') return json(res, 401, { error: 'Sign in to view member videos.' });
      if (!requireHuman(user, res)) return;
      const videos = await Video.find({ status: 'Live' }).sort({ createdAt: -1 }).lean();
      return json(res, 200, videos.map(({ questions, ...video }) => ({ ...video, questions: (questions || []).map(q => ({ prompt: q.prompt })) })));
    }
    if (req.method === 'POST' && /^\/api\/videos\/[\w-]+\/watched$/.test(url.pathname)) {
      if (!requireModels(res, User) || !Video) return;
      const token = readToken(req, 'tv_session'), user = token?.uid ? await User.findById(token.uid) : null;
      if (!user || user.status !== 'Active') return json(res, 401, { error: 'Sign in to earn video rewards.' });
      if (!requireHuman(user, res)) return;
      const id = url.pathname.split('/')[3], video = await Video.findOne({ _id: id, status: 'Live' }); if (!video) return json(res, 404, { error: 'Video is no longer available.' });
      if (user.completedVideos.includes(id)) return json(res, 409, { error: 'This video was already completed.' });
      const input = JSON.parse((await body(req)).toString('utf8')), watched = Number(input.watchedSeconds), duration = Number(input.duration);
      if (!Number.isFinite(duration) || duration <= 0 || watched < duration * 0.98) return json(res, 400, { error: 'Watch the full video without skipping before claiming the reward.' });
      user.completedVideos.push(id); award(user, video.watchReward, Math.round(video.watchReward * 100), '🎬', `Watched ${video.title}`); await user.save(); return json(res, 200, { user: publicMember(user), quizAvailable: video.questions.length > 0 });
    }
    const quizRoute = url.pathname.match(/^\/api\/videos\/([\w-]+)\/quiz$/);
    if (req.method === 'POST' && quizRoute) {
      if (!requireModels(res, User) || !Video) return;
      const token = readToken(req, 'tv_session'), user = token?.uid ? await User.findById(token.uid) : null;
      if (!user || user.status !== 'Active') return json(res, 401, { error: 'Sign in to answer video questions.' });
      if (!requireHuman(user, res)) return;
      const video = await Video.findOne({ _id: quizRoute[1], status: 'Live' }); if (!video) return json(res, 404, { error: 'Video not found.' });
      if (!user.completedVideos.includes(String(video._id))) return json(res, 403, { error: 'Watch the video first.' });
      if (user.completedQuizzes.includes(String(video._id))) return json(res, 409, { error: 'You have already completed this quiz.' });
      const input = JSON.parse((await body(req)).toString('utf8')), answers = Array.isArray(input.answers) ? input.answers : [];
      const norm = x => String(x || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (!video.questions.length || answers.length !== video.questions.length || !video.questions.every((q, i) => norm(answers[i]) === norm(q.answer))) return json(res, 400, { error: 'Some answers are not correct. Review the video and try again.' });
      user.completedQuizzes.push(String(video._id)); award(user, video.quizReward, Math.round(video.quizReward * 100), '🧠', `Passed the ${video.title} quiz`); await user.save(); return json(res, 200, { user: publicMember(user) });
    }
    if (req.method === 'POST' && url.pathname === '/api/withdrawals') {
      if (!requireModels(res, User) || !Withdrawal) return;
      const token = readToken(req, 'tv_session'), user = token?.uid ? await User.findById(token.uid) : null;
      if (!user || user.status !== 'Active') return json(res, 401, { error: 'Sign in to request a withdrawal.' });
      if (!requireHuman(user, res)) return;
      if (nairobiDate() < '2027-02-26') return json(res, 403, { error: 'Withdrawals open on 26 February 2027.' });
      const input = JSON.parse((await body(req)).toString('utf8')), amount = Number(input.amount), method = String(input.method || ''), destination = String(input.destination || '').trim().slice(0, 120);
      if (!Number.isFinite(amount) || amount < 1 || amount > user.balance || !['M-Pesa', 'PayPal'].includes(method) || !destination) return json(res, 400, { error: 'Enter a valid payout destination and an amount between $1.00 and your available rewards.' });
      user.balance = Number((user.balance - amount).toFixed(2)); await user.save();
      const request = await Withdrawal.create({ userId: user._id, memberName: user.name, method, destination, amount, status: 'Pending' });
      return json(res, 201, { request, user: publicMember(user) });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/session') return json(res, 200, { authenticated: Boolean(readToken(req, 'tv_admin')) });
    if (req.method === 'POST' && url.pathname === '/api/admin/login') {
      if (!process.env.ADMIN_PASSWORD) return json(res, 503, { error: 'Set ADMIN_PASSWORD in the deployment environment to enable the admin panel.' });
      const input = JSON.parse((await body(req)).toString('utf8')), got = Buffer.from(String(input.password || '')), expected = Buffer.from(process.env.ADMIN_PASSWORD);
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) return json(res, 401, { error: 'Admin password is incorrect.' });
      setSession(res, req, 'tv_admin', { admin: true }); return json(res, 200, { authenticated: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/logout') { clearSession(res, req, 'tv_admin'); return json(res, 200, { ok: true }); }
    if (url.pathname.startsWith('/api/admin/') && !readToken(req, 'tv_admin')) return json(res, 401, { error: 'Admin sign-in required.' });
    if (req.method === 'GET' && url.pathname === '/api/admin/videos') {
      if (!requireModels(res, Video)) return; return json(res, 200, await Video.find().sort({ createdAt: -1 }).lean());
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/videos') {
      if (!requireModels(res, Video)) return;
      const input = JSON.parse((await body(req)).toString('utf8')), title = String(input.title || '').trim().slice(0, 120), description = String(input.description || '').trim().slice(0, 2000), videoUrl = String(input.videoUrl || '').trim();
      let validUrl = false; try { const parsed = new URL(videoUrl); validUrl = parsed.protocol === 'https:'; } catch {}
      const watchReward = Number(input.watchReward), quizReward = Number(input.quizReward || 0), questions = Array.isArray(input.questions) ? input.questions.slice(0, 5).map(q => ({ prompt: String(q.prompt || '').trim().slice(0, 500), answer: String(q.answer || '').trim().slice(0, 200) })).filter(q => q.prompt && q.answer) : [];
      if (title.length < 2 || !validUrl || !Number.isFinite(watchReward) || watchReward < 0 || watchReward > 100 || !Number.isFinite(quizReward) || quizReward < 0 || quizReward > 100) return json(res, 400, { error: 'Add a title, a direct HTTPS video URL, and valid reward rates from $0 to $100.' });
      const video = await Video.create({ title, description, videoUrl, watchReward, quizReward, questions, status: 'Draft' }); return json(res, 201, video);
    }
    const videoAdminRoute = url.pathname.match(/^\/api\/admin\/videos\/([\w-]+)$/);
    if (req.method === 'PATCH' && videoAdminRoute) {
      if (!requireModels(res, Video)) return;
      const input = JSON.parse((await body(req)).toString('utf8')), video = await Video.findById(videoAdminRoute[1]); if (!video) return json(res, 404, { error: 'Video not found.' });
      if (input.status && ['Draft', 'Live', 'Paused'].includes(input.status)) video.status = input.status;
      if (input.title) video.title = String(input.title).trim().slice(0, 120);
      await video.save(); return json(res, 200, video);
    }
    if (req.method === 'DELETE' && videoAdminRoute) {
      if (!requireModels(res, Video)) return; await Video.deleteOne({ _id: videoAdminRoute[1] }); return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/users') {
      if (!requireModels(res, User)) return; const users = await User.find().sort({ createdAt: -1 }).select('-passwordHash -passwordSalt').lean(); return json(res, 200, users);
    }
    const userAdminRoute = url.pathname.match(/^\/api\/admin\/users\/([\w-]+)$/);
    if (req.method === 'PATCH' && userAdminRoute) {
      if (!requireModels(res, User)) return;
      const input = JSON.parse((await body(req)).toString('utf8')), user = await User.findById(userAdminRoute[1]); if (!user) return json(res, 404, { error: 'Member not found.' });
      if (['Active', 'Suspended'].includes(input.status)) user.status = input.status;
      if (input.balance !== undefined && Number.isFinite(Number(input.balance)) && Number(input.balance) >= 0) user.balance = Number(Number(input.balance).toFixed(2));
      await user.save(); return json(res, 200, { id: user._id, status: user.status, balance: user.balance });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/payments') {
      if (!requireModels(res, Payment)) return; return json(res, 200, await Payment.find().sort({ createdAt: -1 }).limit(200).lean());
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/withdrawals') {
      if (!requireModels(res, Withdrawal)) return; return json(res, 200, await Withdrawal.find().sort({ createdAt: -1 }).lean());
    }
    const withdrawalAdminRoute = url.pathname.match(/^\/api\/admin\/withdrawals\/([\w-]+)$/);
    if (req.method === 'PATCH' && withdrawalAdminRoute) {
      if (!requireModels(res, Withdrawal) || !User) return;
      const input = JSON.parse((await body(req)).toString('utf8')), request = await Withdrawal.findOne({ _id: withdrawalAdminRoute[1], status: 'Pending' });
      if (!request) return json(res, 404, { error: 'Pending withdrawal not found.' });
      if (!['Approved', 'Rejected'].includes(input.status)) return json(res, 400, { error: 'Choose Approved or Rejected.' });
      request.status = input.status; request.processedAt = new Date(); await request.save();
      if (input.status === 'Rejected') await User.updateOne({ _id: request.userId }, { $inc: { balance: request.amount } });
      return json(res, 200, request);
    }
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: databaseReady ? 'ok' : 'degraded', database: databaseReady, databaseName: process.env.MONGO_DB_NAME || 'task_vault', databaseMessage: databaseError, hashpayConfigured: Boolean(process.env.HASHPAY_API_KEY && process.env.HASHPAY_ACCOUNT_ID), webhookConfigured: Boolean(process.env.HASHPAY_WEBHOOK_SECRET) });
    if (req.method === 'POST' && url.pathname === '/api/payments/prompt') {
      if (!requireDatabase(res)) return;
      if (!process.env.HASHPAY_API_KEY || !process.env.HASHPAY_ACCOUNT_ID || !process.env.HASHPAY_WEBHOOK_SECRET || !(process.env.PUBLIC_BASE_URL || process.env.HASHPAY_WEBHOOK_URL)) return json(res, 503, { error: 'HashPay environment settings are incomplete.' });
      if (limited(req.socket.remoteAddress || 'unknown')) return json(res, 429, { error: 'Too many payment prompts. Try again in a minute.' });
      const input = JSON.parse((await body(req)).toString('utf8'));
      const amount = Math.round(Number(input.amount));
      const phone = normalizePhone(input.phone);
      if (!Number.isInteger(amount) || amount < 1 || amount > 150000) return json(res, 400, { error: 'Enter a valid amount from KES 1 to KES 150,000.' });
      if (!phone) return json(res, 400, { error: 'Enter a valid Kenyan M-Pesa number.' });
      const reference = `TV${Date.now().toString(36).toUpperCase()}${randomUUID().slice(0, 6).toUpperCase()}`;
      const record = await Payment.create({ reference, amount, phoneLast4: phone.slice(-4), status: 'starting' });
      try {
        const provider = await initiatePrompt({ amount, phone, reference });
        record.checkoutId = provider.checkout_id || provider.CheckoutRequestID || null;
        record.merchantRequestId = provider.MerchantRequestID || null;
        if (record.status !== 'paid') record.status = 'pending';
        record.customerMessage = provider.CustomerMessage || 'Check your phone and enter your M-Pesa PIN to complete.';
        await record.save();
        return json(res, 200, { reference, status: record.status, customerMessage: record.customerMessage });
      } catch (error) {
        if (record.status !== 'paid') { record.status = 'failed'; record.failure = error.message; await record.save(); }
        return json(res, 502, { error: error.message });
      }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/payments/')) {
      if (!requireDatabase(res)) return;
      const reference = decodeURIComponent(url.pathname.slice('/api/payments/'.length));
      const record = await Payment.findOne({ reference }).lean();
      return record ? json(res, 200, { reference, status: record.status, amount: record.amount, receipt: record.receipt || null }) : json(res, 404, { error: 'Payment not found.' });
    }
    if (req.method === 'POST' && url.pathname === '/webhooks/hashpay') {
      if (!requireDatabase(res)) return;
      if (!process.env.HASHPAY_WEBHOOK_SECRET) return json(res, 503, { error: 'Webhook is not configured.' });
      const raw = await body(req, 100000);
      const signature = req.headers['x-hashpay-signature'] || '';
      const expected = `sha256=${createHmac('sha256', process.env.HASHPAY_WEBHOOK_SECRET).update(raw).digest('hex')}`;
      const a = Buffer.from(String(signature)), b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return json(res, 401, { error: 'Invalid webhook signature.' });
      const event = JSON.parse(raw.toString('utf8'));
      const reference = String(event.TransactionReference || event.reference || '');
      const record = await Payment.findOne({ reference });
      if (record && record.status !== 'paid' && (event.event === 'payment.success' || String(event.ResponseCode) === '0')) {
        const paid = Number(event.TransactionAmount ?? event.amount);
        const accountMatches = !process.env.HASHPAY_ACCOUNT_ID || String(event.AccountID || process.env.HASHPAY_ACCOUNT_ID) === String(process.env.HASHPAY_ACCOUNT_ID);
        if (paid === record.amount && accountMatches) {
          record.status = 'paid'; record.receipt = String(event.TransactionReceipt || event.TransactionID || event.receipt || '');
          record.paidAt = new Date(); await record.save();
        } else {
          console.warn('HashPay callback did not match the pending Task Vault payment', { reference, amount: paid, accountMatches });
        }
      }
      return json(res, 200, { received: true });
    }
    const pathname = decodeURIComponent(url.pathname);
    const relative = pathname === '/' || pathname === '/admin' || pathname === '/admin/' ? 'index.html' : pathname.slice(1);
    const path = normalize(join(root, relative));
    if (!path.startsWith(root)) return res.writeHead(403).end('Forbidden');
    const file = await readFile(path);
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Permissions-Policy': 'camera=(self)' });
    res.end(file);
  } catch (error) {
    console.error('Task Vault request failed:', error.message);
    json(res, error.message === 'Request too large' ? 413 : 400, { error: error.message || 'Request failed.' });
  }
});
const port = Number(process.env.PORT || 4173);
server.listen(port, '0.0.0.0', () => console.log(`Task Vault listening on port ${port}`));
