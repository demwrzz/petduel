'use strict';
/* =====================================================================
   AMP ROLL - server.js  (tek dosya backend + site sunucusu)
   Bellek içi (memory) durum: Render free'de restart olunca her şey silinir.
   ===================================================================== */
const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

/* ------------------------------ CONFIG ------------------------------ */
const E = process.env;
const PORT = Number(E.PORT) || 3000;
const BOT_NAME = 'DedokAmp';
const BOT_LINK = 'https://www.roblox.com/share?code=a0dd8a7bc68f034b99e078f454d4e903&type=Server';
const BOT_SECRET = E.BOT_SECRET || '';

const ADMIN_USERS = new Set((E.ADMIN_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const ADMIN_IDS = new Set((E.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
if (!ADMIN_USERS.size && !ADMIN_IDS.size) ADMIN_USERS.add('dedokxxreal');

let RANGE = parseFloat(E.JOIN_RANGE);
if (!(RANGE >= 0 && RANGE <= 1)) RANGE = 0.10;

const MAX_ITEMS = 8;
const MAX_OPEN_MATCHES = 3;
const LOBBY_CAP = 150;
const COUNTDOWN_MS = 3000;
const FLIP_MS = 3600;
const FINISHED_SHOW_MS = 20000;

const GA_MAX_ITEMS = 5;
const GA_MAX_PER_USER = 3;
const GA_MAX_TOTAL = 20;
const GA_EASY = [30, 120, 300];

/* ------------------------------ STATE ------------------------------- */
const S = {
  users: {},            // internalId -> user
  byRoblox: {},         // robloxId -> internalId
  sessions: new Map(),  // sha256(token) -> {uid, exp}
  pending: new Map(),   // login codes
  catalog: {},          // id -> {id,name,image,value,age,fly,ride}
  matches: {},          // id -> match
  giveaways: {},        // id -> giveaway
  chat: [],
  history: [],          // biten maçlar (public görünüm)
  withdrawals: [],
  refs: {}              // bot deposit ref'leri (idempotent)
};
const lastChat = new Map();
let txCounter = 0;

/* ------------------------------ HELPERS ----------------------------- */
class HttpError extends Error {
  constructor(msg, code) { super(msg); this.status = code || 400; }
}
const fail = (msg, code) => { throw new HttpError(msg, code); };
const round2 = n => Math.round(n * 100) / 100;
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const hmac = (key, msg) => crypto.createHmac('sha256', String(key)).update(String(msg)).digest('hex');
const rid = (n = 8) => crypto.randomBytes(n).toString('hex');
const now = () => Date.now();
const h = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

function isAdmin(u) {
  if (!u) return false;
  return ADMIN_USERS.has(String(u.username).toLowerCase()) || ADMIN_IDS.has(String(u.robloxId));
}

/* ------------------------------ ITEMS ------------------------------- */
function snap(c) {
  return { catalogId: c.id, name: c.name, image: c.image, value: c.value, age: c.age, fly: !!c.fly, ride: !!c.ride };
}
function newItem(c) { return Object.assign({ uid: rid(8) }, snap(c)); }
function itemPub(it) {
  return {
    catalogId: it.catalogId, name: it.name, image: it.image, img: it.image, value: it.value,
    age: it.age, neon: it.age === 'neon', mega: it.age === 'mega', fly: !!it.fly, ride: !!it.ride, qty: 1
  };
}
function itemInv(it) {
  return Object.assign(itemPub(it), { id: it.uid, uid: it.uid, catalogId: it.uid, realCatalogId: it.catalogId });
}
const sumValue = items => round2(items.reduce((a, i) => a + i.value, 0));

function takeItems(user, uids, max) {
  if (!Array.isArray(uids) || !uids.length) fail('Select at least one item');
  if (uids.length > max) fail('You can select at most ' + max + ' items');
  const set = new Set();
  for (const u of uids) {
    if (typeof u !== 'string') fail('Bad selection');
    if (set.has(u)) fail('Duplicate item in selection');
    set.add(u);
  }
  const taken = user.inventory.filter(i => set.has(i.uid));
  if (taken.length !== set.size) fail('Some items are not in your inventory');
  user.inventory = user.inventory.filter(i => !set.has(i.uid));
  return taken;
}
function giveItems(user, items) {
  for (const it of items) user.inventory.push(Object.assign({}, it, { uid: rid(8) }));
}
function selectionToUids(user, body, max) {
  if (body && Array.isArray(body.uids)) return body.uids;
  if (body && Array.isArray(body.items)) {
    const out = [], used = new Set();
    for (const e of body.items.slice(0, 50)) {
      if (!e || typeof e.catalogId !== 'string') fail('Bad selection');
      const q = Math.max(1, Math.min(max, parseInt(e.qty, 10) || 1));
      const direct = user.inventory.find(i => i.uid === e.catalogId && !used.has(i.uid));
      if (direct) { used.add(direct.uid); out.push(direct.uid); continue; }
      let n = 0;
      for (const i of user.inventory) {
        if (n >= q) break;
        if (i.catalogId === e.catalogId && !used.has(i.uid)) { used.add(i.uid); out.push(i.uid); n++; }
      }
      if (!n) fail('Item not found in your inventory');
    }
    return out;
  }
  return fail('Select at least one item');
}

/* ------------------------------ USERS ------------------------------- */
function userPub(u) { return { id: u.id, robloxId: u.robloxId, username: u.username, avatar: u.avatar || '' }; }

function addTx(user, type, detail, amount, extra) {
  user.tx.push(Object.assign({
    id: ++txCounter, type, game: 'Coinflip', detail: detail || '', amount: round2(amount), value: round2(amount), ts: now()
  }, extra || {}));
  if (user.tx.length > 500) user.tx.shift();
}

function meView(u) {
  const inv = u.inventory.map(itemInv);
  const total = sumValue(u.inventory);
  return {
    id: u.id, robloxId: u.robloxId, username: u.username, avatar: u.avatar || '',
    isAdmin: isAdmin(u), balance: total, inventoryValue: total, inventory: inv,
    stats: statsOf(u)
  };
}
function statsOf(u) {
  return {
    totalBet: round2(u.stats.totalBet), totalWon: round2(u.stats.totalWon),
    profit: round2(u.stats.totalWon - u.stats.totalBet)
  };
}

/* ------------------------------ SERVER ------------------------------ */
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e4, pingTimeout: 30000 });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '50kb' }));

