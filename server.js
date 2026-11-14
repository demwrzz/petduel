'use strict';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

/* ================= CONFIG ================= */

const E = process.env;
const PORT = Number(E.PORT || 3000);
const MONGODB_URI = E.MONGODB_URI || '';

const ADMIN_NAMES = (E.ADMIN_USERS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const ADMIN_IDS = (E.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean);

const BOT_NAME = 'DedokAmp';
const BOT_LINK = 'https://www.roblox.com/share?code=a0dd8a7bc68f034b99e078f454d4e903&type=Server';
const MAX_ITEMS = 8;

const DISCORD_INVITE = E.DISCORD_INVITE || 'https://discord.gg/TaPXaAseP';
/* Put the webhook URLs in Render > Environment, NOT in the code */
const WEBHOOK_GW = E.DISCORD_GW_WEBHOOK || '';
const WEBHOOK_CF = E.DISCORD_CF_WEBHOOK || '';
const MAX_GW_MINUTES = 200;

let RANGE = Number(E.JOIN_RANGE || 0.10);
if (!Number.isFinite(RANGE) || RANGE < 0 || RANGE > 1) RANGE = 0.10;

const S = {
  users: {},
  sessions: {},
  catalog: [],
  matches: {},
  history: [],
  giveaways: {},
  chat: [],
  withdrawals: [],
  announcement: null
};

const pending = new Map();
const lastChat = new Map();

/* ================= HELPERS ================= */

const now = () => Date.now();
const rid = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');
const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const round2 = n => Math.round(Number(n) * 100) / 100;
const bad = (res, message, status = 400) => res.status(status).json({ error: message });
const safeNumber = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const valueOf = items => round2(items.reduce((t, i) => t + safeNumber(i.value), 0));

const publicUser = u => ({ id: u.id, username: u.username, avatar: u.avatar || null });

/* ---------- Discord webhooks ---------- */
const clip = (v, n = 1000) => String(v ?? '').slice(0, n);

const itemLine = items => clip(
  items.map(i =>
    `${i.name}${i.age && i.age !== 'normal' ? ' (' + i.age + ')' : ''}${i.fly ? ' F' : ''}${i.ride ? ' R' : ''} - ${i.value}`
  ).join('\n') || '-'
);

function sendWebhook(url, embed) {
  if (!url) return;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'AMP ROLL',
      allowed_mentions: { parse: [] },
      embeds: [embed]
    }),
    signal: AbortSignal.timeout(8000)
  }).catch(err => console.error('Webhook error:', err.message));
}

function isAdmin(user) {
  if (!user) return false;
  return ADMIN_IDS.includes(String(user.id)) ||
    ADMIN_NAMES.includes(String(user.username).toLowerCase());
}

function rankOf(totalBet) {
  if (totalBet >= 100000) return 'Whale';
  if (totalBet >= 10000) return 'Highroller';
  if (totalBet >= 1000) return 'Roller';
  return 'Rookie';
}

function addTransaction(user, type, id, amount) {
  user.tx.unshift({ type, id, ts: now(), amount: round2(amount) });
  if (user.tx.length > 300) user.tx.length = 300;
}

function inventoryView(item) {
  return { ...item, realCatalogId: item.catalogId, catalogId: item.uid, id: item.uid, qty: 1 };
}

function meView(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatar: user.avatar || null,
    isAdmin: isAdmin(user),
    totalBet: round2(user.totalBet),
    totalWon: round2(user.totalWon),
    totalLost: round2(user.totalLost || 0),
    profit: round2(user.profit),
    rank: rankOf(user.totalBet),
    wagerLeft: round2(user.wagerLeft || 0),
    inventory: user.inventory.map(inventoryView)
  };
}

function newItem(c) {
  return {
    uid: rid(12), catalogId: c.id, name: c.name, image: c.image,
    value: c.value, age: c.age, fly: c.fly, ride: c.ride
  };
}

function publicItem(item) {
  return { ...item, id: item.uid, catalogId: item.uid, qty: 1 };
}

function selectionToUids(body) {
  if (Array.isArray(body.uids)) return body.uids;
  if (!Array.isArray(body.items)) return null;
  const ids = [];
  for (const item of body.items) {
    if (!item || typeof item !== 'object') return null;
    const id = String(item.catalogId || item.id || '');
    if (!id || Number(item.qty) !== 1) return null;
    ids.push(id);
  }
  return ids;
}

function pickItems(user, uids, max) {
  if (!Array.isArray(uids)) return null;
  if (uids.length < 1 || uids.length > max) return null;
  if (!uids.every(id => typeof id === 'string')) return null;
  if (new Set(uids).size !== uids.length) return null;
  const selected = [];
  for (const id of uids) {
    const item = user.inventory.find(x => x.uid === id);
    if (!item) return null;
    selected.push(item);
  }
  return selected;
}

/* Items are removed from the inventory in the same synchronous step
   as validation, so the same item can never be used twice (no dupe). */
function takeItems(user, uids, max) {
  const selected = pickItems(user, uids, max);
  if (!selected) return null;
  const ids = new Set(uids);
  user.inventory = user.inventory.filter(i => !ids.has(i.uid));
  return selected;
}

function ensureUser(u) {
  u.inventory = u.inventory || [];
  u.tx = u.tx || [];
  u.totalBet = u.totalBet || 0;
  u.totalWon = u.totalWon || 0;
  u.totalLost = u.totalLost || 0;
  u.profit = u.profit || 0;
  u.wagerLeft = u.wagerLeft || 0;
  return u;
}

/* ================= PERSISTENCE (optional MongoDB) ================= */

let mongoColl = null;
let dirty = false;

function markDirty() { dirty = true; }

