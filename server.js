'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

/* ===================== CONFIG ===================== */
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ORIGINS = (process.env.FRONTEND_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean);
const WILDCARD = ORIGINS.includes('*');
const ADMIN_NAMES = (process.env.ADMIN_USERNAMES || 'dedokxxxreal,dedokxxreal').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ADMIN_IDS = (process.env.ADMIN_ROBLOX_IDS || '').split(',').map(s => s.trim()).filter(Boolean); // daha güvenli
const BOT_USERNAME = process.env.BOT_USERNAME || 'DedokAmp';
const DEFAULT_LINK = 'https://www.roblox.com/share?code=a0dd8a7bc68f034b99e078f454d4e903&type=Server';
let BOT_JOIN_LINK = process.env.BOT_JOIN_LINK || DEFAULT_LINK;
if (!/^https:\/\/www\.roblox\.com\//.test(BOT_JOIN_LINK)) BOT_JOIN_LINK = DEFAULT_LINK;
const BOT_SECRET = process.env.BOT_SECRET || '';

const RANGE = 0.05;            // join aralığı ±%5
const MAX_ITEMS = 15;
const COUNTDOWN_MS = 3000;
const FLIP_MS = 2800;
const KEEP_MS = 20000;         // biten maç dışarıda 20sn kalır
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const GIVEAWAY_TIMES = [30, 120, 300];

/* ===================== HELPERS ===================== */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rid = (n = 8) => crypto.randomBytes(n).toString('hex');
const r2 = x => Math.round(x * 100) / 100;
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ===================== DATABASE (atomik JSON) ===================== */
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { users: {}, sessions: {}, catalog: {}, matches: {}, history: [], giveaways: {}, chat: [], withdrawals: {}, tx: [], adminLog: [] };
function loadDB() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch (e) { console.error('DB load failed, refusing to start to avoid data loss:', e); process.exit(1); }
}
let saveTimer = null;
function saveNow() {
  try { const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DB_FILE); }
  catch (e) { console.error('DB save failed', e); }
}
function save() { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 300); }
loadDB();

function seedCatalog() {
  if (Object.keys(db.catalog).length) return;
  const seed = [
    ['Shadow Dragon', 15250, 'mega', true, true], ['Bat Dragon', 9800, 'neon', true, true],
    ['Frost Dragon', 6180, 'mega', true, true], ['Giraffe', 2310, 'neon', true, true],
    ['Owl', 1450, 'normal', true, true], ['Parrot', 980, 'neon', true, true],
    ['Evil Unicorn', 760, 'mega', true, true], ['Crow', 68, 'neon', true, true],
    ['Cow', 55, 'normal', true, true], ['Turtle', 38, 'neon', false, true]
  ];
  for (const [name, value, variant, fly, ride] of seed) {
    const id = 'c_' + rid(5);
    db.catalog[id] = { id, name, img: '', value, variant, fly, ride, tag: makeTag(variant, fly, ride), hidden: false, createdAt: Date.now() };
  }
  save();
}
function makeTag(variant, fly, ride) { return (variant === 'mega' ? 'M' : variant === 'neon' ? 'N' : '') + (fly ? 'F' : '') + (ride ? 'R' : ''); }
seedCatalog();