function emitMe(u) { if (u) io.to('u:' + u.id).emit('me:update', meView(u)); }
function emitOnline() { io.emit('online', io.engine.clientsCount); }

/* ---------------------------- SESSIONS/AUTH ------------------------- */
function userByToken(t) {
  if (typeof t !== 'string' || !/^[a-f0-9]{64}$/.test(t)) return null;
  const s = S.sessions.get(sha256(t));
  if (!s) return null;
  if (s.exp < now()) { S.sessions.delete(sha256(t)); return null; }
  return S.users[s.uid] || null;
}
function auth(req, res, next) {
  const hd = req.headers.authorization || '';
  const t = hd.startsWith('Bearer ') ? hd.slice(7).trim() : '';
  const u = userByToken(t);
  if (!u) return res.status(401).json({ error: 'Please log in' });
  req.user = u; req.token = t;
  next();
}
function adminOnly(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
  next();
}

const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts, wait a bit' } });
const actLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Slow down' } });
app.use('/api/', apiLimiter);

async function rbx(url, opts) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(url, Object.assign({ signal: ac.signal }, opts || {}));
    if (!r.ok) fail('Roblox returned an error (' + r.status + '), try again', 502);
    return await r.json();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    fail('Roblox is not responding, try again', 502);
  } finally { clearTimeout(to); }
}

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const g = () => Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join('');
  return 'AMP-' + g() + '-' + g() + '-' + g();
}

app.post('/api/auth/start', authLimiter, h(async (req, res) => {
  const name = String((req.body || {}).username || '').trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) fail('Invalid Roblox username');
  if (S.pending.size > 5000) fail('Server busy, try again later', 503);
  const r = await rbx('https://users.roblox.com/v1/usernames/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [name], excludeBannedUsers: true })
  });
  const u = r && r.data && r.data[0];
  if (!u) fail('Roblox user not found', 404);
  let avatar = '';
  try {
    const a = await rbx('https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=' + u.id + '&size=150x150&format=Png');
    const url = a && a.data && a.data[0] && a.data[0].imageUrl;
    if (typeof url === 'string' && /^https:\/\/[a-z0-9.-]+\.rbxcdn\.com\//i.test(url)) avatar = url;
  } catch (e) { /* avatar şart değil */ }
  const id = rid(16);
  const code = makeCode();
  S.pending.set(id, { robloxId: String(u.id), username: u.name, avatar, code, exp: now() + 10 * 60 * 1000, tries: 0, busy: false });
  res.json({ id, robloxId: String(u.id), username: u.name, code, avatar });
}));

app.post('/api/auth/verify', authLimiter, h(async (req, res) => {
  const b = req.body || {};
  const p = S.pending.get(String(b.id || ''));
  if (!p || p.exp < now()) fail('Code expired, start again');
  if (p.busy) fail('Already verifying, wait a second');
  if (String(b.code || '').trim() !== p.code) fail('Invalid code');
  if (++p.tries > 8) { S.pending.delete(String(b.id)); fail('Too many tries, start again'); }
  p.busy = true;
  let info;
  try {
    info = await rbx('https://users.roblox.com/v1/users/' + encodeURIComponent(p.robloxId));
  } finally { p.busy = false; }
  if (S.pending.get(String(b.id)) !== p) fail('Code expired, start again');
  const desc = String((info && info.description) || '');
  if (!desc.includes(p.code)) fail('Code not found in your Roblox About description. Save it and try again.');
  S.pending.delete(String(b.id));

  let user = S.users[S.byRoblox[p.robloxId]];
  if (!user) {
    user = {
      id: 'u' + rid(6), robloxId: p.robloxId, username: p.username, avatar: p.avatar,
      createdAt: now(), inventory: [], tx: [], stats: { totalBet: 0, totalWon: 0 }
    };
    S.users[user.id] = user;
    S.byRoblox[p.robloxId] = user.id;
  } else {
    user.username = (info && info.name) || p.username;
    if (p.avatar) user.avatar = p.avatar;
  }
  const token = rid(32);
  S.sessions.set(sha256(token), { uid: user.id, exp: now() + 30 * 24 * 3600 * 1000 });
  res.json({ token, user: meView(user) });
}));

app.post('/api/auth/logout', auth, (req, res) => {
  S.sessions.delete(sha256(req.token));
  res.json({ ok: true });
});