function snapshot() {
  /* Escrowed items (open matches / giveaways) are returned to their owners
     in the snapshot, so nothing is ever lost or duplicated after a restart. */
  const users = JSON.parse(JSON.stringify(S.users));

  for (const m of Object.values(S.matches)) {
    if (m.state === 'finished') continue;
    if (users[m.host.id]) users[m.host.id].inventory.push(...JSON.parse(JSON.stringify(m.hostItems)));
    if (m.opp && users[m.opp.id]) users[m.opp.id].inventory.push(...JSON.parse(JSON.stringify(m.oppItems)));
  }
  for (const g of Object.values(S.giveaways)) {
    if (users[g.host.id]) users[g.host.id].inventory.push(...JSON.parse(JSON.stringify(g.items)));
  }

  return {
    users,
    sessions: S.sessions,
    catalog: S.catalog,
    history: S.history.slice(0, 200),
    withdrawals: S.withdrawals.slice(0, 500),
    announcement: S.announcement
  };
}

async function initDb() {
  if (!MONGODB_URI) {
    console.warn('MONGODB_URI not set: data is memory-only and resets on restart.');
    return;
  }
  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    mongoColl = client.db(E.MONGODB_DB || 'amproll').collection('state');

    const doc = await mongoColl.findOne({ _id: 'main' });
    if (doc && doc.data) {
      const d = doc.data;
      S.users = d.users || {};
      Object.values(S.users).forEach(ensureUser);
      S.sessions = d.sessions || {};
      S.catalog = d.catalog || [];
      S.history = d.history || [];
      S.withdrawals = d.withdrawals || [];
      S.announcement = d.announcement || null;
      console.log('State loaded from MongoDB.');
    }
  } catch (err) {
    console.error('MongoDB error, running in memory:', err.message);
    mongoColl = null;
  }
}

async function saveNow() {
  if (!mongoColl || !dirty) return;
  dirty = false;
  try {
    await mongoColl.updateOne({ _id: 'main' }, { $set: { data: snapshot() } }, { upsert: true });
  } catch (err) {
    dirty = true;
    console.error('Save failed:', err.message);
  }
}

setInterval(saveNow, 5000);

