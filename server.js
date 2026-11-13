'use strict';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

/* =========================================================
   CONFIG
   ========================================================= */

const E = process.env;
const PORT = Number(E.PORT || 3000);

const ADMIN_NAMES = (E.ADMIN_USERS || '')
  .split(',')
  .map(x => x.trim().toLowerCase())
  .filter(Boolean);

const ADMIN_IDS = (E.ADMIN_IDS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const BOT_NAME = 'DedokAmp';

const BOT_LINK =
  'https://www.roblox.com/share?code=a0dd8a7bc68f034b99e078f454d4e903&type=Server';

const MAX_ITEMS = 8;

let RANGE = Number(E.JOIN_RANGE || 0.10);

if (!Number.isFinite(RANGE) || RANGE < 0 || RANGE > 1) {
  RANGE = 0.10;
}

/*
  ÜCRETSİZ RENDER TEST SÜRÜMÜ

  Bu değişken bellekte tutulur.
  Sunucu yeniden başlarsa TÜM veriler silinir.
*/
const S = {
  users: {},
  sessions: {},
  catalog: [],
  matches: {},
  history: [],
  giveaways: {},
  chat: []
};

const pending = new Map();
const lastChat = new Map();

/* =========================================================
   HELPERS
   ========================================================= */

const now = () => Date.now();

const rid = (bytes = 8) =>
  crypto.randomBytes(bytes).toString('hex');

const sha = value =>
  crypto.createHash('sha256').update(String(value)).digest('hex');

const round2 = n => Math.round(Number(n) * 100) / 100;

const bad = (res, message, status = 400) =>
  res.status(status).json({ error: message });

const safeNumber = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const valueOf = items =>
  round2(items.reduce((total, item) => total + safeNumber(item.value), 0));

const publicUser = user => ({
  id: user.id,
  username: user.username,
  avatar: user.avatar || null
});

function isAdmin(user) {
  if (!user) return false;

  return (
    ADMIN_IDS.includes(String(user.id)) ||
    ADMIN_NAMES.includes(String(user.username).toLowerCase())
  );
}

function rankOf(totalBet) {
  if (totalBet >= 100000) return 'Whale';
  if (totalBet >= 10000) return 'Highroller';
  if (totalBet >= 1000) return 'Roller';
  return 'Rookie';
}

function addTransaction(user, type, id, amount) {
  user.tx.unshift({
    type,
    id,
    ts: now(),
    amount: round2(amount)
  });

  if (user.tx.length > 300) {
    user.tx.length = 300;
  }
}

/*
  Frontend, item seçiminde "id" kullanıyor.

  Her envanter iteminin kendine ait uid değeri var.
  catalogId alanını frontend görünümünde uid olarak veriyoruz.
  Böylece aynı katalog iteminden birkaç tane olsa bile her biri
  ayrı ve tekil seçilir.
*/
function inventoryView(item) {
  return {
    ...item,
    realCatalogId: item.catalogId,
    catalogId: item.uid,
    id: item.uid,
    qty: 1
  };
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
    profit: round2(user.profit),
    rank: rankOf(user.totalBet),
    inventory: user.inventory.map(inventoryView)
  };
}

function newItem(catalogItem) {
  return {
    uid: rid(12),
    catalogId: catalogItem.id,
    name: catalogItem.name,
    image: catalogItem.image,
    value: catalogItem.value,
    age: catalogItem.age,
    fly: catalogItem.fly,
    ride: catalogItem.ride
  };
}

function publicItem(item) {
  return {
    ...item,
    id: item.uid,
    catalogId: item.uid,
    qty: 1
  };
}