/* ------------------------------ VIEWS ------------------------------- */
function matchView(m) {
  const v = {
    id: m.id, state: m.state, status: m.state, hash: m.hash,
    host: m.host, joiner: m.joiner || null, opp: m.joiner || null,
    hostSide: m.hostSide, joinSide: m.joinSide,
    hostItems: m.hostItems.map(itemPub),
    joinerItems: m.joinerItems.map(itemPub),
    oppItems: m.joinerItems.map(itemPub),
    hostValue: m.hostValue, oppValue: m.oppValue, joinerValue: m.oppValue,
    value: round2(m.hostValue + m.oppValue),
    createdAt: m.createdAt, countdownEnd: m.countdownEnd || null
  };
  if (m.state === 'finished') {
    v.winnerSide = m.winnerSide; v.result = m.result; v.winnerId = m.winnerId;
    v.winner = m.winner; v.seed = m.seed; v.finishedAt = m.finishedAt;
  }
  return v;
}
function giveawayView(g) {
  return {
    id: g.id, mode: g.mode, host: g.host, items: g.items.map(itemPub), value: g.value,
    minBet: g.minBet, createdAt: g.createdAt, endsAt: g.endsAt,
    entrants: Array.from(g.entrants), entries: g.entrants.size, count: g.entrants.size
  };
}
const emitMatch = (ev, m) => io.emit(ev, matchView(m));

/* ------------------------------ PUBLIC API -------------------------- */
app.get('/api/state', (req, res) => {
  res.json({
    matches: Object.values(S.matches).sort((a, b) => a.createdAt - b.createdAt).map(matchView),
    giveaways: Object.values(S.giveaways).map(giveawayView),
    chat: S.chat.slice(-50),
    online: io.engine.clientsCount,
    bot: { name: BOT_NAME, link: BOT_LINK },
    config: { range: RANGE, maxItems: MAX_ITEMS }
  });
});

app.get('/api/me', auth, (req, res) => {
  const v = meView(req.user);
  res.json(Object.assign({ user: v }, v));
});

app.get('/api/profile', auth, (req, res) => {
  const u = req.user;
  const per = 6;
  const all = u.tx.slice().reverse();
  const pages = Math.max(1, Math.ceil(all.length / per));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
  res.json({
    user: { id: u.id, robloxId: u.robloxId, username: u.username, avatar: u.avatar, createdAt: u.createdAt },
    stats: statsOf(u),
    rows: all.slice((page - 1) * per, page * per),
    page, pages
  });
});

app.get('/api/history/me', auth, (req, res) => {
  const uid = req.user.id;
  const list = [];
  for (let i = S.history.length - 1; i >= 0 && list.length < 50; i--) {
    const m = S.history[i];
    if (m.host.id === uid || (m.joiner && m.joiner.id === uid)) list.push(m);
  }
  res.json({ history: list });
});

/* ------------------------------ COINFLIP ---------------------------- */
function openMatchesOf(uid) {
  return Object.values(S.matches).filter(m => m.host.id === uid && m.state !== 'finished').length;
}

app.post('/api/match/create', auth, actLimiter, (req, res) => {
  const u = req.user, b = req.body || {};
  const side = b.side === 'cat' ? 'cat' : b.side === 'dog' ? 'dog' : null;
  if (!side) fail('Pick a side');
  if (Object.keys(S.matches).length >= LOBBY_CAP) fail('Lobby is full, try again soon', 503);
  if (openMatchesOf(u.id) >= MAX_OPEN_MATCHES) fail('You can have at most ' + MAX_OPEN_MATCHES + ' open matches');
  const uids = selectionToUids(u, b, MAX_ITEMS);
  const items = takeItems(u, uids, MAX_ITEMS);
  const value = sumValue(items);
  const seed = rid(32);
  const m = {
    id: rid(6), state: 'waiting', seed, hash: sha256(seed),
    host: userPub(u), joiner: null,
    hostSide: side, joinSide: side === 'dog' ? 'cat' : 'dog',
    hostItems: items, joinerItems: [], hostValue: value, oppValue: 0,
    createdAt: now(), countdownEnd: 0
  };
  S.matches[m.id] = m;
  u.stats.totalBet += value;
  addTx(u, 'Bet', 'Created match #' + m.id, -value, { matchId: m.id });
  emitMatch('match:new', m);
  emitMe(u);
  res.json({ ok: true, match: matchView(m), user: meView(u) });
});

app.post('/api/match/join', auth, actLimiter, (req, res) => {
  const u = req.user, b = req.body || {};
  const m = S.matches[String(b.id || '')];
  if (!m) fail('Match not found', 404);
  if (m.state !== 'waiting') fail('Match already started');
  if (m.host.id === u.id) fail('You cannot join your own match');
  const uids = selectionToUids(u, b, MAX_ITEMS);
  // değer kontrolü, item'lar çekilmeden önce (hata olursa kaybolmasın)
  const set = new Set(uids);
  if (set.size !== uids.length) fail('Duplicate item in selection');
  const pick = u.inventory.filter(i => set.has(i.uid));
  if (pick.length !== set.size) fail('Some items are not in your inventory');
  if (pick.length > MAX_ITEMS) fail('You can select at most ' + MAX_ITEMS + ' items');
  const v = sumValue(pick);
  const lo = m.hostValue * (1 - RANGE) - 1e-9, hi = m.hostValue * (1 + RANGE) + 1e-9;
  if (v < lo || v > hi) fail('Your value must be between ' + round2(m.hostValue * (1 - RANGE)) + ' and ' + round2(m.hostValue * (1 + RANGE)));

  const items = takeItems(u, uids, MAX_ITEMS);
  m.joiner = userPub(u);
  m.joinerItems = items;
  m.oppValue = v;
  m.state = 'countdown';
  m.countdownEnd = now() + COUNTDOWN_MS;
  u.stats.totalBet += v;
  addTx(u, 'Bet', 'Joined match #' + m.id, -v, { matchId: m.id });
  emitMatch('match:update', m);
  emitMe(u);

  setTimeout(() => {
    if (m.state !== 'countdown') return;
    m.state = 'flipping';
    emitMatch('match:update', m);
    setTimeout(() => finishMatch(m), FLIP_MS);
  }, COUNTDOWN_MS);

  res.json({ ok: true, match: matchView(m), user: meView(u) });
});