/* ===================== ROBLOX API ===================== */
async function rbx(url, opts = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
    if (!r.ok) throw new Error('roblox ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function resolveUsername(name) {
  const j = await rbx('https://users.roblox.com/v1/usernames/users', { method: 'POST', body: JSON.stringify({ usernames: [name], excludeBannedUsers: true }) });
  const u = j.data && j.data[0];
  return u ? { id: String(u.id), username: u.name, displayName: u.displayName } : null;
}
const getRbxUser = id => rbx('https://users.roblox.com/v1/users/' + id);
async function getThumb(id, type = 'avatar-headshot', size = '150x150') {
  try {
    const j = await rbx(`https://thumbnails.roblox.com/v1/users/${type}?userIds=${id}&size=${size}&format=Png&isCircular=false`);
    const d = j.data && j.data[0];
    return d && d.state === 'Completed' ? d.imageUrl : '';
  } catch { return ''; }
}

let BOT = { username: BOT_USERNAME, displayName: BOT_USERNAME, id: '', avatar: '', joinLink: BOT_JOIN_LINK };
async function refreshBot() {
  try {
    const u = await resolveUsername(BOT_USERNAME);
    if (u) BOT = { username: u.username, displayName: u.displayName, id: u.id, avatar: await getThumb(u.id), joinLink: BOT_JOIN_LINK };
  } catch (e) { console.warn('bot refresh failed', e.message); }
}
refreshBot(); setInterval(refreshBot, 30 * 60 * 1000);

/* ===================== USERS / INVENTORY ===================== */
const isAdmin = u => !!u && (ADMIN_IDS.includes(u.id) || ADMIN_NAMES.includes(String(u.username).toLowerCase()));
const pubUser = u => ({ id: u.id, username: u.username, avatar: u.avatar || '' });
function newUser(info, avatar, bust) {
  return { id: info.id, username: info.username, displayName: info.displayName || info.username, avatar, bust, inventory: [], stats: { bet: 0, won: 0, profit: 0 }, ledger: [], createdAt: Date.now(), avatarAt: Date.now(), banned: false };
}
function snap(inst) { const c = db.catalog[inst.itemId]; return { uid: inst.uid, itemId: inst.itemId, name: c.name, img: c.img, value: c.value, tag: c.tag }; }
const unsnap = s => ({ uid: s.uid, itemId: s.itemId });
function rankOf(bet) { return bet >= 250000 ? 'Whale' : bet >= 50000 ? 'Highroller' : bet >= 5000 ? 'Player' : 'Rookie'; }
function mePayload(u) {
  const inv = u.inventory.map(snap);
  return { id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar, bust: u.bust || u.avatar, isAdmin: isAdmin(u), inventory: inv, worth: r2(inv.reduce((a, b) => a + b.value, 0)), stats: u.stats, rank: rankOf(u.stats.bet) };
}
function pushMe(u) { io.to('user:' + u.id).emit('me', mePayload(u)); }
function notify(u, type, text, extra) { io.to('user:' + u.id).emit('notify', { type, text, ...extra }); }
function ledger(u, type, id, amount) { u.ledger.unshift({ type, id, at: Date.now(), amount: r2(amount) }); if (u.ledger.length > 1000) u.ledger.length = 1000; }
function pickItems(user, ids, max = MAX_ITEMS) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > max) throw new HttpError(400, `Select between 1 and ${max} items`);
  const set = new Set(ids);
  if (set.size !== ids.length) throw new HttpError(400, 'Duplicate items');
  const picks = [];
  for (const uid of set) {
    if (typeof uid !== 'string') throw new HttpError(400, 'Invalid item');
    const inst = user.inventory.find(i => i.uid === uid);
    if (!inst) throw new HttpError(400, 'Item not in your inventory');
    picks.push(inst);
  }
  return picks;
}
function removeItems(user, picks) { const s = new Set(picks.map(p => p.uid)); user.inventory = user.inventory.filter(i => !s.has(i.uid)); }
const sumVal = arr => r2(arr.reduce((a, b) => a + b.value, 0));
function sysMsg(text) { const m = { id: rid(6), system: true, text, at: Date.now() }; db.chat.push(m); if (db.chat.length > 60) db.chat.shift(); io.emit('chat', m); }

/* ===================== EXPRESS + SOCKET ===================== */
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: WILDCARD ? '*' : ORIGINS }, maxHttpBufferSize: 1e4 });
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: WILDCARD ? '*' : ORIGINS, allowedHeaders: ['Content-Type', 'Authorization', 'X-Bot-Secret'], methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(express.json({ limit: '20kb' }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false }));
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts, wait a few minutes.' } });
const actLimiter = rateLimit({ windowMs: 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'Slow down!' } });

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/healthz', (req, res) => res.json({ ok: true }));

function userFromToken(tok) {
  if (!tok || tok.length < 20) return null;
  const h = sha(tok); const s = db.sessions[h];
  if (!s) return null;
  if (Date.now() - s.at > SESSION_TTL) { delete db.sessions[h]; return null; }
  return db.users[s.userId] || null;
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const u = userFromToken(tok);
  if (!u) return res.status(401).json({ error: 'Not logged in' });
  if (u.banned) return res.status(403).json({ error: 'Account banned' });
  req.user = u; req.token = tok; next();
}
const adminOnly = (req, res, next) => isAdmin(req.user) ? next() : res.status(404).json({ error: 'Not found' });