function selectionToUids(body) {
  if (Array.isArray(body.uids)) {
    return body.uids;
  }

  if (!Array.isArray(body.items)) {
    return null;
  }

  const ids = [];

  for (const item of body.items) {
    if (!item || typeof item !== 'object') return null;

    const id = String(item.catalogId || item.id || '');
    const qty = Number(item.qty);

    /*
      Bu frontend için her item ayrı uid'dir.
      Aynı uid'den birden fazla istenemez.
    */
    if (!id || qty !== 1) return null;

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

function takeItems(user, uids, max) {
  const selected = pickItems(user, uids, max);

  if (!selected) return null;

  const ids = new Set(uids);

  user.inventory = user.inventory.filter(item => !ids.has(item.uid));

  return selected;
}

/* =========================================================
   ROBLOX API
   ========================================================= */

const WORDS = [
  'apple', 'bunny', 'candy', 'cloud', 'daisy', 'eagle',
  'fairy', 'ginger', 'happy', 'honey', 'igloo', 'jelly',
  'kitten', 'lemon', 'magic', 'nectar', 'ocean', 'panda',
  'queen', 'rabbit', 'sunny', 'tiger', 'unicorn', 'violet',
  'waffle', 'yellow', 'zebra', 'berry', 'cookie', 'dragon',
  'flower', 'garden', 'castle', 'puppy', 'rocket', 'silver',
  'turtle', 'velvet', 'window', 'maple', 'otter', 'pearl',
  'pixel', 'robin', 'sugar', 'thunder', 'wizard', 'rainbow'
];

function generateCode() {
  return Array.from(
    { length: 6 },
    () => WORDS[crypto.randomInt(WORDS.length)]
  ).join(' ');
}

async function robloxLookup(username) {
  const response = await fetch(
    'https://users.roblox.com/v1/usernames/users',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        usernames: [username],
        excludeBannedUsers: true
      }),
      signal: AbortSignal.timeout(10000)
    }
  );

  if (!response.ok) {
    throw new Error('Roblox username API error');
  }

  const data = await response.json();
  const user = data.data && data.data[0];

  if (!user) return null;

  return {
    id: String(user.id),
    username: user.name,
    displayName: user.displayName
  };
}

async function robloxDescription(id) {
  const response = await fetch(
    `https://users.roblox.com/v1/users/${encodeURIComponent(id)}`,
    {
      signal: AbortSignal.timeout(10000)
    }
  );

  if (!response.ok) {
    throw new Error('Roblox profile API error');
  }

  const data = await response.json();

  return data.description || '';
}

async function robloxAvatar(id) {
  try {
    const url =
      'https://thumbnails.roblox.com/v1/users/avatar-headshot' +
      `?userIds=${encodeURIComponent(id)}` +
      '&size=150x150&format=Png&isCircular=false';

    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) return null;

    const data = await response.json();

    return data.data?.[0]?.imageUrl || null;
  } catch {
    return null;
  }
}

const bot = {
  username: BOT_NAME,
  id: null,
  avatar: null,
  link: BOT_LINK,
  joinLink: BOT_LINK
};

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

/* =========================================================
   EXPRESS + SOCKET
   ========================================================= */

const app = express();

app.set('trust proxy', 1);

/*
  Önceki index.html inline CSS ve script kullanıyor.
  Bu nedenle varsayılan Helmet CSP kapalı.

  Bu, HTML'in çalışması için yapılmıştır;
  üretim ortamı için özel CSP hazırlanmalıdır.
*/
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: {
      policy: 'cross-origin'
    }
  })
);

app.use(express.json({ limit: '20kb' }));

app.use(
  '/api/',
  rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false
  })
);

const authLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false
});

const actionLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false
});

const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 10000
});

function tokenFromRequest(req) {
  const value = String(req.headers.authorization || '');

  if (!value.startsWith('Bearer ')) return '';

  return value.slice(7).trim();
}

function userFromToken(token) {
  if (!token || typeof token !== 'string' || token.length > 128) {
    return null;
  }

  const session = S.sessions[sha(token)];

  if (!session || session.exp <= now()) {
    return null;
  }

  const user = S.users[session.userId];

  if (!user || user.banned) {
    return null;
  }

  return user;
}

function auth(req, res, next) {
  const user = userFromToken(tokenFromRequest(req));

  if (!user) {
    return bad(res, 'Not logged in', 401);
  }

  req.user = user;
  next();
}

function adminOnly(req, res, next) {
  if (!isAdmin(req.user)) {
    return bad(res, 'Admin access required', 403);
  }

  next();
}

function emitMe(user) {
  io.to(`u:${user.id}`).emit('me:update', meView(user));
}

/* =========================================================
   AUTH
   ========================================================= */

app.post('/api/auth/start', authLimit, async (req, res) => {
  const username = String(req.body.username || '').trim();

  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return bad(res, 'Invalid Roblox username');
  }

  let user;

  try {
    user = await robloxLookup(username);
  } catch {
    return bad(res, 'Roblox API error. Try again.', 502);
  }

  if (!user) {
    return bad(res, 'Roblox user not found', 404);
  }

  const code = generateCode();

  pending.set(user.id, {
    ...user,
    code,
    exp: now() + 10 * 60 * 1000,
    tries: 0
  });

  res.json({
    id: user.id,
    robloxId: user.id,
    username: user.username,
    code,
    avatar: await robloxAvatar(user.id)
  });
});