function finishMatch(m) {
  if (m.state === 'finished' || !S.matches[m.id]) return;
  const r = parseInt(hmac(m.seed, m.id).slice(0, 8), 16) / 4294967296;
  const result = r < 0.5 ? 'dog' : 'cat';
  const hostWins = m.hostSide === result;
  const winnerPub = hostWins ? m.host : m.joiner;
  const loserPub = hostWins ? m.joiner : m.host;
  const winnerUser = S.users[winnerPub.id];
  const loserUser = S.users[loserPub.id];
  const pot = m.hostItems.concat(m.joinerItems);
  const potValue = round2(m.hostValue + m.oppValue);

  if (winnerUser) {
    giveItems(winnerUser, pot);
    winnerUser.stats.totalWon += potValue;
    addTx(winnerUser, 'Win', 'Won match #' + m.id, potValue, { matchId: m.id });
  }
  if (loserUser) addTx(loserUser, 'Loss', 'Lost match #' + m.id, 0, { matchId: m.id });

  m.state = 'finished';
  m.result = result; m.winnerSide = result;
  m.winnerId = winnerPub.id; m.winner = winnerPub;
  m.finishedAt = now();

  S.history.push(matchView(m));
  if (S.history.length > 2000) S.history.splice(0, S.history.length - 2000);

  emitMatch('match:update', m);
  emitMe(winnerUser); emitMe(loserUser);

  setTimeout(() => {
    delete S.matches[m.id];
    io.emit('match:remove', { id: m.id });
  }, FINISHED_SHOW_MS);
}

app.post('/api/match/cancel', auth, actLimiter, (req, res) => {
  const u = req.user;
  const m = S.matches[String((req.body || {}).id || '')];
  if (!m) fail('Match not found', 404);
  if (m.host.id !== u.id) fail('Not your match', 403);
  if (m.state !== 'waiting') fail('Match already started');
  delete S.matches[m.id];
  giveItems(u, m.hostItems);
  u.stats.totalBet -= m.hostValue;
  addTx(u, 'Refund', 'Cancelled match #' + m.id, m.hostValue, { matchId: m.id });
  io.emit('match:remove', { id: m.id });
  emitMe(u);
  res.json({ ok: true, user: meView(u) });
});

/* ------------------------------ GIVEAWAYS --------------------------- */
function systemChat(text) {
  const msg = { id: rid(6), userId: 'system', username: 'AMP ROLL', avatar: '', text, ts: now(), admin: true, system: true };
  S.chat.push(msg);
  if (S.chat.length > 60) S.chat.shift();
  io.emit('chat:msg', msg);
}

app.post('/api/giveaway/create', auth, actLimiter, (req, res) => {
  const u = req.user, b = req.body || {};
  const mode = b.mode === 'advanced' ? 'advanced' : 'easy';
  const duration = parseInt(b.duration, 10);
  let minBet = 0;
  if (mode === 'easy') {
    if (!GA_EASY.includes(duration)) fail('Invalid duration');
  } else {
    if (!(duration >= 60 && duration <= 3600)) fail('Duration must be 60-3600 seconds');
    minBet = Number(b.minBet) || 0;
    if (!isFinite(minBet) || minBet < 0 || minBet > 1e9) fail('Invalid minimum bet');
    minBet = round2(minBet);
  }
  const mine = Object.values(S.giveaways).filter(g => g.host.id === u.id).length;
  if (mine >= GA_MAX_PER_USER) fail('You can have at most ' + GA_MAX_PER_USER + ' giveaways');
  if (Object.keys(S.giveaways).length >= GA_MAX_TOTAL) fail('Too many active giveaways, try later', 503);
  const uids = selectionToUids(u, b, GA_MAX_ITEMS);
  const items = takeItems(u, uids, GA_MAX_ITEMS);
  const value = sumValue(items);
  const g = {
    id: rid(6), mode, host: userPub(u), items, value, minBet,
    createdAt: now(), endsAt: now() + duration * 1000, entrants: new Set()
  };
  S.giveaways[g.id] = g;
  addTx(u, 'Giveaway', 'Created giveaway #' + g.id, -value, { game: 'Giveaway' });
  io.emit('giveaway:new', giveawayView(g));
  emitMe(u);
  setTimeout(() => endGiveaway(g.id), duration * 1000);
  res.json({ ok: true, giveaway: giveawayView(g), user: meView(u) });
});