/* ---------- public config ---------- */
app.get('/api/config', (req, res) => res.json({ bot: BOT, range: RANGE, maxItems: MAX_ITEMS }));

/* ---------- ROBLOX LOGIN (açıklama kodu ile doğrulama) ---------- */
const pending = new Map();
setInterval(() => { const n = Date.now(); for (const [k, v] of pending) if (v.expires < n) pending.delete(k); for (const [k, s] of Object.entries(db.sessions)) if (n - s.at > SESSION_TTL) delete db.sessions[k]; }, 10 * 60 * 1000);

app.post('/api/auth/start', authLimiter, ah(async (req, res) => {
  const name = String((req.body || {}).username || '').trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) throw new HttpError(400, 'Invalid Roblox username');
  let u;
  try { u = await resolveUsername(name); } catch { throw new HttpError(502, 'Roblox is not responding, try again'); }
  if (!u) throw new HttpError(404, 'Roblox user not found');
  const ex = db.users[u.id];
  if (ex && ex.banned) throw new HttpError(403, 'This account is banned');
  const pendingId = rid(16);
  const code = 'AMPROLL-' + rid(5).toUpperCase();
  const avatar = await getThumb(u.id);
  pending.set(pendingId, { ...u, code, expires: Date.now() + 10 * 60 * 1000 });
  res.json({ pendingId, code, user: { id: u.id, username: u.username, displayName: u.displayName, avatar } });
}));

app.post('/api/auth/verify', authLimiter, ah(async (req, res) => {
  const pid = String((req.body || {}).pendingId || '');
  const p = pending.get(pid);
  if (!p || p.expires < Date.now()) throw new HttpError(400, 'Code expired, start again');
  let info;
  try { info = await getRbxUser(p.id); } catch { throw new HttpError(502, 'Roblox is not responding, try again'); }
  if (!pending.has(pid)) throw new HttpError(400, 'Code already used');
  if (!String(info.description || '').includes(p.code)) throw new HttpError(400, 'Code not found in your Roblox description yet. Save it and try again.');
  pending.delete(pid);
  const [avatar, bust] = await Promise.all([getThumb(p.id), getThumb(p.id, 'avatar-bust', '420x420')]);
  let user = db.users[p.id];
  if (!user) user = db.users[p.id] = newUser({ id: p.id, username: info.name, displayName: info.displayName }, avatar, bust);
  else { user.username = info.name; user.displayName = info.displayName; if (avatar) user.avatar = avatar; if (bust) user.bust = bust; user.avatarAt = Date.now(); }
  if (user.banned) throw new HttpError(403, 'This account is banned');
  const token = rid(32);
  db.sessions[sha(token)] = { userId: user.id, at: Date.now() };
  save();
  res.json({ token, me: mePayload(user) });
}));

app.post('/api/auth/logout', auth, (req, res) => { delete db.sessions[sha(req.token)]; save(); res.json({ ok: true }); });

app.get('/api/me', auth, (req, res) => {
  const u = req.user;
  if (Date.now() - (u.avatarAt || 0) > 12 * 3600 * 1000) {
    u.avatarAt = Date.now();
    Promise.all([getThumb(u.id), getThumb(u.id, 'avatar-bust', '420x420')]).then(([a, b]) => { if (a) u.avatar = a; if (b) u.bust = b; save(); pushMe(u); });
  }
  res.json(mePayload(u));
});
app.get('/api/me/ledger', auth, (req, res) => {
  const size = 8; const total = req.user.ledger.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page) || 1));
  res.json({ rows: req.user.ledger.slice((page - 1) * size, page * size), page, pages, total, stats: req.user.stats, rank: rankOf(req.user.stats.bet) });
});
app.get('/api/me/history', auth, (req, res) => {
  const id = req.user.id;
  res.json({ matches: db.history.filter(h => h.host.id === id || (h.opp && h.opp.id === id)).slice(0, 50).map(pubMatch) });
});