app.post('/api/auth/verify', authLimit, async (req, res) => {
  const id = String(req.body.id || req.body.robloxId || '');
  const requestCode = String(req.body.code || '');
  const p = pending.get(id);

  if (!p || p.exp <= now()) {
    return bad(res, 'Code expired. Start again.');
  }

  if (++p.tries > 20) {
    pending.delete(id);
    return bad(res, 'Too many tries. Start again.');
  }

  /*
    Kullanıcının gönderdiği kod da bekleyen kodla eşleşmeli.
    Esas doğrulama Roblox About alanından yapılır.
  */
  if (requestCode && requestCode !== p.code) {
    return bad(res, 'Invalid verification code.');
  }

  let description;

  try {
    description = await robloxDescription(id);
  } catch {
    return bad(res, 'Roblox API error. Try again.', 502);
  }

  if (!description.includes(p.code)) {
    return bad(
      res,
      'Code not found in your Roblox About. Save it and try again.',
      401
    );
  }

  pending.delete(id);

  const avatar = await robloxAvatar(id);

  let user = S.users[id];

  if (!user) {
    user = {
      id,
      username: p.username,
      displayName: p.displayName,
      avatar: null,
      createdAt: now(),
      inventory: [],
      totalBet: 0,
      totalWon: 0,
      profit: 0,
      tx: [],
      banned: false
    };

    S.users[id] = user;
  }

  if (user.banned) {
    return bad(res, 'Account banned', 403);
  }

  user.username = p.username;
  user.displayName = p.displayName;

  if (avatar) {
    user.avatar = avatar;
  }

  const token = rid(32);

  S.sessions[sha(token)] = {
    userId: id,
    exp: now() + 30 * 24 * 60 * 60 * 1000
  };

  res.json({
    token,
    user: meView(user)
  });
});

app.post('/api/auth/logout', auth, (req, res) => {
  const token = tokenFromRequest(req);

  delete S.sessions[sha(token)];

  res.json({ ok: true });
});

setInterval(() => {
  const time = now();

  for (const [key, session] of Object.entries(S.sessions)) {
    if (session.exp <= time) {
      delete S.sessions[key];
    }
  }

  for (const [key, value] of pending.entries()) {
    if (value.exp <= time) {
      pending.delete(key);
    }
  }
}, 10 * 60 * 1000);

/* =========================================================
   PUBLIC DATA
   ========================================================= */

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
    countdownEnd: match.startedAt
      ? match.startedAt + 3000
      : null
  };

  /*
    Sonuç sadece maç bittikten sonra açıklanır.
  */
  if (match.state === 'finished') {
    result.winnerSide = match.winnerSide;
    result.result = match.winnerSide;
    result.winnerId = match.winnerId;
    result.winner = match.winnerId === match.host.id
      ? match.host
      : match.opp;
    result.seed = match.seed;
    result.finishedAt = match.finishedAt;
  }

  return result;
}

function publicGiveaway(giveaway) {
  return {
    id: giveaway.id,
    host: giveaway.host,
    items: giveaway.items.map(publicItem),
    value: giveaway.value,
    endsAt: giveaway.endsAt,
    minBet: giveaway.minBet,
    entrantCount: giveaway.entrants.length
  };
}

app.get('/api/state', (req, res) => {
  res.json({
    matches: Object.values(S.matches).map(publicMatch),
    giveaways: Object.values(S.giveaways).map(publicGiveaway),
    chat: S.chat,
    online: io.engine.clientsCount,
    bot,
    config: {
      range: RANGE,
      maxItems: MAX_ITEMS
    }
  });
});

app.get('/api/me', auth, (req, res) => {
  res.json({
    user: meView(req.user)
  });
});

app.get('/api/profile', auth, (req, res) => {
  const user = req.user;
  const perPage = 6;

  const pages = Math.max(
    1,
    Math.ceil(user.tx.length / perPage)
  );

  const page = Math.min(
    pages,
    Math.max(1, parseInt(req.query.page, 10) || 1)
  );

  res.json({
    user: meView(user),
    stats: {
      totalBet: round2(user.totalBet),
      totalWon: round2(user.totalWon),
      profit: round2(user.profit)
    },
    rows: user.tx.slice(
      (page - 1) * perPage,
      page * perPage
    ),
    page,
    pages
  });
});

app.get('/api/history/me', auth, (req, res) => {
  const history = S.history
    .filter(match =>
      match.host?.id === req.user.id ||
      match.joiner?.id === req.user.id
    )
    .slice(0, 30);

  res.json({ history });
});