async function shutdown() {
  dirty = true;
  await saveNow();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

/* ================= ROBLOX API ================= */

const WORDS = [
  'hello', 'world', 'apple', 'bunny', 'candy', 'cloud', 'daisy', 'eagle',
  'fairy', 'ginger', 'happy', 'honey', 'igloo', 'jelly', 'kitten', 'lemon',
  'magic', 'nectar', 'ocean', 'panda', 'queen', 'rabbit', 'sunny', 'tiger',
  'unicorn', 'violet', 'waffle', 'yellow', 'zebra', 'berry', 'cookie',
  'dragon', 'flower', 'garden', 'castle', 'puppy', 'rocket', 'silver',
  'turtle', 'velvet', 'window', 'maple', 'otter', 'pearl', 'pixel', 'robin',
  'sugar', 'thunder', 'wizard', 'rainbow', 'planet', 'summer', 'winter',
  'forest', 'island', 'smile', 'dream', 'star', 'moon', 'river', 'light'
];

function generateCode() {
  return Array.from({ length: 8 }, () => WORDS[crypto.randomInt(WORDS.length)]).join(' ');
}

async function robloxLookup(username) {
  const response = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('Roblox username API error');
  const data = await response.json();
  const user = data.data && data.data[0];
  if (!user) return null;
  return { id: String(user.id), username: user.name, displayName: user.displayName };
}

async function robloxDescription(id) {
  const response = await fetch(
    `https://users.roblox.com/v1/users/${encodeURIComponent(id)}`,
    { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Roblox profile API error');
  const data = await response.json();
  return data.description || '';
}

async function robloxAvatar(id) {
  try {
    const url = 'https://thumbnails.roblox.com/v1/users/avatar-headshot' +
      `?userIds=${encodeURIComponent(id)}&size=150x150&format=Png&isCircular=false`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const data = await response.json();
    return data.data?.[0]?.imageUrl || null;
  } catch { return null; }
}

const bot = { username: BOT_NAME, id: null, avatar: null, link: BOT_LINK, joinLink: BOT_LINK };

async function loadBot() {
  try {
    const user = await robloxLookup(BOT_NAME);
    if (!user) return;
    bot.id = user.id;
    bot.username = user.username;
    bot.avatar = await robloxAvatar(user.id);
  } catch (error) {
    console.error('Bot profile could not be loaded:', error.message);
  }
}

/* ================= EXPRESS + SOCKET ================= */

const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

app.use(express.json({ limit: '20kb' }));
app.use('/assets', express.static(path.join(__dirname, 'assets'), { maxAge: '7d' }));

app.use('/api/', rateLimit({ windowMs: 60000, max: 300, standardHeaders: true, legacyHeaders: false }));
const authLimit = rateLimit({ windowMs: 60000, max: 15, standardHeaders: true, legacyHeaders: false });
const actionLimit = rateLimit({ windowMs: 60000, max: 40, standardHeaders: true, legacyHeaders: false });

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10000 });

function tokenFromRequest(req) {
  const v = String(req.headers.authorization || '');
  return v.startsWith('Bearer ') ? v.slice(7).trim() : '';
}

function userFromToken(token) {
  if (!token || typeof token !== 'string' || token.length > 128) return null;
  const session = S.sessions[sha(token)];
  if (!session || session.exp <= now()) return null;
  const user = S.users[session.userId];
  if (!user || user.banned) return null;
  return user;
}

function auth(req, res, next) {
  const user = userFromToken(tokenFromRequest(req));
  if (!user) return bad(res, 'Not logged in', 401);
  req.user = user;
  next();
}

function adminOnly(req, res, next) {
  if (!isAdmin(req.user)) return bad(res, 'Admin access required', 403);
  next();
}

function emitMe(user) {
  markDirty();
  io.to(`u:${user.id}`).emit('me:update', meView(user));
}

/* ================= AUTH ================= */

app.post('/api/auth/start', authLimit, async (req, res) => {
  const username = String(req.body.username || '').trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return bad(res, 'Invalid Roblox username');

  let user;
  try { user = await robloxLookup(username); }
  catch { return bad(res, 'Roblox API error. Try again.', 502); }

  if (!user) return bad(res, 'Roblox user not found', 404);

  const code = generateCode();
  pending.set(user.id, { ...user, code, exp: now() + 10 * 60 * 1000, tries: 0 });

  res.json({
    id: user.id, robloxId: user.id, username: user.username,
    code, avatar: await robloxAvatar(user.id)
  });
});

app.post('/api/auth/verify', authLimit, async (req, res) => {
  const id = String(req.body.id || req.body.robloxId || '');
  const requestCode = String(req.body.code || '');
  const p = pending.get(id);

  if (!p || p.exp <= now()) return bad(res, 'Code expired. Start again.');

  if (++p.tries > 20) {
    pending.delete(id);
    return bad(res, 'Too many tries. Start again.');
  }

  if (requestCode && requestCode !== p.code) return bad(res, 'Invalid verification code.');

  let description;
  try { description = await robloxDescription(id); }
  catch { return bad(res, 'Roblox API error. Try again.', 502); }

  if (!description.includes(p.code)) {
    return bad(res, 'Code not found in your Roblox About. Save it and try again.', 401);
  }

  pending.delete(id);
  const avatar = await robloxAvatar(id);

  let user = S.users[id];
  if (!user) {
    user = ensureUser({
      id, username: p.username, displayName: p.displayName,
      avatar: null, createdAt: now(), banned: false
    });
    S.users[id] = user;
  }

  if (user.banned) return bad(res, 'Account banned', 403);

  user.username = p.username;
  user.displayName = p.displayName;
  if (avatar) user.avatar = avatar;

  const token = rid(32);
  S.sessions[sha(token)] = { userId: id, exp: now() + 30 * 24 * 60 * 60 * 1000 };
  markDirty();

  res.json({ token, user: meView(user) });
});

app.post('/api/auth/logout', auth, (req, res) => {
  delete S.sessions[sha(tokenFromRequest(req))];
  markDirty();
  res.json({ ok: true });
});

setInterval(() => {
  const t = now();
  for (const [k, s] of Object.entries(S.sessions)) if (s.exp <= t) delete S.sessions[k];
  for (const [k, v] of pending.entries()) if (v.exp <= t) pending.delete(k);
}, 10 * 60 * 1000);

/* ================= PUBLIC DATA ================= */

/* Result data (winnerSide, winner, seed) is only included once the match is
   finished, i.e. after the client's animation has ended. */
function publicMatch(match) {
  const result = {
    id: match.id,
    state: match.state,
    status: match.state,
    hash: match.hash,
    host: match.host,
    joiner: match.opp,
    opp: match.opp,
    hostSide: match.hostSide,
    joinSide: match.hostSide === 'dog' ? 'cat' : 'dog',
    hostItems: match.hostItems.map(publicItem),
    joinerItems: match.oppItems.map(publicItem),
    oppItems: match.oppItems.map(publicItem),
    hostValue: match.hostValue,
    oppValue: match.oppValue,
    value: match.hostValue,
    createdAt: match.createdAt,
    countdownEnd: match.startedAt ? match.startedAt + 3000 : null
  };

  if (match.state === 'finished') {
    result.winnerSide = match.winnerSide;
    result.result = match.winnerSide;
    result.winnerId = match.winnerId;
    result.winner = match.winnerId === match.host.id ? match.host : match.opp;
    result.seed = match.seed;
    result.finishedAt = match.finishedAt;
  }
  return result;
}

function publicGiveaway(g) {
  return {
    id: g.id, host: g.host, items: g.items.map(publicItem), value: g.value,
    endsAt: g.endsAt, minBet: g.minBet, entrantCount: g.entrants.length
  };
}

app.get('/api/state', (req, res) => {
  res.json({
    matches: Object.values(S.matches).map(publicMatch),
    giveaways: Object.values(S.giveaways).map(publicGiveaway),
    chat: S.chat,
    online: io.engine.clientsCount,
    bot,
    announcement: S.announcement,
    discord: DISCORD_INVITE,
    config: { range: RANGE, maxItems: MAX_ITEMS }
  });
});

app.get('/api/me', auth, (req, res) => res.json({ user: meView(req.user) }));

app.get('/api/profile', auth, (req, res) => {
  const user = req.user;
  const perPage = 6;
  const pages = Math.max(1, Math.ceil(user.tx.length / perPage));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));

  res.json({
    user: meView(user),
    stats: {
      totalBet: round2(user.totalBet),
      totalWon: round2(user.totalWon),
      totalLost: round2(user.totalLost || 0),
      profit: round2(user.profit)
    },
    rows: user.tx.slice((page - 1) * perPage, page * perPage),
    page, pages
  });
});

/* Public profile card (click on a player in chat / lobby) */
app.get('/api/user/:id', (req, res) => {
  const user = S.users[String(req.params.id)];
  if (!user) return bad(res, 'User not found', 404);
  res.json({
    user: {
      id: user.id,
      username: user.username,
      avatar: user.avatar || null,
      rank: rankOf(user.totalBet),
      totalBet: round2(user.totalBet),
      totalWon: round2(user.totalWon),
      totalLost: round2(user.totalLost || 0),
      profit: round2(user.profit)
    }
  });
});

app.get('/api/history/me', auth, (req, res) => {
  const history = S.history
    .filter(m => m.host?.id === req.user.id || m.joiner?.id === req.user.id)
    .slice(0, 30);
  res.json({ history });
});

/* ================= COINFLIP ================= */