/* ===================== COINFLIP ===================== */
function pubItem(i) { return { name: i.name, img: i.img, value: i.value, tag: i.tag }; }
function pubMatch(m) {
  const rev = m.state === 'flipping' || m.state === 'finished';
  return {
    id: m.id, hash: m.hash, state: m.state, createdAt: m.createdAt,
    host: m.host, hostSide: m.hostSide, hostItems: m.hostItems.map(pubItem), hostValue: m.hostValue,
    opp: m.opp, oppSide: m.oppSide, oppItems: m.oppItems.map(pubItem), oppValue: m.oppValue,
    countdownEndsAt: m.countdownEndsAt || 0, flipEndsAt: m.flipEndsAt || 0,
    winnerSide: rev ? m.winnerSide : null,
    winnerId: m.state === 'finished' ? m.winnerId : null,
    seed: m.state === 'finished' ? m.seed : null, finishedAt: m.finishedAt || 0
  };
}
const broadcastMatches = () => io.emit('matches', Object.values(db.matches).map(pubMatch));
const computeSide = (seed, id) => parseInt(sha(seed + ':' + id).slice(0, 8), 16) % 2 === 0 ? 'dog' : 'cat';

app.post('/api/coinflip/create', auth, actLimiter, (req, res) => {
  const { itemIds, side } = req.body || {};
  if (side !== 'dog' && side !== 'cat') throw new HttpError(400, 'Invalid side');
  const mine = Object.values(db.matches).filter(m => m.host.id === req.user.id && m.state === 'waiting').length;
  if (mine >= 5) throw new HttpError(400, 'You can only have 5 open matches');
  const picks = pickItems(req.user, itemIds);
  const items = picks.map(snap); const value = sumVal(items);
  if (value <= 0) throw new HttpError(400, 'Items must have value');
  removeItems(req.user, picks);
  const seed = rid(32); const id = rid(6);
  const m = db.matches[id] = {
    id, seed, hash: sha(seed), state: 'waiting', createdAt: Date.now(),
    host: pubUser(req.user), hostSide: side, hostItems: items, hostValue: value,
    opp: null, oppSide: side === 'dog' ? 'cat' : 'dog', oppItems: [], oppValue: 0,
    winnerSide: null, winnerId: null
  };
  save(); broadcastMatches(); pushMe(req.user);
  res.json({ match: pubMatch(m) });
});

app.post('/api/coinflip/:id/join', auth, actLimiter, (req, res) => {
  const m = db.matches[req.params.id];
  if (!m || m.state !== 'waiting') throw new HttpError(409, 'Match is no longer available');
  if (m.host.id === req.user.id) throw new HttpError(400, "You can't join your own match");
  const picks = pickItems(req.user, (req.body || {}).itemIds);
  const items = picks.map(snap); const value = sumVal(items);
  if (value < r2(m.hostValue * (1 - RANGE)) || value > r2(m.hostValue * (1 + RANGE))) throw new HttpError(400, 'Your value is outside the allowed range');
  // --- senkron kritik bölüm (await yok => race/dupe yok) ---
  removeItems(req.user, picks);
  m.opp = pubUser(req.user); m.oppItems = items; m.oppValue = value;
  m.state = 'countdown';
  m.countdownEndsAt = Date.now() + COUNTDOWN_MS;
  m.flipEndsAt = m.countdownEndsAt + FLIP_MS;
  m.winnerSide = computeSide(m.seed, m.id);
  // ---------------------------------------------------------
  scheduleMatch(m);
  save(); broadcastMatches(); pushMe(req.user);
  res.json({ match: pubMatch(m) });
});

app.post('/api/coinflip/:id/cancel', auth, actLimiter, (req, res) => {
  const m = db.matches[req.params.id];
  if (!m || m.state !== 'waiting') throw new HttpError(409, 'Cannot cancel: opponent already joined');
  if (m.host.id !== req.user.id) throw new HttpError(403, 'Not your match');
  delete db.matches[m.id];
  m.hostItems.forEach(it => req.user.inventory.push(unsnap(it)));
  save(); broadcastMatches(); pushMe(req.user);
  res.json({ ok: true });
});