/* =========================================================
   COINFLIP
   ========================================================= */

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

  if (!host || !opponent) {
    console.error('Cannot finish match: user not found', match.id);
    return;
  }

  const hostWins = match.winnerSide === match.hostSide;
  const winner = hostWins ? host : opponent;
  const loser = hostWins ? opponent : host;

  const winnerStake = hostWins
    ? match.hostValue
    : match.oppValue;

  const loserStake = hostWins
    ? match.oppValue
    : match.hostValue;

  match.state = 'finished';
  match.finishedAt = now();
  match.winnerId = winner.id;

  winner.inventory.push(
    ...match.hostItems,
    ...match.oppItems
  );

  host.totalBet = round2(host.totalBet + match.hostValue);

  opponent.totalBet = round2(
    opponent.totalBet + match.oppValue
  );

  winner.totalWon = round2(
    winner.totalWon + match.hostValue + match.oppValue
  );

  winner.profit = round2(winner.profit + loserStake);
  loser.profit = round2(loser.profit - loserStake);

  addTransaction(
    winner,
    'Coinflip Win',
    match.id,
    loserStake
  );

  addTransaction(
    loser,
    'Coinflip Loss',
    match.id,
    -loserStake
  );

  S.history.unshift(publicMatch(match));

  if (S.history.length > 500) {
    S.history.length = 500;
  }

  io.emit('match:update', publicMatch(match));
  emitMe(winner);
  emitMe(loser);

  setTimeout(
    () => removeFinishedMatch(match.id),
    20000
  );
}

function runMatch(match) {
  setTimeout(() => {
    if (match.state !== 'countdown') return;

    match.state = 'flipping';

    io.emit('match:update', publicMatch(match));

    setTimeout(() => {
      finishMatch(match);
    }, 3600);
  }, 3000);
}

app.post('/api/match/create', auth, actionLimit, (req, res) => {
  const user = req.user;
  const side = req.body.side;
  const uids = selectionToUids(req.body);

  if (side !== 'dog' && side !== 'cat') {
    return bad(res, 'Pick a side');
  }

  const openMatches = Object.values(S.matches).filter(
    match =>
      match.host.id === user.id &&
      match.state === 'waiting'
  );

  if (openMatches.length >= 3) {
    return bad(res, 'Max 3 open matches');
  }

  if (Object.keys(S.matches).length >= 150) {
    return bad(res, 'Lobby is full');
  }

  const selected = pickItems(user, uids, MAX_ITEMS);

  if (!selected) {
    return bad(res, 'Invalid item selection');
  }

  if (valueOf(selected) <= 0) {
    return bad(res, 'Value too low');
  }

  const items = takeItems(user, uids, MAX_ITEMS);
  const seed = rid(32);
  const id = rid(10);

  const match = {
    id,
    state: 'waiting',

    seed,
    hash: sha(seed),

    host: publicUser(user),
    opp: null,

    hostSide: side,

    hostItems: items,
    oppItems: [],

    hostValue: valueOf(items),
    oppValue: 0,

    createdAt: now(),
    startedAt: 0,
    finishedAt: 0,

    winnerSide: null,
    winnerId: null
  };

  S.matches[id] = match;

  io.emit('match:new', publicMatch(match));
  emitMe(user);

  res.json({
    match: publicMatch(match)
  });
});

app.post('/api/match/join', auth, actionLimit, (req, res) => {
  const user = req.user;
  const match = S.matches[String(req.body.id || '')];
  const uids = selectionToUids(req.body);

  if (!match || match.state !== 'waiting') {
    return bad(res, 'This match is no longer available');
  }

  if (match.host.id === user.id) {
    return bad(res, 'You cannot join your own match');
  }

  const selected = pickItems(user, uids, MAX_ITEMS);

  if (!selected) {
    return bad(res, 'Invalid item selection');
  }

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

  const digest = crypto
    .createHmac('sha256', match.seed)
    .update(match.id)
    .digest('hex');

  const roll =
    parseInt(digest.slice(0, 8), 16) / 0x100000000;

  match.winnerSide = roll < 0.5 ? 'dog' : 'cat';

  io.emit('match:update', publicMatch(match));
  emitMe(user);

  runMatch(match);

  res.json({
    match: publicMatch(match)
  });
});