app.post('/api/giveaway/enter', auth, actLimiter, (req, res) => {
  const u = req.user;
  const g = S.giveaways[String((req.body || {}).id || '')];
  if (!g) fail('Giveaway not found', 404);
  if (g.endsAt <= now()) fail('Giveaway already ended');
  if (g.host.id === u.id) fail('You cannot enter your own giveaway');
  if (g.entrants.has(u.id)) fail('Already entered');
  if (u.stats.totalBet < g.minBet) fail('You need at least ' + g.minBet + ' total wagered to enter');
  g.entrants.add(u.id);
  io.emit('giveaway:update', giveawayView(g));
  res.json({ ok: true });
});

function endGiveaway(id) {
  const g = S.giveaways[id];
  if (!g) return;
  delete S.giveaways[id];
  const host = S.users[g.host.id];
  const ids = Array.from(g.entrants).filter(x => S.users[x]);
  if (!ids.length) {
    if (host) {
      giveItems(host, g.items);
      addTx(host, 'Refund', 'Giveaway #' + g.id + ' had no entrants', g.value, { game: 'Giveaway' });
      emitMe(host);
    }
  } else {
    const w = S.users[ids[crypto.randomInt(ids.length)]];
    giveItems(w, g.items);
    addTx(w, 'Giveaway', 'Won giveaway #' + g.id, g.value, { game: 'Giveaway' });
    emitMe(w);
    systemChat('🎁 ' + w.username + ' won a giveaway worth ' + g.value + ' gems from ' + g.host.username + '!');
  }
  io.emit('giveaway:remove', { id: g.id });
}

/* ------------------------------ WITHDRAW ---------------------------- */
app.post('/api/withdraw', auth, actLimiter, (req, res) => {
  const u = req.user;
  const uids = selectionToUids(u, req.body || {}, 500);
  const items = takeItems(u, uids, 500);
  const value = sumValue(items);
  const w = {
    id: rid(6), userId: u.id, robloxId: u.robloxId, username: u.username,
    items, value, status: 'pending', ts: now()
  };
  S.withdrawals.push(w);
  if (S.withdrawals.length > 5000) S.withdrawals = S.withdrawals.filter(x => x.status === 'pending').concat(S.withdrawals.filter(x => x.status !== 'pending').slice(-2000));
  addTx(u, 'Withdraw', 'Withdraw request #' + w.id + ' (' + items.length + ' items)', -value, { game: 'Wallet' });
  emitMe(u);
  res.json({ ok: true, id: w.id, bot: BOT_NAME, user: meView(u) });
});

function failWithdrawal(w) {
  if (w.status !== 'pending') return false;
  w.status = 'failed';
  const u = S.users[w.userId];
  if (u) {
    giveItems(u, w.items);
    addTx(u, 'Refund', 'Withdraw #' + w.id + ' refunded', w.value, { game: 'Wallet' });
    emitMe(u);
  }
  return true;
}