function scheduleMatch(m) {
  const n = Date.now();
  setTimeout(() => { if (m.state === 'countdown') { m.state = 'flipping'; save(); broadcastMatches(); } }, Math.max(0, m.countdownEndsAt - n));
  setTimeout(() => finishMatch(m.id), Math.max(50, m.flipEndsAt - n));
}
function finishMatch(id) {
  const m = db.matches[id];
  if (!m || (m.state !== 'countdown' && m.state !== 'flipping')) return;
  m.state = 'finished'; m.finishedAt = Date.now();
  const hostWon = m.winnerSide === m.hostSide;
  const winner = hostWon ? m.host : m.opp, loser = hostWon ? m.opp : m.host;
  const wv = hostWon ? m.hostValue : m.oppValue, lv = hostWon ? m.oppValue : m.hostValue;
  m.winnerId = winner.id;
  const wu = db.users[winner.id], lu = db.users[loser.id];
  const pot = [...m.hostItems, ...m.oppItems];
  if (wu) {
    pot.forEach(it => wu.inventory.push(unsnap(it)));
    wu.stats.bet = r2(wu.stats.bet + wv); wu.stats.won = r2(wu.stats.won + wv + lv); wu.stats.profit = r2(wu.stats.profit + lv);
    ledger(wu, 'Coinflip Win', m.id, lv);
  }
  if (lu) {
    lu.stats.bet = r2(lu.stats.bet + lv); lu.stats.profit = r2(lu.stats.profit - lv);
    ledger(lu, 'Coinflip Loss', m.id, -lv);
  }
  db.history.unshift(m); if (db.history.length > 1500) db.history.length = 1500;
  save(); broadcastMatches();
  if (wu) { pushMe(wu); notify(wu, 'win', `You won ${r2(wv + lv)} value in the coinflip!`); }
  if (lu) { pushMe(lu); notify(lu, 'lose', 'You lost the coinflip. Better luck next time!'); }
  setTimeout(() => { delete db.matches[id]; save(); broadcastMatches(); }, KEEP_MS);
}

/* ===================== GIVEAWAYS ===================== */
const pubGW = g => ({ id: g.id, host: g.host, item: pubItem(g.item), endsAt: g.endsAt, mode: g.mode, minBet: g.minBet, entries: g.entries, status: g.status, winner: g.winner || null });
const broadcastGW = () => io.emit('giveaways', Object.values(db.giveaways).map(pubGW));

app.post('/api/giveaway/create', auth, actLimiter, (req, res) => {
  const { itemIds, durationSec, mode } = req.body || {};
  const minBet = Math.max(0, Math.min(1e9, Number((req.body || {}).minBet) || 0));
  if (!GIVEAWAY_TIMES.includes(Number(durationSec))) throw new HttpError(400, 'Invalid duration');
  if (mode !== 'easy' && mode !== 'advanced') throw new HttpError(400, 'Invalid mode');
  const act = Object.values(db.giveaways).filter(g => g.status === 'active');
  if (act.some(g => g.host.id === req.user.id)) throw new HttpError(400, 'You already have an active giveaway');
  if (act.length >= 10) throw new HttpError(400, 'Too many active giveaways');
  const picks = pickItems(req.user, itemIds, 1);
  const item = snap(picks[0]);
  removeItems(req.user, picks);
  const id = rid(6);
  const g = db.giveaways[id] = { id, host: pubUser(req.user), item, createdAt: Date.now(), endsAt: Date.now() + Number(durationSec) * 1000, mode, minBet: mode === 'advanced' ? minBet : 0, entries: [], status: 'active' };
  scheduleGW(g); save(); broadcastGW(); pushMe(req.user);
  sysMsg(`🎁 ${req.user.username} started a giveaway: ${item.tag ? item.tag + ' ' : ''}${item.name}!`);
  res.json({ ok: true });
});
app.post('/api/giveaway/:id/enter', auth, actLimiter, (req, res) => {
  const g = db.giveaways[req.params.id];
  if (!g || g.status !== 'active' || g.endsAt <= Date.now()) throw new HttpError(409, 'Giveaway is over');
  if (g.host.id === req.user.id) throw new HttpError(400, "You can't enter your own giveaway");
  if (g.entries.includes(req.user.id)) throw new HttpError(400, 'Already entered');
  if (g.mode === 'advanced' && req.user.stats.bet < g.minBet) throw new HttpError(400, `You need at least ${g.minBet} total bet to enter`);
  g.entries.push(req.user.id); save(); broadcastGW();
  res.json({ ok: true });
});
function scheduleGW(g) { setTimeout(() => endGiveaway(g.id), Math.max(50, g.endsAt - Date.now())); }
function endGiveaway(id) {
  const g = db.giveaways[id];
  if (!g || g.status !== 'active') return;
  g.status = 'ended';
  const host = db.users[g.host.id];
  if (!g.entries.length) {
    if (host) { host.inventory.push(unsnap(g.item)); pushMe(host); notify(host, 'info', 'Your giveaway had no entries. Item returned.'); }
    sysMsg(`Giveaway for ${g.item.name} ended with no entries.`);
  } else {
    const wid = g.entries[crypto.randomInt(g.entries.length)];
    const w = db.users[wid];
    if (w) {
      w.inventory.push(unsnap(g.item)); ledger(w, 'Giveaway Win', g.id, g.item.value);
      g.winner = { id: w.id, username: w.username, avatar: w.avatar };
      pushMe(w); notify(w, 'win', `You won the giveaway: ${g.item.name}!`);
    }
    sysMsg(`🎉 ${g.winner ? g.winner.username : 'Someone'} won the giveaway: ${g.item.tag ? g.item.tag + ' ' : ''}${g.item.name}!`);
  }
  save(); broadcastGW();
  setTimeout(() => { delete db.giveaways[id]; save(); broadcastGW(); }, 15000);
}