app.post('/api/match/cancel', auth, actionLimit, (req, res) => {
  const match = S.matches[String(req.body.id || '')];

  if (
    !match ||
    match.state !== 'waiting' ||
    match.host.id !== req.user.id
  ) {
    return bad(res, 'Cannot cancel this match');
  }

  req.user.inventory.push(...match.hostItems);

  delete S.matches[match.id];

  io.emit('match:remove', { id: match.id });
  emitMe(req.user);

  res.json({ ok: true });
});

/* =========================================================
   CHAT HELPERS
   ========================================================= */

function pushChat(message) {
  S.chat.push(message);

  if (S.chat.length > 60) {
    S.chat.shift();
  }

  io.emit('chat:msg', message);
}

/* =========================================================
   GIVEAWAYS
   ========================================================= */

function endGiveaway(id) {
  const giveaway = S.giveaways[id];

  if (!giveaway) return;

  delete S.giveaways[id];

  const host = S.users[giveaway.host.id];

  if (!host) {
    console.error('Giveaway host not found:', id);
    return;
  }

  if (!giveaway.entrants.length) {
    host.inventory.push(...giveaway.items);

    emitMe(host);

    pushChat({
      id: rid(4),
      user: {
        username: 'System',
        avatar: null
      },
      text:
        `🎁 ${giveaway.host.username}'s giveaway ended ` +
        'with no entrants. Items returned.',
      ts: now()
    });
  } else {
    const winnerId =
      giveaway.entrants[
        crypto.randomInt(giveaway.entrants.length)
      ];

    const winner = S.users[winnerId];

    if (!winner) {
      host.inventory.push(...giveaway.items);
      emitMe(host);
    } else {
      winner.inventory.push(...giveaway.items);

      addTransaction(
        winner,
        'Giveaway Win',
        giveaway.id,
        giveaway.value
      );

      emitMe(winner);

      pushChat({
        id: rid(4),
        user: {
          username: 'System',
          avatar: null
        },
        text:
          `🎉 ${winner.username} won ` +
          `${giveaway.items.length} item(s) ` +
          `worth ${giveaway.value} from ` +
          `${giveaway.host.username}'s giveaway!`,
        ts: now()
      });
    }
  }

  io.emit('giveaway:remove', { id });
}

app.post(
  '/api/giveaway/create',
  auth,
  actionLimit,
  (req, res) => {
    const user = req.user;
    const mode = req.body.mode;
    const duration = Math.floor(Number(req.body.duration));
    const minBet = Number(req.body.minBet || 0);
    const uids = selectionToUids(req.body);

    if (mode === 'easy') {
      if (![30, 120, 300].includes(duration)) {
        return bad(res, 'Invalid duration');
      }
    } else if (mode === 'advanced') {
      if (duration < 60 || duration > 3600) {
        return bad(
          res,
          'Advanced duration must be 1–60 minutes'
        );
      }

      if (!Number.isFinite(minBet) || minBet < 0) {
        return bad(res, 'Invalid minimum bet');
      }
    } else {
      return bad(res, 'Invalid mode');
    }

    const ownGiveaways = Object.values(S.giveaways)
      .filter(g => g.host.id === user.id);

    if (ownGiveaways.length >= 3) {
      return bad(res, 'Max 3 active giveaways');
    }

    if (Object.keys(S.giveaways).length >= 20) {
      return bad(res, 'Too many active giveaways');
    }

    const selected = pickItems(user, uids, 5);

    if (!selected) {
      return bad(res, 'Select up to 5 valid items');
    }

    const items = takeItems(user, uids, 5);

    const giveaway = {
      id: rid(8),
      host: publicUser(user),
      items,
      value: valueOf(items),
      endsAt: now() + duration * 1000,
      minBet: mode === 'advanced' ? round2(minBet) : 0,
      entrants: []
    };

    S.giveaways[giveaway.id] = giveaway;

    setTimeout(
      () => endGiveaway(giveaway.id),
      duration * 1000
    );

    io.emit('giveaway:new', publicGiveaway(giveaway));
    emitMe(user);

    res.json({ ok: true });
  }
);

app.post(
  '/api/giveaway/enter',
  auth,
  actionLimit,
  (req, res) => {
    const user = req.user;
    const giveaway =
      S.giveaways[String(req.body.id || '')];

    if (!giveaway || giveaway.endsAt <= now()) {
      return bad(res, 'Giveaway ended');
    }

    if (giveaway.host.id === user.id) {
      return bad(res, 'You cannot enter your own giveaway');
    }

    if (giveaway.entrants.includes(user.id)) {
      return bad(res, 'Already entered');
    }

    if (user.totalBet < giveaway.minBet) {
      return bad(
        res,
        `You need ${giveaway.minBet} total bet to enter`
      );
    }

    giveaway.entrants.push(user.id);

    io.emit(
      'giveaway:update',
      publicGiveaway(giveaway)
    );

    res.json({ ok: true });
  }
);