/* ------------------------------ BOT API ----------------------------- */
function botAuth(req, res, next) {
  if (!BOT_SECRET) return res.status(503).json({ error: 'Bot API disabled' });
  const given = String(req.headers['x-bot-secret'] || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(BOT_SECRET).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Bad secret' });
  next();
}

app.post('/api/bot/deposit', botAuth, (req, res) => {
  const b = req.body || {};
  const ref = String(b.ref || '');
  if (!ref || ref.length > 100) fail('ref required');
  if (S.refs[ref]) return res.json({ ok: true, duplicate: true });
  const uid = S.byRoblox[String(b.robloxId || '')];
  const user = S.users[uid];
  if (!user) fail('User not registered on the site', 404);
  const c = S.catalog[String(b.catalogId || '')];
  if (!c) fail('Unknown catalog item', 404);
  const qty = parseInt(b.qty, 10);
  if (!(qty >= 1 && qty <= 100)) fail('Bad qty');
  if (user.inventory.length + qty > 5000) fail('Inventory full');
  for (let i = 0; i < qty; i++) user.inventory.push(newItem(c));
  S.refs[ref] = now();
  addTx(user, 'Deposit', 'Deposited ' + qty + 'x ' + c.name, c.value * qty, { game: 'Wallet' });
  emitMe(user);
  res.json({ ok: true });
});

app.get('/api/bot/withdrawals', botAuth, (req, res) => {
  res.json({
    withdrawals: S.withdrawals.filter(w => w.status === 'pending').map(w => ({
      id: w.id, userId: w.userId, robloxId: w.robloxId, username: w.username, ts: w.ts, value: w.value,
      items: w.items.map(itemPub)
    }))
  });
});

app.post('/api/bot/withdrawals/done', botAuth, (req, res) => {
  const w = S.withdrawals.find(x => x.id === String((req.body || {}).id || ''));
  if (!w) fail('Not found', 404);
  if (w.status !== 'pending') fail('Not pending');
  w.status = 'done';
  res.json({ ok: true });
});

app.post('/api/bot/withdrawals/fail', botAuth, (req, res) => {
  const w = S.withdrawals.find(x => x.id === String((req.body || {}).id || ''));
  if (!w) fail('Not found', 404);
  if (!failWithdrawal(w)) fail('Not pending');
  res.json({ ok: true });
});

/* ------------------------------ ADMIN API --------------------------- */
function cleanCatalog(b) {
  const name = String(b.name || '').trim();
  if (!name || name.length > 40) fail('Name required (max 40 chars)');
  const image = String(b.image || '').trim();
  if (!/^https?:\/\/[^\s"'<>]{4,500}$/i.test(image)) fail('Image must be a valid http(s) URL');
  const value = Number(b.value);
  if (!isFinite(value) || value < 0.01 || value > 1e9) fail('Value must be between 0.01 and 1,000,000,000');
  const age = ['normal', 'neon', 'mega'].includes(b.age) ? b.age : 'normal';
  const flag = x => x === true || x === 'true' || x === 1;
  return { name, image, value: round2(value), age, fly: flag(b.fly), ride: flag(b.ride) };
}

app.get('/api/admin/ui', auth, adminOnly, (req, res) => {
  const script = '(' + adminUI.toString() + ')();';
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, script, js: script, code: script });
});

app.get('/api/admin/data', auth, adminOnly, (req, res) => {
  res.json({
    catalog: Object.values(S.catalog),
    users: Object.keys(S.users).length,
    botConfigured: !!BOT_SECRET,
    withdrawals: S.withdrawals.filter(w => w.status === 'pending').map(w => ({
      id: w.id, username: w.username, robloxId: w.robloxId, value: w.value, ts: w.ts, count: w.items.length,
      items: w.items.map(i => i.name)
    }))
  });
});

app.post('/api/admin/catalog', auth, adminOnly, (req, res) => {
  const c = Object.assign({ id: rid(5) }, cleanCatalog(req.body || {}));
  S.catalog[c.id] = c;
  res.json({ ok: true, item: c });
});

app.post('/api/admin/catalog/update', auth, adminOnly, (req, res) => {
  const b = req.body || {};
  const c = S.catalog[String(b.id || '')];
  if (!c) fail('Item not found', 404);
  Object.assign(c, cleanCatalog(b));
  const touched = new Set();
  for (const u of Object.values(S.users)) {
    for (const it of u.inventory) {
      if (it.catalogId === c.id) { Object.assign(it, snap(c)); touched.add(u); }
    }
  }
  touched.forEach(emitMe);
  res.json({ ok: true, item: c });
});

app.post('/api/admin/catalog/delete', auth, adminOnly, (req, res) => {
  const id = String((req.body || {}).id || '');
  if (!S.catalog[id]) fail('Item not found', 404);
  delete S.catalog[id];
  res.json({ ok: true });
});

app.post('/api/admin/grant', auth, adminOnly, (req, res) => {
  const b = req.body || {};
  const uname = String(b.username || '').trim().toLowerCase();
  const user = Object.values(S.users).find(u => u.username.toLowerCase() === uname);
  if (!user) fail('User not found (they must log in once first)', 404);
  const c = S.catalog[String(b.catalogId || '')];
  if (!c) fail('Catalog item not found', 404);
  const qty = parseInt(b.qty, 10);
  if (!(qty >= 1 && qty <= 100)) fail('Qty must be 1-100');
  if (user.inventory.length + qty > 5000) fail('Inventory full');
  for (let i = 0; i < qty; i++) user.inventory.push(newItem(c));
  addTx(user, 'Deposit', 'Admin grant ' + qty + 'x ' + c.name, c.value * qty, { game: 'Wallet' });
  emitMe(user);
  res.json({ ok: true });
});

app.post('/api/admin/withdrawals/refund', auth, adminOnly, (req, res) => {
  const w = S.withdrawals.find(x => x.id === String((req.body || {}).id || ''));
  if (!w) fail('Not found', 404);
  if (!failWithdrawal(w)) fail('Not pending');
  res.json({ ok: true });
});

/* Admin paneli: sadece doğrulanmış admin'e /api/admin/ui ile gönderilir.
   Sayfa kaynağında YOKTUR. Fonksiyon serileştirilip tarayıcıda çalışır. */
function adminUI() {
  const AMP = window.AMP || {};
  const esc = AMP.esc || (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const toast = AMP.toast || (m => alert(m));

  const old = document.getElementById('adm'); if (old) old.remove();
  const oldS = document.getElementById('adm-style'); if (oldS) oldS.remove();

  const st = document.createElement('style');
  st.id = 'adm-style';
  st.textContent =
    '#adm{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.7);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:30px 12px;font-family:Inter,system-ui,sans-serif;color:#e8eaf0}' +
    '#adm .adm-box{width:100%;max-width:820px;background:#161a22;border:1px solid #262c38;border-radius:16px;padding:18px}' +
    '#adm .adm-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-size:18px}' +
    '#adm h3{margin:18px 0 8px;font-size:14px;color:#00efa0;text-transform:uppercase;letter-spacing:.05em}' +
    '#adm input,#adm select{background:#101218;border:1px solid #2a3140;color:#e8eaf0;border-radius:10px;padding:9px 11px;font-size:14px;outline:none;min-width:0}' +
    '#adm input:focus,#adm select:focus{border-color:#00efa0}' +
    '#adm .adm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;align-items:center}' +
    '#adm .adm-row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}' +
    '#adm .adm-btn{background:#00efa0;color:#03140d;border:0;border-radius:10px;padding:9px 14px;font-weight:700;cursor:pointer;font-size:13px}' +
    '#adm .adm-btn.ghost{background:#222938;color:#e8eaf0}' +
    '#adm .adm-btn.red{background:#ef4444;color:#fff}' +
    '#adm .adm-btn.sm{padding:6px 10px;font-size:12px}' +
    '#adm .adm-x{background:#222938;color:#e8eaf0;border:0;border-radius:8px;width:32px;height:32px;cursor:pointer}' +
    '#adm .adm-item{display:flex;align-items:center;gap:10px;background:#101218;border:1px solid #232a37;border-radius:12px;padding:8px 10px;margin-bottom:6px}' +
    '#adm .adm-item img{width:40px;height:40px;object-fit:contain;border-radius:8px;background:#0b0d12}' +
    '#adm .adm-item .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '#adm .tg{display:inline-block;font-size:10px;font-weight:800;border-radius:5px;padding:1px 5px;margin-left:3px;color:#fff}' +
    '#adm .muted{color:#8b93a5;font-size:13px}' +
    '#adm label{display:flex;align-items:center;gap:6px;font-size:14px}';
  document.head.appendChild(st);

  const root = document.createElement('div');
  root.id = 'adm';
  root.innerHTML = '<div class="adm-box"><div class="adm-head"><b>Admin Panel</b><button class="adm-x" data-a="close">✕</button></div><div id="adm-body" class="muted">Loading…</div></div>';
  document.body.appendChild(root);

  let DATA = { catalog: [], withdrawals: [], users: 0 };
  let editing = null;

  function tok() {
    try {
      if (AMP.token) return typeof AMP.token === 'function' ? AMP.token() : AMP.token;
      const re = /^[a-f0-9]{64}$/;
      for (const store of [window.localStorage, window.sessionStorage]) {
        for (let i = 0; i < store.length; i++) {
          const v = store.getItem(store.key(i));
          if (re.test(v)) return v;
          try { const j = JSON.parse(v); if (typeof j === 'string' && re.test(j)) return j; } catch (e) { }
        }
      }
    } catch (e) { }
    return '';
  }
  async function call(path, body) {
    const o = { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + tok() } };
    if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    const r = await fetch(path, o);
    let j = {}; try { j = await r.json(); } catch (e) { }
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }
  function tags(c) {
    let t = '';
    if (c.age === 'neon') t += '<span class="tg" style="background:#22c55e">N</span>';
    if (c.age === 'mega') t += '<span class="tg" style="background:#a855f7">M</span>';
    if (c.fly) t += '<span class="tg" style="background:#3b82f6">F</span>';
    if (c.ride) t += '<span class="tg" style="background:#ef4444">R</span>';
    return t;
  }
  function render() {
    const body = document.getElementById('adm-body'); if (!body) return;
    const e = editing ? DATA.catalog.find(c => c.id === editing) : null;
    let o = '<div class="muted">Registered users: ' + DATA.users + ' · Bot API: ' + (DATA.botConfigured ? 'ON' : 'OFF (set BOT_SECRET)') + '</div>';

    o += '<h3>' + (e ? 'Edit item' : 'Add item') + '</h3><div class="adm-grid">' +
      '<input id="adm-name" placeholder="Item name" maxlength="40" value="' + esc(e ? e.name : '') + '">' +
      '<input id="adm-img" placeholder="Image URL (https://...)" value="' + esc(e ? e.image : '') + '">' +
      '<input id="adm-val" type="number" step="0.01" min="0.01" placeholder="Value (gems)" value="' + (e ? e.value : '') + '">' +
      '<select id="adm-age">' + ['normal', 'neon', 'mega'].map(a => '<option value="' + a + '"' + (e && e.age === a ? ' selected' : '') + '>' + a + '</option>').join('') + '</select>' +
      '<label><input type="checkbox" id="adm-fly"' + (e && e.fly ? ' checked' : '') + '> Fly</label>' +
      '<label><input type="checkbox" id="adm-ride"' + (e && e.ride ? ' checked' : '') + '> Ride</label></div>' +
      '<div class="adm-row"><button class="adm-btn" data-a="save">' + (e ? 'Save changes' : 'Add item') + '</button>' +
      (e ? '<button class="adm-btn ghost" data-a="cancel">Cancel</button>' : '') + '</div>';

    o += '<h3>Catalog (' + DATA.catalog.length + ')</h3>';
    if (!DATA.catalog.length) o += '<div class="muted">No items yet.</div>';
    DATA.catalog.forEach(c => {
      o += '<div class="adm-item"><img src="' + esc(c.image) + '" alt=""><div class="nm">' + esc(c.name) + tags(c) +
        ' <span class="muted">· ' + c.value + ' gems</span></div>' +
        '<button class="adm-btn ghost sm" data-a="edit" data-id="' + esc(c.id) + '">Edit</button>' +
        '<button class="adm-btn red sm" data-a="del" data-id="' + esc(c.id) + '">Delete</button></div>';
    });

    o += '<h3>Grant item to user</h3><div class="adm-grid">' +
      '<input id="adm-gu" placeholder="Roblox username">' +
      '<select id="adm-gc">' + DATA.catalog.map(c => '<option value="' + esc(c.id) + '">' + esc(c.name) + ' (' + c.value + ')</option>').join('') + '</select>' +
      '<input id="adm-gq" type="number" min="1" max="100" value="1"></div>' +
      '<div class="adm-row"><button class="adm-btn" data-a="grant">Grant</button></div>';

    o += '<h3>Pending withdrawals (' + DATA.withdrawals.length + ')</h3>';
    if (!DATA.withdrawals.length) o += '<div class="muted">None.</div>';
    DATA.withdrawals.forEach(w => {
      o += '<div class="adm-item"><div class="nm"><b>' + esc(w.username) + '</b> <span class="muted">· ' + w.count + ' items · ' + w.value + ' gems · ' +
        esc(w.items.slice(0, 4).join(', ')) + (w.items.length > 4 ? '…' : '') + '</span></div>' +
        '<button class="adm-btn red sm" data-a="refund" data-id="' + esc(w.id) + '">Refund</button></div>';
    });
    body.className = '';
    body.innerHTML = o;
  }
  async function load() {
    try { DATA = await call('/api/admin/data'); render(); }
    catch (e) { const b = document.getElementById('adm-body'); if (b) b.textContent = 'Error: ' + e.message; }
  }
  const val = id => { const x = document.getElementById(id); return x ? x.value : ''; };
  const chk = id => { const x = document.getElementById(id); return !!(x && x.checked); };

  root.addEventListener('click', async ev => {
    if (ev.target === root) { root.remove(); st.remove(); return; }
    const btn = ev.target.closest('[data-a]'); if (!btn) return;
    const a = btn.dataset.a, id = btn.dataset.id;
    try {
      if (a === 'close') { root.remove(); st.remove(); return; }
      if (a === 'edit') { editing = id; render(); return; }
      if (a === 'cancel') { editing = null; render(); return; }
      if (a === 'save') {
        const body = { name: val('adm-name'), image: val('adm-img'), value: val('adm-val'), age: val('adm-age'), fly: chk('adm-fly'), ride: chk('adm-ride') };
        if (editing) { body.id = editing; await call('/api/admin/catalog/update', body); toast('Item updated'); }
        else { await call('/api/admin/catalog', body); toast('Item added'); }
        editing = null; await load(); return;
      }
      if (a === 'del') {
        if (!confirm('Delete this catalog item? (Items already owned stay in inventories)')) return;
        await call('/api/admin/catalog/delete', { id }); toast('Deleted'); await load(); return;
      }
      if (a === 'grant') {
        await call('/api/admin/grant', { username: val('adm-gu'), catalogId: val('adm-gc'), qty: val('adm-gq') });
        toast('Granted'); await load(); return;
      }
      if (a === 'refund') {
        if (!confirm('Refund this withdrawal to the user?')) return;
        await call('/api/admin/withdrawals/refund', { id }); toast('Refunded'); await load(); return;
      }
    } catch (e) { toast(e.message); }
  });

  load();
}

/* ------------------------------ SOCKET ------------------------------ */
const CLEAN_RE = /[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202f\u2060\ufeff]/g;
const LINK_RE = /(https?:\/\/|www\.|[a-z0-9-]+\.(com|net|org|gg|io|me|xyz|ru|tr|co|ly|to|gl|cc|tk|link|app|dev|info|site)\b)/i;

io.on('connection', socket => {
  const hs = socket.handshake || {};
  let user = userByToken((hs.auth && hs.auth.token) || (hs.query && hs.query.token) || '');
  if (user) socket.join('u:' + user.id);
  emitOnline();

  socket.on('auth', (t, ack) => {
    const cb = typeof ack === 'function' ? ack : () => { };
    const tk = typeof t === 'object' && t ? t.token : t;
    const u = userByToken(tk);
    if (!u) return cb({ error: 'Invalid session' });
    if (user) socket.leave('u:' + user.id);
    user = u; socket.join('u:' + u.id);
    cb({ ok: true });
  });

  socket.on('chat:send', (data, ack) => {
    const cb = typeof ack === 'function' ? ack : () => { };
    try {
      if (!user) return cb({ error: 'Log in to chat' });
      let text = typeof data === 'string' ? data : (data && data.text);
      if (typeof text !== 'string') return cb({ error: 'Invalid message' });
      text = text.replace(CLEAN_RE, '').trim().slice(0, 200);
      if (!text) return cb({ error: 'Empty message' });
      const adm = isAdmin(user);
      if (adm && text === '/clear') {
        S.chat = [];
        io.emit('chat:clear');
        return cb({ ok: true });
      }
      const last = lastChat.get(user.id) || 0;
      if (now() - last < 1200) return cb({ error: 'Slow down' });
      if (!adm && LINK_RE.test(text)) return cb({ error: 'Links are not allowed' });
      lastChat.set(user.id, now());
      const msg = { id: rid(6), userId: user.id, username: user.username, avatar: user.avatar || '', text, ts: now(), admin: adm };
      S.chat.push(msg);
      if (S.chat.length > 60) S.chat.shift();
      io.emit('chat:msg', msg);
      cb({ ok: true });
    } catch (e) { cb({ error: 'Error' }); }
  });

  socket.on('disconnect', () => setTimeout(emitOnline, 50));
});

/* ------------------------------ PAGES ------------------------------- */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

/* ------------------------------ CLEANUP ----------------------------- */
setInterval(() => {
  const t = now();
  for (const [k, p] of S.pending) if (p.exp < t) S.pending.delete(k);
  for (const [k, s] of S.sessions) if (s.exp < t) S.sessions.delete(k);
  for (const [k, v] of lastChat) if (t - v > 60000) lastChat.delete(k);
  for (const k of Object.keys(S.refs)) if (t - S.refs[k] > 7 * 24 * 3600 * 1000) delete S.refs[k];
}, 60 * 1000).unref();

process.on('unhandledRejection', e => console.error('unhandledRejection', e));

server.listen(PORT, '0.0.0.0', () => console.log('AMP ROLL running on :' + PORT));