function removeFinishedMatch(id) {
  const match = S.matches[id];
  if (!match || match.state !== 'finished') return;
  delete S.matches[id];
  io.emit('match:remove', { id });
}

function finishMatch(match) {
  if (!match || match.state !== 'flipping') return;
  if (!match.host || !match.opp) return;

  const host = S.users[match.host.id];
  const opponent = S.users[match.opp.id];
  if (!host || !opponent) { console.error('Cannot finish match', match.id); return; }

  const hostWins = match.winnerSide === match.hostSide;
  const winner = hostWins ? host : opponent;
  const loser = hostWins ? opponent : host;
  const loserStake = hostWins ? match.oppValue : match.hostValue;

  match.state = 'finished';
  match.finishedAt = now();
  match.winnerId = winner.id;

  winner.inventory.push(...match.hostItems, ...match.oppItems);

  host.totalBet = round2(host.totalBet + match.hostValue);
  opponent.totalBet = round2(opponent.totalBet + match.oppValue);

  /* wager requirement goes down by what each player staked */
  host.wagerLeft = Math.max(0, round2((host.wagerLeft || 0) - match.hostValue));
  opponent.wagerLeft = Math.max(0, round2((opponent.wagerLeft || 0) - match.oppValue));
  winner.totalWon = round2(winner.totalWon + loserStake);
  loser.totalLost = round2((loser.totalLost || 0) + loserStake);
  winner.profit = round2(winner.profit + loserStake);
  loser.profit = round2(loser.profit - loserStake);

  addTransaction(winner, 'Coinflip Win', match.id, loserStake);
  addTransaction(loser, 'Coinflip Loss', match.id, -loserStake);

  S.history.unshift(publicMatch(match));
  if (S.history.length > 500) S.history.length = 500;

  sendWebhook(WEBHOOK_CF, {
    title: '🪙 Coinflip finished',
    color: 0x00efa0,
    fields: [
      { name: 'Winner', value: clip(winner.username, 100), inline: true },
      { name: 'Loser', value: clip(loser.username, 100), inline: true },
      { name: 'Pot', value: String(round2(match.hostValue + match.oppValue)), inline: true },
      { name: clip(`${match.host.username} (${match.hostSide}) - ${match.hostValue}`, 250), value: itemLine(match.hostItems) },
      { name: clip(`${match.opp.username} - ${match.oppValue}`, 250), value: itemLine(match.oppItems) },
      { name: 'Winning side', value: String(match.winnerSide), inline: true },
      { name: 'Match / Hash', value: clip(`${match.id}\n${match.hash}`, 300) }
    ],
    timestamp: new Date().toISOString()
  });

  io.emit('match:update', publicMatch(match));
  emitMe(winner);
  emitMe(loser);

  setTimeout(() => removeFinishedMatch(match.id), 20000);
}

function runMatch(match) {
  setTimeout(() => {
    if (match.state !== 'countdown') return;
    match.state = 'flipping';
    io.emit('match:update', publicMatch(match));
    setTimeout(() => finishMatch(match), 3600);
  }, 3000);
}

app.post('/api/match/create', auth, actionLimit, (req, res) => {
  const user = req.user;
  const side = req.body.side;
  const uids = selectionToUids(req.body);

  if (side !== 'dog' && side !== 'cat') return bad(res, 'Pick a side');

  const open = Object.values(S.matches).filter(m => m.host.id === user.id && m.state === 'waiting');
  if (open.length >= 3) return bad(res, 'Max 3 open matches');
  if (Object.keys(S.matches).length >= 150) return bad(res, 'Lobby is full');

  const selected = pickItems(user, uids, MAX_ITEMS);
  if (!selected) return bad(res, 'Invalid item selection');
  if (valueOf(selected) <= 0) return bad(res, 'Value too low');

  const items = takeItems(user, uids, MAX_ITEMS);
  const seed = rid(32);
  const id = rid(10);

  const match = {
    id, state: 'waiting', seed, hash: sha(seed),
    host: publicUser(user), opp: null, hostSide: side,
    hostItems: items, oppItems: [],
    hostValue: valueOf(items), oppValue: 0,
    createdAt: now(), startedAt: 0, finishedAt: 0,
    winnerSide: null, winnerId: null
  };

  S.matches[id] = match;
  io.emit('match:new', publicMatch(match));
  emitMe(user);
  res.json({ match: publicMatch(match) });
});

app.post('/api/match/join', auth, actionLimit, (req, res) => {
  const user = req.user;
  const match = S.matches[String(req.body.id || '')];
  const uids = selectionToUids(req.body);

  if (!match || match.state !== 'waiting') return bad(res, 'This match is no longer available');
  if (match.host.id === user.id) return bad(res, 'You cannot join your own match');

  const selected = pickItems(user, uids, MAX_ITEMS);
  if (!selected) return bad(res, 'Invalid item selection');

  const value = valueOf(selected);
  const min = match.hostValue * (1 - RANGE);
  const max = match.hostValue * (1 + RANGE);
  if (value < min - 0.001 || value > max + 0.001) {
    return bad(res, 'Your value must be inside the required range');
  }

  const items = takeItems(user, uids, MAX_ITEMS);

  match.opp = publicUser(user);
  match.oppItems = items;
  match.oppValue = valueOf(items);
  match.state = 'countdown';
  match.startedAt = now();

  const digest = crypto.createHmac('sha256', match.seed).update(match.id).digest('hex');
  const roll = parseInt(digest.slice(0, 8), 16) / 0x100000000;
  match.winnerSide = roll < 0.5 ? 'dog' : 'cat';

  io.emit('match:update', publicMatch(match));
  emitMe(user);
  runMatch(match);
  res.json({ match: publicMatch(match) });
});