/* =========================================================
   WITHDRAW
   ========================================================= */

/*
  Bot yazılımı bağlı olmadığı için withdraw kapalı.

  Önceki frontend "queued" mesajı gösteriyordu. Gerçekte bot
  bulunmadığından yanlış beklenti oluşturmaması için itemleri
  envanterden çıkarmadan hata döndürüyoruz.
*/
app.post('/api/withdraw', auth, actionLimit, (req, res) => {
  return bad(
    res,
    'Withdraw is disabled in this test version. No trade bot is connected.',
    503
  );
});

/* =========================================================
   ADMIN API
   ========================================================= */

function cleanItem(body) {
  const name = String(body.name || '').trim().slice(0, 40);
  const image = String(body.image || '').trim();
  const value = round2(Number(body.value));

  if (!name) return null;

  if (!/^https:\/\/[^\s"'<>]{4,400}$/.test(image)) {
    return null;
  }

  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1e9
  ) {
    return null;
  }

  return {
    name,
    image,
    value,
    age: ['normal', 'neon', 'mega'].includes(body.age)
      ? body.age
      : 'normal',
    fly: Boolean(body.fly),
    ride: Boolean(body.ride)
  };
}

app.get(
  '/api/admin/ui',
  auth,
  adminOnly,
  (req, res) => {
    res
      .type('application/javascript')
      .send(`(${adminUI.toString()})();`);
  }
);

app.get(
  '/api/admin/data',
  auth,
  adminOnly,
  (req, res) => {
    res.json({
      catalog: S.catalog,
      users: Object.values(S.users).map(user => ({
        id: user.id,
        username: user.username,
        items: user.inventory.length,
        value: valueOf(user.inventory),
        totalBet: round2(user.totalBet)
      }))
    });
  }
);

app.post(
  '/api/admin/catalog',
  auth,
  adminOnly,
  (req, res) => {
    const item = cleanItem(req.body);

    if (!item) {
      return bad(
        res,
        'Invalid item. Image must be a valid https:// URL.'
      );
    }

    item.id = rid(8);

    S.catalog.push(item);

    res.json({
      ok: true,
      item
    });
  }
);

app.post(
  '/api/admin/catalog/update',
  auth,
  adminOnly,
  (req, res) => {
    const item = S.catalog.find(
      x => x.id === req.body.id
    );

    const value = round2(Number(req.body.value));

    if (
      !item ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1e9
    ) {
      return bad(res, 'Invalid value');
    }

    item.value = value;

    /*
      Sadece katalogdaki değer değişir.
      Önceden verilmiş itemlerin değeri değişmez.
    */
    res.json({ ok: true });
  }
);

app.post(
  '/api/admin/catalog/delete',
  auth,
  adminOnly,
  (req, res) => {
    const index = S.catalog.findIndex(
      x => x.id === req.body.id
    );

    if (index < 0) {
      return bad(res, 'Item not found', 404);
    }

    S.catalog.splice(index, 1);

    res.json({ ok: true });
  }
);

app.post(
  '/api/admin/grant',
  auth,
  adminOnly,
  (req, res) => {
    const username = String(
      req.body.username || ''
    ).trim().toLowerCase();

    const user = Object.values(S.users).find(
      x => x.username.toLowerCase() === username
    );

    const item = S.catalog.find(
      x => x.id === req.body.catalogId
    );

    const qty = Math.floor(Number(req.body.qty));

    if (!user) {
      return bad(
        res,
        'User not found. They must log in once.'
      );
    }

    if (!item) {
      return bad(res, 'Catalog item not found');
    }

    if (!Number.isInteger(qty) || qty < 1 || qty > 50) {
      return bad(res, 'Quantity must be between 1 and 50');
    }

    for (let i = 0; i < qty; i++) {
      user.inventory.push(newItem(item));
    }

    emitMe(user);

    res.json({ ok: true });
  }
);

/* =========================================================
   ADMIN UI

   Bu fonksiyon sadece admin yetkisi doğrulandıktan sonra
   /api/admin/ui üzerinden gönderilir.
   ========================================================= */

