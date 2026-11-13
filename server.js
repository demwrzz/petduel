'use strict';
const express = require('express'), http = require('http'), crypto = require('crypto'), fs = require('fs');
const cors = require('cors'), helmet = require('helmet'), rateLimit = require('express-rate-limit');
const { Server } = require('socket.io'), { MongoClient } = require('mongodb');

/* ================= CONFIG (Render > Environment) ================= */
const E = process.env;
const PORT = E.PORT || 3000;
const ORIGINS = (E.FRONTEND_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean);
const CORS_ORIGIN = ORIGINS.includes('*') ? true : ORIGINS;
const ADMIN_NAMES = (E.ADMIN_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ADMIN_IDS = (E.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const BOT_SECRET = E.BOT_SECRET || '';
const BOT_NAME = E.BOT_USERNAME || 'DedokAmp';
const BOT_LINK = E.BOT_JOIN_LINK || 'https://www.roblox.com/share?code=a0dd8a7bc68f034b99e078f454d4e903&type=Server';
const RANGE = Number(E.JOIN_RANGE || 0.10);   // join value tolerance (+-10%)
const MAX_ITEMS = 8;

/* ================= STATE + PERSISTENCE ================= */
let S = { users: {}, sessions: {}, catalog: [], matches: {}, history: [], giveaways: {}, chat: [], withdrawals: [], audit: [], refs: {} };
let dirty = false, col = null;
const save = () => { dirty = true; };
async function initDB() {
  let saved = null;
  if (E.MONGODB_URI) {
    const c = new MongoClient(E.MONGODB_URI); await c.connect();
    col = c.db('amproll').collection('kv');
    const d = await col.findOne({ _id: 'state' }); if (d) saved = d.data;
  } else if (fs.existsSync('state.json')) saved = JSON.parse(fs.readFileSync('state.json', 'utf8'));
  if (saved) S = Object.assign(S, saved);
  console.log(col ? 'MongoDB connected' : 'WARNING: no MONGODB_URI, using local file (data is lost on Render redeploy!)');
}
async function flush() {
  if (!dirty) return; dirty = false;
  try {
    if (col) await col.replaceOne({ _id: 'state' }, { _id: 'state', data: S }, { upsert: true });
    else fs.writeFileSync('state.json', JSON.stringify(S));
  } catch (e) { console.error('save failed', e.message); dirty = true; }
}
setInterval(flush, 2000);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { dirty = true; await flush(); process.exit(0); });

/* ================= HELPERS ================= */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rid = (n = 8) => crypto.randomBytes(n).toString('hex');
const now = () => Date.now();
const round2 = n => Math.round(n * 100) / 100;
const vsum = a => round2(a.reduce((s, i) => s + i.value, 0));
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const pp = u => ({ id: u.id, username: u.username, avatar: u.avatar });
const isAdmin = u => ADMIN_IDS.includes(u.id) || ADMIN_NAMES.includes(u.username.toLowerCase());
const rankOf = b => b >= 100000 ? 'Whale' : b >= 10000 ? 'Highroller' : b >= 1000 ? 'Roller' : 'Rookie';
const WORDS = ['apple','bunny','candy','cloud','daisy','eagle','fairy','ginger','happy','honey','igloo','jelly','kitten','lemon','magic','nectar','ocean','panda','queen','rabbit','sunny','tiger','unicorn','violet','waffle','yellow','zebra','berry','cookie','dragon','flower','garden','castle','puppy','rocket','silver','turtle','velvet','window','maple','otter','pearl','pixel','robin','sugar','thunder','wizard','rainbow'];
const genCode = () => Array.from({ length: 6 }, () => WORDS[crypto.randomInt(WORDS.length)]).join(' ');
function addTx(u, type, id, amount) { u.tx.unshift({ type, id, ts: now(), amount: round2(amount) }); if (u.tx.length > 300) u.tx.length = 300; }
function audit(u, action, detail) { S.audit.unshift({ ts: now(), by: u.username, action, detail }); if (S.audit.length > 300) S.audit.length = 300; save(); }
function meView(u) {
  return { id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar, isAdmin: isAdmin(u),
    totalBet: round2(u.totalBet), totalWon: round2(u.totalWon), profit: round2(u.profit || 0), rank: rankOf(u.totalBet), inventory: u.inventory };
}

/* ================= ROBLOX API ================= */
async function robloxLookup(username) {
  const r = await fetch('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }) });
  if (!r.ok) throw new Error('roblox');
  const j = await r.json(); const u = j.data && j.data[0];
  return u ? { id: String(u.id), username: u.name, displayName: u.displayName } : null;
}
async function robloxDescription(id) {
  const r = await fetch('https://users.roblox.com/v1/users/' + id); if (!r.ok) throw new Error('roblox');
  return (await r.json()).description || '';
}
async function robloxAvatar(id) {
  try {
    const r = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=false`);
    const j = await r.json(); return (j.data && j.data[0] && j.data[0].imageUrl) || null;
  } catch { return null; }
}
let bot = { username: BOT_NAME, id: null, avatar: null, link: BOT_LINK };
async function loadBot() {
  try { const u = await robloxLookup(BOT_NAME); if (u) { bot.id = u.id; bot.username = u.username; bot.avatar = await robloxAvatar(u.id); } } catch {}
  if (!bot.avatar) setTimeout(loadBot, 60000);
}

/* ================= APP / SOCKET ================= */
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '20kb' }));
app.use('/api/', rateLimit({ windowMs: 60000, max: 300, standardHeaders: true, legacyHeaders: false }));
const authLimit = rateLimit({ windowMs: 60000, max: 15 });
const actLimit = rateLimit({ windowMs: 60000, max: 40 });
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CORS_ORIGIN }, maxHttpBufferSize: 1e4 });

function userFromToken(t) {
  if (!t || typeof t !== 'string' || t.length > 128) return null;
  const s = S.sessions[sha(t)]; if (!s || s.exp < now()) return null;
  const u = S.users[s.userId]; return (u && !u.banned) ? u : null;
}
function auth(req, res, next) {
  const u = userFromToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!u) return bad(res, 'Not logged in', 401);
  req.user = u; next();
}
const adminOnly = [auth, (req, res, next) => isAdmin(req.user) ? next() : bad(res, 'forbidden', 403)];
const emitMe = u => io.to('u:' + u.id).emit('me:update', meView(u));

/* ================= INVENTORY PRIMITIVES (dupe-safe, all synchronous) ================= */
function pick(user, uids, max) {
  if (!Array.isArray(uids) || uids.length < 1 || uids.length > max || !uids.every(x => typeof x === 'string')) return null;
  if (new Set(uids).size !== uids.length) return null;
  const out = [];
  for (const id of uids) { const it = user.inventory.find(i => i.uid === id); if (!it) return null; out.push(it); }
  return out;
}
function takeItems(user, uids, max) {
  const items = pick(user, uids, max); if (!items) return null;
  const set = new Set(uids); user.inventory = user.inventory.filter(i => !set.has(i.uid));
  return items;
}
const newItem = c => ({ uid: rid(8), catalogId: c.id, name: c.name, image: c.image, value: c.value, age: c.age, fly: c.fly, ride: c.ride });

/* ================= AUTH (Roblox bio code) ================= */
const pending = new Map();
app.post('/api/auth/start', authLimit, async (req, res) => {
  const username = String(req.body.username || '').trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return bad(res, 'Invalid Roblox username');
  let u; try { u = await robloxLookup(username); } catch { return bad(res, 'Roblox API error, try again', 502); }
  if (!u) return bad(res, 'Roblox user not found', 404);
  const code = genCode();
  pending.set(u.id, { ...u, code, exp: now() + 10 * 60000, tries: 0 });
  res.json({ id: u.id, username: u.username, code, avatar: await robloxAvatar(u.id) });
});
app.post('/api/auth/verify', authLimit, async (req, res) => {
  const id = String(req.body.id || ''); const p = pending.get(id);
  if (!p || p.exp < now()) return bad(res, 'Code expired, start again');
  if (++p.tries > 20) { pending.delete(id); return bad(res, 'Too many tries, start again'); }
  let desc; try { desc = await robloxDescription(id); } catch { return bad(res, 'Roblox API error, try again', 502); }
  if (!desc.includes(p.code)) return bad(res, 'Code not found in your Roblox "About" yet. Save it and try again in a few seconds.', 401);
  pending.delete(id);
  const avatar = await robloxAvatar(id);
  let u = S.users[id];
  if (!u) u = S.users[id] = { id, username: p.username, displayName: p.displayName, avatar: null, createdAt: now(), inventory: [], totalBet: 0, totalWon: 0, profit: 0, tx: [], banned: false };
  if (u.banned) return bad(res, 'Account banned', 403);
  u.username = p.username; u.displayName = p.displayName; if (avatar) u.avatar = avatar;
  const token = rid(32);
  S.sessions[sha(token)] = { userId: id, exp: now() + 30 * 864e5 };
  save(); res.json({ token, user: meView(u) });
});
app.post('/api/auth/logout', auth, (req, res) => {
  delete S.sessions[sha((req.headers.authorization || '').replace('Bearer ', ''))]; save(); res.json({ ok: true });
});
setInterval(() => { for (const k in S.sessions) if (S.sessions[k].exp < now()) delete S.sessions[k]; for (const [k, v] of pending) if (v.exp < now()) pending.delete(k); }, 600000);

/* ================= PUBLIC VIEWS ================= */
function pubMatch(m) {
  const o = { id: m.id, state: m.state, hash: m.hash, host: m.host, opp: m.opp, hostSide: m.hostSide, oppSide: m.hostSide === 'dog' ? 'cat' : 'dog',
    hostItems: m.hostItems, oppItems: m.oppItems, hostValue: m.hostValue, oppValue: m.oppValue, createdAt: m.createdAt, elapsed: m.startedAt ? now() - m.startedAt : 0 };
  if (m.state === 'flipping' || m.state === 'finished') o.winnerSide = m.winnerSide;
  if (m.state === 'finished') { o.winnerId = m.winnerId; o.seed = m.seed; o.finishedAt = m.finishedAt; }
  return o;
}
const pubGA = g => ({ id: g.id, host: g.host, items: g.items, value: g.value, left: Math.max(0, g.endsAt - now()), minBet: g.minBet, entrantIds: g.entrants });
app.get('/api/state', (req, res) => res.json({
  matches: Object.values(S.matches).map(pubMatch), giveaways: Object.values(S.giveaways).map(pubGA), chat: S.chat,
  online: io.engine.clientsCount, bot, config: { range: RANGE, maxItems: MAX_ITEMS }
}));
app.get('/api/me', auth, (req, res) => res.json({ user: meView(req.user) }));
app.get('/api/profile', auth, (req, res) => {
  const u = req.user, per = 6, pages = Math.max(1, Math.ceil(u.tx.length / per));
  const page = Math.min(Math.max(1, parseInt(req.query.page) || 1), pages);
  res.json({ user: meView(u), rows: u.tx.slice((page - 1) * per, page * per), page, pages });
});
app.get('/api/history/me', auth, (req, res) => res.json({ history: S.history.filter(h => h.host.id === req.user.id || (h.opp && h.opp.id === req.user.id)).slice(0, 30) }));

/* ================= COINFLIP ================= */
function runMatch(m) {
  setTimeout(() => {
    if (m.state !== 'countdown') return;
    m.state = 'flipping'; io.emit('match:update', pubMatch(m)); save();
    setTimeout(() => finishMatch(m), 3600);
  }, 3000);
}
function finishMatch(m) {
  if (m.state === 'finished') return;
  m.state = 'finished'; m.finishedAt = now();
  const hostWins = m.winnerSide === m.hostSide;
  const w = S.users[(hostWins ? m.host : m.opp).id], l = S.users[(hostWins ? m.opp : m.host).id];
  const loseStake = hostWins ? m.oppValue : m.hostValue, winStake = hostWins ? m.hostValue : m.oppValue;
  m.winnerId = w.id;
  w.inventory.push(...[...m.hostItems, ...m.oppItems].map(i => ({ ...i })));
  S.users[m.host.id].totalBet += m.hostValue; S.users[m.opp.id].totalBet += m.oppValue;
  w.totalWon += m.hostValue + m.oppValue; w.profit = (w.profit || 0) + loseStake; l.profit = (l.profit || 0) - loseStake;
  addTx(w, 'Coinflip Win', m.id, loseStake); addTx(l, 'Coinflip Loss', m.id, -(hostWins ? m.oppValue : m.hostValue));
  S.history.unshift(JSON.parse(JSON.stringify(pubMatch(m)))); if (S.history.length > 500) S.history.length = 500;
  io.emit('match:update', pubMatch(m)); emitMe(w); emitMe(l); save();
  setTimeout(() => { delete S.matches[m.id]; io.emit('match:remove', { id: m.id }); save(); }, 20000);
}
app.post('/api/match/create', auth, actLimit, (req, res) => {
  const u = req.user, side = req.body.side;
  if (side !== 'dog' && side !== 'cat') return bad(res, 'Pick a side');
  if (Object.values(S.matches).filter(m => m.host.id === u.id && m.state === 'waiting').length >= 3) return bad(res, 'Max 3 open matches');
  if (Object.keys(S.matches).length >= 150) return bad(res, 'Lobby is full');
  const picked = pick(u, req.body.uids, MAX_ITEMS); if (!picked) return bad(res, 'Invalid item selection');
  if (vsum(picked) <= 0) return bad(res, 'Value too low');
  const items = takeItems(u, req.body.uids, MAX_ITEMS);
  const seed = rid(32), id = rid(10);
  const m = { id, state: 'waiting', seed, hash: sha(seed), host: pp(u), opp: null, hostSide: side, hostItems: items, oppItems: [], hostValue: vsum(items), oppValue: 0, createdAt: now(), startedAt: 0, winnerSide: null, winnerId: null };
  S.matches[id] = m; io.emit('match:new', pubMatch(m)); emitMe(u); save();
  res.json({ match: pubMatch(m) });
});
app.post('/api/match/join', auth, actLimit, (req, res) => {
  const u = req.user, m = S.matches[String(req.body.id)];
  if (!m || m.state !== 'waiting') return bad(res, 'This match is no longer available');
  if (m.host.id === u.id) return bad(res, 'You cannot join your own match');
  const picked = pick(u, req.body.uids, MAX_ITEMS); if (!picked) return bad(res, 'Invalid item selection');
  const v = vsum(picked), min = m.hostValue * (1 - RANGE), max = m.hostValue * (1 + RANGE);
  if (v < min - 0.001 || v > max + 0.001) return bad(res, 'Your value must be inside the required range');
  const items = takeItems(u, req.body.uids, MAX_ITEMS);
  m.opp = pp(u); m.oppItems = items; m.oppValue = vsum(items); m.state = 'countdown'; m.startedAt = now();
  const roll = parseInt(crypto.createHmac('sha256', m.seed).update(m.id).digest('hex').slice(0, 8), 16) / 0x100000000;
  m.winnerSide = roll < 0.5 ? 'dog' : 'cat';
  io.emit('match:update', pubMatch(m)); emitMe(u); save(); runMatch(m);
  res.json({ match: pubMatch(m) });
});
app.post('/api/match/cancel', auth, actLimit, (req, res) => {
  const m = S.matches[String(req.body.id)];
  if (!m || m.state !== 'waiting' || m.host.id !== req.user.id) return bad(res, 'Cannot cancel this match');
  req.user.inventory.push(...m.hostItems); delete S.matches[m.id];
  io.emit('match:remove', { id: m.id }); emitMe(req.user); save(); res.json({ ok: true });
});

/* ================= GIVEAWAYS ================= */
function pushChat(msg) { S.chat.push(msg); if (S.chat.length > 60) S.chat.shift(); io.emit('chat:msg', msg); save(); }
function endGiveaway(id) {
  const g = S.giveaways[id]; if (!g) return; delete S.giveaways[id];
  const host = S.users[g.host.id];
  if (!g.entrants.length) { host.inventory.push(...g.items); emitMe(host); pushChat({ id: rid(4), system: true, text: `🎁 ${g.host.username}'s giveaway ended with no entrants.`, ts: now() }); }
  else {
    const w = S.users[g.entrants[crypto.randomInt(g.entrants.length)]];
    w.inventory.push(...g.items); addTx(w, 'Giveaway Win', g.id, g.value); emitMe(w);
    pushChat({ id: rid(4), system: true, text: `🎉 ${w.username} won ${g.items.length > 1 ? g.items.length + ' items' : g.items[0].name} (💎${g.value}) from ${g.host.username}'s giveaway!`, ts: now() });
  }
  io.emit('giveaway:remove', { id }); save();
}
app.post('/api/giveaway/create', auth, actLimit, (req, res) => {
  const u = req.user, { mode, duration, uids, minBet } = req.body; const dur = Math.floor(Number(duration));
  if (mode === 'easy') { if (![30, 120, 300].includes(dur)) return bad(res, 'Invalid time'); }
  else if (mode === 'advanced') { if (!(dur >= 60 && dur <= 3600)) return bad(res, 'Advanced time must be 1-60 minutes'); }
  else return bad(res, 'Invalid mode');
  if (Object.values(S.giveaways).filter(g => g.host.id === u.id).length >= 3) return bad(res, 'Max 3 active giveaways');
  if (Object.keys(S.giveaways).length >= 20) return bad(res, 'Too many active giveaways');
  const items = takeItems(u, uids, 5); if (!items) return bad(res, 'Invalid item selection');
  const g = { id: rid(8), host: pp(u), items, value: vsum(items), endsAt: now() + dur * 1000, minBet: mode === 'advanced' ? Math.max(0, round2(Number(minBet) || 0)) : 0, entrants: [] };
  S.giveaways[g.id] = g; setTimeout(() => endGiveaway(g.id), dur * 1000);
  io.emit('giveaway:new', pubGA(g)); emitMe(u); save(); res.json({ ok: true });
});
app.post('/api/giveaway/enter', auth, actLimit, (req, res) => {
  const u = req.user, g = S.giveaways[String(req.body.id)];
  if (!g || g.endsAt <= now()) return bad(res, 'Giveaway ended');
  if (g.host.id === u.id) return bad(res, 'You cannot enter your own giveaway');
  if (g.entrants.includes(u.id)) return bad(res, 'Already entered');
  if (u.totalBet < g.minBet) return bad(res, `You need ${g.minBet} total bet to enter`);
  g.entrants.push(u.id); io.emit('giveaway:update', pubGA(g)); save(); res.json({ ok: true });
});

/* ================= WITHDRAW + BOT API ================= */
app.post('/api/withdraw', auth, actLimit, (req, res) => {
  const items = takeItems(req.user, req.body.uids, 500); if (!items) return bad(res, 'Invalid selection');
  const w = { id: rid(8), userId: req.user.id, username: req.user.username, items, status: 'pending', ts: now() };
  S.withdrawals.push(w); emitMe(req.user); save(); res.json({ ok: true, id: w.id });
});
function botAuth(req, res, next) {
  const k = String(req.headers['x-bot-secret'] || '');
  if (!BOT_SECRET || k.length !== BOT_SECRET.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(BOT_SECRET))) return bad(res, 'forbidden', 403);
  next();
}
app.post('/api/bot/deposit', botAuth, (req, res) => {
  const ref = String(req.body.ref || ''); if (!/^[A-Za-z0-9_-]{1,64}$/.test(ref)) return bad(res, 'bad ref');
  if (S.refs[ref]) return res.json({ ok: true, duplicate: true });
  const u = S.users[String(req.body.robloxId)], c = S.catalog.find(x => x.id === req.body.catalogId), qty = Math.min(50, Math.max(1, parseInt(req.body.qty) || 1));
  if (!u || !c) return bad(res, 'unknown user/item');
  for (let i = 0; i < qty; i++) u.inventory.push(newItem(c));
  S.refs[ref] = now(); const ks = Object.keys(S.refs); if (ks.length > 5000) ks.slice(0, 1000).forEach(k => delete S.refs[k]);
  emitMe(u); save(); res.json({ ok: true });
});
app.get('/api/bot/withdrawals', botAuth, (req, res) => res.json({ withdrawals: S.withdrawals.filter(w => w.status === 'pending') }));
app.post('/api/bot/withdrawals/done', botAuth, (req, res) => {
  const w = S.withdrawals.find(x => x.id === req.body.id && x.status === 'pending'); if (!w) return bad(res, 'not found');
  w.status = 'done'; save(); res.json({ ok: true });
});
app.post('/api/bot/withdrawals/fail', botAuth, (req, res) => {
  const w = S.withdrawals.find(x => x.id === req.body.id && x.status === 'pending'); if (!w) return bad(res, 'not found');
  w.status = 'failed'; const u = S.users[w.userId]; u.inventory.push(...w.items); emitMe(u); save(); res.json({ ok: true });
});

/* ================= ADMIN API ================= */
function cleanItem(b) {
  const name = String(b.name || '').trim().slice(0, 40), image = String(b.image || '').trim(), value = round2(Number(b.value));
  if (!name || !/^https:\/\/[^\s"'<>]{4,400}$/.test(image) || !isFinite(value) || value < 0 || value > 1e9) return null;
  return { name, image, value, age: ['normal', 'neon', 'mega'].includes(b.age) ? b.age : 'normal', fly: !!b.fly, ride: !!b.ride };
}
app.get('/api/admin/ui', adminOnly, (req, res) => res.type('application/javascript').send('(' + adminUI.toString() + ')();'));
app.get('/api/admin/data', adminOnly, (req, res) => res.json({ catalog: S.catalog, users: Object.values(S.users).map(u => ({ id: u.id, username: u.username, items: u.inventory.length, value: vsum(u.inventory), totalBet: round2(u.totalBet) })) }));
app.post('/api/admin/catalog', adminOnly, (req, res) => {
  const c = cleanItem(req.body); if (!c) return bad(res, 'Invalid item (image must be https://)');
  c.id = rid(5); S.catalog.push(c); audit(req.user, 'catalog_add', c.name + ' ' + c.value); res.json({ ok: true });
});
app.post('/api/admin/catalog/update', adminOnly, (req, res) => {
  const c = S.catalog.find(x => x.id === req.body.id), v = round2(Number(req.body.value));
  if (!c || !isFinite(v) || v < 0) return bad(res, 'Invalid'); c.value = v; audit(req.user, 'catalog_value', c.name + ' ' + v); res.json({ ok: true });
});
app.post('/api/admin/catalog/delete', adminOnly, (req, res) => {
  S.catalog = S.catalog.filter(x => x.id !== req.body.id); audit(req.user, 'catalog_delete', req.body.id); res.json({ ok: true });
});
app.post('/api/admin/grant', adminOnly, (req, res) => {
  const name = String(req.body.username || '').trim().toLowerCase();
  const u = Object.values(S.users).find(x => x.username.toLowerCase() === name);
  const c = S.catalog.find(x => x.id === req.body.catalogId), qty = Math.min(50, Math.max(1, parseInt(req.body.qty) || 1));
  if (!u) return bad(res, 'User not found (they must log in once)'); if (!c) return bad(res, 'Item not found');
  for (let i = 0; i < qty; i++) u.inventory.push(newItem(c));
  emitMe(u); audit(req.user, 'grant', `${qty}x ${c.name} -> ${u.username}`); res.json({ ok: true });
});

/* Admin UI */
function adminUI() {
  const { api, esc, toast, fmt, tags } = window.AMP;
  if (document.getElementById('adm')) return;
  const o = document.createElement('div'); o.id = 'adm'; o.className = 'overlay show'; o.style.zIndex = 120;
  o.innerHTML = `<div class="modal" style="max-width:1000px;max-height:92vh;display:flex;flex-direction:column">
    <div class="mh"><h3>🛠️ Admin Panel</h3><button class="x" id="adm-x">✕</button></div>
    <div class="p-4 overflow-y-auto">
      <div class="grid md:grid-cols-2 gap-4 mb-4">
        <div class="card2 p-3 space-y-2"><h4 class="font-bold">➕ Add New Item</h4>
          <input id="a-img" class="inp w-full" placeholder="Image URL (https://...)">
          <div class="flex gap-3 items-start">
            <div class="ic" style="width:84px;height:84px"><img id="a-prev" style="width:70px;height:70px;object-fit:contain"></div>
            <div class="flex-1 space-y-2">
              <input id="a-name" class="inp w-full" placeholder="Item name">
              <input id="a-val" type="number" min="0" step="0.01" class="inp w-full" placeholder="Value">
              <div class="flex gap-3 items-center flex-wrap">
                <select id="a-age" class="inp"><option value="normal">Normal</option><option value="neon">Neon (N)</option><option value="mega">Mega (M)</option></select>
                <label class="font-bold"><input type="checkbox" id="a-fly"> Fly (F)</label>
                <label class="font-bold"><input type="checkbox" id="a-ride"> Ride (R)</label>
              </div>
            </div>
          </div>
          <button id="a-add" class="btn w-full">Add to Catalog</button>
        </div>
        <div class="card2 p-3 space-y-2"><h4 class="font-bold">🎁 Give Items To Player</h4>
          <input id="g-user" list="g-users" class="inp w-full" placeholder="Roblox username (must have logged in once)">
          <datalist id="g-users"></datalist>
          <input id="g-qty" type="number" min="1" max="50" value="1" class="inp w-full" placeholder="Quantity">
          <p class="text-sm" style="color:var(--mut)">Type the username, then press <b>Give</b> on any catalog item below. You can edit values anytime.</p>
        </div>
      </div>
      <h4 class="font-bold mb-2">📦 Catalog</h4><div id="adm-cat" class="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-4"></div>
      <h4 class="font-bold mb-2">👥 Users</h4><div id="adm-users" class="text-sm"></div>
    </div></div>`;
  document.body.appendChild(o);
  const $ = id => document.getElementById(id);
  $('adm-x').onclick = () => o.remove();
  $('a-img').oninput = () => { const v = $('a-img').value.trim(); $('a-prev').src = /^https:\/\//.test(v) ? v : ''; };
  let data = { catalog: [], users: [] };
  async function load() {
    data = await api('/api/admin/data');
    $('adm-cat').innerHTML = data.catalog.length ? data.catalog.map(c => `<div class="item" style="cursor:default"><div class="tgs-top">${tags(c)}</div><img src="${esc(c.image)}"><b class="nm">${esc(c.name)}</b>
      <input class="inp w-full" style="padding:.25rem .5rem" type="number" step="0.01" value="${c.value}" data-act="val" data-id="${c.id}">
      <div class="flex gap-1 w-full mt-1"><button class="btn btn-green btn-sm flex-1" data-act="give" data-id="${c.id}">Give</button><button class="btn btn-red btn-sm" data-act="del" data-id="${c.id}">🗑</button></div></div>`).join('') : '<p style="color:var(--mut)">No items yet. Add your first one above.</p>';
    $('adm-users').innerHTML = data.users.map(u => `<div class="flex justify-between py-1 border-b" style="border-color:var(--line)"><b>${esc(u.username)}</b><span>${u.items} items · 💎 ${fmt(u.value)} · bet ${fmt(u.totalBet)}</span></div>`).join('') || 'No users yet.';
    $('g-users').innerHTML = data.users.map(u => `<option value="${esc(u.username)}">`).join('');
  }
  $('a-add').onclick = async () => {
    try {
      await api('/api/admin/catalog', { method: 'POST', body: { image: $('a-img').value, name: $('a-name').value, value: $('a-val').value, age: $('a-age').value, fly: $('a-fly').checked, ride: $('a-ride').checked } });
      toast('Item added to catalog'); ['a-img', 'a-name', 'a-val'].forEach(i => $(i).value = ''); $('a-prev').src = ''; load();
    } catch (e) { toast(e.message, 'err'); }
  };
  $('adm-cat').onclick = async e => {
    const b = e.target.closest('[data-act]'); if (!b) return; const id = b.dataset.id;
    try {
      if (b.dataset.act === 'give') { await api('/api/admin/grant', { method: 'POST', body: { username: $('g-user').value, catalogId: id, qty: $('g-qty').value } }); toast('Item given!'); load(); }
      if (b.dataset.act === 'del' && confirm('Delete from catalog? (existing inventories are not affected)')) { await api('/api/admin/catalog/delete', { method: 'POST', body: { id } }); load(); }
    } catch (er) { toast(er.message, 'err'); }
  };
  $('adm-cat').onchange = async e => {
    if (e.target.dataset.act !== 'val') return;
    try { await api('/api/admin/catalog/update', { method: 'POST', body: { id: e.target.dataset.id, value: e.target.value } }); toast('Value updated'); } catch (er) { toast(er.message, 'err'); }
  };
  load().catch(e => { toast(e.message, 'err'); o.remove(); });
}

/* ================= CHAT SOCKET ================= */
io.use((s, next) => { s.user = userFromToken(s.handshake.auth && s.handshake.auth.token); next(); });
const lastChat = new Map();
io.on('connection', s => {
  if (s.user) s.join('u:' + s.user.id);
  io.emit('online', io.engine.clientsCount);
  s.on('chat:send', (text, ack) => {
    const cb = typeof ack === 'function' ? ack : () => {};
    const u = s.user && S.users[s.user.id];
    if (!u || u.banned) return cb({ error: 'Login to chat' });
    if (typeof text !== 'string') return cb({ error: 'Invalid' });
    text = text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160); if (!text) return cb({ error: 'Empty' });
    const t = now(); if (t - (lastChat.get(u.id) || 0) < 1200) return cb({ error: 'Slow down!' }); lastChat.set(u.id, t);
    const adm = isAdmin(u);
    if (adm && text === '/clear') { S.chat = []; io.emit('chat:clear'); save(); return cb({ ok: true }); }
    if (!adm && /(https?:|www\.|discord\.gg|\.gg\/|\.com|\.net|\.xyz|\.ru|\.io)/i.test(text)) return cb({ error: 'Links are not allowed in chat' });
    pushChat({ id: rid(4), user: pp(u), text, ts: t, admin: adm }); cb({ ok: true });
  });
  s.on('disconnect', () => io.emit('online', io.engine.clientsCount));
});

/* ================= BOOT ================= */
app.get('/', (req, res) => res.send('AMP ROLL API online'));
(async () => {
  await initDB();
  for (const m of Object.values(S.matches)) {
    if (m.state === 'countdown' || m.state === 'flipping') finishMatch(m);
    else if (m.state === 'finished') delete S.matches[m.id];
  }
  for (const g of Object.values(S.giveaways)) setTimeout(() => endGiveaway(g.id), Math.max(0, g.endsAt - now()));
  loadBot();
  server.listen(PORT, () => console.log('AMP ROLL API on :' + PORT));
})();