app.post('/api/match/cancel', auth, actionLimit, (req, res) => {
  const match = S.matches[String(req.body.id || '')];
  if (!match || match.state !== 'waiting' || match.host.id !== req.user.id) {
    return bad(res, 'Cannot cancel this match');
  }
  /* Delete first, then refund: the match can never be cancelled twice. */
  delete S.matches[match.id];
  req.user.inventory.push(...match.hostItems);
  io.emit('match:remove', { id: match.id });
  emitMe(req.user);
  res.json({ ok: true });
});

/* ================= CHAT ================= */

function pushChat(message) {
  S.chat.push(message);
  if (S.chat.length > 60) S.chat.shift();
  io.emit('chat:msg', message);
}

/* ================= GIVEAWAYS ================= */

function endGiveaway(id) {
  const g = S.giveaways[id];
  if (!g) return;
  delete S.giveaways[id];

  const host = S.users[g.host.id];
  if (!host) return;

  const system = text => pushChat({
    id: rid(4), user: { username: 'System', avatar: null }, text, ts: now()
  });

  const eligible = g.entrants.filter(uid => S.users[uid] && !S.users[uid].banned);

  if (!eligible.length) {
    host.inventory.push(...g.items);
    emitMe(host);
    system(`🎁 ${g.host.username}'s giveaway ended with no entrants. Items returned.`);
  } else {
    const winner = S.users[eligible[crypto.randomInt(eligible.length)]];
    if (!winner) {
      host.inventory.push(...g.items);
      emitMe(host);
    } else {
      winner.inventory.push(...g.items);
      /* items from giveaways must be wagered 1x their value before withdrawing */
      winner.wagerLeft = round2((winner.wagerLeft || 0) + g.value);
      addTransaction(winner, 'Giveaway Win', g.id, g.value);

      sendWebhook(WEBHOOK_GW, {
        title: '🎉 Giveaway ended',
        color: 0xffb52e,
        fields: [
          { name: 'Host', value: clip(g.host.username, 100), inline: true },
          { name: 'Winner', value: clip(winner.username, 100), inline: true },
          { name: 'Entrants', value: String(eligible.length), inline: true },
          { name: 'Value', value: String(g.value), inline: true },
          { name: 'Items', value: itemLine(g.items) }
        ],
        timestamp: new Date().toISOString()
      });
      emitMe(winner);
      system(`🎉 ${winner.username} won ${g.items.length} item(s) worth ${g.value} from ${g.host.username}'s giveaway!`);
    }
  }
  io.emit('giveaway:remove', { id });
}

app.post('/api/giveaway/create', auth, actionLimit, (req, res) => {
  const user = req.user;
  const mode = req.body.mode;
  const duration = Math.floor(Number(req.body.duration));
  const minBet = Number(req.body.minBet || 0);
  const uids = selectionToUids(req.body);

  if (mode === 'easy') {
    if (![30, 120, 300].includes(duration)) return bad(res, 'Invalid duration');
  } else if (mode === 'advanced') {
    if (!(duration >= 60 && duration <= MAX_GW_MINUTES * 60)) return bad(res, `Advanced duration must be 1–${MAX_GW_MINUTES} minutes`);
    if (!Number.isFinite(minBet) || minBet < 0) return bad(res, 'Invalid minimum bet');
  } else {
    return bad(res, 'Invalid mode');
  }

  if (Object.values(S.giveaways).filter(g => g.host.id === user.id).length >= 3) {
    return bad(res, 'Max 3 active giveaways');
  }
  if (Object.keys(S.giveaways).length >= 20) return bad(res, 'Too many active giveaways');

  if (!pickItems(user, uids, 5)) return bad(res, 'Select up to 5 valid items');
  const items = takeItems(user, uids, 5);

  const g = {
    id: rid(8), host: publicUser(user), items, value: valueOf(items),
    endsAt: now() + duration * 1000,
    minBet: mode === 'advanced' ? round2(minBet) : 0,
    entrants: []
  };

  S.giveaways[g.id] = g;
  setTimeout(() => endGiveaway(g.id), duration * 1000);

  sendWebhook(WEBHOOK_GW, {
    title: '🎁 New giveaway',
    color: 0x00efa0,
    fields: [
      { name: 'Host', value: clip(user.username, 100), inline: true },
      { name: 'Value', value: String(g.value), inline: true },
      { name: 'Mode', value: mode, inline: true },
      { name: 'Ends', value: `<t:${Math.floor(g.endsAt / 1000)}:R>`, inline: true },
      { name: 'Min total bet', value: String(g.minBet), inline: true },
      { name: 'Items', value: itemLine(g.items) }
    ],
    timestamp: new Date().toISOString()
  });

  io.emit('giveaway:new', publicGiveaway(g));
  emitMe(user);
  res.json({ ok: true });
});

app.post('/api/giveaway/enter', auth, actionLimit, (req, res) => {
  const user = req.user;
  const g = S.giveaways[String(req.body.id || '')];

  if (!g || g.endsAt <= now()) return bad(res, 'Giveaway ended');
  if (g.host.id === user.id) return bad(res, 'You cannot enter your own giveaway');
  if (g.entrants.includes(user.id)) return bad(res, 'Already entered');
  if (user.totalBet < g.minBet) return bad(res, `You need ${g.minBet} total bet to enter`);

  g.entrants.push(user.id);
  io.emit('giveaway:update', publicGiveaway(g));
  res.json({ ok: true });
});

/* ================= WITHDRAW (manual) =================
   Items leave the inventory immediately (so they can't be used in a game
   or withdrawn twice) and an admin sends them by hand in Adopt Me. */