function adminUI() {
  const { api, esc, toast, fmt, tags } = window.AMP;

  if (document.getElementById('adm')) return;

  const overlay = document.createElement('div');

  overlay.id = 'adm';
  overlay.className = 'ov open';
  overlay.style.zIndex = '150';

  overlay.innerHTML = `
    <div class="modal wide">
      <div class="mh">
        <h3>🛠 Admin Panel</h3>
        <button class="x" id="adm-x">✕</button>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px">
        <div style="background:#f5faff;padding:14px;border-radius:16px">
          <h4 style="margin-bottom:10px">➕ Add New Item</h4>

          <input
            id="a-img"
            class="in"
            style="width:100%;margin-bottom:8px"
            placeholder="Image URL (https://...)"
          >

          <img
            id="a-prev"
            alt=""
            style="width:70px;height:70px;object-fit:contain;display:block;margin:0 auto 8px"
          >

          <input
            id="a-name"
            class="in"
            style="width:100%;margin-bottom:8px"
            placeholder="Item name"
          >

          <input
            id="a-val"
            class="in"
            style="width:100%;margin-bottom:8px"
            type="number"
            min="0"
            step="0.01"
            placeholder="Value"
          >

          <div class="row">
            <select id="a-age">
              <option value="normal">Normal</option>
              <option value="neon">Neon</option>
              <option value="mega">Mega</option>
            </select>

            <label>
              <input id="a-fly" type="checkbox"> Fly
            </label>

            <label>
              <input id="a-ride" type="checkbox"> Ride
            </label>
          </div>

          <button
            id="a-add"
            class="btn"
            style="width:100%"
          >
            Add to Catalog
          </button>
        </div>

        <div style="background:#f5faff;padding:14px;border-radius:16px">
          <h4 style="margin-bottom:10px">🎁 Give Test Items</h4>

          <input
            id="g-user"
            list="g-users"
            class="in"
            style="width:100%;margin-bottom:8px"
            placeholder="Roblox username"
          >

          <datalist id="g-users"></datalist>

          <input
            id="g-qty"
            class="in"
            style="width:100%;margin-bottom:8px"
            type="number"
            min="1"
            max="50"
            value="1"
          >

          <p class="hint">
            User must have logged in once.
            Enter their username, then press Give on an item.
          </p>

          <p class="hint">
            Test data disappears when the server restarts.
          </p>
        </div>
      </div>

      <h4 style="margin:16px 0 8px">📦 Catalog</h4>

      <div
        id="adm-cat"
        style="display:grid;grid-template-columns:repeat(auto-fill,minmax(145px,1fr));gap:10px"
      ></div>

      <h4 style="margin:16px 0 8px">👥 Users</h4>

      <div id="adm-users"></div>
    </div>
  `;

  document.body.appendChild(overlay);

  const $ = id => document.getElementById(id);

  $('adm-x').onclick = () => overlay.remove();

  overlay.addEventListener('mousedown', event => {
    if (event.target === overlay) {
      overlay.remove();
    }
  });

  $('a-img').oninput = () => {
    const value = $('a-img').value.trim();

    $('a-prev').src = /^https:\/\//.test(value)
      ? value
      : '';
  };

  async function load() {
    const data = await api('/api/admin/data');

    $('adm-cat').innerHTML = data.catalog.length
      ? data.catalog.map(item => `
        <div
          style="border:2px solid #e0edfb;border-radius:14px;padding:10px;text-align:center"
        >
          <img
            src="${esc(item.image)}"
            alt=""
            style="width:70px;height:70px;object-fit:contain"
          >

          <div style="font-weight:700">
            ${esc(item.name)}
          </div>

          ${tags(item)}

          <input
            class="in"
            type="number"
            min="0"
            step="0.01"
            value="${esc(item.value)}"
            data-value-id="${esc(item.id)}"
            style="width:100%;margin:8px 0"
          >

          <div style="display:flex;gap:5px">
            <button
              class="btn mint sm"
              data-action="give"
              data-id="${esc(item.id)}"
              style="flex:1"
            >
              Give
            </button>

            <button
              class="btn red sm"
              data-action="delete"
              data-id="${esc(item.id)}"
            >
              🗑
            </button>
          </div>
        </div>
      `).join('')
      : '<p class="hint">No items yet.</p>';

    $('adm-users').innerHTML = data.users.length
      ? data.users.map(user => `
        <div
          style="display:flex;justify-content:space-between;gap:10px;padding:8px;border-bottom:1px solid #e0edfb"
        >
          <b>${esc(user.username)}</b>

          <span>
            ${user.items} items · ${fmt(user.value)}
          </span>
        </div>
      `).join('')
      : '<p class="hint">No users yet.</p>';

    $('g-users').innerHTML = data.users
      .map(user => `
        <option value="${esc(user.username)}"></option>
      `)
      .join('');
  }

  $('a-add').onclick = async () => {
    try {
      await api('/api/admin/catalog', {
        method: 'POST',
        body: {
          image: $('a-img').value,
          name: $('a-name').value,
          value: $('a-val').value,
          age: $('a-age').value,
          fly: $('a-fly').checked,
          ride: $('a-ride').checked
        }
      });

      $('a-img').value = '';
      $('a-name').value = '';
      $('a-val').value = '';
      $('a-prev').removeAttribute('src');

      toast('Item added!', 'ok');

      await load();
    } catch (error) {
      toast(error.message, 'err');
    }
  };

  $('adm-cat').onclick = async event => {
    const button = event.target.closest('[data-action]');

    if (!button) return;

    const id = button.dataset.id;

    try {
      if (button.dataset.action === 'give') {
        await api('/api/admin/grant', {
          method: 'POST',
          body: {
            username: $('g-user').value,
            catalogId: id,
            qty: $('g-qty').value
          }
        });

        toast('Test item given!', 'ok');
        await load();
      }

      if (button.dataset.action === 'delete') {
        if (!confirm('Delete this catalog item?')) return;

        await api('/api/admin/catalog/delete', {
          method: 'POST',
          body: { id }
        });

        toast('Item deleted', 'ok');
        await load();
      }
    } catch (error) {
      toast(error.message, 'err');
    }
  };

  $('adm-cat').onchange = async event => {
    const input = event.target;

    if (!input.dataset.valueId) return;

    try {
      await api('/api/admin/catalog/update', {
        method: 'POST',
        body: {
          id: input.dataset.valueId,
          value: input.value
        }
      });

      toast('Catalog value updated', 'ok');
    } catch (error) {
      toast(error.message, 'err');
      await load();
    }
  };

  load().catch(error => {
    toast(error.message, 'err');
    overlay.remove();
  });
}