/* ===================== WITHDRAW ===================== */
app.post('/api/withdraw', auth, actLimiter, (req, res) => {
  const pend = Object.values(db.withdrawals).filter(w => w.userId === req.user.id && w.status === 'pending').length;
  if (pend >= 5) throw new HttpError(400, 'Too many pending withdrawals');
  const picks = pickItems(req.user, (req.body || {}).itemIds, 30);
  const items = picks.map(snap); removeItems(req.user, picks);
  const id = rid(6);
  db.withdrawals[id] = { id, userId: req.user.id, username: req.user.username, items, status: 'pending', at: Date.now() };
  ledger(req.user, 'Withdraw', id, -sumVal(items));
  save(); pushMe(req.user);
  res.json({ ok: true, id, joinLink: BOT.joinLink });
});

/* ===================== BOT API (secret korumalı) ===================== */
function botAuth(req, res, next) {
  if (!BOT_SECRET) return res.status(503).json({ error: 'Bot API disabled' });
  const a = Buffer.from(sha(String(req.headers['x-bot-secret'] || ''))), b = Buffer.from(sha(BOT_SECRET));
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
app.post('/api/bot/deposit', botAuth, (req, res) => {
  const { txId, robloxId, itemId } = req.body || {};
  const qty = Math.floor(Number((req.body || {}).qty) || 1);
  if (typeof txId !== 'string' || txId.length < 4 || qty < 1 || qty > 50) throw new HttpError(400, 'Bad request');
  if (db.tx.includes(txId)) return res.json({ ok: true, duplicate: true });
  const u = db.users[String(robloxId)]; const c = db.catalog[itemId];
  if (!u || !c) throw new HttpError(404, 'User or item not found');
  db.tx.push(txId); if (db.tx.length > 5000) db.tx.shift();
  for (let i = 0; i < qty; i++) u.inventory.push({ uid: rid(8), itemId });
  ledger(u, 'Deposit', txId.slice(0, 24), c.value * qty);
  save(); pushMe(u); notify(u, 'ok', `Deposit received: ${qty}x ${c.name}`);
  res.json({ ok: true });
});
app.get('/api/bot/withdrawals', botAuth, (req, res) => res.json({ withdrawals: Object.values(db.withdrawals).filter(w => w.status === 'pending') }));
app.post('/api/bot/withdrawals/:id/complete', botAuth, (req, res) => {
  const w = db.withdrawals[req.params.id];
  if (!w || w.status !== 'pending') throw new HttpError(409, 'Not pending');
  w.status = 'completed'; w.doneAt = Date.now(); save(); res.json({ ok: true });
});
app.post('/api/bot/withdrawals/:id/reject', botAuth, (req, res) => {
  const w = db.withdrawals[req.params.id];
  if (!w || w.status !== 'pending') throw new HttpError(409, 'Not pending');
  w.status = 'rejected'; w.doneAt = Date.now();
  const u = db.users[w.userId];
  if (u) { w.items.forEach(it => u.inventory.push(unsnap(it))); ledger(u, 'Withdraw Refund', w.id, sumVal(w.items)); pushMe(u); }
  save(); res.json({ ok: true });
});

/* ===================== ADMIN (gizli panel + API) ===================== */
const admin = express.Router();
admin.use(auth, adminOnly);
const alog = (req, a, d) => { db.adminLog.unshift({ at: Date.now(), by: req.user.username, a, d }); if (db.adminLog.length > 300) db.adminLog.length = 300; console.log('[ADMIN]', req.user.username, a, d); };

admin.get('/panel.js', (req, res) => {
  res.set('Cache-Control', 'no-store').type('application/javascript').send(fs.readFileSync(path.join(__dirname, 'admin-panel.js'), 'utf8'));
});
function cleanItem(b) {
  b = b || {};
  const name = String(b.name || '').trim().slice(0, 40);
  if (name.length < 2) throw new HttpError(400, 'Name too short');
  const img = String(b.img || '').trim();
  if (img && !/^https:\/\/[^\s"'<>]{4,480}$/i.test(img)) throw new HttpError(400, 'Image URL must be a valid https link');
  const value = Number(b.value);
  if (!isFinite(value) || value < 0 || value > 1e9) throw new HttpError(400, 'Invalid value');
  const variant = ['normal', 'neon', 'mega'].includes(b.variant) ? b.variant : 'normal';
  const fly = !!b.fly, ride = !!b.ride;
  return { name, img, value: r2(value), variant, fly, ride, tag: makeTag(variant, fly, ride) };
}
admin.get('/catalog', (req, res) => res.json({ items: Object.values(db.catalog).filter(c => !c.hidden).sort((a, b) => b.value - a.value) }));
admin.post('/catalog', (req, res) => {
  const c = cleanItem(req.body); const id = 'c_' + rid(5);
  db.catalog[id] = { id, ...c, hidden: false, createdAt: Date.now() };
  alog(req, 'catalog.add', c.name); save(); res.json({ item: db.catalog[id] });
});
admin.put('/catalog/:id', (req, res) => {
  const it = db.catalog[req.params.id]; if (!it) throw new HttpError(404, 'Not found');
  Object.assign(it, cleanItem(req.body)); alog(req, 'catalog.edit', it.name); save(); io.emit('refresh:me'); res.json({ item: it });
});
admin.delete('/catalog/:id', (req, res) => {
  const it = db.catalog[req.params.id]; if (!it) throw new HttpError(404, 'Not found');
  it.hidden = true; alog(req, 'catalog.hide', it.name); save(); res.json({ ok: true });
});
async function ensureUser(name) {
  name = String(name || '').trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) throw new HttpError(400, 'Invalid username');
  const f = Object.values(db.users).find(u => u.username.toLowerCase() === name.toLowerCase());
  if (f) return f;
  let info; try { info = await resolveUsername(name); } catch { throw new HttpError(502, 'Roblox not responding'); }
  if (!info) throw new HttpError(404, 'Roblox user not found');
  if (db.users[info.id]) return db.users[info.id];
  const [a, b] = await Promise.all([getThumb(info.id), getThumb(info.id, 'avatar-bust', '420x420')]);
  return db.users[info.id] || (db.users[info.id] = newUser(info, a, b));
}
admin.post('/give', ah(async (req, res) => {
  const u = await ensureUser((req.body || {}).username);
  const c = db.catalog[(req.body || {}).itemId];
  const qty = Math.floor(Number((req.body || {}).qty) || 1);
  if (!c || c.hidden) throw new HttpError(404, 'Item not found');
  if (qty < 1 || qty > 50) throw new HttpError(400, 'Qty 1-50');
  for (let i = 0; i < qty; i++) u.inventory.push({ uid: rid(8), itemId: c.id });
  ledger(u, 'Deposit', 'admin-' + rid(4), c.value * qty);
  alog(req, 'give', `${qty}x ${c.name} -> ${u.username}`); save(); pushMe(u);
  notify(u, 'ok', `${qty}x ${c.name} added to your inventory!`);
  res.json({ ok: true, user: { id: u.id, username: u.username } });
}));
admin.get('/user', ah(async (req, res) => {
  const u = await ensureUser(req.query.name);
  res.json({ user: { id: u.id, username: u.username, avatar: u.avatar, banned: !!u.banned, stats: u.stats, inventory: u.inventory.map(snap) } });
}));
admin.post('/remove', (req, res) => {
  const u = db.users[String((req.body || {}).userId)]; if (!u) throw new HttpError(404, 'User not found');
  const i = u.inventory.findIndex(x => x.uid === (req.body || {}).uid); if (i < 0) throw new HttpError(404, 'Item not found');
  const [rem] = u.inventory.splice(i, 1); alog(req, 'remove', `${db.catalog[rem.itemId].name} from ${u.username}`);
  save(); pushMe(u); res.json({ ok: true });
});
admin.post('/ban', (req, res) => {
  const u = db.users[String((req.body || {}).userId)]; if (!u) throw new HttpError(404, 'User not found');
  if (isAdmin(u)) throw new HttpError(400, 'Cannot ban admin');
  u.banned = !!(req.body || {}).banned;
  if (u.banned) for (const [k, s] of Object.entries(db.sessions)) if (s.userId === u.id) delete db.sessions[k];
  alog(req, 'ban', `${u.username}=${u.banned}`); save(); res.json({ ok: true });
});
admin.get('/users', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  res.json({ users: Object.values(db.users).filter(u => !q || u.username.toLowerCase().includes(q)).slice(0, 100).map(u => ({ id: u.id, username: u.username, banned: !!u.banned, bet: u.stats.bet, items: u.inventory.length })) });
});
app.use('/api/admin', admin);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  const status = err.status && err.status < 500 ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Server error' : err.message });
});