app.post('/api/withdraw', auth, actionLimit, (req, res) => {
  const user = req.user;
  const uids = selectionToUids(req.body);

  if ((user.wagerLeft || 0) > 0.001) {
    return bad(res, `You must wager ${round2(user.wagerLeft)} more before you can withdraw.`);
  }

  const open = S.withdrawals.filter(w => w.user.id === user.id && w.status === 'pending');
  if (open.length >= 5) return bad(res, 'You already have 5 pending withdrawals');

  if (!pickItems(user, uids, 50)) return bad(res, 'Invalid item selection');
  const items = takeItems(user, uids, 50);

  const request = {
    id: rid(6),
    user: publicUser(user),
    items,
    value: valueOf(items),
    status: 'pending',
    ts: now()
  };

  S.withdrawals.unshift(request);
  addTransaction(user, 'Withdraw Request', request.id, -request.value);
  emitMe(user);

  res.json({
    ok: true,
    message: 'Withdraw successful! An admin will send your items to you shortly.',
    request: { id: request.id, value: request.value, status: request.status }
  });
});

/* ================= ADMIN API ================= */

function cleanItem(body) {
  const name = String(body.name || '').trim().slice(0, 40);
  const image = String(body.image || '').trim();
  const value = round2(Number(body.value));

  if (!name) return null;
  if (!/^https:\/\/[^\s"'<>]{4,400}$/.test(image)) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1e9) return null;

  return {
    name, image, value,
    age: ['normal', 'neon', 'mega'].includes(body.age) ? body.age : 'normal',
    fly: Boolean(body.fly),
    ride: Boolean(body.ride)
  };
}

app.get('/api/admin/ui', auth, adminOnly, (req, res) => {
  res.type('application/javascript').send(`(${adminUI.toString()})();`);
});

app.get('/api/admin/data', auth, adminOnly, (req, res) => {
  res.json({
    catalog: S.catalog,
    users: Object.values(S.users).map(u => ({
      id: u.id, username: u.username, items: u.inventory.length,
      value: valueOf(u.inventory), totalBet: round2(u.totalBet),
      banned: Boolean(u.banned), wagerLeft: round2(u.wagerLeft || 0)
    })),
    withdrawals: S.withdrawals.filter(w => w.status === 'pending')
  });
});

app.post('/api/admin/withdraw/done', auth, adminOnly, (req, res) => {
  const w = S.withdrawals.find(x => x.id === req.body.id);
  if (!w || w.status !== 'pending') return bad(res, 'Request not found');
  w.status = 'done';
  w.doneAt = now();
  markDirty();
  res.json({ ok: true });
});

app.post('/api/admin/withdraw/refund', auth, adminOnly, (req, res) => {
  const w = S.withdrawals.find(x => x.id === req.body.id);
  if (!w || w.status !== 'pending') return bad(res, 'Request not found');
  const user = S.users[w.user.id];
  if (!user) return bad(res, 'User not found');
  w.status = 'refunded';
  user.inventory.push(...w.items);
  addTransaction(user, 'Withdraw Refund', w.id, w.value);
  emitMe(user);
  res.json({ ok: true });
});

app.post('/api/admin/ban', auth, adminOnly, (req, res) => {
  const user = S.users[String(req.body.id || '')];
  if (!user) return bad(res, 'User not found', 404);

  const ban = Boolean(req.body.ban);
  if (ban && isAdmin(user)) return bad(res, 'You cannot ban an admin');

  user.banned = ban;

  if (ban) {
    for (const [key, session] of Object.entries(S.sessions)) {
      if (session.userId === user.id) delete S.sessions[key];
    }

    /* return items of their open (waiting) matches */
    for (const m of Object.values(S.matches)) {
      if (m.state === 'waiting' && m.host.id === user.id) {
        delete S.matches[m.id];
        user.inventory.push(...m.hostItems);
        io.emit('match:remove', { id: m.id });
      }
    }

    io.in(`u:${user.id}`).disconnectSockets(true);
  }

  markDirty();
  res.json({ ok: true });
});

app.post('/api/admin/announce', auth, adminOnly, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 60);
  const text = String(req.body.text || '').trim().slice(0, 300);

  if (!title && !text) {
    S.announcement = null;
  } else {
    S.announcement = { title: title || 'Announcement', text, ts: now() };
  }

  if (req.body.chat && text) {
    pushChat({
      id: rid(4),
      user: { username: '📢 Announcement', avatar: null },
      text,
      ts: now(),
      admin: true
    });
  }

  markDirty();
  io.emit('announce:update', S.announcement);
  res.json({ ok: true });
});

app.post('/api/admin/catalog', auth, adminOnly, (req, res) => {
  const item = cleanItem(req.body);
  if (!item) return bad(res, 'Invalid item. Image must be a valid https:// URL.');
  item.id = rid(8);
  S.catalog.push(item);
  markDirty();
  res.json({ ok: true, item });
});

app.post('/api/admin/catalog/update', auth, adminOnly, (req, res) => {
  const item = S.catalog.find(x => x.id === req.body.id);
  const value = round2(Number(req.body.value));
  if (!item || !Number.isFinite(value) || value < 0 || value > 1e9) return bad(res, 'Invalid value');
  item.value = value;
  markDirty();
  res.json({ ok: true });
});

app.post('/api/admin/catalog/delete', auth, adminOnly, (req, res) => {
  const i = S.catalog.findIndex(x => x.id === req.body.id);
  if (i < 0) return bad(res, 'Item not found', 404);
  S.catalog.splice(i, 1);
  markDirty();
  res.json({ ok: true });
});

app.post('/api/admin/grant', auth, adminOnly, (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const user = Object.values(S.users).find(x => x.username.toLowerCase() === username);
  const item = S.catalog.find(x => x.id === req.body.catalogId);
  const qty = Math.floor(Number(req.body.qty));

  if (!user) return bad(res, 'User not found. They must log in once.');
  if (!item) return bad(res, 'Catalog item not found');
  if (!Number.isInteger(qty) || qty < 1 || qty > 50) return bad(res, 'Quantity must be between 1 and 50');

  for (let i = 0; i < qty; i++) user.inventory.push(newItem(item));
  user.wagerLeft = round2((user.wagerLeft || 0) + item.value * qty);
  emitMe(user);
  res.json({ ok: true });
});