/* =========================================================
   SOCKET CHAT
   ========================================================= */

io.use((socket, next) => {
  socket.token =
    socket.handshake.auth &&
    socket.handshake.auth.token;

  socket.user = userFromToken(socket.token);

  next();
});

io.on('connection', socket => {
  if (socket.user) {
    socket.join(`u:${socket.user.id}`);
  }

  io.emit('online', io.engine.clientsCount);

  socket.on('chat:send', (payload, ack) => {
    const callback =
      typeof ack === 'function' ? ack : () => {};

    /*
      Her mesajda token tekrar kontrol edilir.
    */
    const user = userFromToken(socket.token);

    if (!user) {
      return callback({ error: 'Login to chat' });
    }

    let text = typeof payload === 'string'
      ? payload
      : payload && payload.text;

    if (typeof text !== 'string') {
      return callback({ error: 'Invalid message' });
    }

    text = text
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 160);

    if (!text) {
      return callback({ error: 'Empty message' });
    }

    const time = now();

    if (time - (lastChat.get(user.id) || 0) < 1200) {
      return callback({ error: 'Slow down' });
    }

    lastChat.set(user.id, time);

    const admin = isAdmin(user);

    if (admin && text === '/clear') {
      S.chat = [];

      io.emit('chat:clear');

      return callback({ ok: true });
    }

    if (
      !admin &&
      /(https?:|www\.|discord\.gg|\.gg\/|\.com|\.net|\.xyz|\.ru|\.io)/i.test(text)
    ) {
      return callback({
        error: 'Links are not allowed in chat'
      });
    }

    pushChat({
      id: rid(4),
      user: {
        ...publicUser(user),
        rank: rankOf(user.totalBet)
      },
      rank: rankOf(user.totalBet),
      text,
      ts: time,
      admin
    });

    callback({ ok: true });
  });

  socket.on('disconnect', () => {
    io.emit('online', io.engine.clientsCount);
  });
});

/* =========================================================
   FRONTEND
   ========================================================= */

/*
  index.html, server.js ile aynı klasörde olmalı.
*/
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    storage: 'memory-only',
    warning: 'Data is lost when the server restarts.'
  });
});

/* =========================================================
   START
   ========================================================= */

server.listen(PORT, '0.0.0.0', () => {
  console.log(`AMP ROLL running on port ${PORT}`);
  console.log('TEST MODE: data is stored in memory only.');
  console.log('WARNING: all data is lost on restart.');

  loadBot();
});

setInterval(loadBot, 10 * 60 * 1000);