/* ===================== SOCKET.IO ===================== */
io.use((socket, next) => {
  const tok = socket.handshake.auth && socket.handshake.auth.token;
  const u = tok ? userFromToken(String(tok)) : null;
  socket.user = u && !u.banned ? u : null;
  socket.th = tok ? sha(String(tok)) : '';
  next();
});
const chatLast = new Map();
io.on('connection', socket => {
  if (socket.user) { socket.join('user:' + socket.user.id); socket.emit('me', mePayload(socket.user)); }
  socket.emit('init', {
    serverTime: Date.now(), matches: Object.values(db.matches).map(pubMatch),
    giveaways: Object.values(db.giveaways).map(pubGW), chat: db.chat.slice(-50), online: io.engine.clientsCount
  });
  io.emit('online', io.engine.clientsCount);
  socket.on('chat:send', (text, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const u = socket.user && db.users[socket.user.id];
    if (!u || u.banned || !db.sessions[socket.th]) return ack({ error: 'Login required' });
    if (typeof text !== 'string') return ack({ error: 'Invalid message' });
    text = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!text) return ack({ error: 'Empty message' });
    const last = chatLast.get(u.id) || 0;
    if (Date.now() - last < 1500) return ack({ error: 'Slow down!' });
    chatLast.set(u.id, Date.now());
    if (isAdmin(u) && text === '/clear') { db.chat = []; io.emit('chat:clear'); return ack({ ok: true }); }
    const msg = { id: rid(6), user: { ...pubUser(u), admin: isAdmin(u) }, text, at: Date.now() };
    db.chat.push(msg); if (db.chat.length > 60) db.chat.shift();
    io.emit('chat', msg); save(); ack({ ok: true });
  });
  socket.on('disconnect', () => io.emit('online', io.engine.clientsCount));
});

/* ===================== BOOT ===================== */
for (const m of Object.values(db.matches)) {
  if (m.state === 'finished') { delete db.matches[m.id]; continue; }
  if (m.state !== 'waiting') scheduleMatch(m);
}
for (const g of Object.values(db.giveaways)) { if (g.status === 'ended') delete db.giveaways[g.id]; else scheduleGW(g); }
server.listen(PORT, () => console.log('AMP ROLL backend running on :' + PORT));
const bye = () => { saveNow(); process.exit(0); };
process.on('SIGTERM', bye); process.on('SIGINT', bye);