/* ================= ADMIN UI (sent to browser only after auth) ================= */

function adminUI() {
  const { api, esc, toast, fmt, tags } = window.AMP;
  if (document.getElementById('adm')) return;

  const overlay = document.createElement('div');
  overlay.id = 'adm';
  overlay.className = 'ov open';
  overlay.style.zIndex = '150';

  overlay.innerHTML = `
    <div class="modal wide">
      <div class="mh"><h3>🛠 Admin Panel</h3><button class="x" id="adm-x">✕</button></div>

      <h4 style="margin:0 0 8px">📤 Pending Withdrawals</h4>
      <div id="adm-wd" style="margin-bottom:16px"></div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px">
        <div style="background:#f5faff;padding:14px;border-radius:12px">
          <h4 style="margin-bottom:10px">➕ Add New Item</h4>
          <input id="a-img" class="in" style="width:100%;margin-bottom:8px" placeholder="Image URL (https://...)">
          <img id="a-prev" alt="" style="width:70px;height:70px;object-fit:contain;display:block;margin:0 auto 8px">
          <input id="a-name" class="in" style="width:100%;margin-bottom:8px" placeholder="Item name">
          <input id="a-val" class="in" style="width:100%;margin-bottom:8px" type="number" min="0" step="0.01" placeholder="Value">
          <div class="row">
            <select id="a-age"><option value="normal">Normal</option><option value="neon">Neon</option><option value="mega">Mega</option></select>
            <label><input id="a-fly" type="checkbox"> Fly</label>
            <label><input id="a-ride" type="checkbox"> Ride</label>
          </div>
          <button id="a-add" class="btn" style="width:100%">Add to Catalog</button>
        </div>

        <div style="background:#f5faff;padding:14px;border-radius:12px">
          <h4 style="margin-bottom:10px">🎁 Give Items</h4>
          <input id="g-user" list="g-users" class="in" style="width:100%;margin-bottom:8px" placeholder="Roblox username">
          <datalist id="g-users"></datalist>
          <input id="g-qty" class="in" style="width:100%;margin-bottom:8px" type="number" min="1" max="50" value="1">
          <p class="hint">User must have logged in once. Enter the username, then press Give on an item.</p>
        </div>
      </div>

      <h4 style="margin:16px 0 8px">📢 Announcement (shown in the top banner)</h4>
      <div style="background:#f5faff;padding:14px;border-radius:12px">
        <input id="an-title" class="in" maxlength="60" style="width:100%;margin-bottom:8px" placeholder="Title (e.g. Maintenance tonight)">
        <input id="an-text" class="in" maxlength="300" style="width:100%;margin-bottom:8px" placeholder="Message">
        <div class="row">
          <label><input id="an-chat" type="checkbox"> Also send to chat</label>
        </div>
        <div style="display:flex;gap:8px">
          <button id="an-send" class="btn" style="flex:1">Publish</button>
          <button id="an-clear" class="btn gray">Remove announcement</button>
        </div>
      </div>

      <h4 style="margin:16px 0 8px">📦 Catalog</h4>
      <div id="adm-cat" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(145px,1fr));gap:10px"></div>

      <h4 style="margin:16px 0 8px">👥 Users</h4>
      <div id="adm-users"></div>
    </div>`;

  document.body.appendChild(overlay);
  const $ = id => document.getElementById(id);

  $('adm-x').onclick = () => overlay.remove();
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.remove(); });

  $('a-img').oninput = () => {
    const v = $('a-img').value.trim();
    $('a-prev').src = /^https:\/\//.test(v) ? v : '';
  };

  async function load() {
    const data = await api('/api/admin/data');

    $('adm-wd').innerHTML = data.withdrawals.length
      ? data.withdrawals.map(w => `
        <div style="border:1px solid #343842;border-radius:8px;padding:10px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
            <b>${esc(w.user.username)}</b>
            <span>${fmt(w.value)} · ${new Date(w.ts).toLocaleString()}</span>
            <span>
              <button class="btn mint sm" data-wd="done" data-id="${esc(w.id)}">Mark sent</button>
              <button class="btn red sm" data-wd="refund" data-id="${esc(w.id)}">Refund</button>
            </span>
          </div>
          <div style="margin-top:6px;font-size:12px">
            ${w.items.map(i => esc(i.name) + (i.age !== 'normal' ? ' (' + esc(i.age) + ')' : '') + (i.fly ? ' F' : '') + (i.ride ? ' R' : '')).join(' · ')}
          </div>
        </div>`).join('')
      : '<p class="hint">No pending withdrawals.</p>';

    $('adm-cat').innerHTML = data.catalog.length
      ? data.catalog.map(item => `
        <div style="border:2px solid #e0edfb;border-radius:12px;padding:10px;text-align:center">
          <img src="${esc(item.image)}" alt="" style="width:70px;height:70px;object-fit:contain">
          <div style="font-weight:700">${esc(item.name)}</div>
          ${tags(item)}
          <input class="in" type="number" min="0" step="0.01" value="${esc(item.value)}" data-value-id="${esc(item.id)}" style="width:100%;margin:8px 0">
          <div style="display:flex;gap:5px">
            <button class="btn mint sm" data-action="give" data-id="${esc(item.id)}" style="flex:1">Give</button>
            <button class="btn red sm" data-action="delete" data-id="${esc(item.id)}">🗑</button>
          </div>
        </div>`).join('')
      : '<p class="hint">No items yet.</p>';

    $('adm-users').innerHTML = data.users.length
      ? data.users.map(u => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px;border-bottom:1px solid #e0edfb">
          <b>${esc(u.username)}${u.banned ? ' 🚫' : ''}</b>
          <span>${u.items} items · ${fmt(u.value)}${u.wagerLeft > 0 ? ' · wager left ' + fmt(u.wagerLeft) : ''}</span>
          <button class="btn sm ${u.banned ? 'mint' : 'red'}" data-ban="${esc(u.id)}" data-state="${u.banned ? '0' : '1'}">${u.banned ? 'Unban' : 'Ban'}</button>
        </div>`).join('')
      : '<p class="hint">No users yet.</p>';

    $('g-users').innerHTML = data.users.map(u => `<option value="${esc(u.username)}"></option>`).join('');
  }

  $('adm-wd').onclick = async e => {
    const b = e.target.closest('[data-wd]');
    if (!b) return;
    try {
      await api('/api/admin/withdraw/' + b.dataset.wd, { method: 'POST', body: { id: b.dataset.id } });
      toast(b.dataset.wd === 'done' ? 'Marked as sent' : 'Items refunded', 'ok');
      await load();
    } catch (err) { toast(err.message, 'err'); }
  };

  $('a-add').onclick = async () => {
    try {
      await api('/api/admin/catalog', {
        method: 'POST',
        body: {
          image: $('a-img').value, name: $('a-name').value, value: $('a-val').value,
          age: $('a-age').value, fly: $('a-fly').checked, ride: $('a-ride').checked
        }
      });
      $('a-img').value = ''; $('a-name').value = ''; $('a-val').value = '';
      $('a-prev').removeAttribute('src');
      toast('Item added!', 'ok');
      await load();
    } catch (err) { toast(err.message, 'err'); }
  };

  $('adm-cat').onclick = async e => {
    const button = e.target.closest('[data-action]');
    if (!button) return;
    const id = button.dataset.id;
    try {
      if (button.dataset.action === 'give') {
        await api('/api/admin/grant', {
          method: 'POST',
          body: { username: $('g-user').value, catalogId: id, qty: $('g-qty').value }
        });
        toast('Item given!', 'ok');
        await load();
      }
      if (button.dataset.action === 'delete') {
        if (!confirm('Delete this catalog item?')) return;
        await api('/api/admin/catalog/delete', { method: 'POST', body: { id } });
        toast('Item deleted', 'ok');
        await load();
      }
    } catch (err) { toast(err.message, 'err'); }
  };

  $('adm-cat').onchange = async e => {
    const input = e.target;
    if (!input.dataset.valueId) return;
    try {
      await api('/api/admin/catalog/update', {
        method: 'POST', body: { id: input.dataset.valueId, value: input.value }
      });
      toast('Catalog value updated', 'ok');
    } catch (err) { toast(err.message, 'err'); await load(); }
  };

  $('adm-users').onclick = async e => {
    const b = e.target.closest('[data-ban]');
    if (!b) return;
    const ban = b.dataset.state === '1';
    if (ban && !confirm('Ban this user?')) return;
    try {
      await api('/api/admin/ban', { method: 'POST', body: { id: b.dataset.ban, ban } });
      toast(ban ? 'User banned' : 'User unbanned', 'ok');
      await load();
    } catch (err) { toast(err.message, 'err'); }
  };

  async function announce(clear) {
    try {
      await api('/api/admin/announce', {
        method: 'POST',
        body: clear
          ? { title: '', text: '' }
          : { title: $('an-title').value, text: $('an-text').value, chat: $('an-chat').checked }
      });
      if (clear) { $('an-title').value = ''; $('an-text').value = ''; }
      toast(clear ? 'Announcement removed' : 'Announcement published', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  $('an-send').onclick = () => announce(false);
  $('an-clear').onclick = () => announce(true);

  load().catch(err => { toast(err.message, 'err'); overlay.remove(); });
}

/* ================= SOCKET CHAT ================= */

io.use((socket, next) => {
  socket.token = socket.handshake.auth && socket.handshake.auth.token;
  socket.user = userFromToken(socket.token);
  next();
});

io.on('connection', socket => {
  if (socket.user) socket.join(`u:${socket.user.id}`);
  io.emit('online', io.engine.clientsCount);

  socket.on('chat:send', (payload, ack) => {
    const callback = typeof ack === 'function' ? ack : () => {};
    const user = userFromToken(socket.token);
    if (!user) return callback({ error: 'Login to chat' });

    let text = typeof payload === 'string' ? payload : payload && payload.text;
    if (typeof text !== 'string') return callback({ error: 'Invalid message' });

    text = text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160);
    if (!text) return callback({ error: 'Empty message' });

    const t = now();
    if (t - (lastChat.get(user.id) || 0) < 1200) return callback({ error: 'Slow down' });
    lastChat.set(user.id, t);

    const admin = isAdmin(user);

    if (admin && text === '/clear') {
      S.chat = [];
      io.emit('chat:clear');
      return callback({ ok: true });
    }

    if (!admin && /(https?:|www\.|discord\.gg|\.gg\/|\.com|\.net|\.xyz|\.ru|\.io)/i.test(text)) {
      return callback({ error: 'Links are not allowed in chat' });
    }

    pushChat({
      id: rid(4),
      user: { ...publicUser(user), rank: rankOf(user.totalBet) },
      rank: rankOf(user.totalBet),
      text, ts: t, admin
    });
    callback({ ok: true });
  });

  socket.on('disconnect', () => io.emit('online', io.engine.clientsCount));
});

/* ================= FRONTEND ================= */

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/health', (req, res) => {
  res.json({ ok: true, storage: mongoColl ? 'mongodb' : 'memory-only' });
});

/* ================= START ================= */

(async () => {
  await initDb();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`AMP ROLL running on port ${PORT}`);
    console.log(mongoColl ? 'Storage: MongoDB' : 'Storage: MEMORY ONLY (resets on restart)');
    loadBot();
  });
})();

setInterval(loadBot, 10 * 60 * 1000);
