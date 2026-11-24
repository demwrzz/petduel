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
const MAX_ITEMS = 20;

const DISCORD_INVITE = E.DISCORD_INVITE || 'https://discord.gg/TaPXaAseP';

/* ---- Discord ----
   Webhooks are gone: every coinflip / jackpot / giveaway / event / withdraw message is posted by the
   PetDuel Discord bot, which gets them live from this server (see sendWebhook > io.to('bots')). */
const WEBHOOK_GW = 'bot', WEBHOOK_CF = 'bot', WEBHOOK_JP = 'bot', WEBHOOK_WD = 'bot';
const SITE_URL = E.SITE_URL || 'https://petduel.win';
/* giveaways can run as long as you like (the cap is only a safety limit) */
const MAX_GW_SECONDS = 365 * 24 * 60 * 60;

let RANGE = Number(E.JOIN_RANGE || 0.10);
if (!Number.isFinite(RANGE) || RANGE < 0 || RANGE > 1) RANGE = 0.10;

const S = {
  users: Object.create(null),
  sessions: Object.create(null),
  catalog: [],
  matches: Object.create(null),
  history: [],
  giveaways: Object.create(null),
  chat: [],
  withdrawals: [],
  announcement: null,
  notifications: [],
  bounties: [],
  settings: { taxPercent: 0, taxReceiver: 'auto', taxIdx: 0 },
  updateNotes: [],
  jpHistory: [],
  /* deposit bots, managed in the admin panel: { id, username, link, online } */
  bots: [],
  /* banned IP addresses: { ip, reason, by, user, userId, ts } */
  ipBans: []
};

const pending = new Map();
const lastChat = new Map();

/* ================= HELPERS ================= */

const now = () => Date.now();
const rid = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');
const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');

/* ---------- Discord bot access ----------
   The PetDuel Discord bot sends its secret key in the X-Bot-Key header (or socket auth.botKey).
   Only the SHA-256 of the key is in this file; the key itself is only in the bot's .env.
   BOT_API_KEY in Railway can add another key. */
const BOT_KEY_HASHES = ['b17581f51a7513ea7610c5c9a9c9bdd5247474a78a6fdfa632eb6d6599ce99d7', ...(process.env.BOT_API_KEY ? [sha(process.env.BOT_API_KEY)] : [])];
const validBotKey = k => typeof k === 'string' && k.length >= 16 && k.length <= 200 && BOT_KEY_HASHES.includes(sha(k));
const reqHasBotKey = req => validBotKey(req.headers['x-bot-key']);
const round2 = n => Math.round(Number(n) * 100) / 100;
const bad = (res, message, status = 400) => res.status(status).json({ error: message });
const safeNumber = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const valueOf = items => round2(items.reduce((t, i) => t + safeNumber(i.value), 0));

/* players are shown with their site nickname; the Roblox name stays private (admins still see it) */
const nick = u => (u && (u.nickname || u.username)) || '';
const publicUser = u => ({ id: u.id, username: nick(u), avatar: u.avatar || null });

const NICK_RE = /^[A-Za-z0-9_]{3,16}$/;
const NICK_RESERVED = ['admin', 'owner', 'staff', 'support', 'moderator', 'mod', 'petduel', 'system', 'bot', 'official', 'roblox'];
function nickProblem(name, self) {
  if (!NICK_RE.test(name)) return 'Nickname must be 3-16 letters, numbers or _';
  const low = name.toLowerCase();
  if (NICK_RESERVED.some(r => low.includes(r))) return 'This nickname is not allowed';
  const taken = Object.values(S.users).some(u => u.id !== self.id &&
    ((u.nickname && u.nickname.toLowerCase() === low) || String(u.username).toLowerCase() === low));
  if (taken) return 'This nickname is taken';
  if (S.bots.some(b => b.username.toLowerCase() === low)) return 'This nickname is not allowed';
  return '';
}
/* admins type a nickname or a Roblox name */
const findUserByName = name => {
  const low = String(name || '').trim().toLowerCase();
  if (!low) return null;
  return Object.values(S.users).find(u => (u.nickname && u.nickname.toLowerCase() === low)) ||
    Object.values(S.users).find(u => String(u.username).toLowerCase() === low) || null;
};

/* ---------- admin notifications (bell) ---------- */
function notifyAdmins(type, text) {
  const n = { id: rid(4), type, text, ts: now() };
  S.notifications.unshift(n);
  if (S.notifications.length > 50) S.notifications.length = 50;
  markDirty();
  io.to('admins').emit('admin:notify', n);
}

/* ---------- Discord webhooks ---------- */
const clip = (v, n = 1000) => String(v ?? '').slice(0, n);

/* 28930000000 -> "28.93B" (PS99 values are in diamonds) */
const fmtV = v => {
  const n = Number(v || 0), a = Math.abs(n);
  for (const [d, u] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (a >= d) return +(n / d).toFixed(2) + u;
  return String(Math.round(n * 100) / 100);
};

/* PS99 pets: base name ("Huge Cat") + variant (normal / golden / rainbow) + shiny. The catalog name already
   holds the variant ("Shiny Rainbow Huge Cat"), so labels are just the name. */
const PS99_VARIANTS = ['normal', 'golden', 'rainbow'];
function ps99Parse(name) {
  let base = String(name || '').trim().replace(/\s+/g, ' ');
  let shiny = false, variant = 'normal';
  for (let k = 0; k < 3; k++) {
    if (/^shiny /i.test(base)) { shiny = true; base = base.slice(6); }
    else if (/^golden /i.test(base)) { variant = 'golden'; base = base.slice(7); }
    else if (/^(rainbow|rb) /i.test(base)) { variant = 'rainbow'; base = base.replace(/^(rainbow|rb) /i, ''); }
  }
  return { base, variant, shiny };
}
const ps99Key = (base, variant, shiny) => `${String(base || '').trim().toLowerCase().replace(/\s+/g, ' ')}|${PS99_VARIANTS.includes(variant) ? variant : 'normal'}|${shiny ? 1 : 0}`;
const ps99KeyOf = c => {
  const parsed = ps99Parse(c.name);
  return ps99Key(c.base || parsed.base, c.variant || parsed.variant, c.shiny !== undefined ? c.shiny : parsed.shiny);
};
const ps99FullName = (base, variant, shiny) => `${shiny ? 'Shiny ' : ''}${variant === 'golden' ? 'Golden ' : variant === 'rainbow' ? 'Rainbow ' : ''}${base}`;

const itemLine = items => clip(items.map(i => `${i.name} - ${fmtV(i.value)}`).join('\n') || '-');

/* pictures for embeds: only public https images are sent to Discord */
const httpsUrl = v => (typeof v === 'string' && /^https:\/\/[^\s"'<>]{4,500}$/.test(v) ? v : null);
const avatarOf = u => httpsUrl(u && (S.users[u.id]?.avatar || u.avatar));
const topImage = items => {
  const best = [...(items || [])].sort((a, b) => Number(b.value || 0) - Number(a.value || 0)).find(i => httpsUrl(i.image));
  return best ? best.image : null;
};

/* opts: { thumb: user whose avatar goes top right, image: big picture (url), author: user } */
/* what kind of event an embed is, from its title emoji (the bot posts each kind in its own channel) */
const embedKind = title => {
  const t = String(title || '');
  if (t.includes('🪙')) return 'coinflip';
  if (t.includes('💣')) return 'jackpot';
  if (t.includes('🎁') || t.includes('🎉')) return 'giveaway';
  if (t.includes('🎯')) return 'bounty';
  if (t.includes('🎡') || t.includes('🔤')) return 'event';
  if (t.includes('📤')) return 'withdraw';
  return 'other';
};

function sendWebhook(url, embed, opts = {}) {
  const thumb = opts.thumb ? avatarOf(opts.thumb) : null;
  const image = httpsUrl(opts.image);
  const full = {
    ...embed,
    url: embed.url || SITE_URL,
    footer: { text: 'Pet Duel · petduel.win' },
    ...(thumb ? { thumbnail: { url: thumb } } : {}),
    ...(image ? { image: { url: image } } : {}),
    ...(opts.author ? { author: { name: clip(nick(opts.author), 80), ...(avatarOf(opts.author) ? { icon_url: avatarOf(opts.author) } : {}) } } : {})
  };
  /* the Discord bot gets every event live, even when no webhook URL is set */
  if (typeof io !== 'undefined') io.to('bots').emit('bot:event', { kind: embedKind(embed.title), embed: full, data: opts.data || null });
}

/* Support team: given by admins in the admin panel. They can mark withdrawals as sent and mute in the chat. */
const isSupport = user => Boolean(user) && (isAdmin(user) || user.support === true);

function isAdmin(user) {
  if (!user) return false;
  return user.admin === true ||
    ADMIN_IDS.includes(String(user.id)) ||
    ADMIN_NAMES.includes(String(user.username).toLowerCase());
}

/* 12 ranks, based on total wagered value. "icon" picks the badge shape on the site. */
/* PS99: values are diamonds (a Huge Cat is ~15,000,000,000). Rank limits are x1,000,000; the stats saved from
   the old x1000 scale are moved over once (x1000) by scaleAllValues, so nobody loses their rank. */
const VALUE_SCALE = 1000000;
const RANKS = [
  { name: 'Rookie',      min: 0,       color: '#8d909a', icon: 'medal' },
  { name: 'Bronze',      min: 500,     color: '#cd7f32', icon: 'medal' },
  { name: 'Silver',      min: 2500,    color: '#c0c7d1', icon: 'medal' },
  { name: 'Gold',        min: 10000,   color: '#ffd24a', icon: 'medal' },
  { name: 'Platinum',    min: 25000,   color: '#7fe6e0', icon: 'gem' },
  { name: 'Diamond',     min: 60000,   color: '#6fb8ff', icon: 'gem' },
  { name: 'Master',      min: 120000,  color: '#a78bfa', icon: 'star' },
  { name: 'Grandmaster', min: 250000,  color: '#ec4899', icon: 'star' },
  { name: 'Champion',    min: 500000,  color: '#ff8a3d', icon: 'crown' },
  { name: 'Legend',      min: 1000000, color: '#ef4444', icon: 'crown' },
  { name: 'Mythic',      min: 2500000, color: '#22d3ee', icon: 'bolt' },
  { name: 'Godlike',     min: 5000000, color: '#f0abfc', icon: 'bolt' }
].map(r => ({ ...r, min: r.min * VALUE_SCALE }));

/* one-time migration: multiply every stored value by VALUE_SCALE (catalog, inventories, games, stats, history...) */
function scaleAllValues() {
  if (S.settings.valueScale === VALUE_SCALE) return;
  const f = VALUE_SCALE / (Number(S.settings.valueScale) || 1);
  const x = v => round2(Number(v || 0) * f);
  const items = list => (list || []).forEach(i => { if (i) i.value = x(i.value); });

  S.catalog.forEach(c => { c.value = x(c.value); });
  for (const u of Object.values(S.users)) {
    items(u.inventory);
    u.totalBet = x(u.totalBet); u.totalWon = x(u.totalWon); u.totalLost = x(u.totalLost); u.profit = x(u.profit);
    (u.tx || []).forEach(t => { t.amount = x(t.amount); });
  }
  for (const m of Object.values(S.matches)) { items(m.hostItems); items(m.oppItems); m.hostValue = x(m.hostValue); m.oppValue = x(m.oppValue); }
  for (const h of S.history) {
    items(h.hostItems); items(h.joinerItems); if (h.oppItems !== h.joinerItems) items(h.oppItems);
    h.hostValue = x(h.hostValue); h.oppValue = x(h.oppValue); h.value = x(h.value); if (h.taxValue) h.taxValue = x(h.taxValue);
  }
  for (const g of Object.values(S.giveaways)) { items(g.items); g.value = x(g.value); g.minBet = x(g.minBet); }
  for (const w of S.withdrawals) { items(w.items); w.value = x(w.value); }
  for (const b of S.bounties) { if (b.prize) b.prize.value = x(b.prize.value); }
  for (const r of S.jpHistory || []) {
    r.total = x(r.total); r.winnerValue = x(r.winnerValue);
    (r.players || []).forEach(p => { p.value = x(p.value); });
  }
  if (savedJackpot) (savedJackpot.entries || []).forEach(e => { items(e.items); e.value = x(e.value); });

  S.settings.valueScale = VALUE_SCALE;
  markDirty();
  console.log(`Values scaled x${f} (catalog ${S.catalog.length} items, ${Object.keys(S.users).length} players).`);
}

const rankIndex = name => RANKS.findIndex(r => r.name === name);

function rankOf(totalBet) {
  let result = RANKS[0].name;
  for (const r of RANKS) {
    if (totalBet >= r.min) result = r.name;
  }
  return result;
}

const MUTE_FOREVER = Number.MAX_SAFE_INTEGER;

/* every stat change goes through here */
function bump(user, d) {
  if (d.bet)    user.totalBet  = round2(user.totalBet + d.bet);
  if (d.won)    user.totalWon  = round2(user.totalWon + d.won);
  if (d.lost)   user.totalLost = round2((user.totalLost || 0) + d.lost);
  if (d.profit) user.profit    = round2(user.profit + d.profit);
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
    username: nick(user),
    nickname: user.nickname || '',
    robloxName: user.username,
    discordTag: user.discordTag || '',
    nickChangedAt: user.nickChangedAt || 0,
    displayName: user.displayName,
    avatar: user.avatar || null,
    isAdmin: isAdmin(user),
    isSupport: isSupport(user),
    totalBet: round2(user.totalBet),
    totalWon: round2(user.totalWon),
    totalLost: round2(user.totalLost || 0),
    profit: round2(user.profit),
    rank: rankOf(user.totalBet),
    mutedUntil: user.mutedUntil || 0,
    inventory: user.inventory.map(inventoryView)
  };
}

function newItem(c) {
  return {
    uid: rid(12), catalogId: c.id, name: c.name, image: c.image, value: c.value,
    base: c.base || ps99Parse(c.name).base, variant: c.variant || ps99Parse(c.name).variant, shiny: c.shiny !== undefined ? Boolean(c.shiny) : ps99Parse(c.name).shiny
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
  delete u.wagerLeft;

  /* the old second game is gone: its items disappear and only Adopt Me stats stay in the totals */
  u.inventory = u.inventory.filter(i => i.game !== 'ctd');
  for (const i of u.inventory) delete i.game;
  if (u.gstats) {
    const a = u.gstats.adoptme || {};
    u.totalBet = a.bet || 0;
    u.totalWon = a.won || 0;
    u.totalLost = a.lost || 0;
    u.profit = a.profit || 0;
    delete u.gstats;
  }

  return u;
}

/* ================= PERSISTENCE (optional MongoDB) ================= */

let mongoColl = null;
let dirty = false;
let dbRev = 0;
let dbDocExists = false;

function markDirty() { dirty = true; }

function snapshot() {
  /* Escrowed items (open matches / giveaways) are returned to their owners
     in the snapshot, so nothing is ever lost or duplicated after a restart. */
  const users = JSON.parse(JSON.stringify(S.users));

  /* open coinflips and the chat are saved as they are, so a restart does not cancel games or clear the chat */
  /* giveaways are saved as they are (they can run for days), so they survive a restart */

  /* the running jackpot round is saved too and continues after a restart */

  return {
    users,
    sessions: S.sessions,
    catalog: S.catalog,
    history: S.history.slice(0, 200),
    withdrawals: S.withdrawals.slice(0, 500),
    announcement: S.announcement,
    notifications: S.notifications.slice(0, 50),
    bounties: S.bounties,
    settings: S.settings,
    updateNotes: S.updateNotes,
    giveaways: S.giveaways,
    matches: Object.fromEntries(Object.entries(S.matches).filter(([, m]) => m.state !== 'finished')),
    jackpot: JP && JP.state !== 'finished' ? { ...JP, winner: null } : null,
    jpHistory: S.jpHistory.slice(0, 100),
    chat: S.chat.slice(-60),
    bots: S.bots.map(b => ({ id: b.id, username: b.username, link: b.link, online: b.online !== false, role: botRole(b) })),
    eventEscrow: S.eventEscrow || null,
    ipBans: S.ipBans || [],
    amTrades: (S.amTrades || []).slice(0, 5000),
    depositSessions: S.depositSessions || {},
    botWithdrawals: (S.botWithdrawals || []).slice(0, 2000),
    ltcSends: (S.ltcSends || []).slice(0, 500),
    usdtSends: (S.usdtSends || []).slice(0, 500)
  };
}

/* MM2 is removed from Pet Duel. Once, before anything else reads the data, everything MM2 is taken out:
   MM2 items in inventories, the MM2 catalog and bots, MM2 coinflips, giveaways, jackpot round, withdrawals,
   history and transactions; the stats go back to the Adopt Me stats. The whole data is saved first as the
   document backup-before-mm2-delete (never shown on the site). If that backup fails, nothing is removed. */
async function purgeMM2(d) {
  if (!d || (d.settings && d.settings.mm2Purged)) return d;
  const isMM = x => x && x.game === 'mm2';
  try {
    await mongoColl.updateOne({ _id: 'backup-before-mm2-delete' }, { $setOnInsert: { data: d, savedAt: new Date() } }, { upsert: true });
  } catch (error) {
    console.error('[MM2 DELETE] backup failed, nothing was removed:', error.message);
    return d;
  }
  let items = 0;
  for (const u of Object.values(d.users || {})) {
    const before = (u.inventory || []).length;
    u.inventory = (u.inventory || []).filter(i => !isMM(i));
    items += before - u.inventory.length;
    u.tx = (u.tx || []).filter(t => t.g !== 'mm2');
    if (u.gstats && u.gstats.adoptme) {
      const a = u.gstats.adoptme;
      u.totalBet = a.bet || 0; u.totalWon = a.won || 0; u.totalLost = a.lost || 0; u.profit = a.profit || 0;
    }
    delete u.gstats;
  }
  const keepObj = obj => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => !isMM(v)));
  d.catalog = (d.catalog || []).filter(c => !isMM(c));
  d.bots = (d.bots || []).filter(b => !isMM(b));
  d.matches = keepObj(d.matches);
  d.giveaways = keepObj(d.giveaways);
  d.history = (d.history || []).filter(h => !isMM(h));
  d.jpHistory = (d.jpHistory || []).filter(h => !isMM(h));
  d.withdrawals = (d.withdrawals || []).filter(w => !isMM(w));
  d.jackpot = (d.jackpots && d.jackpots.adoptme) || d.jackpot || null;
  for (const k of ['jackpots', 'botWithdrawals', 'processedTrades', 'cw', 'market']) delete d[k];
  d.settings = { ...(d.settings || {}), mm2Purged: true };
  for (const k of ['mm2Off', 'adoptMeOff', 'mm2Back', 'gamesV2', 'botAutoStatusOffFix', 'adoptMeRemoved']) delete d.settings[k];
  dirty = true;
  console.log(`[MM2 DELETE] MM2 removed: ${items} MM2 items taken out of inventories; backup saved as backup-before-mm2-delete`);
  return d;
}

/* Pet Duel is Pet Simulator 99 only now. Once, everything from Adopt Me is removed: the Adopt Me catalog,
   every pet in inventories, games, giveaways, jackpot, withdrawals, history and transactions. Player stats
   (total bet / won / profit, ranks) stay. The whole data is saved first as backup-before-adoptme-delete;
   if that backup fails nothing is removed. Bots stay but go offline until they get a PS99 join link. */
async function purgeAdoptMe(d) {
  if (!d || (d.settings && d.settings.adoptMePurged)) return d;
  try {
    await mongoColl.updateOne({ _id: 'backup-before-adoptme-delete' }, { $setOnInsert: { data: d, savedAt: new Date() } }, { upsert: true });
  } catch (error) {
    console.error('[ADOPT ME DELETE] backup failed, nothing was removed:', error.message);
    return d;
  }
  let items = 0;
  for (const u of Object.values(d.users || {})) {
    items += (u.inventory || []).length;
    u.inventory = [];
    u.tx = [];
  }
  d.catalog = [];
  d.matches = {};
  d.giveaways = {};
  d.history = [];
  d.jpHistory = [];
  d.withdrawals = [];
  d.jackpot = null;
  d.bounties = [];
  d.eventEscrow = null;
  d.depositSessions = {};
  d.botWithdrawals = [];
  d.bots = (d.bots || []).map(b => ({ ...b, online: false, needsLink: true }));
  d.settings = { ...(d.settings || {}), adoptMePurged: true };
  for (const k of ['valueSource', 'elveUrl', 'ps99CatalogV']) delete d.settings[k];
  dirty = true;
  console.log(`[ADOPT ME DELETE] Adopt Me removed: ${items} pets taken out of inventories; backup saved as backup-before-adoptme-delete`);
  return d;
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
    dbDocExists = Boolean(doc);
    dbRev = doc && doc.rev ? doc.rev : 0;

    if (doc && doc.data) {
      const d = await purgeAdoptMe(await purgeMM2(doc.data));
      S.users = Object.assign(Object.create(null), d.users || {});
      Object.values(S.users).forEach(ensureUser);
      S.sessions = Object.assign(Object.create(null), d.sessions || {});
      S.catalog = d.catalog || [];
      S.catalog = S.catalog.filter(c => c.game !== 'ctd');
      S.catalog.forEach(c => { delete c.game; });
      S.history = d.history || [];
      S.withdrawals = d.withdrawals || [];
      S.announcement = d.announcement || null;
      S.notifications = d.notifications || [];
      S.bounties = d.bounties || [];
      S.settings = { taxPercent: 0, taxReceiver: 'auto', taxIdx: 0, ...(d.settings || {}) };
      S.bots = Array.isArray(d.bots) ? d.bots : [];
      botsFromDb = Array.isArray(d.bots);
      S.updateNotes = d.updateNotes || [];
      S.giveaways = Object.assign(Object.create(null), d.giveaways || {});
      S.matches = Object.assign(Object.create(null), d.matches || {});
      S.chat = Array.isArray(d.chat) ? d.chat.slice(-60) : [];
      savedJackpot = d.jackpot || null;
      S.jpHistory = Array.isArray(d.jpHistory) ? d.jpHistory : [];
      S.ipBans = Array.isArray(d.ipBans) ? d.ipBans : [];
      S.amTrades = Array.isArray(d.amTrades) ? d.amTrades : [];
      S.depositSessions = d.depositSessions && typeof d.depositSessions === 'object' ? d.depositSessions : {};
      S.botWithdrawals = Array.isArray(d.botWithdrawals) ? d.botWithdrawals : [];
      S.ltcSends = Array.isArray(d.ltcSends) ? d.ltcSends : [];
      S.usdtSends = Array.isArray(d.usdtSends) ? d.usdtSends : [];
      /* an event prize from an admin's inventory was in play when the server stopped: give it back */
      const esc = d.eventEscrow;
      if (esc && esc.item && S.users[esc.userId]) {
        S.users[esc.userId].inventory.push(esc.item);
        console.log(`Event prize ${esc.item.name} returned to ${S.users[esc.userId].username} after a restart`);
        dirty = true;
      }
      S.eventEscrow = null;
      console.log('State loaded from MongoDB.');
    }
  } catch (err) {
    console.error('MongoDB error, running in memory:', err.message);
    mongoColl = null;
  }
}

/* The database keeps a revision number. If another server instance saved in the meantime
   (for example while Render swaps instances), this instance stops instead of overwriting newer data. */
async function saveNow() {
  if (!mongoColl || !dirty) return;
  dirty = false;

  try {
    const data = snapshot();
    let ok = true;

    if (!dbDocExists) {
      try {
        await mongoColl.insertOne({ _id: 'main', rev: 1, data });
        dbRev = 1;
        dbDocExists = true;
      } catch { ok = false; }
    } else {
      const filter = dbRev === 0 ? { _id: 'main', rev: { $exists: false } } : { _id: 'main', rev: dbRev };
      const result = await mongoColl.updateOne(filter, { $set: { data, rev: dbRev + 1 } });
      if (result.matchedCount === 1) dbRev += 1; else ok = false;
    }

    if (!ok) {
      console.error('[SECURITY] The database was changed by another server instance. Stopping this instance to protect the data.');
      process.exit(1);
    }
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

/* ---- Deposit bots ----
   Admins add / remove bots and switch each one online or offline in the admin panel.
   Deposits are confirmed by hand, so "offline" simply means: do not send trades to this bot right now. */
const botProfiles = new Map(); /* username (lowercase) -> { robloxId, username, avatar } */

/* the default bot is only added once, on a brand-new database. A list emptied by an admin stays empty. */
let botsFromDb = false;
function ensureDefaultBot() {
  if (botsFromDb || S.settings.botsSeeded) return;
  if (!S.bots.length) S.bots.push({ id: rid(6), username: BOT_NAME, link: BOT_LINK, online: true });
  S.settings.botsSeeded = true;
  markDirty();
}

/* every bot is either a deposit bot (players trade pets to it) or a withdraw bot (it sends pets out) */
const botRole = b => (b.role === 'withdraw' ? 'withdraw' : 'deposit');
/* the bots that send withdrawals; while no withdraw bot is set up, the deposit bots do it */
function withdrawBotPool() {
  const w = S.bots.filter(b => botRole(b) === 'withdraw');
  return w.length ? w : S.bots.filter(b => botRole(b) === 'deposit');
}
let wdBotTurn = 0;
function pickWithdrawBot() {
  const online = withdrawBotPool().filter(b => b.online !== false);
  if (!online.length) return null;
  return online[wdBotTurn++ % online.length];
}
function publicWdBot(ref, full = false) {
  if (!ref) return null;
  const b = S.bots.find(x => x.id === ref.id);
  const p = botProfiles.get(String(ref.username).toLowerCase()) || {};
  const name = p.username || ref.username;
  return { username: full ? name : maskName(name), avatar: p.avatar || null, link: b ? b.link : '', online: b ? b.online !== false : false };
}

/* bot names are shown in full so players can find the bot in game */
const maskName = n => n;
const publicBots = (full = false) => S.bots.map(b => {
  const p = botProfiles.get(b.username.toLowerCase()) || {};
  const name = p.username || b.username;
  return {
    id: b.id, username: full ? name : maskName(name), ...(full ? { robloxId: p.robloxId || null } : {}),
    avatar: p.avatar || null, link: b.link, joinLink: b.link, online: b.online !== false, role: botRole(b)
  };
});

/* kept for older clients: the first bot */
const firstBot = () => publicBots().find(b => b.role === 'deposit') || null;

async function loadBotProfile(username) {
  try {
    const user = await robloxLookup(username);
    if (!user) return;
    botProfiles.set(username.toLowerCase(), { robloxId: user.id, username: user.username, avatar: await robloxAvatar(user.id) });
  } catch (error) {
    console.error(`Bot profile ${username} could not be loaded:`, error.message);
  }
}

async function loadBots() {
  for (const b of S.bots) await loadBotProfile(b.username);
  io.emit('bots:update', publicBots());
}

const emitBots = () => io.emit('bots:update', publicBots());

/* ================= EXPRESS + SOCKET ================= */

const app = express();
app.set('trust proxy', 1);

/* ---------- Country block ----------
   BLOCK_COUNTRIES=TR (comma separated country codes) blocks visitors from those countries.
   Cloudflare tells us the visitor's country in the CF-IPCountry header.
   Staff open https://petduel.win/?staff=STAFF_KEY once: a cookie then lets them in from anywhere. */
const ENV_BLOCK = (E.BLOCK_COUNTRIES || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
/* blocked countries come from the admin panel (saved in the database) plus BLOCK_COUNTRIES if it is set */
const blockList = () => [...new Set([...ENV_BLOCK, ...((S.settings && S.settings.blockCountries) || [])])];
const STAFF_KEY = E.STAFF_KEY || '';
/* staff key: STAFF_KEY from Railway, or one the site creates itself (saved in the database) */
const staffKey = () => {
  if (STAFF_KEY) return STAFF_KEY;
  if (!S.settings.staffKey) { S.settings.staffKey = rid(12); markDirty(); }
  return S.settings.staffKey;
};
const staffCookieValue = () => sha('staff:' + staffKey());
const staffCookieHeader = () => `pd_staff=${staffCookieValue()}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;

const hasStaffCookie = cookieHeader =>
  String(cookieHeader || '').split(';').some(c => c.trim() === 'pd_staff=' + staffCookieValue());
/* the visitor's real IP: Cloudflare sends it in CF-Connecting-IP, otherwise the first X-Forwarded-For entry */
const clientIp = (headers, fallback) => {
  const cf = String(headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf;
  const xff = String(headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || String(fallback || '');
};

/* country: Cloudflare's CF-IPCountry header; if it is missing, a cached lookup of the IP */
const geoCache = new Map();   /* ip -> { c, exp } */
async function lookupCountry(ip) {
  if (!ip || /^(127\.|10\.|192\.168\.|::1|::ffff:127\.)/.test(ip)) return '';
  const hit = geoCache.get(ip);
  if (hit && hit.exp > now()) return hit.c;
  let c = '';
  try {
    const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code`, { signal: AbortSignal.timeout(2000) });
    const d = await r.json();
    if (d && d.success) c = String(d.country_code || '').toUpperCase();
  } catch { /* unknown country: let the visitor in */ }
  if (geoCache.size > 50000) geoCache.clear();
  geoCache.set(ip, { c, exp: now() + (c ? 24 : 1) * 60 * 60 * 1000 });
  return c;
}
async function countryOf(headers, fallbackIp) {
  const cf = String(headers['cf-ipcountry'] || '').toUpperCase();
  if (cf && cf !== 'XX' && cf !== 'T1') return { country: cf, source: 'cloudflare' };
  return { country: await lookupCountry(clientIp(headers, fallbackIp)), source: 'ip lookup' };
}
const blockedCountry = async (headers, ip) => blockList().includes((await countryOf(headers, ip)).country);

const BLOCKED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pet Duel</title><style>html,body{margin:0;height:100%}body{display:grid;place-items:center;padding:24px;box-sizing:border-box;
background:radial-gradient(circle at 50% 40%,#10291f,#0b0d12 70%);color:#fff;font-family:system-ui,Arial,sans-serif;text-align:center}
h1{margin:0;font-size:clamp(56px,14vw,140px);font-weight:900;letter-spacing:-.04em}h1 span{color:#00efa0}
p{margin:16px 0 0;font-size:clamp(17px,3vw,24px);font-weight:700}small{display:block;margin-top:10px;color:#8d909a;font-size:15px}</style></head>
<body><div><h1>PET<span>DUEL</span></h1><p>Pet Duel is not available in your country.</p><small>Sorry! This site cannot be used from your location.</small></div></body></html>`;

/* check what the server sees: https://petduel.win/api/whereami */
app.get('/api/whereami', async (req, res) => {
  const { country, source } = await countryOf(req.headers, req.ip);
  res.json({
    country: country || 'unknown', source,
    blocking: blockList(), blocked: blockList().includes(country),
    staffCookie: hasStaffCookie(req.headers.cookie)
  });
});

/* banned IPs stop here (before anything else answers) */
app.use((req, res, next) => {
  if (!(S.ipBans || []).length || req.path === '/health') return next();
  const ip = clientIp(req.headers, req.ip);
  if (!ipBanned(ip) || hasStaffCookie(req.headers.cookie) || reqHasBotKey(req) || gameBotSecretOk(req) || (req.query.staff && req.query.staff === staffKey())) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'You are banned from Pet Duel', ipBanned: true });
  return res.status(403).type('html').send(BANNED_PAGE);
});

app.use(async (req, res, next) => {
  if (req.query.staff && req.query.staff === staffKey()) {
    res.setHeader('Set-Cookie', staffCookieHeader());
    return res.redirect('/');
  }
  if (!blockList().length || req.path === '/health' || req.path === '/api/whereami') return next();
  if (hasStaffCookie(req.headers.cookie) || reqHasBotKey(req) || gameBotSecretOk(req)) return next();
  if (await blockedCountry(req.headers, req.ip)) {
    if (req.path.startsWith('/api/')) return res.status(451).json({ error: 'Pet Duel is not available in your country' });
    return res.status(451).type('html').send(BLOCKED_PAGE);
  }
  next();
});

/* ---------- abuse / DDoS protection ----------
   Layers: per-IP rate limits (page, API, bursts, login), automatic 15 minute block for IPs that keep
   hitting the limits, request size and timeout limits, socket connection and event limits,
   and a short cache for the public state endpoint. For large attacks also put Cloudflare in front of the site. */
const strikes = new Map();
const blockedIps = new Map();

function strike(ip) {
  const t = now();
  const e = strikes.get(ip) || { n: 0, t };

  if (t - e.t > 10 * 60 * 1000) { e.n = 0; e.t = t; }
  e.n += 1;
  strikes.set(ip, e);

  if (e.n >= 8) {
    blockedIps.set(ip, t + 15 * 60 * 1000);
    strikes.delete(ip);
    console.warn(`[SECURITY] ${ip} blocked for 15 minutes (too many requests)`);
  }
}

app.use((req, res, next) => {
  const until = blockedIps.get(req.ip);

  if (until) {
    if (until > now()) {
      res.set('Retry-After', '900');
      return res.status(429).type('text/plain').send('Too many requests. Try again later.');
    }
    blockedIps.delete(req.ip);
  }

  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      /* unsafe-inline / unsafe-eval are needed because the pages use inline scripts and the admin panel is loaded after login */
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://challenges.cloudflare.com'],
      frameSrc: ["'self'", 'https://challenges.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

const limiter = (windowMs, max, extra = {}) => rateLimit({
  windowMs, max,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    strike(req.ip);
    res.status(429).json({ error: 'Too many requests. Slow down.' });
  },
  ...extra
});

app.use(limiter(60 * 1000, 500, { skip: req => req.path === '/health' }));   // everything, per IP
app.use(express.json({ limit: '20kb' }));
app.use('/assets', express.static(path.join(__dirname, 'assets'), { maxAge: '7d' }));

app.use('/api/', limiter(60 * 1000, 400));        // API per minute
app.use('/api/', limiter(10 * 1000, 150));        // API bursts

const authLimit = limiter(60 * 1000, 10);                                        // login attempts per IP
const authGlobal = limiter(60 * 1000, 150, { keyGenerator: () => 'global' });    // protects the Roblox API from floods
const actionLimit = limiter(60 * 1000, 30);                                      // item / game actions per IP

const server = http.createServer(app);
server.headersTimeout = 15000;
server.requestTimeout = 20000;
server.keepAliveTimeout = 10000;
server.maxHeadersCount = 50;

const io = new Server(server, {
  maxHttpBufferSize: 10000,
  pingInterval: 25000,
  pingTimeout: 20000,
  connectTimeout: 10000,
  perMessageDeflate: false
});

/* limit sockets per IP */
const socketsByIp = new Map();
const socketsByUser = new Map();
const onlineCount = () => socketsByUser.size;

/* ---------- IP bans ----------
   Admins ban single IPs or every IP a player used (the last 10 IPs of each player are kept).
   A banned IP gets a "banned" page / API error and cannot open a live connection. The staff link cookie and the
   Discord bot key always get through, so an admin cannot lock themselves out. */
const validIp = v => /^(\d{1,3}\.){3}\d{1,3}$/.test(v) || (/^[0-9a-f:]+$/i.test(v) && v.includes(':') && v.length <= 45);
const ipBanned = ip => Boolean(ip) && (S.ipBans || []).some(b => b.ip === ip);
const BANNED_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pet Duel</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101218;color:#f6f7fb;font-family:Arial,sans-serif;text-align:center;padding:20px}
h1{font-size:34px;margin:0 0 10px}p{color:#9aa0ad;max-width:420px}</style></head>
<body><div><h1>🚫 You are banned</h1><p>Your access to Pet Duel has been blocked. If you think this is a mistake, contact us on Discord.</p></div></body></html>`;

function rememberIp(user, ip) {
  if (!user || !ip) return;
  const list = Array.isArray(user.ips) ? user.ips : [];
  if (list[0] === ip) return;
  user.ips = [ip, ...list.filter(x => x !== ip)].slice(0, 10);
  markDirty();
}

function kickBannedIps() {
  for (const sock of io.sockets.sockets.values()) {
    if (ipBanned(sock._realIp) && !sock.isBot) sock.disconnect(true);
  }
}

const socketIp = socket => {
  const xff = String(socket.handshake.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : socket.handshake.address;
};

io.use(async (socket, next) => {
  socket._realIp = clientIp(socket.handshake.headers, socket.handshake.address);
  if (ipBanned(socket._realIp) && !hasStaffCookie(socket.handshake.headers.cookie) && !validBotKey(socket.handshake.auth && socket.handshake.auth.botKey)) {
    return next(new Error('banned'));
  }
  if (blockList().length && !hasStaffCookie(socket.handshake.headers.cookie) && !validBotKey(socket.handshake.auth && socket.handshake.auth.botKey) &&
      await blockedCountry(socket.handshake.headers, socket.handshake.address)) {
    return next(new Error('Not available in your country'));
  }
  const ip = socketIp(socket);
  const count = socketsByIp.get(ip) || 0;

  if (blockedIps.has(ip) || count >= 12) return next(new Error('Too many connections'));

  socket._ip = ip;
  socketsByIp.set(ip, count + 1);

  socket.on('disconnect', () => {
    const left = (socketsByIp.get(ip) || 1) - 1;
    if (left <= 0) socketsByIp.delete(ip); else socketsByIp.set(ip, left);
  });

  next();
});

/* the online counter is broadcast at most every 2 seconds, so connect / disconnect floods cannot spam everyone */
let onlineTimer = null;
function emitOnlineSoon() {
  if (onlineTimer) return;
  onlineTimer = setTimeout(() => {
    onlineTimer = null;
    io.emit('online', onlineCount());
  }, 2000);
}

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
  if (now() - (user.lastSeen || 0) > 30000) user.lastSeen = now();
  return user;
}

const NICK_FREE = ['/api/me', '/api/me/nickname', '/api/auth/logout', '/api/withdrawals', '/api/profile', '/api/me/discord-code', '/api/me/discord-unlink'];

/* the Discord bot acts as an admin; the Discord staff member who used the command is named in the logs */
function botActor(req) {
  const who = String(req.headers['x-bot-actor'] || 'staff').replace(/[^\w .#-]/g, '').slice(0, 40) || 'staff';
  return { id: 'discord-bot', username: `Discord/${who}`, nickname: `Discord/${who}`, admin: true, inventory: [], tx: [], totalBet: 0, totalWon: 0, totalLost: 0, profit: 0 };
}

function auth(req, res, next) {
  if (reqHasBotKey(req)) { req.user = botActor(req); req.isBot = true; return next(); }
  const user = userFromToken(tokenFromRequest(req));
  if (!user) return bad(res, 'Not logged in', 401);
  req.user = user;
  rememberIp(user, clientIp(req.headers, req.ip));
  /* everyone has to choose a site nickname before playing (admins can still use the admin panel) */
  const path = req.originalUrl.split('?')[0];
  if (!user.nickname && !NICK_FREE.includes(path) && !(isAdmin(user) && path.startsWith('/api/admin'))) {
    return res.status(403).json({ error: 'Choose a nickname first', needNickname: true });
  }
  next();
}

function botOnly(req, res, next) {
  if (!reqHasBotKey(req)) return bad(res, 'Bot key required', 403);
  req.user = botActor(req);
  next();
}

function adminOnly(req, res, next) {
  if (!isAdmin(req.user)) return bad(res, 'Admin access required', 403);
  next();
}

/* ---------- Maintenance mode: only admins can use the site ----------
   Login, captcha and /api/me stay open so admins can still sign in. */
const maintenanceOn = () => Boolean(S.settings.maintenance);
const MAINT_OPEN = ['/auth/', '/captcha', '/me'];

app.use('/api', (req, res, next) => {
  if (!maintenanceOn() || reqHasBotKey(req) || gameBotSecretOk(req)) return next();
  const user = userFromToken(tokenFromRequest(req));
  if (user && isAdmin(user)) return next();

  if (req.path === '/state') {
    return res.json({
      maintenance: true,
      maintenanceText: S.settings.maintenanceText || '',
      config: { captcha: { mode: TURNSTILE_SECRET && TURNSTILE_SITE_KEY ? 'turnstile' : 'builtin', siteKey: TURNSTILE_SITE_KEY }, robloxLogin: oauthOn() },
      now: now()
    });
  }
  if (MAINT_OPEN.some(p => req.path === p || req.path.startsWith(p))) return next();
  res.status(503).json({ error: 'Pet Duel is closed right now', maintenance: true });
});

function emitMe(user) {
  markDirty();
  io.to(`u:${user.id}`).emit('me:update', meView(user));
}

/* ================= CAPTCHA =================
   Login and giveaway entries need a captcha. With TURNSTILE_SITE_KEY + TURNSTILE_SECRET set in Render
   (free Cloudflare Turnstile) the real Turnstile widget is used. Without them a built-in image captcha is used. */

const TURNSTILE_SITE_KEY = E.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET = E.TURNSTILE_SECRET || '';

const captchas = new Map();
const CAPTCHA_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeCaptcha() {
  const rnd = (a, b) => round2(a + (crypto.randomInt(10001) / 10000) * (b - a));
  const colors = ['#8bffd8', '#ffd35a', '#8ec5ff', '#ffb3c1', '#d6b8ff', '#ffffff'];
  const pick = () => colors[crypto.randomInt(colors.length)];

  const text = Array.from({ length: 5 }, () => CAPTCHA_CHARS[crypto.randomInt(CAPTCHA_CHARS.length)]).join('');

  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="70" viewBox="0 0 200 70"><rect width="200" height="70" fill="#1b1e27"/>';

  for (let i = 0; i < 7; i++) {
    svg += `<line x1="${rnd(0, 200)}" y1="${rnd(0, 70)}" x2="${rnd(0, 200)}" y2="${rnd(0, 70)}" stroke="${pick()}" stroke-opacity="0.45" stroke-width="${rnd(1, 2.5)}"/>`;
  }
  for (let i = 0; i < 40; i++) {
    svg += `<circle cx="${rnd(0, 200)}" cy="${rnd(0, 70)}" r="${rnd(0.6, 1.8)}" fill="${pick()}" opacity="0.5"/>`;
  }

  [...text].forEach((ch, i) => {
    const x = round2(22 + i * 34 + rnd(-4, 4));
    const y = round2(46 + rnd(-6, 6));
    svg += `<text x="${x}" y="${y}" font-size="${Math.round(rnd(30, 38))}" font-family="Arial, Helvetica, sans-serif" font-weight="800" fill="${pick()}" transform="rotate(${rnd(-28, 28)} ${x} ${y})">${ch}</text>`;
  });

  return { text, svg: svg + '</svg>' };
}

app.get('/api/captcha', limiter(60 * 1000, 30), (req, res) => {
  if (TURNSTILE_SECRET && TURNSTILE_SITE_KEY) return bad(res, 'The built-in captcha is not used');

  if (captchas.size > 5000) {
    const oldest = captchas.keys().next().value;
    captchas.delete(oldest);
  }

  const c = makeCaptcha();
  const id = rid(10);
  captchas.set(id, { answer: c.text, exp: now() + 3 * 60 * 1000 });

  res.json({ id, image: c.svg });
});

/* every captcha can be used only once, right or wrong */
async function checkCaptcha(req, res) {
  const body = req.body || {};

  if (TURNSTILE_SECRET && TURNSTILE_SITE_KEY) {
    const token = String(body.captchaToken || '');

    if (token && token.length <= 4096) {
      try {
        const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token, remoteip: String(req.ip || '') }),
          signal: AbortSignal.timeout(8000)
        });
        const data = await response.json();
        if (data && data.success) return true;
      } catch { /* falls through to the error below */ }
    }

    res.status(400).json({ error: 'Captcha failed. Try again.', captcha: true });
    return false;
  }

  const id = String(body.captchaId || '');
  const answer = String(body.captchaAnswer || '').trim().toUpperCase();
  const c = captchas.get(id);
  captchas.delete(id);

  if (!c || c.exp < now() || c.answer !== answer) {
    res.status(400).json({ error: 'Wrong captcha. Try again.', captcha: true });
    return false;
  }

  return true;
}

/* ================= AUTH ================= */

app.post('/api/auth/start', authLimit, authGlobal, async (req, res) => {
  if (pending.size > 5000) return bad(res, 'The server is busy. Try again in a minute.', 503);
  if (!(await checkCaptcha(req, res))) return;

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

  const result = loginUser(id, p.username, p.displayName, avatar);
  if (result.error) return bad(res, result.error, 403);
  res.json(result);
});

/* creates the account on first login, updates name / avatar, and returns a new session */
function loginUser(id, username, displayName, avatar) {
  let user = S.users[id];
  if (!user) {
    user = ensureUser({
      id, username, displayName,
      avatar: null, createdAt: now(), banned: false
    });
    S.users[id] = user;
    notifyAdmins('register', `New player registered: ${user.username}`);
  }

  if (user.banned) return { error: 'Account banned' };

  user.username = username;
  user.displayName = displayName || username;
  if (avatar) user.avatar = avatar;

  const token = rid(32);
  S.sessions[sha(token)] = { userId: id, exp: now() + 30 * 24 * 60 * 60 * 1000 };
  markDirty();
  return { token, user: meView(user) };
}

/* ---------- Sign in with Roblox (official OAuth 2.0, authorization code + PKCE) ----------
   Create the app at create.roblox.com > OAuth 2.0 Apps, scopes "openid" + "profile",
   redirect URL: SITE_URL + /api/auth/roblox/callback. Then set ROBLOX_CLIENT_ID and ROBLOX_CLIENT_SECRET. */
const ROBLOX_CLIENT_ID = E.ROBLOX_CLIENT_ID || '';
const ROBLOX_CLIENT_SECRET = E.ROBLOX_CLIENT_SECRET || '';
const oauthOn = () => Boolean(ROBLOX_CLIENT_ID && ROBLOX_CLIENT_SECRET);
const oauthRedirect = () => SITE_URL.replace(/\/+$/, '') + '/api/auth/roblox/callback';
const oauthStates = new Map();   /* state -> { verifier, exp } */
const oauthTickets = new Map();  /* one-time ticket -> { token, user, exp }: the session token never goes in a URL */
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

app.get('/api/auth/roblox', authLimit, (req, res) => {
  if (!oauthOn()) return res.redirect('/?oauth_error=' + encodeURIComponent('Sign in with Roblox is not set up yet'));
  if (oauthStates.size > 5000) oauthStates.clear();

  const state = rid(16);
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  oauthStates.set(state, { verifier, exp: now() + 10 * 60 * 1000 });

  const url = new URL('https://apis.roblox.com/oauth/v1/authorize');
  url.searchParams.set('client_id', ROBLOX_CLIENT_ID);
  url.searchParams.set('redirect_uri', oauthRedirect());
  url.searchParams.set('scope', 'openid profile');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  res.redirect(url.toString());
});

app.get('/api/auth/roblox/callback', authLimit, async (req, res) => {
  const fail = msg => res.redirect('/?oauth_error=' + encodeURIComponent(msg));
  if (!oauthOn()) return fail('Sign in with Roblox is not set up yet');
  if (req.query.error) return fail(req.query.error === 'access_denied' ? 'Login cancelled' : 'Roblox login failed');

  const state = String(req.query.state || '');
  const code = String(req.query.code || '');
  const st = oauthStates.get(state);
  oauthStates.delete(state);
  if (!st || st.exp <= now() || !code) return fail('Login expired, please try again');

  try {
    const tokenRes = await fetch('https://apis.roblox.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, code_verifier: st.verifier,
        client_id: ROBLOX_CLIENT_ID, client_secret: ROBLOX_CLIENT_SECRET
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!tokenRes.ok) throw new Error('token ' + tokenRes.status);
    const tok = await tokenRes.json();

    const infoRes = await fetch('https://apis.roblox.com/oauth/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + tok.access_token },
      signal: AbortSignal.timeout(10000)
    });
    if (!infoRes.ok) throw new Error('userinfo ' + infoRes.status);
    const info = await infoRes.json();

    const id = String(info.sub || '');
    const username = String(info.preferred_username || info.name || '').slice(0, 40);
    if (!/^\d{1,20}$/.test(id) || !username) throw new Error('bad userinfo');

    const avatar = (await robloxAvatar(id)) || httpsUrl(info.picture);
    const result = loginUser(id, username, String(info.nickname || info.name || username).slice(0, 40), avatar);
    if (result.error) return fail(result.error);

    const ticket = rid(16);
    oauthTickets.set(ticket, { ...result, exp: now() + 60 * 1000 });
    res.redirect('/?oauth=' + ticket);
  } catch (error) {
    console.error('Roblox OAuth error:', error.message);
    fail('Roblox login failed, please try again');
  }
});

/* the page swaps the one-time ticket for the session token */
app.post('/api/auth/roblox/finish', authLimit, (req, res) => {
  const ticket = String(req.body.ticket || '');
  const t = oauthTickets.get(ticket);
  oauthTickets.delete(ticket);
  if (!t || t.exp <= now()) return bad(res, 'Login expired, please try again');
  res.json({ token: t.token, user: t.user });
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
  for (const [k, v] of oauthStates.entries()) if (v.exp <= t) oauthStates.delete(k);
  for (const [k, v] of oauthTickets.entries()) if (v.exp <= t) oauthTickets.delete(k);
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
    maxJoin: match.maxJoin || 0,
    countdownEnd: match.startedAt ? match.startedAt + 3000 : null
  };

  if (match.state === 'flipping') {
    /* both sides are already locked in: clients play the same flip animation as the replay */
    result.winnerSide = match.winnerSide;
  }

  if (match.state === 'finished') {
    result.winnerSide = match.winnerSide;
    result.result = match.winnerSide;
    result.winnerId = match.winnerId;
    result.winner = match.winnerId === match.host.id ? match.host : match.opp;
    result.seed = match.seed;
    result.finishedAt = match.finishedAt;
    result.taxValue = match.taxValue || 0;
  }
  return result;
}

function publicGiveaway(g) {
  return {
    id: g.id, host: g.host, items: g.items.map(publicItem), value: g.value,
    endsAt: g.endsAt, startedAt: g.startedAt, duration: g.duration,
    minBet: g.minBet, minRank: g.minRank || '', entrantCount: g.entrants.length, entrantIds: g.entrants
  };
}

function buildState() {
  return {
    matches: Object.values(S.matches).map(publicMatch),
    giveaways: Object.values(S.giveaways).map(publicGiveaway),
    chat: S.chat,
    online: onlineCount(),
    maintenance: maintenanceOn(),
    bot: firstBot(),
    bots: publicBots(),
    bounties: publicBounties(),
    announcement: S.announcement,
    event: publicEvent(EVENT),
    jackpot: publicJackpot(JP),
    discord: DISCORD_INVITE,
    config: {
      range: RANGE, maxItems: MAX_ITEMS, ranks: RANKS,
      tax: Number(S.settings.taxPercent) || 0,
      captcha: { mode: TURNSTILE_SECRET && TURNSTILE_SITE_KEY ? 'turnstile' : 'builtin', siteKey: TURNSTILE_SITE_KEY },
      robloxLogin: oauthOn(),
      autoDeposit: autoDepositOn()
    }
  };
}

/* every browser polls this endpoint, so it is built at most every 400 ms */
let stateCache = { t: 0, body: '' };

app.get('/api/state', (req, res) => {
  const t = now();
  if (t - stateCache.t > 400) stateCache = { t, body: JSON.stringify(buildState()) };
  res.type('application/json').send(stateCache.body.slice(0, -1) + ',"now":' + t + '}');
});

app.get('/api/me', auth, (req, res) => res.json({ user: meView(req.user) }));

/* ---------- Discord account link ----------
   The site shows a one-time code; the player types /link CODE in our Discord. */
const discordCodes = new Map();   /* code -> { userId, exp } */

app.post('/api/me/discord-code', auth, actionLimit, (req, res) => {
  for (const [c, v] of discordCodes) if (v.userId === req.user.id || v.exp <= now()) discordCodes.delete(c);
  const code = 'PD-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  discordCodes.set(code, { userId: req.user.id, exp: now() + 10 * 60 * 1000 });
  res.json({ code, expiresIn: 600 });
});

app.post('/api/me/discord-unlink', auth, (req, res) => {
  const u = req.user;
  const old = u.discordId;
  delete u.discordId; delete u.discordTag;
  markDirty();
  if (old) io.to('bots').emit('bot:unlink', { discordId: old });
  emitMe(u);
  res.json({ ok: true });
});

app.post('/api/bot/link', botOnly, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const discordId = String(req.body.discordId || '');
  const c = discordCodes.get(code);
  if (!c || c.exp <= now()) return bad(res, 'This code is wrong or expired. Get a new one on petduel.win (Profile > Link Discord).');
  if (!/^\d{5,25}$/.test(discordId)) return bad(res, 'Invalid Discord account');
  const user = S.users[c.userId];
  if (!user) return bad(res, 'Account not found');
  /* one Discord account belongs to one site account */
  for (const u of Object.values(S.users)) if (u.discordId === discordId && u.id !== user.id) { delete u.discordId; delete u.discordTag; }
  discordCodes.delete(code);
  user.discordId = discordId;
  user.discordTag = String(req.body.discordTag || '').slice(0, 40);
  markDirty();
  emitMe(user);
  res.json({ ok: true, user: botUserView(user) });
});

app.post('/api/bot/unlink', botOnly, (req, res) => {
  const u = Object.values(S.users).find(x => x.discordId === String(req.body.discordId || ''));
  if (!u) return bad(res, 'This Discord account is not linked');
  delete u.discordId; delete u.discordTag;
  markDirty();
  emitMe(u);
  res.json({ ok: true });
});

/* everything the bot shows about a player */
function botUserView(u) {
  return {
    id: u.id, nickname: nick(u), robloxName: u.username, avatar: u.avatar || null,
    rank: rankOf(u.totalBet), totalBet: round2(u.totalBet), totalWon: round2(u.totalWon), totalLost: round2(u.totalLost || 0), profit: round2(u.profit),
    items: u.inventory.length, inventoryValue: round2(valueOf(u.inventory)),
    topPets: [...u.inventory].sort((a, b) => b.value - a.value).slice(0, 5).map(i => ({ name: i.name, value: i.value })),
    online: socketsByUser.has(u.id), lastSeen: u.lastSeen || 0, banned: Boolean(u.banned), muted: (u.mutedUntil || 0) > now(),
    isAdmin: isAdmin(u), discordId: u.discordId || null,
    pendingWithdrawals: S.withdrawals.filter(w => w.user.id === u.id && w.status === 'pending').map(w => ({ id: w.id, value: w.value, items: w.items.length, ts: w.ts }))
  };
}

app.get('/api/bot/user', botOnly, (req, res) => {
  const q = String(req.query.q || '').trim();
  const discordId = String(req.query.discordId || '');
  const u = discordId ? Object.values(S.users).find(x => x.discordId === discordId) : (S.users[q] || findUserByName(q));
  if (!u) return bad(res, discordId ? 'This Discord account is not linked to Pet Duel. Use /link first.' : 'Player not found', 404);
  res.json({ user: botUserView(u) });
});

app.get('/api/bot/linked', botOnly, (req, res) => {
  res.json({ list: Object.values(S.users).filter(u => u.discordId).map(u => ({ discordId: u.discordId, rank: rankOf(u.totalBet), nickname: nick(u) })) });
});

app.get('/api/bot/stats', botOnly, (req, res) => {
  const open = Object.values(S.matches).filter(m => m.state !== 'finished');
  res.json({
    online: onlineCount(), players: Object.keys(S.users).length,
    openGames: open.length, gamesValue: round2(open.reduce((t, m) => t + m.hostValue + (m.oppValue || 0), 0)),
    jackpot: JP ? { state: JP.state, total: JP.total, players: JP.entries.length } : null,
    giveaways: Object.keys(S.giveaways).length, pendingWithdrawals: S.withdrawals.filter(w => w.status === 'pending').length,
    maintenance: maintenanceOn(), bots: publicBots(true).map(b => ({ id: b.id, username: b.username, online: b.online, role: b.role })),
    ranks: RANKS.map(r => ({ name: r.name, min: r.min, color: r.color })),
    event: EVENT ? { type: EVENT.type, status: EVENT.status } : null
  });
});

app.get('/api/bot/games', botOnly, (req, res) => {
  res.json({ list: Object.values(S.matches).filter(m => m.state === 'waiting').sort((a, b) => b.hostValue - a.hostValue).slice(0, 10)
    .map(m => ({ id: m.id, host: nick(m.host), value: m.hostValue, pets: m.hostItems.length, maxJoin: m.maxJoin || 0 })) });
});

app.get('/api/bot/withdrawals', botOnly, (req, res) => {
  res.json({ list: S.withdrawals.filter(w => w.status === 'pending').slice(0, 25).map(w => {
    const u = S.users[w.user.id];
    return { id: w.id, nickname: nick(u || w.user), robloxName: u ? u.username : w.user.username, value: w.value, ts: w.ts,
      items: w.items.map(i => i.name) };
  }) });
});

app.get('/api/bot/catalog', botOnly, (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  res.json({ list: S.catalog.filter(c => !q || c.name.toLowerCase().includes(q)).sort((a, b) => b.value - a.value).slice(0, 25)
    .map(c => ({ id: c.id, label: `${c.name} (${fmtV(c.value)})` })) });
});

app.post('/api/bot/say', botOnly, (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 200);
  if (!text) return bad(res, 'Write a message');
  systemChat(text);
  res.json({ ok: true });
});

/* choose (or change, once every 7 days) the nickname shown on the site */
app.post('/api/me/nickname', auth, actionLimit, (req, res) => {
  const user = req.user;
  const name = String(req.body.nickname || '').trim();
  if (user.nickname && user.nickname === name) return res.json({ ok: true, user: meView(user) });
  const wait = (user.nickChangedAt || 0) + 7 * 24 * 60 * 60 * 1000 - now();
  if (user.nickname && wait > 0) return bad(res, `You can change your nickname again in ${Math.ceil(wait / 86400000)} day(s)`);
  const problem = nickProblem(name, user);
  if (problem) return bad(res, problem);

  const first = !user.nickname;
  user.nickname = name;
  user.nickChangedAt = now();
  markDirty();
  if (first) notifyAdmins('register', `${user.username} chose the nickname ${name}`);
  emitMe(user);
  stateCache.t = 0;
  res.json({ ok: true, user: meView(user) });
});

app.get('/api/profile', auth, (req, res) => {
  const user = req.user;
  const perPage = 5;
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
    page, pages,
    /* every game result with its time, oldest first, for the profit graph (1D / 3D / 7D / 30D / All) */
    games: user.tx.filter(t => GAME_TX.test(t.type)).map(t => ({ ts: t.ts, a: t.amount })).reverse()
  });
});

/* profit after each of the player's last 60 games (coinflip + jackpot), oldest first, for the graph */
const GAME_TX = /^(Coinflip|Jackpot) (Win|Loss|Tax)$/;
function profitSeries(user) {
  const games = (user.tx || []).filter(t => GAME_TX.test(t.type)).slice(0, 60).reverse();
  const recent = games.reduce((t, g) => t + Number(g.amount || 0), 0);
  let run = round2(Number(user.profit || 0) - recent);
  const out = [run];
  for (const g of games) { run = round2(run + Number(g.amount || 0)); out.push(run); }
  return out;
}

/* Public profile card (click on a player in chat / lobby) */
app.get('/api/user/:id', (req, res) => {
  const user = S.users[String(req.params.id)];
  if (!user) return bad(res, 'User not found', 404);
  res.json({
    user: {
      id: user.id,
      username: nick(user),
      avatar: user.avatar || null,
      rank: rankOf(user.totalBet),
      totalBet: round2(user.totalBet),
      totalWon: round2(user.totalWon),
      totalLost: round2(user.totalLost || 0),
      profit: round2(user.profit),
      online: socketsByUser.has(user.id),
      lastSeen: user.lastSeen || 0,
      owner: isAdmin(user) && user.adminTag !== false,
      support: !isAdmin(user) && user.support === true,
      series: profitSeries(user)
    }
  });
});

app.get('/api/leaderboard', (req, res) => {
  const mode = ['profit', 'least', 'totalBet'].includes(req.query.by) ? req.query.by : 'totalBet';
  const by = mode === 'totalBet' ? 'totalBet' : 'profit';
  const valueFor = u => u[by] || 0;

  const list = Object.values(S.users)
    .filter(u => !u.banned && (mode === 'least' ? valueFor(u) < 0 : valueFor(u) > 0))
    .sort((a, b) => mode === 'least' ? valueFor(a) - valueFor(b) : valueFor(b) - valueFor(a))
    .slice(0, 25)
    .map(u => ({
      id: u.id,
      username: nick(u),
      avatar: u.avatar || null,
      rank: rankOf(u.totalBet),
      value: round2(valueFor(u)),
      totalBet: round2(u.totalBet),
      totalWon: round2(u.totalWon)
    }));

  res.json({ by: mode, list });
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

/* The tax receiver is an admin account: either the one chosen in the admin panel or, in "auto" mode, admins in turn. */
function pickTaxReceiver() {
  const admins = Object.values(S.users).filter(u => isAdmin(u) && !u.banned).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (!admins.length) return null;

  if (S.settings.taxReceiver !== 'auto') {
    const chosen = S.users[S.settings.taxReceiver];
    if (chosen && !chosen.banned && isAdmin(chosen)) return chosen;
  }

  const receiver = admins[(S.settings.taxIdx || 0) % admins.length];
  S.settings.taxIdx = ((S.settings.taxIdx || 0) + 1) % 1000000;
  return receiver;
}

/* Tax is taken in items from the pot, never more than the rate allows (largest items that still fit). */
function takeTax(match) {
  const none = { items: [], value: 0, receiver: null };
  const rate = Math.min(20, Math.max(0, Number(S.settings.taxPercent) || 0)) / 100;
  if (rate <= 0) return none;

  const cap = (match.hostValue + match.oppValue) * rate;
  const all = [...match.hostItems, ...match.oppItems].sort((a, b) => safeNumber(b.value) - safeNumber(a.value));

  const items = [];
  let total = 0;

  for (const item of all) {
    const v = safeNumber(item.value);
    if (v > 0 && total + v <= cap + 1e-9) { items.push(item); total += v; }
  }

  if (!items.length) return none;

  const receiver = pickTaxReceiver();
  if (!receiver) return none;

  return { items, value: round2(total), receiver };
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

  /* tax items go to the admin account, the rest of the pot to the winner (each item moves exactly once) */
  const tax = takeTax(match);
  const taxIds = new Set(tax.items.map(i => i.uid));

  winner.inventory.push(...[...match.hostItems, ...match.oppItems].filter(i => !taxIds.has(i.uid)));
  if (tax.receiver) tax.receiver.inventory.push(...tax.items);

  match.taxValue = tax.value;

  bump(host, { bet: match.hostValue });
  bump(opponent, { bet: match.oppValue });
  bump(winner, { won: round2(loserStake - tax.value), profit: round2(loserStake - tax.value) });
  bump(loser, { lost: loserStake, profit: -loserStake });

  addTransaction(winner, 'Coinflip Win', match.id, round2(loserStake - tax.value));

  if (tax.receiver && tax.items.length) {
    addTransaction(winner, 'Coinflip Tax', match.id, -tax.value);
    addTransaction(tax.receiver, 'Tax Received', match.id, tax.value);
    notifyAdmins('tax', `💰 Tax: ${tax.items.length} item(s) worth ${tax.value} from a coinflip went to ${tax.receiver.username}`);
    emitMe(tax.receiver);
  }
  addTransaction(loser, 'Coinflip Loss', match.id, -loserStake);

  S.history.unshift(publicMatch(match));
  if (S.history.length > 500) S.history.length = 500;

  claimBounty(winner, loser, match);

  sendWebhook(WEBHOOK_CF, {
    title: '🪙 Coinflip finished',
    color: 0x00efa0,
    fields: [
      { name: 'Winner', value: clip(nick(winner), 100), inline: true },
      { name: 'Loser', value: clip(nick(loser), 100), inline: true },
      { name: 'Pot', value: fmtV(match.hostValue + match.oppValue), inline: true },
      { name: clip(`${nick(match.host)} (${match.hostSide}) - ${match.hostValue}`, 250), value: itemLine(match.hostItems) },
      { name: clip(`${nick(match.opp)} - ${match.oppValue}`, 250), value: itemLine(match.oppItems) },
      { name: 'Winning side', value: String(match.winnerSide), inline: true },
      { name: 'Match / Hash', value: clip(`${match.id}\n${match.hash}`, 300) }
    ],
    timestamp: new Date().toISOString()
  }, { thumb: winner, author: winner, image: topImage([...match.hostItems, ...match.oppItems]) });

  io.emit('match:update', publicMatch(match));
  emitMe(winner);
  emitMe(loser);

  setTimeout(() => removeFinishedMatch(match.id), 45000);
}

/* after a restart: games that were already joined are played to the end (their result was fixed when they were joined) */
function resumeMatches() {
  for (const m of Object.values(S.matches)) {
    if (m.state === 'countdown') {
      m.startedAt = now();
      runMatch(m);
    } else if (m.state === 'flipping') {
      setTimeout(() => finishMatch(m), 2400);
    }
  }
  const open = Object.values(S.matches).length;
  if (open) console.log(`Resumed ${open} open coinflip(s) after restart.`);
}

function runMatch(match) {
  setTimeout(() => {
    if (match.state !== 'countdown') return;
    match.state = 'flipping';
    io.emit('match:update', publicMatch(match));
    setTimeout(() => finishMatch(match), 2400);
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

  /* optional limit: how many pets the opponent may join with (empty = no limit) */
  const maxJoinRaw = Math.floor(Number(req.body.maxJoin));
  const maxJoin = Number.isInteger(maxJoinRaw) && maxJoinRaw >= 1 && maxJoinRaw < MAX_ITEMS ? maxJoinRaw : 0;

  const items = takeItems(user, uids, MAX_ITEMS);
  const seed = rid(32);
  const id = rid(10);

  const match = {
    id, state: 'waiting', seed, hash: sha(seed),
    host: publicUser(user), opp: null, hostSide: side,
    hostItems: items, oppItems: [],
    hostValue: valueOf(items), oppValue: 0,
    createdAt: now(), startedAt: 0, finishedAt: 0,
    winnerSide: null, winnerId: null, maxJoin
  };

  S.matches[id] = match;
  io.emit('match:new', publicMatch(match));

  sendWebhook(WEBHOOK_CF, {
    title: '🪙 New coinflip',
    color: 0x4da3ff,
    fields: [
      { name: 'Host', value: clip(nick(user), 100), inline: true },
      { name: 'Value', value: fmtV(match.hostValue), inline: true },
      { name: 'Join range', value: `${round2(match.hostValue * (1 - RANGE))} - ${round2(match.hostValue * (1 + RANGE))}`, inline: true },
      ...(maxJoin ? [{ name: 'Max pets to join', value: String(maxJoin), inline: true }] : []),
      { name: `Pets (${items.length})`, value: itemLine(items) }
    ],
    timestamp: new Date().toISOString()
  }, { thumb: user, author: user, image: topImage(items) });
  emitMe(user);
  res.json({ match: publicMatch(match) });
});

app.post('/api/match/join', auth, actionLimit, (req, res) => {
  const user = req.user;
  const match = S.matches[String(req.body.id || '')];
  const uids = selectionToUids(req.body);

  if (!match || match.state !== 'waiting') return bad(res, 'This match is no longer available');
  if (match.host.id === user.id) return bad(res, 'You cannot join your own match');

  const joinLimit = match.maxJoin || MAX_ITEMS;
  if (Array.isArray(uids) && uids.length > joinLimit) return bad(res, `This game allows at most ${joinLimit} pet${joinLimit === 1 ? '' : 's'}`);

  const selected = pickItems(user, uids, joinLimit);
  if (!selected) return bad(res, 'Invalid item selection');

  const value = valueOf(selected);
  const min = match.hostValue * (1 - RANGE);
  const max = match.hostValue * (1 + RANGE);
  if (value < min - 0.001 || value > max + 0.001) {
    return bad(res, 'Your value must be inside the required range');
  }

  const items = takeItems(user, uids, joinLimit);

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

/* admins can cancel any game that has not started flipping yet; every pet goes back to its owner */
app.post('/api/admin/match/cancel', auth, adminOnly, (req, res) => {
  const match = S.matches[String(req.body.id || '')];
  if (!match || (match.state !== 'waiting' && match.state !== 'countdown')) {
    return bad(res, 'This game cannot be cancelled any more (it is already flipping or finished)');
  }
  /* mark it first: the countdown timer of this game then does nothing */
  match.state = 'cancelled';
  delete S.matches[match.id];

  const host = S.users[match.host.id];
  if (host) { host.inventory.push(...match.hostItems); emitMe(host); }
  if (match.opp) {
    const opp = S.users[match.opp.id];
    if (opp) { opp.inventory.push(...match.oppItems); emitMe(opp); }
  }
  markDirty();
  console.log(`[ADMIN] ${req.user.username} cancelled coinflip ${match.id} of ${match.host.username}`);
  pushChat({ id: rid(4), user: { username: 'PetDuel', avatar: null }, system: true, text: `${nick(match.host)}'s coinflip was cancelled by an admin. All pets were returned.`, ts: now() });
  io.emit('match:remove', { id: match.id });
  res.json({ ok: true });
});

/* ================= CHAT ================= */

/* a system message from PetDuel (shown with the site logo and a SYSTEM tag) */
const systemChat = (text, extra = {}) => pushChat({ id: rid(4), user: { username: 'PetDuel', avatar: null }, system: true, text, ts: now(), ...extra });

/* every 30 minutes: the deposit risk reminder */
const RISK_TEXT = 'PetDuel is not responsible for any item losses due to rollbacks, bans, or trade restrictions applied by Pet Simulator 99 / BIG Games moderators or Roblox. Deposit and play at your own risk.';
setInterval(() => {
  if (maintenanceOn()) return;
  const last = S.chat[S.chat.length - 1];
  if (last && last.warn) return;            /* do not repeat it when nobody wrote in between */
  systemChat(RISK_TEXT, { warn: true });
}, 30 * 60 * 1000);

function pushChat(message) {
  S.chat.push(message);
  if (S.chat.length > 60) S.chat.shift();
  markDirty();
  io.emit('chat:msg', message);
}

/* ================= GIVEAWAYS ================= */

setInterval(() => {
  const t = now();
  for (const g of Object.values(S.giveaways)) if (g.endsAt <= t) endGiveaway(g.id);
}, 2000);

function endGiveaway(id) {
  const g = S.giveaways[id];
  if (!g) return;
  delete S.giveaways[id];
  markDirty();

  const host = S.users[g.host.id];
  if (!host) return;

  const system = text => pushChat({
    id: rid(4), user: { username: 'PetDuel', avatar: null }, system: true, text, ts: now()
  });

  const eligible = g.entrants.filter(uid => S.users[uid] && !S.users[uid].banned);

  if (!eligible.length) {
    host.inventory.push(...g.items);
    emitMe(host);
    system(`${nick(g.host)}'s giveaway ended with no entrants. Items returned.`);
  } else {
    const winner = S.users[eligible[crypto.randomInt(eligible.length)]];
    if (!winner) {
      host.inventory.push(...g.items);
      emitMe(host);
    } else {
      winner.inventory.push(...g.items);
      addTransaction(winner, 'Giveaway Win', g.id, g.value);

      sendWebhook(WEBHOOK_GW, {
        title: '🎉 Giveaway ended',
        color: 0xffb52e,
        fields: [
          { name: 'Host', value: clip(nick(g.host), 100), inline: true },
          { name: 'Winner', value: clip(nick(winner), 100), inline: true },
          { name: 'Entrants', value: String(eligible.length), inline: true },
          { name: 'Value', value: fmtV(g.value), inline: true },
          { name: 'Items', value: itemLine(g.items) }
        ],
        timestamp: new Date().toISOString()
      }, { thumb: winner, author: winner, image: topImage(g.items) });
      emitMe(winner);
      system(`${nick(winner)} won ${g.items.length} item(s) worth ${g.value} from ${nick(g.host)}'s giveaway!`);
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
    if (![30, 120, 300, 3600, 86400].includes(duration)) return bad(res, 'Invalid duration');
  } else if (mode === 'advanced') {
    if (!(duration >= 60 && duration <= MAX_GW_SECONDS)) return bad(res, 'Duration must be at least 1 minute');
    if (!Number.isFinite(minBet) || minBet < 0) return bad(res, 'Invalid minimum bet');
  } else {
    return bad(res, 'Invalid mode');
  }

  const minRank = String(req.body.minRank || '');
  if (minRank && rankIndex(minRank) < 0) return bad(res, 'Invalid rank');

  if (Object.values(S.giveaways).filter(g => g.host.id === user.id).length >= 3) {
    return bad(res, 'Max 3 active giveaways');
  }
  if (Object.keys(S.giveaways).length >= 20) return bad(res, 'Too many active giveaways');

  const picked = pickItems(user, uids, 5);
  if (!picked) return bad(res, 'Select up to 5 valid items');

  const items = takeItems(user, uids, 5);

  const g = {
    id: rid(8), host: publicUser(user), items, value: valueOf(items),
    endsAt: now() + duration * 1000,
    startedAt: now(),
    duration,
    minBet: mode === 'advanced' ? round2(minBet) : 0,
    minRank,
    entrants: []
  };

  S.giveaways[g.id] = g;
  markDirty();

  sendWebhook(WEBHOOK_GW, {
    title: '🎁 New giveaway',
    color: 0x00efa0,
    fields: [
      { name: 'Host', value: clip(nick(user), 100), inline: true },
      { name: 'Value', value: fmtV(g.value), inline: true },
      { name: 'Mode', value: mode, inline: true },
      { name: 'Ends', value: `<t:${Math.floor(g.endsAt / 1000)}:R>`, inline: true },
      { name: 'Min total bet', value: fmtV(g.minBet), inline: true },
      { name: 'Min rank', value: g.minRank || 'None', inline: true },
      { name: 'Items', value: itemLine(g.items) }
    ],
    timestamp: new Date().toISOString()
  }, { thumb: user, author: user, image: topImage(g.items) });

  io.emit('giveaway:new', publicGiveaway(g));
  emitMe(user);
  res.json({ ok: true });
});

/* admins can delete any giveaway; by default the pets go back to the host */
app.post('/api/admin/giveaway/delete', auth, adminOnly, (req, res) => {
  const g = S.giveaways[String(req.body.id || '')];
  if (!g) return bad(res, 'Giveaway not found', 404);
  delete S.giveaways[g.id];

  const host = S.users[g.host.id];
  const refund = req.body.refund !== false;
  if (refund && host) {
    host.inventory.push(...g.items);
    emitMe(host);
  }
  markDirty();
  console.log(`[ADMIN] ${req.user.username} deleted giveaway ${g.id} of ${g.host.username} (${refund ? 'pets returned' : 'pets removed'})`);
  pushChat({ id: rid(4), user: { username: 'PetDuel', avatar: null }, system: true, text: `${nick(g.host)}'s giveaway was cancelled by an admin.`, ts: now() });
  io.emit('giveaway:remove', { id: g.id });
  res.json({ ok: true });
});

app.post('/api/giveaway/enter', auth, actionLimit, async (req, res) => {
  if (!(await checkCaptcha(req, res))) return;

  const user = req.user;
  const g = S.giveaways[String(req.body.id || '')];

  if (!g || g.endsAt <= now()) return bad(res, 'Giveaway ended');
  if (g.host.id === user.id) return bad(res, 'You cannot enter your own giveaway');
  if (g.entrants.includes(user.id)) return bad(res, 'Already entered');
  const wagered = user.totalBet;

  if (wagered < g.minBet) return bad(res, `You need ${fmtV(g.minBet)} total bet to enter`);

  if (g.minRank && rankIndex(g.minRank) >= 0 && rankIndex(rankOf(wagered)) < rankIndex(g.minRank)) {
    return bad(res, `You need the ${g.minRank} rank (or higher) to enter`);
  }

  /* one entry per IP: a second account on the same connection cannot enter, and neither can the host's connection */
  const ip = clientIp(req.headers, req.ip);
  g.entrantIps = g.entrantIps || {};
  if (ip && g.entrantIps[ip] && g.entrantIps[ip] !== user.id) return bad(res, 'Only one account per IP address can enter this giveaway');
  const host = S.users[g.host.id];
  if (ip && host && (host.ips || []).includes(ip)) return bad(res, 'You cannot enter a giveaway from the same connection as its host');

  if (ip) g.entrantIps[ip] = user.id;
  g.entrants.push(user.id);
  markDirty();
  io.emit('giveaway:update', publicGiveaway(g));
  res.json({ ok: true });
});

/* ================= BOUNTY =================
   An admin puts a bounty on a player. The first player who beats them in a coinflip wins the prize
   (created from a catalog item when claimed) and everyone sees a congratulation popup. */

function publicBounty(b) {
  return { id: b.id, target: b.target, prize: publicItem(b.prize), createdAt: b.createdAt };
}

function publicBounties() {
  return S.bounties.map(publicBounty);
}

function claimBounty(winner, loser, match) {
  if (!winner || !loser || winner.id === loser.id) return;

  const index = S.bounties.findIndex(b => b.target.id === loser.id);
  if (index < 0) return;

  const [b] = S.bounties.splice(index, 1);

  winner.inventory.push(b.prize);
  addTransaction(winner, 'Bounty Win', b.id, b.prize.value);

  markDirty();
  emitMe(winner);

  io.emit('bounty:update', publicBounties());
  io.emit('bounty:claimed', {
    winner: publicUser(winner),
    target: b.target,
    prize: publicItem(b.prize)
  });

  pushChat({
    id: rid(4),
    user: { username: 'Bounty', avatar: null },
    text: `${nick(winner)} claimed the bounty on ${nick(b.target)} and won ${b.prize.name}! Congratulations!`,
    ts: now()
  });

  sendWebhook(WEBHOOK_CF, {
    title: '🎯 Bounty claimed',
    color: 0xff5968,
    fields: [
      { name: 'Winner', value: clip(nick(winner), 100), inline: true },
      { name: 'Target', value: clip(nick(b.target), 100), inline: true },
      { name: 'Prize', value: itemLine([b.prize]) },
      { name: 'Match', value: clip(match.id, 100), inline: true }
    ],
    timestamp: new Date().toISOString()
  }, { thumb: winner, author: winner, image: topImage([b.prize]) });
}

app.post('/api/admin/block', auth, adminOnly, (req, res) => {
  const list = String(req.body.countries || '').split(/[\s,]+/).map(x => x.trim().toUpperCase()).filter(x => /^[A-Z]{2}$/.test(x));
  S.settings.blockCountries = [...new Set(list)].slice(0, 50);
  markDirty();
  /* the admin who turns the block on always keeps access from this browser */
  res.setHeader('Set-Cookie', staffCookieHeader());
  console.log(`[ADMIN] ${req.user.username} set blocked countries: ${S.settings.blockCountries.join(',') || 'none'}`);
  res.json({ ok: true, countries: blockList() });
});

app.post('/api/admin/maintenance', auth, adminOnly, (req, res) => {
  S.settings.maintenance = Boolean(req.body.on);
  S.settings.maintenanceText = String(req.body.text || '').trim().slice(0, 200);
  stateCache.t = 0;
  markDirty();
  console.log(`[ADMIN] ${req.user.username} turned maintenance ${S.settings.maintenance ? 'ON' : 'OFF'}`);

  if (S.settings.maintenance) {
    /* everyone who is not an admin is sent to the closed screen right away */
    for (const sock of io.sockets.sockets.values()) {
      if (!(sock.user && isAdmin(sock.user))) {
        sock.emit('maintenance', { on: true });
        sock.disconnect(true);
      }
    }
  }
  io.emit('maintenance', { on: S.settings.maintenance });
  res.json({ ok: true, on: S.settings.maintenance });
});

app.post('/api/admin/tax', auth, adminOnly, (req, res) => {
  const percent = Number(req.body.percent);
  if (!Number.isFinite(percent) || percent < 0 || percent > 20) return bad(res, 'Tax must be between 0 and 20 percent');

  const receiver = String(req.body.receiver || 'auto');

  if (receiver !== 'auto') {
    const user = S.users[receiver];
    if (!user || !isAdmin(user) || user.banned) return bad(res, 'The tax receiver must be an admin');
  }

  console.log(`[ADMIN] ${req.user.username} set the coinflip tax to ${percent}% (receiver: ${receiver})`);

  S.settings.taxPercent = round2(percent);
  S.settings.taxReceiver = receiver;
  markDirty();
  res.json({ ok: true });
});

const UPDATE_LOG = [
  { version: '6.0', title: 'Pet Simulator 99', changes: [
    'Pet Duel is now a Pet Simulator 99 site: coinflip, jackpot, giveaways and events with PS99 pets',
    'New catalog with every Huge, Titanic and Gargantuan (Normal, Golden, Rainbow and Shiny) plus valuable exclusives, with pictures',
    'Values follow the official PS99 RAP and update by themselves every 6 hours',
    'Automatic deposits and withdrawals with our in-game bot; no extra items needed in the trade',
    'Values are shown short: 15.09B, 604M'
  ] }
];

app.post('/api/admin/updatelog', auth, adminOnly, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 80);
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (!title || !text) return bad(res, 'Write a title and a text');
  if (S.updateNotes.length >= 100) return bad(res, 'Too many notes. Delete an old one first.');

  S.updateNotes.unshift({ id: rid(4), title, text, ts: now(), by: req.user.username });
  markDirty();
  res.json({ ok: true });
});

app.post('/api/admin/updatelog/delete', auth, adminOnly, (req, res) => {
  const index = S.updateNotes.findIndex(n => n.id === String(req.body.id || ''));
  if (index < 0) return bad(res, 'Note not found', 404);
  S.updateNotes.splice(index, 1);
  markDirty();
  res.json({ ok: true });
});

app.post('/api/admin/bounty', auth, adminOnly, (req, res) => {
  const target = findUserByName(req.body.username);
  const catalogItem = S.catalog.find(x => x.id === req.body.itemId);

  if (!target) return bad(res, 'User not found. They must log in once.');
  if (target.banned) return bad(res, 'This user is banned');
  if (target.id === req.user.id) return bad(res, 'You cannot put a bounty on yourself');
  if (!catalogItem) return bad(res, 'Pick a prize item');
  if (S.bounties.some(b => b.target.id === target.id)) return bad(res, 'This player already has a bounty');
  if (S.bounties.length >= 10) return bad(res, 'Too many active bounties');

  const b = {
    id: rid(6),
    target: publicUser(target),
    prize: newItem(catalogItem),
    createdBy: req.user.id,
    createdAt: now()
  };

  S.bounties.push(b);
  markDirty();

  io.emit('bounty:update', publicBounties());

  pushChat({
    id: rid(4),
    user: { username: 'Bounty', avatar: null },
    text: `A bounty was placed on ${nick(target)}! Be the first to beat them in a coinflip and win ${b.prize.name}!`,
    ts: now()
  });

  sendWebhook(WEBHOOK_CF, {
    title: '🎯 New bounty',
    color: 0xffb52e,
    fields: [
      { name: 'Target', value: clip(nick(target), 100), inline: true },
      { name: 'Placed by', value: clip(nick(req.user), 100), inline: true },
      { name: 'Prize', value: itemLine([b.prize]) }
    ],
    timestamp: new Date().toISOString()
  }, { thumb: target, author: req.user, image: topImage([b.prize]) });

  res.json({ ok: true });
});

app.post('/api/admin/bounty/cancel', auth, adminOnly, (req, res) => {
  const index = S.bounties.findIndex(b => b.id === String(req.body.id || ''));
  if (index < 0) return bad(res, 'Bounty not found', 404);

  S.bounties.splice(index, 1);
  markDirty();
  io.emit('bounty:update', publicBounties());
  res.json({ ok: true });
});

/* ================= JACKPOT =================
   Players put items in the pot. When a second player joins a 60s countdown starts.
   The winner is picked by value share: roll = HMAC(seed, roundId), published after the round.
   The winner and roll are hidden from the clients until the round is finished. */

const JP_TIME = 60;
const JP_ROLL_MS = 4500;
const JP_RESULT_MS = 9000;
const JP_MAX_PLAYERS = 25;
const JP_MAX_JOIN_ITEMS = 20;
const JP_MAX_USER_ITEMS = 40;

let JP = null;
let jpTimers = [];
let savedJackpot = null;

/* after a restart: continue the saved round (its result is fixed by its seed, so nothing changes) */
function resumeJackpot() {
  const j = savedJackpot;
  savedJackpot = null;
  if (!j || !Array.isArray(j.entries) || !j.entries.length || j.state === 'finished') return newJackpot();

  jpTimers.forEach(clearTimeout);
  jpTimers = [];
  j.winner = null;
  JP = j;
  jpRecalc(j);

  if (j.state === 'countdown') {
    const left = Math.max(3000, Number(j.endsAt || 0) - now());
    j.endsAt = now() + left;
    jpLater(() => rollJackpot(j), left);
  } else if (j.state === 'rolling') {
    /* roll again: same seed, same winner, the wheel animation plays once more */
    j.state = 'countdown';
    j.endsAt = now() + 3000;
    jpLater(() => rollJackpot(j), 3000);
  } else {
    j.state = 'waiting';
  }
  console.log(`Resumed jackpot round ${j.id} (${j.state}, ${j.entries.length} player(s)).`);
  emitJackpot(j);
}

function jpLater(fn, ms) { jpTimers.push(setTimeout(fn, ms)); }

function publicJackpot(j) {
  if (!j) return null;

  const out = {
    id: j.id,
    state: j.state,
    hash: j.hash,
    entries: j.entries.map(e => ({ user: e.user, value: e.value, items: e.items.map(publicItem) })),
    total: j.total,
    endsAt: j.endsAt,
    rollEndsAt: j.rollEndsAt,
    time: JP_TIME
  };

  if (j.state === 'finished') {
    out.winnerId = j.winnerId;
    out.roll = j.roll;
    out.seed = j.seed;
  }

  return out;
}

function emitJackpot(j) { io.emit('jackpot:update', publicJackpot(j)); }

function newJackpot() {
  jpTimers.forEach(clearTimeout);
  jpTimers = [];

  const seed = rid(32);
  const j = {
    id: rid(8), state: 'waiting', seed, hash: sha(seed),
    entries: [], total: 0, endsAt: 0, rollEndsAt: 0,
    winnerId: null, roll: null, winner: null
  };

  JP = j;
  emitJackpot(j);
}

function jpRecalc(j) {
  for (const e of j.entries) e.value = valueOf(e.items);
  j.total = round2(j.entries.reduce((t, e) => t + e.value, 0));
}

function rollJackpot(j) {
  if (JP !== j || j.state !== 'countdown') return;

  const digest = crypto.createHmac('sha256', j.seed).update(j.id).digest('hex');
  j.roll = parseInt(digest.slice(0, 8), 16) / 0x100000000;

  const ticket = j.roll * j.total;
  let acc = 0;
  j.winner = j.entries[j.entries.length - 1];

  for (const e of j.entries) {
    acc += e.value;
    if (ticket < acc) { j.winner = e; break; }
  }

  j.state = 'rolling';
  j.rollEndsAt = now() + JP_ROLL_MS;
  emitJackpot(j);

  jpLater(() => finishJackpot(j), JP_ROLL_MS);
}

function finishJackpot(j) {
  if (JP !== j || j.state !== 'rolling') return;

  const winEntry = j.winner;
  const winner = S.users[winEntry.user.id];
  const allItems = j.entries.flatMap(e => e.items);

  j.state = 'finished';
  j.winnerId = winEntry.user.id;

  /* public history: who won, how much, with what chance, and the seed to verify it */
  S.jpHistory.unshift({
    id: j.id, total: j.total, finishedAt: now(),
    winner: winEntry.user, winnerValue: winEntry.value,
    chance: j.total ? round2((winEntry.value / j.total) * 100) : 0,
    players: j.entries.map(e => ({ user: e.user, value: e.value, items: e.items.length, top: topImage(e.items) })),
    hash: j.hash, seed: j.seed, roll: j.roll
  });
  if (S.jpHistory.length > 100) S.jpHistory.length = 100;
  markDirty();

  if (winner) winner.inventory.push(...allItems);

  for (const e of j.entries) {
    const u = S.users[e.user.id];
    if (!u) continue;

    bump(u, { bet: e.value });

    if (e === winEntry) {
      const gain = round2(j.total - e.value);
      bump(u, { won: gain, profit: gain });
      addTransaction(u, 'Jackpot Win', j.id, gain);
    } else {
      bump(u, { lost: e.value, profit: -e.value });
      addTransaction(u, 'Jackpot Loss', j.id, -e.value);
    }

    emitMe(u);
  }

  /* beating a bounty target in a jackpot round also claims the bounty */
  if (winner) {
    for (const e of j.entries) {
      const u = S.users[e.user.id];
      if (u && e !== winEntry) claimBounty(winner, u, { id: j.id });
    }
  }

  sendWebhook(WEBHOOK_JP, {
    title: '💣 Jackpot finished',
    color: 0xff5968,
    fields: [
      { name: 'Winner', value: clip(nick(winEntry.user), 100), inline: true },
      { name: 'Pot', value: fmtV(j.total), inline: true },
      { name: 'Chance', value: `${round2((winEntry.value / j.total) * 100)}%`, inline: true },
      { name: 'Players', value: j.entries.map(e => `${nick(e.user)}: ${e.value}`).join('\n').slice(0, 1000) },
      { name: 'Round / Hash', value: clip(`${j.id}\n${j.hash}`, 300) }
    ],
    timestamp: new Date().toISOString()
  }, { thumb: winEntry.user, author: winEntry.user, image: topImage(j.entries.flatMap(e => e.items)) });

  emitJackpot(j);
  jpLater(() => newJackpot(), JP_RESULT_MS);
}

app.get('/api/jackpot/history', (req, res) => {
  res.json({ list: S.jpHistory.slice(0, 50) });
});

app.post('/api/jackpot/join', auth, actionLimit, (req, res) => {
  const user = req.user;
  const j = JP;

  if (!j || (j.state !== 'waiting' && j.state !== 'countdown')) {
    return bad(res, 'This round is already rolling. Join the next round.');
  }

  const uids = selectionToUids(req.body);
  const selected = pickItems(user, uids, JP_MAX_JOIN_ITEMS);

  if (!selected) return bad(res, `Select 1–${JP_MAX_JOIN_ITEMS} valid items`);
  if (valueOf(selected) <= 0) return bad(res, 'Value too low');

  let entry = j.entries.find(e => e.user.id === user.id);

  if (!entry && j.entries.length >= JP_MAX_PLAYERS) return bad(res, 'The jackpot is full');
  if (entry && entry.items.length + uids.length > JP_MAX_USER_ITEMS) return bad(res, 'Too many items in this round');

  const items = takeItems(user, uids, JP_MAX_JOIN_ITEMS);

  if (!entry) {
    entry = { user: publicUser(user), items: [], value: 0 };
    j.entries.push(entry);
  }

  entry.items.push(...items);
  jpRecalc(j);

  if (j.state === 'waiting' && j.entries.length >= 2) {
    j.state = 'countdown';
    j.endsAt = now() + JP_TIME * 1000;
    jpLater(() => rollJackpot(j), JP_TIME * 1000);
  }

  emitJackpot(j);
  emitMe(user);
  res.json({ ok: true });
});

/* a lone player can take their items back while nobody else has joined */
app.post('/api/jackpot/leave', auth, actionLimit, (req, res) => {
  const j = JP;

  if (!j || j.state !== 'waiting') return bad(res, 'You can only leave while waiting for a second player');

  const index = j.entries.findIndex(e => e.user.id === req.user.id);
  if (index < 0) return bad(res, 'You are not in this round');

  const [entry] = j.entries.splice(index, 1);
  req.user.inventory.push(...entry.items);
  jpRecalc(j);

  emitJackpot(j);
  emitMe(req.user);
  res.json({ ok: true });
});

/* ================= TIP =================
   Send items from your inventory to another player (from their profile card).
   The items leave the sender in the same step they reach the receiver (no dupes).
   */

app.post('/api/tip', auth, actionLimit, (req, res) => {
  const sender = req.user;
  const target = S.users[String(req.body.userId || '')];
  const uids = selectionToUids(req.body);

  if (!target || target.banned) return bad(res, 'User not found');
  if (target.id === sender.id) return bad(res, 'You cannot tip yourself');
  if (!pickItems(sender, uids, 10)) return bad(res, 'Select 1–10 valid items');

  const items = takeItems(sender, uids, 10);
  const value = valueOf(items);

  target.inventory.push(...items);

  addTransaction(sender, 'Tip Sent', nick(target), -value);
  addTransaction(target, 'Tip Received', nick(sender), value);

  io.to(`u:${target.id}`).emit('tip:received', {
    from: nick(sender), count: items.length, value
  });

  emitMe(sender);
  emitMe(target);

  res.json({ ok: true, value, count: items.length });
});

/* ================= WITHDRAW (manual) =================
   Items leave the inventory immediately (so they can't be used in a game
   or withdrawn twice) and an admin sends them by hand in Pet Simulator 99. */

app.post('/api/withdraw', auth, actionLimit, (req, res) => {
  const user = req.user;
  const uids = selectionToUids(req.body);

  /* pets can only be sent while at least one withdraw bot is online */
  const wdBot = pickWithdrawBot();
  if (!wdBot) {
    return bad(res, 'Withdrawals are paused while our withdraw bots are offline. Please try again when a bot is back online.');
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
    bot: { id: wdBot.id, username: wdBot.username },
    ts: now()
  };

  S.withdrawals.unshift(request);
  notifyAdmins('withdraw', `${user.username} requested a withdraw worth ${request.value}`);
  sendWebhook(WEBHOOK_WD, {
    title: '📤 Withdraw request',
    color: 0xffb52e,
    fields: [
      { name: 'Player', value: clip(nick(user), 100), inline: true },
      { name: 'Value', value: fmtV(request.value), inline: true },
      { name: `Pets (${items.length})`, value: itemLine(items) }
    ],
    timestamp: new Date().toISOString()
  }, { thumb: user, author: user, image: topImage(items), data: { withdrawId: request.id } });
  addTransaction(user, 'Withdraw Request', request.id, -request.value);
  emitMe(user);

  res.json({
    ok: true,
    message: 'Withdraw successful! An admin will send your items to you shortly.',
    request: { id: request.id, value: request.value, status: request.status, bot: publicWdBot(request.bot) }
  });
});

/* the player's own withdraw requests (pending ones first), shown in the wallet */
app.get('/api/withdrawals', auth, (req, res) => {
  const mine = S.withdrawals.filter(w => w.user.id === req.user.id).slice(0, 30);
  mine.sort((a, b) => (Number(b.status === 'pending') - Number(a.status === 'pending')) || b.ts - a.ts);
  res.json({
    list: mine.map(w => ({
      id: w.id, status: w.status, value: w.value, ts: w.ts, doneAt: w.doneAt || 0,
      bot: w.status === 'pending' ? publicWdBot(w.bot) : null,
      items: w.items.map(publicItem)
    }))
  });
});

/* ================= EVENTS (wheel + word scramble) =================
   The prize is a pet from the admin's own inventory (kept aside, returned if nobody wins) or a catalog item.
   Events live in memory: a restart simply ends the running event. */

const SCRAMBLE_WORDS = [
  'unicorn', 'dragon', 'phoenix', 'kitten', 'puppy', 'penguin', 'giraffe', 'turtle',
  'monkey', 'flamingo', 'parrot', 'bunny', 'elephant', 'hedgehog', 'dolphin', 'butterfly',
  'panda', 'raccoon', 'dinosaur', 'mermaid', 'reindeer', 'lemur', 'peacock', 'cheetah'
];

const WHEEL_MAX_PLAYERS = 30;
const SPIN_MS = 3000;
const REVEAL_MS = 4200;      /* the wheel slows down and lands during the first ~3 s of the reveal */

let EVENT = null;
let eventTimers = [];
const lastGuess = new Map();

function clearEventTimers() {
  eventTimers.forEach(clearTimeout);
  eventTimers = [];
}

function later(fn, ms) {
  eventTimers.push(setTimeout(fn, ms));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* The word, and who will be eliminated next, are never sent to the clients early. */
function publicEvent(ev) {
  if (!ev) return null;

  const base = {
    id: ev.id, type: ev.type, status: ev.status, host: ev.host,
    prize: publicItem(ev.prize), createdAt: ev.createdAt, note: ev.note || null
  };

  if (ev.type === 'wheel') {
    return {
      ...base,
      joinEndsAt: ev.joinEndsAt,
      participants: ev.participants,
      players: ev.players,
      round: ev.round,
      phase: ev.phase,
      phaseEndsAt: ev.phaseEndsAt,
      victimId: ev.phase === 'reveal' ? ev.victimId : null,
      eliminated: ev.eliminated,
      winner: ev.winner
    };
  }

  /* hints: first letter after half of the time, last letter after 75% */
  let hint = null;
  if (ev.status === 'running') {
    const part = (now() - ev.createdAt) / Math.max(1, ev.endsAt - ev.createdAt);
    const w = ev.word.toUpperCase();
    if (part >= 0.75) hint = w[0] + '_'.repeat(Math.max(0, w.length - 2)) + w[w.length - 1];
    else if (part >= 0.5) hint = w[0] + '_'.repeat(w.length - 1);
  }
  return {
    ...base,
    scrambled: ev.scrambled,
    length: ev.word.length,
    startedAt: ev.createdAt,
    endsAt: ev.endsAt,
    winner: ev.winner,
    guesses: ev.guesses || 0,
    players: (ev.guessers || []).length,
    hint,
    solvedIn: ev.solvedAt ? Math.round((ev.solvedAt - ev.createdAt) / 1000) : null,
    word: ev.status === 'finished' ? ev.word : null
  };
}

function emitEvent() {
  io.emit('event:update', publicEvent(EVENT));
}

function eventChat(text, withButton = false) {
  pushChat({
    id: rid(4),
    user: { username: 'PetDuel', avatar: null },
    system: true,
    text,
    ts: now(),
    event: withButton
  });
}

function scheduleEventClear(ev) {
  later(() => {
    if (EVENT === ev) {
      EVENT = null;
      io.emit('event:update', null);
    }
  }, 60000);
}

/* the prize comes from the admin's own inventory (invUid) or is created from a catalog item (itemId) */
function takeEventPrize(req) {
  const uid = String(req.body.invUid || '');
  if (uid) {
    const idx = req.user.inventory.findIndex(i => i.uid === uid);
    if (idx < 0) return { error: 'That pet is not in your inventory anymore' };
    return { item: req.user.inventory[idx], fromUser: req.user.id, idx };
  }
  const catalogItem = S.catalog.find(x => x.id === req.body.itemId);
  if (!catalogItem) return { error: 'Pick a prize pet' };
  return { item: newItem(catalogItem), fromUser: null };
}

function lockEventPrize(req, picked) {
  if (picked.fromUser) {
    req.user.inventory.splice(picked.idx, 1);
    S.eventEscrow = { userId: req.user.id, item: picked.item };
    emitMe(req.user);
    markDirty();
  }
}

/* nobody won (or the event was cancelled): an inventory prize goes back to its owner */
function returnEventPrize(ev) {
  if (!ev.prizeFrom || ev.prizeSettled) return;
  ev.prizeSettled = true;
  const owner = S.users[ev.prizeFrom];
  if (owner) { owner.inventory.push(ev.prize); emitMe(owner); }
  S.eventEscrow = null;
  markDirty();
}

function awardPrize(user, ev) {
  const item = ev.prize;
  ev.prizeSettled = true;
  if (ev.prizeFrom) { S.eventEscrow = null; markDirty(); }

  user.inventory.push(item);
  addTransaction(user, 'Event Win', ev.id, item.value);
  emitMe(user);

  sendWebhook(WEBHOOK_GW, {
    title: ev.type === 'wheel' ? '🎡 Wheel event winner' : '🔤 Word scramble winner',
    color: 0xffb52e,
    fields: [
      { name: 'Winner', value: clip(nick(user), 100), inline: true },
      { name: 'Host', value: clip(nick(ev.host), 100), inline: true },
      { name: 'Prize', value: itemLine([item]) }
    ],
    timestamp: new Date().toISOString()
  }, { thumb: user, author: user, image: topImage([item]) });
}

function eventBusy() {
  return EVENT && EVENT.status !== 'finished';
}

/* ---------- wheel ---------- */

function beginWheel(ev) {
  if (EVENT !== ev || ev.status !== 'joining') return;

  const alive = ev.participants.filter(p => {
    const u = S.users[p.id];
    return u && !u.banned;
  });

  if (alive.length < 2) {
    ev.status = 'finished';
    ev.note = 'Not enough players (at least 2 needed).';
    returnEventPrize(ev);
    emitEvent();
    eventChat('Wheel event cancelled: not enough players.');
    scheduleEventClear(ev);
    return;
  }

  ev.players = shuffle(alive);
  ev.status = 'running';
  ev.round = 0;

  eventChat('The wheel is spinning!');
  startWheelRound(ev);
}

function startWheelRound(ev) {
  if (EVENT !== ev || ev.status !== 'running') return;

  if (ev.players.length <= 1) return finishWheel(ev);

  ev.round += 1;
  ev.phase = 'spin';
  ev.victimId = null;
  ev.victim = ev.players[crypto.randomInt(ev.players.length)];   // private until reveal
  ev.phaseEndsAt = now() + SPIN_MS;

  emitEvent();
  later(() => revealWheel(ev), SPIN_MS);
}

function revealWheel(ev) {
  if (EVENT !== ev || ev.status !== 'running') return;

  ev.phase = 'reveal';
  ev.victimId = ev.victim.id;
  ev.phaseEndsAt = now() + REVEAL_MS;

  emitEvent();

  later(() => {
    if (EVENT !== ev || ev.status !== 'running') return;
    ev.eliminated.push(ev.victim);
    ev.players = ev.players.filter(p => p.id !== ev.victim.id);
    startWheelRound(ev);
  }, REVEAL_MS);
}

function finishWheel(ev) {
  const winnerPublic = ev.players[0];
  const user = winnerPublic && S.users[winnerPublic.id];

  ev.status = 'finished';
  ev.phase = 'done';
  ev.winner = winnerPublic || null;

  if (user) awardPrize(user, ev); else returnEventPrize(ev);

  emitEvent();
  if (winnerPublic) eventChat(`${nick(winnerPublic)} won the wheel event and got ${ev.prize.name}!`);
  scheduleEventClear(ev);
}

/* ---------- word scramble ---------- */

function scrambleWord(word) {
  let out = word;
  for (let k = 0; k < 30 && out === word && word.length > 1; k++) {
    out = shuffle(word.split('')).join('');
  }
  return out.toUpperCase();
}

function endScramble(ev, winnerUser) {
  if (EVENT !== ev || ev.status !== 'running') return;

  ev.status = 'finished';

  if (winnerUser) {
    ev.solvedAt = now();
    ev.winner = publicUser(winnerUser);
    awardPrize(winnerUser, ev);
    eventChat(`${nick(winnerUser)} solved "${ev.word}" and won ${ev.prize.name}!`);
  } else {
    ev.note = 'Time is up! Nobody solved it.';
    returnEventPrize(ev);
    eventChat(`Time is up! The word was "${ev.word}".`);
  }

  emitEvent();
  scheduleEventClear(ev);
}

/* ---------- admin: start / cancel ---------- */

app.post('/api/admin/event/wheel', auth, adminOnly, (req, res) => {
  if (eventBusy()) return bad(res, 'An event is already running');

  const picked = takeEventPrize(req);
  if (picked.error) return bad(res, picked.error);

  const seconds = Math.floor(Number(req.body.seconds));
  if (!(seconds >= 15 && seconds <= 600)) return bad(res, 'Join time must be 15–600 seconds');

  clearEventTimers();

  const ev = {
    id: rid(6), type: 'wheel', status: 'joining',
    host: publicUser(req.user), prize: picked.item, prizeFrom: picked.fromUser, createdAt: now(),
    joinEndsAt: now() + seconds * 1000,
    participants: [], players: [], eliminated: [],
    round: 0, phase: 'join', phaseEndsAt: 0, victim: null, victimId: null, winner: null
  };

  lockEventPrize(req, picked);
  EVENT = ev;
  later(() => beginWheel(ev), seconds * 1000);

  emitEvent();
  eventChat(`Wheel event started! Prize: ${picked.item.name}. Click to join!`, true);
  res.json({ ok: true });
});

app.post('/api/admin/event/scramble', auth, adminOnly, (req, res) => {
  if (eventBusy()) return bad(res, 'An event is already running');

  const picked = takeEventPrize(req);
  if (picked.error) return bad(res, picked.error);

  const seconds = Math.floor(Number(req.body.seconds));
  if (!(seconds >= 30 && seconds <= 600)) return bad(res, 'Time must be 30–600 seconds');

  let word = String(req.body.word || '').trim().toLowerCase();

  if (!word) {
    word = SCRAMBLE_WORDS[crypto.randomInt(SCRAMBLE_WORDS.length)];
  } else if (!/^[a-z]{3,20}$/.test(word)) {
    return bad(res, 'Word must be 3–20 letters (a-z)');
  }

  clearEventTimers();

  const ev = {
    id: rid(6), type: 'scramble', status: 'running',
    host: publicUser(req.user), prize: picked.item, prizeFrom: picked.fromUser, createdAt: now(),
    word, scrambled: scrambleWord(word), endsAt: now() + seconds * 1000, winner: null
  };

  lockEventPrize(req, picked);
  EVENT = ev;
  later(() => endScramble(ev, null), seconds * 1000);
  /* send the hints when they unlock */
  later(() => emitEvent(), Math.ceil(seconds * 500) + 50);
  later(() => emitEvent(), Math.ceil(seconds * 750) + 50);

  emitEvent();
  eventChat(`Word Scramble started! Prize: ${picked.item.name}. Click to play!`, true);
  res.json({ ok: true });
});

app.post('/api/admin/event/cancel', auth, adminOnly, (req, res) => {
  const ev = EVENT;
  if (!ev || ev.status === 'finished') return bad(res, 'No running event');

  clearEventTimers();
  ev.status = 'finished';
  ev.phase = 'done';
  ev.note = 'This event was cancelled by an admin.';
  returnEventPrize(ev);

  emitEvent();
  eventChat('Event cancelled by an admin.');
  scheduleEventClear(ev);
  res.json({ ok: true });
});

/* ---------- players ---------- */

app.post('/api/event/join', auth, (req, res) => {
  const ev = EVENT;

  if (!ev || ev.type !== 'wheel' || ev.status !== 'joining' || ev.id !== req.body.id) {
    return bad(res, 'Joining is closed');
  }
  if (ev.host.id === req.user.id) return bad(res, 'The host cannot join');
  if (ev.participants.some(p => p.id === req.user.id)) return bad(res, 'You already joined');
  if (ev.participants.length >= WHEEL_MAX_PLAYERS) return bad(res, 'The event is full');

  ev.participants.push(publicUser(req.user));
  emitEvent();
  res.json({ ok: true });
});

app.post('/api/event/guess', auth, (req, res) => {
  const ev = EVENT;

  if (!ev || ev.type !== 'scramble' || ev.status !== 'running' || ev.id !== req.body.id) {
    return bad(res, 'No active word scramble');
  }
  if (ev.host.id === req.user.id) return bad(res, 'The host cannot play');

  const t = now();
  if (t - (lastGuess.get(req.user.id) || 0) < 700) return bad(res, 'Slow down');
  lastGuess.set(req.user.id, t);

  const guess = String(req.body.guess || '').trim().toLowerCase().slice(0, 30);
  if (!guess) return bad(res, 'Type your answer');

  ev.guesses = (ev.guesses || 0) + 1;
  ev.guessers = ev.guessers || [];
  if (!ev.guessers.includes(req.user.id)) ev.guessers.push(req.user.id);
  /* the guess counter on everyone's screen updates at most every 2 seconds */
  if (!ev.guessEmitPending) {
    ev.guessEmitPending = true;
    later(() => { ev.guessEmitPending = false; if (EVENT === ev && ev.status === 'running') emitEvent(); }, 2000);
  }

  if (guess === ev.word) {
    endScramble(ev, req.user);
    return res.json({ correct: true });
  }

  res.json({ correct: false });
});

/* ================= ADMIN API ================= */

const MAX_VALUE = 1e15;
const validImage = v => /^(https:\/\/[^\s"'<>]{4,400}|\/assets\/[\w./-]{1,200})$/.test(v);

/* a catalog item from the admin panel: base name + variant + shiny; the full name is built from them */
function cleanItem(body) {
  const parsed = ps99Parse(body.base || body.name);
  const variant = PS99_VARIANTS.includes(body.variant) ? body.variant : parsed.variant;
  const shiny = body.shiny !== undefined ? Boolean(body.shiny) : parsed.shiny;
  const base = parsed.base.slice(0, 60);
  const image = String(body.image || '').trim();
  const value = round2(Number(body.value));

  if (!base) return null;
  if (!validImage(image)) return null;
  if (!Number.isFinite(value) || value < 0 || value > MAX_VALUE) return null;

  return { name: ps99FullName(base, variant, shiny), base, variant, shiny, image, value, category: String(body.category || '').slice(0, 20) || undefined };
}

/* ================= ADMIN: DEPOSIT BOTS ================= */

const cleanBotName = v => String(v || '').trim();
const validBotName = v => /^[A-Za-z0-9_]{3,20}$/.test(v);
const validBotLink = v => /^https:\/\/(www\.)?roblox\.com\/[^\s"'<>]{1,400}$/.test(v);

app.post('/api/admin/bots/add', auth, adminOnly, async (req, res) => {
  const username = cleanBotName(req.body.username);
  const link = String(req.body.link || '').trim();
  if (!validBotName(username)) return bad(res, 'Enter a valid Roblox username');
  if (!validBotLink(link)) return bad(res, 'The join link must be a https://www.roblox.com/... link');
  if (S.bots.length >= 20) return bad(res, 'You can add at most 20 bots');
  if (S.bots.some(b => b.username.toLowerCase() === username.toLowerCase())) return bad(res, 'This bot is already in the list');

  const b = { id: rid(6), username, link, online: req.body.online !== false, role: req.body.role === 'withdraw' ? 'withdraw' : 'deposit' };
  S.bots.push(b);
  markDirty();
  await loadBotProfile(username);
  emitBots();
  res.json({ ok: true, bots: publicBots(true) });
});

app.post('/api/admin/bots/update', auth, adminOnly, (req, res) => {
  const b = S.bots.find(x => x.id === req.body.id);
  if (!b) return bad(res, 'Bot not found', 404);
  if (req.body.online !== undefined) b.online = Boolean(req.body.online);
  if (req.body.role === 'deposit' || req.body.role === 'withdraw') b.role = req.body.role;
  if (req.body.link !== undefined) {
    const link = String(req.body.link || '').trim();
    if (!validBotLink(link)) return bad(res, 'The join link must be a https://www.roblox.com/... link');
    b.link = link;
  }
  markDirty();
  emitBots();
  res.json({ ok: true, bots: publicBots(true) });
});

app.post('/api/admin/bots/delete', auth, adminOnly, (req, res) => {
  const i = S.bots.findIndex(x => x.id === req.body.id);
  if (i < 0) return bad(res, 'Bot not found', 404);
  S.bots.splice(i, 1);
  markDirty();
  emitBots();
  res.json({ ok: true, bots: publicBots(true) });
});

app.get('/api/admin/ui', auth, adminOnly, (req, res) => {
  res.type('application/javascript').send(`(${adminUI.toString()})();`);
});

app.get('/api/admin/data', auth, adminOnly, (req, res) => {
  res.json({
    catalog: S.catalog,
    users: Object.values(S.users).map(u => ({
      id: u.id, username: u.username, nickname: u.nickname || '', items: u.inventory.length,
      value: valueOf(u.inventory), totalBet: round2(u.totalBet),
      totalWon: round2(u.totalWon), totalLost: round2(u.totalLost || 0), profit: round2(u.profit),
      banned: Boolean(u.banned),
      online: socketsByUser.has(u.id), lastSeen: u.lastSeen || 0,
      isAdmin: isAdmin(u),
      support: u.support === true,
      adminTag: isAdmin(u) && u.adminTag !== false,
      muted: (u.mutedUntil || 0) > now(),
      avatar: u.avatar || null, rank: rankOf(u.totalBet),
      ips: u.ips || [], ipBanned: (u.ips || []).some(ip => ipBanned(ip))
    })),
    ipBans: S.ipBans || [],
    withdrawals: S.withdrawals.filter(w => w.status === 'pending').map(w => ({ ...w, botName: w.bot ? (publicWdBot(w.bot, true) || {}).username : '' })),
    bounties: publicBounties(),
    settings: S.settings,
    admins: Object.values(S.users).filter(u => isAdmin(u)).map(u => ({ id: u.id, username: u.username })),
    updateLog: UPDATE_LOG,
    updateNotes: S.updateNotes,
    bots: publicBots(true),
    myInventory: req.user.inventory.map(i => ({ uid: i.uid, name: i.name, image: i.image, value: i.value })),
    rapAt: S.settings.rapAt || 0,
    rapInfo: S.settings.rapInfo || '',
    maintenance: maintenanceOn(),
    maintenanceText: S.settings.maintenanceText || '',
    blockCountries: (S.settings.blockCountries || []).join(', '),
    blockEnv: ENV_BLOCK.join(', '),
    staffLink: SITE_URL.replace(/\/+$/, '') + '/?staff=' + staffKey()
  });
});

function markWithdrawSent(w, by) {
  w.status = 'done';
  w.doneAt = now();
  w.doneBy = by || '';
  markDirty();
  const owner = S.users[w.user.id];
  if (owner) emitMe(owner);
  const n = w.items.length;
  systemChat(`${nick(owner || w.user)} successfully withdrew ${n} pet${n === 1 ? '' : 's'} worth ${fmtV(w.value)}! 🎉`, { withdraw: true });
}

app.post('/api/admin/withdraw/done', auth, adminOnly, (req, res) => {
  const w = S.withdrawals.find(x => x.id === req.body.id);
  if (!w || w.status !== 'pending') return bad(res, 'Request not found');
  markWithdrawSent(w, req.user.username);
  res.json({ ok: true });
});

/* ---------- Support team ---------- */
function supportOnly(req, res, next) {
  if (!isSupport(req.user)) return bad(res, 'Support access required', 403);
  next();
}

app.post('/api/admin/support', auth, adminOnly, (req, res) => {
  const user = S.users[String(req.body.id || '')];
  if (!user) return bad(res, 'User not found', 404);
  if (req.body.on) user.support = true; else delete user.support;
  markDirty();
  emitMe(user);
  console.log(`[ADMIN] ${req.user.username} ${req.body.on ? 'gave' : 'removed'} Support for ${user.username}`);
  res.json({ ok: true });
});

/* Support can only mute (up to 24 hours; staff cannot be muted). Every mute / unmute goes to the admin bell.
   "Delete messages" is optional: when on, the player's chat messages are removed too. */
app.post('/api/support/mute', auth, supportOnly, (req, res) => {
  const user = findUserByName(req.body.name) || S.users[String(req.body.id || '')];
  if (!user) return bad(res, 'Player not found', 404);
  if (isSupport(user)) return bad(res, 'You cannot mute staff');
  const minutes = Math.floor(Number(req.body.minutes));
  if (!(minutes === 0 || (minutes >= 1 && minutes <= 1440))) return bad(res, 'Mute time must be 1-1440 minutes (0 = unmute)');
  const deleteMessages = req.body.deleteMessages === true;
  user.mutedUntil = minutes ? now() + minutes * 60000 : 0;
  let removed = 0;
  if (minutes && deleteMessages) {
    const before = S.chat.length;
    S.chat = S.chat.filter(m => !(m.user && m.user.id === user.id));
    removed = before - S.chat.length;
    io.emit('chat:purge', { userId: user.id });
  }
  markDirty();
  emitMe(user);
  const time = minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} min`;
  const reason = String(req.body.reason || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  notifyAdmins('mute', minutes
    ? `🔇 Support ${nick(req.user)} muted ${nick(user)} (Roblox: ${user.username}) for ${time}${deleteMessages ? `, ${removed} message${removed === 1 ? '' : 's'} deleted` : ''}${reason ? ` · Reason: ${reason}` : ''}`
    : `🔊 Support ${nick(req.user)} unmuted ${nick(user)} (Roblox: ${user.username})`);
  console.log(`[SUPPORT] ${req.user.username} ${minutes ? `muted ${user.username} for ${minutes} min${deleteMessages ? ' (messages deleted)' : ''}` : `unmuted ${user.username}`}`);
  res.json({ ok: true, nickname: nick(user), removed });
});

app.post('/api/admin/withdraw/refund', auth, adminOnly, (req, res) => {
  const w = S.withdrawals.find(x => x.id === req.body.id);
  if (!w || w.status !== 'pending') return bad(res, 'Request not found');
  const user = S.users[w.user.id];
  if (!user) return bad(res, 'User not found');
  w.status = 'refunded';
  w.doneAt = now();
  markDirty();
  user.inventory.push(...w.items);
  addTransaction(user, 'Withdraw Refund', w.id, w.value);
  emitMe(user);
  res.json({ ok: true });
});

/* Give / remove admin access (and choose if the ADMIN chat tag is shown).
   Admins set in the Render env (ADMIN_USERS / ADMIN_IDS) cannot be removed from here.
   You cannot remove your own admin access, but you can change your own chat tag. */
app.post('/api/admin/role', auth, adminOnly, (req, res) => {
  const user = S.users[String(req.body.id || '')];
  if (!user) return bad(res, 'User not found', 404);

  const make = Boolean(req.body.admin);
  const tag = req.body.tag === undefined ? true : Boolean(req.body.tag);

  if (user.id === req.user.id && !make) return bad(res, 'You cannot remove your own admin access');

  const fromEnv =
    ADMIN_IDS.includes(String(user.id)) ||
    ADMIN_NAMES.includes(String(user.username).toLowerCase());

  if (!make && fromEnv) return bad(res, 'This admin is set in the server settings and cannot be removed here');
  if (make && user.banned) return bad(res, 'Unban this user first');

  if (make) {
    if (!fromEnv) user.admin = true;
    user.adminTag = tag;
  } else {
    user.admin = false;
    delete user.adminTag;
  }

  markDirty();
  emitMe(user);
  res.json({ ok: true });
});

app.get('/api/admin/inventory', auth, adminOnly, (req, res) => {
  const user = S.users[String(req.query.id || '')];
  if (!user) return bad(res, 'User not found', 404);

  res.json({
    username: user.username,
    items: user.inventory.map(i => ({
      uid: i.uid, name: i.name, image: i.image, value: i.value
    }))
  });
});

app.post('/api/admin/inventory/delete', auth, adminOnly, (req, res) => {
  const user = S.users[String(req.body.id || '')];
  if (!user) return bad(res, 'User not found', 404);

  const index = user.inventory.findIndex(i => i.uid === String(req.body.uid || ''));
  if (index < 0) return bad(res, 'Item not found in this inventory (it may be in a match already)');

  const [item] = user.inventory.splice(index, 1);

  addTransaction(user, 'Item Removed (admin)', item.name, -safeNumber(item.value));
  console.log(`[ADMIN] ${req.user.username} deleted "${item.name}" (${item.value}) from ${user.username}`);

  emitMe(user);
  res.json({ ok: true });
});

app.post('/api/admin/inventory/clear', auth, adminOnly, (req, res) => {
  const user = S.users[String(req.body.id || '')];
  if (!user) return bad(res, 'User not found', 404);
  const count = user.inventory.length;
  const value = valueOf(user.inventory);
  user.inventory = [];
  addTransaction(user, 'Removed by admin', 'all pets', -value);
  console.log(`[ADMIN] ${req.user.username} deleted all ${count} pets (${value}) of ${user.username}`);
  emitMe(user);
  res.json({ ok: true, count, value });
});

app.get('/api/admin/notifications', auth, adminOnly, (req, res) => {
  const seen = req.user.notifSeen || 0;
  res.json({
    list: S.notifications,
    seen,
    unread: S.notifications.filter(n => n.ts > seen).length
  });
});

app.post('/api/admin/notifications/read', auth, adminOnly, (req, res) => {
  req.user.notifSeen = now();
  markDirty();
  res.json({ ok: true });
});

/* Fix a player's stats (totals and rank follow automatically). Every change is logged. */
app.post('/api/admin/stats', auth, adminOnly, (req, res) => {
  const user = S.users[String(req.body.id || '')];
  if (!user) return bad(res, 'User not found', 404);

  const fields = { totalBet: 'totalBet', totalWon: 'totalWon', totalLost: 'totalLost', profit: 'profit' };
  const next = {};

  for (const [field, key] of Object.entries(fields)) {
    const raw = req.body[field];
    if (raw === undefined || raw === null || raw === '') continue;

    const n = Number(raw);
    if (!Number.isFinite(n) || Math.abs(n) > 1e12) return bad(res, `Invalid value for ${field}`);
    if (field !== 'profit' && n < 0) return bad(res, `${field} cannot be negative`);

    next[key] = round2(n);
  }

  console.log(`[ADMIN] ${req.user.username} changed stats of ${user.username}:`,
    JSON.stringify({ before: { totalBet: user.totalBet, totalWon: user.totalWon, totalLost: user.totalLost, profit: user.profit }, after: next }));

  Object.assign(user, next);

  markDirty();
  emitMe(user);
  res.json({ ok: true });
});

/* Mute: minutes = 0 unmutes, -1 is permanent. All chat messages of the user are deleted. */
app.post('/api/admin/mute', auth, adminOnly, (req, res) => {
  const user = S.users[String(req.body.id || '')];
  if (!user) return bad(res, 'User not found', 404);
  if (isAdmin(user)) return bad(res, 'You cannot mute an admin');

  const minutes = Math.floor(Number(req.body.minutes));

  if (minutes === 0) {
    user.mutedUntil = 0;
  } else if (minutes === -1) {
    user.mutedUntil = MUTE_FOREVER;
  } else if (minutes >= 1 && minutes <= 60 * 24 * 365) {
    user.mutedUntil = now() + minutes * 60000;
  } else {
    return bad(res, 'Invalid duration');
  }

  if (user.mutedUntil > 0) {
    S.chat = S.chat.filter(m => !(m.user && m.user.id === user.id));
    io.emit('chat:purge', { userId: user.id });
  }

  markDirty();
  emitMe(user);
  res.json({ ok: true });
});

/* ban IPs: { ip } for one address, or { userId } for every IP that player used (the account is banned too) */
app.post('/api/admin/ipban', auth, adminOnly, (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 120);
  let ips = [], user = null;
  if (req.body.userId) {
    user = S.users[String(req.body.userId)];
    if (!user) return bad(res, 'User not found', 404);
    if (isAdmin(user)) return bad(res, 'You cannot IP ban an admin');
    ips = (user.ips || []).slice();
    if (!ips.length) return bad(res, 'No IP is known for this player yet (they have to use the site once after this update)');
  } else {
    const ip = String(req.body.ip || '').trim();
    if (!validIp(ip)) return bad(res, 'Enter a valid IP address');
    const own = clientIp(req.headers, req.ip);
    if (ip === own) return bad(res, 'That is your own IP');
    ips = [ip];
  }
  S.ipBans = S.ipBans || [];
  let added = 0;
  for (const ip of ips) {
    if (S.ipBans.some(b => b.ip === ip)) continue;
    S.ipBans.unshift({ ip, reason, by: req.user.username, user: user ? (user.nickname || user.username) : '', userId: user ? user.id : '', ts: now() });
    added++;
  }
  if (user && !user.banned) {
    user.banned = true;
    for (const [key, session] of Object.entries(S.sessions)) if (session.userId === user.id) delete S.sessions[key];
  }
  markDirty();
  kickBannedIps();
  console.log(`[ADMIN] ${req.user.username} IP banned ${ips.join(', ')}${user ? ` (${user.username})` : ''}`);
  res.json({ ok: true, added, ips });
});

app.post('/api/admin/ipunban', auth, adminOnly, (req, res) => {
  const ip = String(req.body.ip || '').trim();
  const before = (S.ipBans || []).length;
  S.ipBans = (S.ipBans || []).filter(b => b.ip !== ip);
  if (S.ipBans.length === before) return bad(res, 'This IP is not banned');
  markDirty();
  console.log(`[ADMIN] ${req.user.username} removed the IP ban of ${ip}`);
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
      user: { username: 'Announcement', avatar: null },
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
  if (!item) return bad(res, 'Check the name, the value and the image (a https:// link)');
  const k = ps99KeyOf(item);
  const existing = S.catalog.find(c => ps99KeyOf(c) === k);
  if (existing) {
    Object.assign(existing, { image: item.image, value: item.value, manual: true });
    markDirty();
    return res.json({ ok: true, item: existing, updated: true });
  }
  item.id = rid(8);
  item.manual = true;
  S.catalog.push(item);
  markDirty();
  res.json({ ok: true, item });
});

/* ================= PS99 CATALOG + OFFICIAL RAP VALUES =================
   The catalog starts from assets/ps99-catalog.json (every Huge / Titanic / Gargantuan and valuable exclusives,
   pictures in assets/ps99). Values follow the official RAP of BIG Games (ps99.biggamesapi.io/api/rap) every
   6 hours: catalog items and the pets players own get the new value; new Huges / Titanics / Gargantuans are
   added with the official picture. Items an admin changed by hand (manual) keep their value. */
const PS99_CATALOG_V = 1;
const stableId = k => 'p' + crypto.createHash('md5').update(k).digest('hex').slice(0, 11);
function loadPs99Catalog() {
  if (S.settings.ps99CatalogV === PS99_CATALOG_V && S.catalog.length) return;
  let list;
  try { list = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'assets', 'ps99-catalog.json'), 'utf8')); }
  catch (error) { console.error('PS99 catalog file could not be read:', error.message); return; }
  const have = new Map(S.catalog.map(c => [ps99KeyOf(c), c]));
  let added = 0;
  for (const p of list) {
    const k = ps99Key(p.base, p.variant, p.shiny);
    const c = have.get(k);
    if (c) { if (!c.manual) Object.assign(c, { value: p.value, image: c.image || p.image, category: p.category }); continue; }
    const item = { id: stableId(k), name: p.name, base: p.base, variant: p.variant, shiny: p.shiny, category: p.category, image: p.image, value: p.value };
    S.catalog.push(item); have.set(k, item); added++;
  }
  S.settings.ps99CatalogV = PS99_CATALOG_V;
  markDirty();
  console.log(`PS99 catalog loaded: ${added} pets added (${S.catalog.length} in the catalog)`);
}

let rapRunning = false;
async function refreshRap() {
  if (rapRunning) throw new Error('A value update is already running');
  rapRunning = true;
  try {
    const r = await fetch('https://ps99.biggamesapi.io/api/rap', { signal: AbortSignal.timeout(60000) });
    const j = await r.json();
    if (j.status !== 'ok' || !Array.isArray(j.data)) throw new Error('the PS99 API did not send values');
    const idx = new Map(S.catalog.map(c => [ps99KeyOf(c), c]));
    let updated = 0, added = 0, thumbs = null;
    for (const x of j.data) {
      const cd = x.configData || {};
      if (x.category !== 'Pet' || !cd.id || cd.cv) continue;
      const variant = cd.pt === 1 ? 'golden' : cd.pt === 2 ? 'rainbow' : 'normal';
      const k = ps99Key(cd.id, variant, cd.sh);
      const value = Math.round(Number(x.value) || 0);
      if (value <= 0) continue;
      const c = idx.get(k);
      if (c) { if (!c.manual && c.value !== value) { c.value = value; updated++; } continue; }
      if (!/^(Huge|Titanic|Gargantuan) /.test(cd.id)) continue;
      if (!thumbs) {
        thumbs = new Map();
        try {
          const cr = await fetch('https://ps99.biggamesapi.io/api/collection/Pets', { signal: AbortSignal.timeout(60000) });
          for (const pet of (await cr.json()).data || []) thumbs.set(pet.configName, pet.configData || {});
        } catch { /* new pets wait for the next run */ }
      }
      const t = thumbs.get(cd.id);
      const asset = t && String((variant === 'golden' && t.goldenThumbnail) || t.thumbnail || '').match(/\d+/);
      if (!asset) continue;
      const item = { id: stableId(k), name: ps99FullName(cd.id, variant, cd.sh), base: cd.id, variant, shiny: Boolean(cd.sh),
        category: cd.id.split(' ')[0], image: `https://ps99.biggamesapi.io/image/${asset[0]}`, value };
      S.catalog.push(item); idx.set(k, item); added++;
    }
    /* the pets players own follow the catalog value */
    const byId = new Map(S.catalog.map(c => [c.id, c.value]));
    let owned = 0;
    for (const u of Object.values(S.users)) {
      let hit = false;
      for (const i of u.inventory) {
        const v = byId.get(i.catalogId);
        if (v !== undefined && i.value !== v) { i.value = v; hit = true; owned++; }
      }
      if (hit && socketsByUser.has(u.id)) emitMe(u);
    }
    S.settings.rapAt = now();
    S.settings.rapInfo = `${updated} values changed, ${added} new pets, ${owned} owned pets updated`;
    markDirty();
    console.log(`[RAP] ${S.settings.rapInfo}`);
    return { updated, added, owned };
  } finally {
    rapRunning = false;
  }
}
setTimeout(() => refreshRap().catch(e => console.warn('[RAP]', e.message)), 60 * 1000);
setInterval(() => refreshRap().catch(e => console.warn('[RAP]', e.message)), 6 * 60 * 60 * 1000);

app.post('/api/admin/rap/refresh', auth, adminOnly, async (req, res) => {
  try { res.json({ ok: true, ...(await refreshRap()), info: S.settings.rapInfo, at: S.settings.rapAt }); }
  catch (error) { bad(res, `Value update failed: ${error.name === 'TimeoutError' ? 'the PS99 API did not answer in time' : error.message}`, 502); }
});

/* change a catalog item: the value (box on the card) or everything (the ✏️ edit window) */
app.post('/api/admin/catalog/update', auth, adminOnly, (req, res) => {
  const item = S.catalog.find(x => x.id === req.body.id);
  const value = round2(Number(req.body.value));
  if (!item || !Number.isFinite(value) || value < 0 || value > MAX_VALUE) return bad(res, 'Invalid value');
  if (req.body.base !== undefined) {
    const c = cleanItem({ base: req.body.base, variant: req.body.variant, shiny: req.body.shiny, image: req.body.image, value });
    if (!c) return bad(res, 'Check the name and the image (a https:// link)');
    Object.assign(item, { name: c.name, base: c.base, variant: c.variant, shiny: c.shiny, image: c.image });
  }
  if (item.value !== value) item.manual = true;
  if (req.body.manual === false) delete item.manual;
  item.value = value;
  /* optional: the same change for the copies players already own */
  let changed = 0;
  if (req.body.applyToOwned) {
    for (const u of Object.values(S.users)) {
      let hit = false;
      for (const i of u.inventory) {
        if (i.catalogId !== item.id) continue;
        Object.assign(i, { name: item.name, image: item.image, value: item.value, base: item.base, variant: item.variant, shiny: item.shiny });
        changed++; hit = true;
      }
      if (hit) emitMe(u);
    }
  }
  markDirty();
  res.json({ ok: true, item, changed });
});

app.post('/api/admin/catalog/delete', auth, adminOnly, (req, res) => {
  const i = S.catalog.findIndex(x => x.id === req.body.id);
  if (i < 0) return bad(res, 'Item not found', 404);
  S.catalog.splice(i, 1);
  markDirty();
  res.json({ ok: true });
});

app.post('/api/admin/grant', auth, adminOnly, (req, res) => {
  const user = findUserByName(req.body.username);
  const item = S.catalog.find(x => x.id === req.body.catalogId);
  const qty = Math.floor(Number(req.body.qty));

  if (!user) return bad(res, 'User not found. They must log in once.');
  if (!item) return bad(res, 'Catalog item not found');
  if (!Number.isInteger(qty) || qty < 1 || qty > 50) return bad(res, 'Quantity must be between 1 and 50');

  for (let i = 0; i < qty; i++) user.inventory.push(newItem(item));
  emitMe(user);
  res.json({ ok: true });
});

/* ================= ADMIN UI (sent to browser only after auth) ================= */

function adminUI() {
  const { api, esc, toast, fmt, tags, confirmBox } = window.AMP;
  if (document.getElementById('adm')) return;

  const overlay = document.createElement('div');
  overlay.id = 'adm';
  overlay.className = 'ov open';
  overlay.style.zIndex = '150';

  overlay.innerHTML = `
    <div class="modal wide">
      <div class="mh"><h3>🛠 Admin Panel</h3><button class="x" id="adm-x">✕</button></div>

      <div id="mt-box" style="margin-bottom:16px;padding:14px;border-radius:12px;border:1px solid #343842">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <b style="font-size:15px">🔒 Maintenance mode</b>
          <span id="mt-state" style="font-weight:800"></span>
          <span style="flex:1"></span>
          <button id="mt-toggle" class="btn"></button>
        </div>
        <input id="mt-text" class="in" maxlength="200" style="width:100%;margin-top:10px" placeholder="Optional message under &quot;Pet Duel is officially closed&quot;">
        <p class="hint" style="margin:6px 0 0">When it is ON nobody except admins can use the site: players see a big PET DUEL closed screen and are disconnected right away. Admins can still log in and play normally.</p>
      </div>

      <div style="margin-bottom:16px;padding:14px;border-radius:12px;border:1px solid #343842">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <b style="font-size:15px">🌍 Country block</b>
          <span id="cb-state" style="font-weight:800"></span>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <input id="cb-list" class="in" style="flex:1;min-width:160px" placeholder="Country codes, e.g. TR (empty = nobody blocked)">
          <button id="cb-tr" class="btn red">Block Turkey</button>
          <button id="cb-save" class="btn gray">Save</button>
          <button id="cb-off" class="btn gray">Unblock all</button>
        </div>
        <p class="hint" id="cb-hint" style="margin:6px 0 0"></p>
      </div>

      <h4 style="margin:0 0 8px">💵 Send USDT (BEP20)</h4>
      <div style="padding:14px;border-radius:12px;border:1px solid #343842;margin-bottom:16px">
        <div id="usdt-wallet"><p class="hint">Loading…</p></div>
        <div id="usdt-form" style="display:none">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
            <input id="usdt-to" class="in" placeholder="Send to (BEP20 address, 0x…)" autocomplete="off" style="flex:2;min-width:220px">
            <input id="usdt-amt" class="in" placeholder="Amount (USDT)" inputmode="decimal" style="flex:1;min-width:120px">
            <button id="usdt-max" class="btn gray">Max</button>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
            <input id="usdt-note" class="in" placeholder="Note (optional, who/why)" maxlength="120" style="flex:1;min-width:220px">
            <button id="usdt-send" class="btn">Send USDT</button>
          </div>
          <p class="hint" style="margin:6px 0 0">Only send to BNB Smart Chain (BEP20) addresses. Sending to an address on another network can lose the money.</p>
        </div>
        <div id="usdt-sends" style="margin-top:10px"></div>
      </div>

      <h4 style="margin:0 0 8px">💰 Crypto address lookup</h4>
      <div style="padding:14px;border-radius:12px;border:1px solid #343842;margin-bottom:16px">
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <select id="ad-coin" class="in"><option value="ltc">Litecoin (LTC)</option><option value="btc">Bitcoin (BTC)</option><option value="eth">Ethereum (ETH)</option><option value="sol">Solana (SOL)</option></select>
          <input id="ad-addr" class="in" placeholder="Wallet address" autocomplete="off" style="flex:1;min-width:220px">
          <button id="ad-go" class="btn">Check</button>
        </div>
        <div id="ad-saved" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"></div>
        <div id="ad-out" style="margin-top:10px"></div>
        <p class="hint" style="margin:8px 0 0">Public blockchain data, read only. BTC and LTC show everything that came in and went out; ETH and SOL show the current balance. USD at today's price.</p>
      </div>

      <h4 style="margin:0 0 8px">🪙 Send LTC</h4>
      <div style="padding:14px;border-radius:12px;border:1px solid #343842;margin-bottom:16px">
        <div id="ltc-wallet"><p class="hint">Loading…</p></div>
        <div id="ltc-form" style="display:none">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
            <input id="ltc-to" class="in" placeholder="Send to (Litecoin address)" autocomplete="off" style="flex:2;min-width:220px">
            <input id="ltc-amt" class="in" placeholder="Amount (LTC)" inputmode="decimal" style="flex:1;min-width:120px">
            <button id="ltc-max" class="btn gray">Max</button>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
            <input id="ltc-note" class="in" placeholder="Note (optional, who/why)" maxlength="120" style="flex:1;min-width:220px">
            <button id="ltc-send" class="btn">Send LTC</button>
          </div>
          <p id="ltc-usd" class="hint" style="margin:6px 0 0"></p>
        </div>
        <div id="ltc-sends" style="margin-top:10px"></div>
      </div>

      <h4 style="margin:0 0 8px">📤 Pending Withdrawals</h4>
      <div id="adm-wd" style="margin-bottom:16px"></div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px">
        <div style="background:#f5faff;padding:14px;border-radius:12px;grid-column:1 / -1">
          <h4 style="margin-bottom:10px">📈 PS99 values</h4>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <button id="rap-go" class="btn sm">🔄 Update values now (official RAP)</button>
            <span id="rap-msg" class="hint" style="margin:0"></span>
          </div>
          <p class="hint">Values come from the official Pet Simulator 99 RAP and update by themselves every 6 hours, also for the pets players own. New Huges, Titanics and Gargantuans are added automatically. A value you change by hand stays as you set it.</p>
        </div>

        <div style="background:#f5faff;padding:14px;border-radius:12px;grid-column:1 / -1">
          <h4 style="margin-bottom:10px">➕ Add Pet</h4>
          <div style="display:grid;grid-template-columns:2fr 2fr 1fr 70px;gap:8px;align-items:center;margin-bottom:8px">
            <input id="a-name" class="in" autocomplete="off" placeholder="Pet name (e.g. Huge Cat)">
            <input id="a-img" class="in" placeholder="Image URL (https://...)">
            <input id="a-val" class="in" type="number" min="0" placeholder="Value">
            <img id="a-prev" alt="" style="width:64px;height:64px;object-fit:contain;justify-self:center;visibility:hidden">
          </div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
            <select id="a-var" class="in"><option value="normal">Normal</option><option value="golden">Golden</option><option value="rainbow">Rainbow</option></select>
            <label><input type="checkbox" id="a-shiny"> Shiny</label>
            <button id="a-add" class="btn sm">Add / update</button>
          </div>
          <p class="hint">Write the name without Golden / Rainbow / Shiny and pick the version. If the pet and version are already in the catalog, its picture and value are updated.</p>
        </div>

        <div style="background:#f5faff;padding:14px;border-radius:12px">
          <h4 style="margin-bottom:10px">🎁 Give Items</h4>
          <input id="g-user" list="g-users" class="in" style="width:100%;margin-bottom:8px" placeholder="Nickname or Roblox username">
          <datalist id="g-users"></datalist>
          <input id="g-qty" class="in" style="width:100%;margin-bottom:8px" type="number" min="1" max="50" value="1">
          <p class="hint">User must have logged in once. Enter the username, then press Give on an item.</p>
        </div>
      </div>

      <h4 style="margin:16px 0 8px">📥 Deposit bots</h4>
      <div style="background:#f5faff;padding:14px;border-radius:12px">
        <div id="bot-list" data-role="deposit" style="margin-bottom:10px"></div>
        <div style="display:grid;grid-template-columns:1fr 2fr auto;gap:8px">
          <input id="bot-name" class="in" maxlength="20" placeholder="Deposit bot Roblox username">
          <input id="bot-link" class="in" placeholder="Join link (https://www.roblox.com/share?...)">
          <button id="bot-add" class="btn">Add deposit bot</button>
        </div>
        <p class="hint">Players trade their pets to these bots. They are shown in the Deposit window with their status. Players cannot join an offline bot.</p>
      </div>

      <h4 style="margin:16px 0 8px">🧾 In-game bot log</h4>
      <div style="padding:14px;border-radius:12px;border:1px solid #343842;margin-bottom:6px">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">
          <span id="bl-state" style="font-weight:800"></span><span style="flex:1"></span>
          <button id="bl-refresh" class="btn gray sm">Refresh</button>
        </div>
        <div id="bl-sessions" class="hint" style="margin:0 0 6px"></div>
        <div id="bl-list" style="max-height:260px;overflow:auto;font-family:monospace;font-size:12px"></div>
        <p class="hint" style="margin:8px 0 0">Every request of the in-game deposit bot: which name it asked for, the deposit sessions that were open and why it was allowed or refused.</p>
      </div>

      <h4 style="margin:16px 0 8px">📤 Withdraw bots</h4>
      <div style="background:#f5faff;padding:14px;border-radius:12px">
        <div id="wbot-list" data-role="withdraw" style="margin-bottom:10px"></div>
        <div style="display:grid;grid-template-columns:1fr 2fr auto;gap:8px">
          <input id="wbot-name" class="in" maxlength="20" placeholder="Withdraw bot Roblox username">
          <input id="wbot-link" class="in" placeholder="Join link (https://www.roblox.com/share?...)">
          <button id="wbot-add" class="btn">Add withdraw bot</button>
        </div>
        <p class="hint">These bots send the pets out. Every withdraw request gets one online withdraw bot (in turns); the player sees its name and private server in the wallet. Withdrawals are paused while every withdraw bot is offline. While no withdraw bot is added, the deposit bots handle withdrawals.</p>
      </div>

      <h4 style="margin:16px 0 8px">💰 Coinflip tax</h4>
      <div style="background:#f5faff;padding:14px;border-radius:12px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
          <div><small>Tax rate (%), 0–20</small><input id="tax-pct" class="in" type="number" min="0" max="20" step="0.5" style="width:100%"></div>
          <div><small>Receiver</small><select id="tax-rcv" class="in" style="width:100%"></select></div>
        </div>
        <button id="tax-save" class="btn" style="width:100%">Save tax settings</button>
        <p class="hint">The tax is taken in items from the pot of every finished coinflip (the largest items that still fit under the rate, so it is never more than the rate). It goes to the chosen admin, or to the admins in turn when "Auto" is selected, and you get a bell notification each time. 0 turns the tax off.</p>
      </div>

      <h4 style="margin:16px 0 8px">🎯 Bounty</h4>
      <div style="background:#f5faff;padding:14px;border-radius:12px">
        <input id="bt-user" list="g-users" class="in" style="width:100%;margin-bottom:8px" placeholder="Roblox username of the target">
        <select id="bt-item" class="in" style="width:100%;margin-bottom:8px"></select>
        <button id="bt-add" class="btn" style="width:100%">🎯 Place bounty</button>
        <div id="bt-list" style="margin-top:10px"></div>
        <p class="hint">The first player to beat the target in a coinflip wins the prize. Everyone sees a congratulation popup with the winner's avatar and name. The target must have logged in once.</p>
      </div>

      <h4 style="margin:16px 0 8px">🎉 Events</h4>
      <div style="background:#f5faff;padding:14px;border-radius:12px">
        <div class="ev-src">
          <button type="button" data-ev-src="inv" class="on">🎒 My inventory</button>
          <button type="button" data-ev-src="cat">📚 Catalog</button>
        </div>
        <div id="ev-inv-box">
          <input id="ev-inv-q" class="in" style="width:100%;margin-bottom:8px" placeholder="Search your pets…" autocomplete="off">
          <div id="ev-inv" class="ev-inv"></div>
          <p id="ev-inv-sel" class="hint" style="margin:6px 0 8px">Click a pet to use it as the prize.</p>
        </div>
        <select id="ev-item" class="in" style="width:100%;margin-bottom:8px;display:none"></select>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
          <div><small>Wheel: join time (seconds)</small><input id="ev-wsec" class="in" type="number" min="15" max="600" value="60" style="width:100%"></div>
          <div><small>Scramble: time (seconds)</small><input id="ev-ssec" class="in" type="number" min="30" max="600" value="120" style="width:100%"></div>
        </div>
        <input id="ev-word" class="in" maxlength="20" style="width:100%;margin-bottom:8px" placeholder="Scramble word (leave empty for a random one)">
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="ev-wheel" class="btn" style="flex:1">🎡 Start Wheel</button>
          <button id="ev-scr" class="btn" style="flex:1">🔤 Start Word Scramble</button>
          <button id="ev-cancel" class="btn red">Cancel event</button>
        </div>
        <p class="hint">My inventory: the pet leaves your inventory when the event starts and goes to the winner. If nobody wins, the event is cancelled or the server restarts, it comes back to you. Catalog: a new pet is created for the winner. Starting an event posts an announcement in chat and a banner on the home page.</p>
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
      <button id="cat-open" class="btn" style="width:100%;min-height:52px;font-size:15px">📦 Open Catalog <span id="cat-count"></span></button>

      <style>
        #cat-panel { position: fixed; inset: 0; z-index: 170; display: flex; align-items: flex-end; justify-content: center; padding: 18px;
          background: rgba(5, 6, 10, 0); pointer-events: none; transition: background .3s; }
        #cat-panel.open { background: rgba(5, 6, 10, .72); pointer-events: auto; }
        #cat-panel .cat-sheet { display: flex; flex-direction: column; width: min(1180px, 100%); height: min(88vh, 900px); padding: 18px;
          border: 1px solid #343842; border-radius: 16px; background: #171a22; box-shadow: 0 30px 80px #000c;
          transform: translateY(110%) scale(.96); opacity: 0; transition: transform .45s cubic-bezier(.2, .9, .25, 1.05), opacity .3s; }
        #cat-panel.open .cat-sheet { transform: none; opacity: 1; }
        #cat-panel .cat-top { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
        #cat-panel .cat-top h3 { margin: 0; flex: 1; }
        #cat-panel .cat-scroll { flex: 1; overflow-y: auto; padding: 4px; }
        #cat-panel .cat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
        #cat-panel .cat-card { animation: cat-in .35s cubic-bezier(.2, .8, .2, 1) both; transition: transform .15s, border-color .15s; }
        #cat-panel .cat-card:hover { transform: translateY(-3px); border-color: #00efa0 !important; }
        @keyframes cat-in { from { opacity: 0; transform: translateY(14px) scale(.95); } }
        .cat-edit { position: fixed; inset: 0; z-index: 10050; display: grid; place-items: center; padding: 16px; background: rgba(5, 6, 10, .7); }
        .cat-edit-card { width: min(440px, 100%); max-height: 90vh; overflow-y: auto; padding: 18px; border: 1px solid #343842; border-radius: 14px; background: #171a22; box-shadow: 0 30px 80px #000c; }
        /* tabs */
        .adm-tabs { position: sticky; top: -1px; z-index: 5; display: flex; gap: 6px; margin: 0 0 14px; padding: 8px 0; overflow-x: auto; background: inherit; }
        .adm-tabs button { flex: none; padding: 9px 14px; border: 1px solid #343842; border-radius: 10px; color: #9aa0ad; background: #1d212b; font: inherit; font-weight: 800; cursor: pointer; transition: .15s; }
        .adm-tabs button:hover { color: #fff; }
        .adm-tabs button.on { border-color: #00efa0; color: #04120b; background: #00efa0; }
        .adm-tabs button .n { margin-left: 6px; padding: 1px 6px; border-radius: 99px; background: #ff5968; color: #fff; font-size: 11px; }
        .adm-tab[hidden] { display: none !important; }
        /* users as cards */
        .u-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
        .u-card { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid #2f3442; border-radius: 12px; background: #171a22; animation: cat-in .3s cubic-bezier(.2, .8, .2, 1) both; transition: border-color .15s; }
        .u-card:hover { border-color: #00efa0; }
        .u-card.is-banned { border-color: #5c2a30; background: #1e1518; }
        .u-top { display: flex; align-items: center; gap: 10px; }
        .u-av { position: relative; flex: none; width: 44px; height: 44px; }
        .u-av img, .u-av span { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; object-fit: cover; background: #262b36; color: #fff; font-weight: 900; }
        .u-av i { position: absolute; right: -1px; bottom: -1px; width: 12px; height: 12px; border: 2px solid #171a22; border-radius: 50%; background: #5a5f6b; }
        .u-av i.on { background: #22c55e; }
        .u-id { min-width: 0; }
        .u-id b { display: block; overflow: hidden; font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }
        .u-id small { color: #8d909a; font-size: 12px; }
        .u-tags { display: flex; flex-wrap: wrap; gap: 4px; }
        .u-tag { padding: 2px 7px; border-radius: 6px; background: #22262f; color: #cfd2db; font-size: 11px; font-weight: 800; }
        .u-tag.owner { background: rgba(192, 132, 252, .15); color: #c084fc; }
        .u-tag.sup { background: rgba(77, 163, 255, .15); color: #4da3ff; }
        .u-tag.ban { background: rgba(255, 89, 104, .15); color: #ff5968; }
        .u-tag.mute { background: rgba(255, 181, 46, .15); color: #ffb52e; }
        .u-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
        .u-stats div { padding: 6px 8px; border-radius: 8px; background: #1d212b; }
        .u-stats small { display: block; color: #8d909a; font-size: 10px; font-weight: 800; text-transform: uppercase; }
        .u-stats b { font-size: 14px; }
        .u-acts { display: flex; flex-wrap: wrap; gap: 5px; }
        .u-acts .btn { flex: 1 1 auto; }
        .u-ips { color: #6b7180; font-family: monospace; font-size: 11px; word-break: break-all; }
        .ev-src { display: flex; gap: 6px; margin-bottom: 8px; }
        .ev-src button { flex: 1; padding: 8px; border: 1px solid #343842; border-radius: 10px; background: #1d212b; color: #9aa0ad; font: inherit; font-weight: 800; cursor: pointer; transition: .15s; }
        .ev-src button.on { border-color: #00efa0; background: rgba(0, 239, 160, .12); color: #00efa0; }
        .ev-inv { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 8px; max-height: 300px; overflow-y: auto; padding: 2px; }
        .ev-pet { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 8px 6px; border: 2px solid #343842; border-radius: 12px; background: #1d212b; color: #fff; font: inherit; cursor: pointer; transition: transform .15s, border-color .15s; }
        .ev-pet:hover { transform: translateY(-2px); border-color: #4da3ff; }
        .ev-pet.on { border-color: #00efa0; background: rgba(0, 239, 160, .12); box-shadow: 0 0 0 3px rgba(0, 239, 160, .18); }
        .ev-pet img { width: 54px; height: 54px; object-fit: contain; }
        .ev-pet b { width: 100%; overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
        .ev-pet small { color: #9aa0ad; font-size: 11px; font-weight: 700; }
      </style>
      <div id="cat-panel">
        <div class="cat-sheet">
          <div class="cat-top">
            <h3>📦 Catalog <small id="cat-shown" class="hint"></small></h3>
            <input id="cat-q" class="in" placeholder="Search pet name..." autocomplete="off" style="flex:1;min-width:200px;max-width:360px">
            <select id="cat-age" class="in"><option value="">All versions</option><option value="normal">Normal</option><option value="golden">Golden</option><option value="rainbow">Rainbow</option><option value="shiny">Shiny</option></select>
            <select id="cat-sort" class="in"><option value="value">Value: high to low</option><option value="value-asc">Value: low to high</option><option value="name">Name A-Z</option></select>
            <button id="cat-x" class="x">✕</button>
          </div>
          <p class="hint" style="margin:0 0 8px">To give items, write the username in "Give Items" first, then press Give. Change a value and click outside the box to save it.</p>
          <div class="cat-scroll"><div id="adm-cat"></div></div>
        </div>
      </div>

      <h4 style="margin:16px 0 8px">👥 Users</h4>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">
        <input id="u-q" class="in" placeholder="Search username..." autocomplete="off" style="flex:1;min-width:170px">
        <select id="u-f" class="in"><option value="all">All players</option><option value="online">Online</option><option value="offline">Offline</option><option value="admin">Admins</option><option value="support">Support</option><option value="banned">Banned / muted</option></select>
        <select id="u-s" class="in"><option value="seen">Sort: last seen</option><option value="bet">Sort: total bet</option><option value="value">Sort: inventory value</option><option value="name">Sort: name</option></select>
      </div>
      <div id="u-count" class="hint" style="margin-bottom:6px"></div>
      <div id="adm-users"></div>
      <div id="adm-inv"></div>
      <div id="adm-stats"></div>

      <h4 style="margin:16px 0 8px">🚫 IP bans</h4>
      <div style="padding:14px;border-radius:12px;border:1px solid #343842">
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
          <input id="ip-addr" class="in" placeholder="IP address (e.g. 85.105.12.34)" style="flex:1;min-width:180px">
          <input id="ip-why" class="in" placeholder="Reason (optional)" maxlength="120" style="flex:1;min-width:160px">
          <button id="ip-add" class="btn red">Ban IP</button>
        </div>
        <div id="ip-list"></div>
        <p class="hint" style="margin:8px 0 0">Banned IPs see a "You are banned" page and cannot use the site. The <b>IP ban</b> button on a player card bans every IP that player used and their account. Your staff link always gets you in.</p>
      </div>

      <h4 style="margin:16px 0 8px">📋 Update log</h4>
      <div id="adm-log"></div>
    </div>`;

  document.body.appendChild(overlay);
  const $ = id => document.getElementById(id);

  /* tabs: every section of the panel goes into one tab, so only one group is on screen at a time */
  (function makeTabs() {
    const modal = overlay.querySelector('.modal');
    const head = modal.querySelector('.mh');
    const TABS = [['overview', '🏠 Overview'], ['users', '👥 Users'], ['pets', '🐾 Pets'], ['bots', '🤖 Bots'], ['games', '🎲 Games']];
    const byTitle = [['Send LTC', 'overview'], ['Send USDT', 'overview'], ['Crypto address', 'overview'], ['Pending Withdrawals', 'overview'], ['Deposit bots', 'bots'], ['Withdraw bots', 'bots'], ['Coinflip tax', 'games'], ['Bounty', 'games'],
      ['Events', 'games'], ['Announcement', 'overview'], ['Catalog', 'pets'], ['Users', 'users'], ['IP bans', 'users'], ['Update log', 'overview']];
    const boxes = Object.fromEntries(TABS.map(([k]) => { const d = document.createElement('div'); d.className = 'adm-tab'; d.dataset.tab = k; return [k, d]; }));
    let cur = 'overview';
    for (const el of [...modal.children]) {
      if (el === head || el.tagName === 'STYLE' || el.id === 'cat-panel') continue;
      if (el.tagName === 'H4') {
        const hit = byTitle.find(([t]) => el.textContent.includes(t));
        if (hit) cur = hit[1];
      } else if (el.querySelector && el.querySelector('#a-name')) cur = 'pets';
      boxes[cur].appendChild(el);
    }
    const bar = document.createElement('div');
    bar.className = 'adm-tabs';
    bar.innerHTML = TABS.map(([k, label]) => `<button data-tab="${k}">${label}${k === 'overview' ? '<span class="n" id="tab-wd" hidden></span>' : ''}</button>`).join('');
    head.after(bar);
    let last = bar;
    for (const [k] of TABS) { last.after(boxes[k]); last = boxes[k]; }
    const show = k => {
      for (const [t] of TABS) boxes[t].hidden = t !== k;
      bar.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === k));
      try { localStorage.setItem('pd_admin_tab', k); } catch {}
      modal.scrollTop = 0; overlay.scrollTop = 0;
    };
    bar.onclick = e => { const b = e.target.closest('[data-tab]'); if (b) show(b.dataset.tab); };
    let start = 'overview';
    try { start = localStorage.getItem('pd_admin_tab') || 'overview'; } catch {}
    show(boxes[start] ? start : 'overview');
  })();

  $('adm-x').onclick = () => overlay.remove();
  $('u-q').oninput = () => renderUsers();
  $('u-f').onchange = () => renderUsers();
  $('u-s').onchange = () => renderUsers();
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.remove(); });

  let catalogCache = [];
  let catRender = () => {};
  const catPanel = $('cat-panel');
  overlay.appendChild(catPanel); /* outside the animated modal, so it covers the whole screen */
  $('cat-open').onclick = () => { catRender(); catPanel.classList.add('open'); setTimeout(() => $('cat-q').focus({ preventScroll: true }), 300); };
  $('cat-x').onclick = () => catPanel.classList.remove('open');
  catPanel.addEventListener('mousedown', e => { if (e.target === catPanel) catPanel.classList.remove('open'); });
  $('cat-q').oninput = () => catRender();
  $('cat-age').onchange = () => catRender();
  $('cat-sort').onchange = () => catRender();
  const setPreview = () => {
    const v = $('a-img').value.trim();
    if (/^(https:\/\/|\/assets\/)/.test(v)) { $('a-prev').src = v; $('a-prev').style.visibility = 'visible'; }
    else { $('a-prev').removeAttribute('src'); $('a-prev').style.visibility = 'hidden'; }
  };
  $('a-img').oninput = setPreview;
  const rapText = d => { $('rap-msg').textContent = d.rapAt ? `Last update ${new Date(d.rapAt).toLocaleString()}${d.rapInfo ? ': ' + d.rapInfo : ''}` : 'Not updated yet (runs 1 minute after the server starts)'; };
  $('rap-go').onclick = async () => {
    $('rap-go').disabled = true;
    $('rap-msg').textContent = 'Loading the official values…';
    try {
      const r = await api('/api/admin/rap/refresh', { method: 'POST', body: {} });
      toast(`Values updated: ${r.updated} changed, ${r.added} new pets`, 'ok');
      rapText({ rapAt: r.at, rapInfo: r.info });
      await load();
    } catch (err) { $('rap-msg').textContent = err.message; toast(err.message, 'err'); }
    $('rap-go').disabled = false;
  };

  async function load() {
    const data = await api('/api/admin/data');

    const tw = $('tab-wd');
    if (tw) { tw.hidden = !data.withdrawals.length; tw.textContent = data.withdrawals.length; }
    $('adm-wd').innerHTML = data.withdrawals.length
      ? data.withdrawals.map(w => `
        <div style="border:1px solid #343842;border-radius:8px;padding:10px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
            <b>${esc(w.user.username)}</b>
            ${w.botName ? `<span style="color:#4da3ff;font-weight:800">🤖 ${esc(w.botName)}</span>` : ''}
            <span>${fmt(w.value)} · ${new Date(w.ts).toLocaleString()}</span>
            <span>
              <button class="btn mint sm" data-wd="done" data-id="${esc(w.id)}">Mark sent</button>
              <button class="btn red sm" data-wd="refund" data-id="${esc(w.id)}">Refund</button>
            </span>
          </div>
          <div style="margin-top:6px;font-size:12px">
            ${w.items.map(i => esc(i.name)).join(' · ')}
          </div>
        </div>`).join('')
      : '<p class="hint">No pending withdrawals.</p>';

    const catCard = item => {
      return `
        <div style="border:2px solid #e0edfb;border-radius:12px;padding:10px;text-align:center">
          <img src="${esc(item.image)}" alt="" style="width:70px;height:70px;object-fit:contain">
          <div style="font-weight:700">${esc(item.name)}</div>
          ${tags(item)}
          <div style="font-weight:900;color:#4da3ff;margin-top:4px">${esc(fmt(item.value))}${item.manual ? ' ✋' : ''}</div>
          <input class="in" type="number" min="0" step="1" value="${esc(item.value)}" data-value-id="${esc(item.id)}" style="width:100%;margin:6px 0">
          <div style="display:flex;gap:5px">
            <button class="btn mint sm" data-action="give" data-id="${esc(item.id)}" style="flex:1">Give</button>
            <button class="btn gray sm" data-action="edit" data-id="${esc(item.id)}" title="Edit">✏️</button>
            <button class="btn red sm" data-action="delete" data-id="${esc(item.id)}">🗑</button>
          </div>
        </div>`;
    };

    catRender = () => {
      const q = $('cat-q').value.trim().toLowerCase();
      const age = $('cat-age').value;
      const sort = $('cat-sort').value;
      const list = data.catalog
        .filter(i => (!q || i.name.toLowerCase().includes(q)) && (!age || (age === 'shiny' ? i.shiny : (i.variant || 'normal') === age)))
        .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'value-asc' ? a.value - b.value : b.value - a.value);
      $('cat-shown').textContent = `${list.length} / ${data.catalog.length}`;
      $('adm-cat').innerHTML = list.length
        ? `<div class="cat-grid">${list.slice(0, 400).map((item, i) => catCard(item).replace('<div style="border', `<div class="cat-card" style="animation-delay:${Math.min(i, 30) * 18}ms;border`)).join('')}</div>`
        : `<p class="hint" style="text-align:center;padding:30px">${data.catalog.length ? 'No pet matches your search.' : 'No items yet.'}</p>`;
    };
    $('cat-count').textContent = `(${data.catalog.length})`;
    catRender();

    catalogCache = data.catalog || [];
    rapText(data);
    usersCache = data.users;
    renderUsers();
    renderIpBans(data.ipBans || []);
    $('g-users').innerHTML = data.users.map(u => `<option value="${esc(u.username)}"></option>`).join('');

    const prevItem = $('ev-item').value;
    $('ev-item').innerHTML = data.catalog.length
      ? [...data.catalog].sort((a, b) => b.value - a.value).slice(0, 600).map(i => `<option value="${esc(i.id)}">${esc(i.name)} (${fmt(i.value)})</option>`).join('')
      : '<option value="">No catalog items</option>';
    if (prevItem) $('ev-item').value = prevItem;

    myInv = data.myInventory || [];
    if (evPick && !myInv.some(i => i.uid === evPick)) evPick = '';
    renderEvInv();

    const prevBounty = $('bt-item').value;
    $('bt-item').innerHTML = $('ev-item').innerHTML;
    if (prevBounty) $('bt-item').value = prevBounty;

    renderBots(data.bots || []);
    if (document.activeElement !== $('cb-list')) $('cb-list').value = data.blockCountries || '';
    renderBlock(data.blockCountries || '', data.blockEnv || '', data.staffLink || '');
    mtOn = Boolean(data.maintenance);
    if (document.activeElement !== $('mt-text')) $('mt-text').value = data.maintenanceText || '';
    renderMaint();

    $('tax-pct').value = data.settings ? data.settings.taxPercent : 0;
    $('tax-rcv').innerHTML = '<option value="auto">Auto (admins in turn)</option>' +
      (data.admins || []).map(a => `<option value="${esc(a.id)}">${esc(a.username)}</option>`).join('');
    $('tax-rcv').value = data.settings ? data.settings.taxReceiver : 'auto';

    const logBuiltIn = (data.updateLog || []).map(v => `
      <details style="border:1px solid #343842;border-radius:8px;padding:8px 12px;margin-bottom:8px">
        <summary style="cursor:pointer;font-weight:800">v${esc(v.version)} — ${esc(v.title)}</summary>
        <ul style="margin:8px 0 0 18px;line-height:1.6">${v.changes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>
      </details>`).join('');

    const logNotes = (data.updateNotes || []).map(n => `
      <div style="border:1px solid #343842;border-radius:8px;padding:8px 12px;margin-bottom:8px">
        📝 <b>${esc(n.title)}</b> <small>${new Date(n.ts).toLocaleString()} · ${esc(n.by)}</small><br>
        ${esc(n.text)}
        <button class="btn red sm" data-note-del="${esc(n.id)}" style="margin-left:8px">Delete</button>
      </div>`).join('');

    $('adm-log').innerHTML = `
      <div style="margin-bottom:10px">
        <input id="ul-title" class="in" maxlength="80" placeholder="Note title" style="width:100%;margin-bottom:6px">
        <input id="ul-text" class="in" maxlength="500" placeholder="What changed?" style="width:100%;margin-bottom:6px">
        <button class="btn sm" id="ul-add">Add note</button>
      </div>
      ${logNotes}${logBuiltIn}`;

    $('bt-list').innerHTML = (data.bounties || []).length
      ? data.bounties.map(b => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px;border-bottom:1px solid #e0edfb">
          <span>🎯 <b>${esc(b.target.username)}</b> — ${esc(b.prize.name)} (${fmt(b.prize.value)})</span>
          <button class="btn red sm" data-bt-cancel="${esc(b.id)}">Cancel</button>
        </div>`).join('')
      : '<p class="hint">No active bounties.</p>';
  }

  function renderBlock(list, env, staffLink) {
    const all = [list, env].filter(Boolean).join(', ');
    $('cb-state').textContent = all ? `● Blocking: ${all}` : '● Nobody blocked';
    $('cb-state').style.color = all ? '#ff5968' : '#00efa0';
    $('cb-hint').innerHTML = (all
      ? 'Visitors from these countries see "Pet Duel is not available in your country". '
      : 'Two-letter country codes, separated by commas (TR = Turkey). ') +
      'This browser keeps access automatically. For other phones / browsers / admins open this secret staff link once: ' +
      `<code style="user-select:all;word-break:break-all">${esc(staffLink)}</code> (do not share it publicly).` +
      (env ? ` (${esc(env)} comes from Railway and can only be removed there.)` : '');
  }
  async function saveBlock(value) {
    if (value && !(await confirmBox({ title: 'Block countries?', text: `Visitors from ${value} will not be able to open the site. Make sure you can still get in (staff link or VPN).`, ok: 'Block', danger: true }))) return;
    try {
      const r = await api('/api/admin/block', { method: 'POST', body: { countries: value } });
      $('cb-list').value = r.countries.join(', ');
      toast(r.countries.length ? 'Blocked: ' + r.countries.join(', ') : 'Nobody is blocked now', 'ok');
      await load();
    } catch (err) { toast(err.message, 'err'); }
  }
  $('cb-tr').onclick = () => saveBlock('TR');
  $('cb-save').onclick = () => saveBlock($('cb-list').value);
  $('cb-off').onclick = () => saveBlock('');

  let mtOn = false;
  function renderMaint() {
    $('mt-state').textContent = mtOn ? '● ON: the site is closed' : '● OFF: the site is open';
    $('mt-state').style.color = mtOn ? '#ff5968' : '#00efa0';
    $('mt-box').style.borderColor = mtOn ? '#ff5968' : '#343842';
    $('mt-toggle').textContent = mtOn ? 'Open the site' : 'Close the site';
    $('mt-toggle').className = mtOn ? 'btn' : 'btn red';
  }
  $('mt-toggle').onclick = async () => {
    const turnOn = !mtOn;
    if (turnOn && !(await confirmBox({ title: 'Close the site?', text: 'Everyone except admins will be disconnected and see the closed screen.', ok: 'Close the site', danger: true }))) return;
    try {
      const r = await api('/api/admin/maintenance', { method: 'POST', body: { on: turnOn, text: $('mt-text').value } });
      mtOn = r.on;
      renderMaint();
      toast(mtOn ? 'Maintenance ON: the site is closed' : 'Maintenance OFF: the site is open', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };

  async function loadBotLog() {
    try {
      const r = await api('/api/admin/botlog');
      $('bl-state').innerHTML = r.on ? '<span style="color:#00efa0">● Automatic deposits ON</span>' : '<span style="color:#ff5968">● OFF: BOT_SECRET is not set in Railway</span>';
      $('bl-sessions').textContent = 'Open deposit sessions: ' + r.sessions;
      $('bl-list').innerHTML = r.log.length ? r.log.map(l => `<div style="padding:4px 0;border-top:1px solid #2a2e39;color:${/allowed=true|added/.test(l.text) ? '#7dffcf' : /403|503|allowed=false/.test(l.text) ? '#ff8a94' : '#cfd2db'}">${new Date(l.ts).toLocaleTimeString()} · ${esc(l.text)}</div>`).join('') : '<p class="hint">Nothing yet. Press Deposit on the site and send the bot a trade.</p>';
    } catch (err) { $('bl-list').textContent = err.message; }
  }
  $('bl-refresh').onclick = loadBotLog;

  /* crypto address lookup; the last addresses are remembered in this browser */
  const adSaved = () => { try { return JSON.parse(localStorage.getItem('pd_admin_addrs') || '[]'); } catch { return []; } };
  const renderAdSaved = () => {
    $('ad-saved').innerHTML = adSaved().map(x => `<button class="btn gray sm" data-ad-pick="${esc(x.coin)}|${esc(x.address)}" title="${esc(x.address)}">${esc(x.coin.toUpperCase())} ${esc(x.address.slice(0, 6))}…${esc(x.address.slice(-4))}</button>`).join('');
  };
  renderAdSaved();
  const money = v => (v === null || v === undefined ? '-' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const amt = (v, sym) => (v === null || v === undefined ? '-' : `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 8 })} ${sym}`);
  async function adCheck() {
    const coin = $('ad-coin').value, address = $('ad-addr').value.trim();
    if (!address) return toast('Enter an address', 'err');
    $('ad-out').innerHTML = '<p class="hint">Checking…</p>';
    try {
      const r = await api('/api/admin/addr', { method: 'POST', body: { coin, address } });
      const card = (label, v, u, color) => `<div style="flex:1;min-width:150px;padding:10px 12px;border-radius:10px;background:#1d212b"><small style="color:#8d909a;font-weight:800;text-transform:uppercase;font-size:11px">${label}</small><div style="font-size:18px;font-weight:900;color:${color}">${amt(v, r.symbol)}</div><small style="color:#9aa0ad">${money(u)}</small></div>`;
      $('ad-out').innerHTML = `
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${r.full ? card('Total received', r.received, r.usd.received, '#00efa0') + card('Total sent', r.sent, r.usd.sent, '#ff5968') : ''}
          ${card('Balance now', r.balance, r.usd.balance, '#fff')}
        </div>
        <p class="hint" style="margin:6px 0 0">${esc(r.name)} · ${r.txCount !== null ? `${r.txCount} transactions · ` : ''}${r.pending ? `${amt(r.pending, r.symbol)} unconfirmed · ` : ''}${r.price ? `1 ${esc(r.symbol)} = ${money(r.price)}` : 'no USD price right now'}</p>`;
      const list = [{ coin, address }, ...adSaved().filter(x => !(x.coin === coin && x.address === address))].slice(0, 8);
      try { localStorage.setItem('pd_admin_addrs', JSON.stringify(list)); } catch {}
      renderAdSaved();
    } catch (err) { $('ad-out').innerHTML = `<p class="hint" style="color:#ff5968">${esc(err.message)}</p>`; }
  }
  $('ad-go').onclick = adCheck;

  /* send LTC from the site wallet */
  let ltcInfo = null, ltcAll = false;
  async function loadLtc() {
    try {
      const r = ltcInfo = await api('/api/admin/ltc/wallet');
      if (!r.configured) {
        $('ltc-wallet').innerHTML = `<p class="hint">${r.error ? `<span style="color:#ff5968">${esc(r.error)}</span>` : 'Not set up yet.'} In Railway → Variables add <b>LTC_MNEMONIC</b> (the wallet's 12 word secret phrase, words separated by spaces) or <b>LTC_WIF</b> (a WIF private key), then redeploy. Optional: <b>LTC_MAX_SEND</b> = the most LTC one send can be.</p>`;
        $('ltc-form').style.display = 'none';
      } else {
        $('ltc-wallet').innerHTML = `
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            <div style="flex:1;min-width:200px"><small style="color:#8d909a;font-weight:800;text-transform:uppercase;font-size:11px">Site wallet</small><div style="font-family:monospace;font-size:13px;word-break:break-all">${esc(r.address)}</div></div>
            <div style="padding:8px 12px;border-radius:10px;background:#1d212b"><small style="color:#8d909a;font-weight:800;text-transform:uppercase;font-size:11px">Balance</small><div style="font-size:18px;font-weight:900">${r.balance === undefined ? '-' : amt(r.balance, 'LTC')}</div><small style="color:#9aa0ad">${money(r.usd)}${r.pending ? ` · ${amt(r.pending, 'LTC')} unconfirmed` : ''}</small></div>
            <button id="ltc-reload" class="btn gray sm">Refresh</button>
          </div>${r.error ? `<p class="hint" style="color:#ff5968">${esc(r.error)}</p>` : ''}`;
        $('ltc-reload').onclick = loadLtc;
        $('ltc-form').style.display = '';
      }
      $('ltc-sends').innerHTML = (r.sends || []).length ? `<small style="color:#8d909a;font-weight:800;text-transform:uppercase;font-size:11px">Last sends</small>` + r.sends.map(x => `
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:6px 0;border-bottom:1px solid #2a2e37;font-size:13px">
          <b style="color:#00efa0">${amt(x.ltc, 'LTC')}</b>
          <span style="font-family:monospace;color:#c7cbd4">${esc(x.to.slice(0, 10))}…${esc(x.to.slice(-6))}</span>
          <span style="color:#8d909a">${esc(x.by)} · ${new Date(x.ts).toLocaleString()}${x.note ? ' · ' + esc(x.note) : ''}</span>
          <a href="https://litecoinspace.org/tx/${esc(x.txid)}" target="_blank" rel="noopener" style="margin-left:auto;color:#4da3ff">View tx</a>
        </div>`).join('') : '';
    } catch (err) { $('ltc-wallet').innerHTML = `<p class="hint" style="color:#ff5968">${esc(err.message)}</p>`; }
  }
  const ltcUsd = () => {
    const v = Number($('ltc-amt').value.replace(',', '.'));
    $('ltc-usd').textContent = ltcAll ? 'Sends the whole balance (the network fee is taken from it).' : v > 0 && ltcInfo && ltcInfo.price ? `≈ ${money(v * ltcInfo.price)} + a tiny network fee` : '';
  };
  $('ltc-amt').oninput = () => { ltcAll = false; ltcUsd(); };
  $('ltc-max').onclick = () => { ltcAll = true; $('ltc-amt').value = ltcInfo && ltcInfo.balance !== undefined ? String(ltcInfo.balance) : ''; ltcUsd(); };
  $('ltc-send').onclick = async () => {
    const to = $('ltc-to').value.trim(), value = Number($('ltc-amt').value.replace(',', '.'));
    if (!to) return toast('Enter the address', 'err');
    if (!ltcAll && !(value > 0)) return toast('Enter an amount', 'err');
    const what = ltcAll ? 'the WHOLE balance' : `${value} LTC${ltcInfo && ltcInfo.price ? ` (≈ ${money(value * ltcInfo.price)})` : ''}`;
    if (!(await confirmBox({ title: 'Send LTC?', text: `Send ${what} to ${to}? Crypto sends cannot be undone, check the address.`, ok: 'Send', danger: true }))) return;
    $('ltc-send').disabled = true;
    try {
      const r = await api('/api/admin/ltc/send', { method: 'POST', body: { to, amount: value, all: ltcAll, note: $('ltc-note').value } });
      toast(`Sent ${r.send.ltc} LTC`, 'ok');
      $('ltc-to').value = $('ltc-amt').value = $('ltc-note').value = ''; ltcAll = false; ltcUsd();
      setTimeout(loadLtc, 1500);
    } catch (err) { toast(err.message, 'err'); }
    $('ltc-send').disabled = false;
  };
  loadLtc();

  /* send USDT (BEP20) */
  let usdtInfo = null, usdtAll = false;
  async function loadUsdt() {
    try {
      const r = usdtInfo = await api('/api/admin/usdt/wallet');
      if (!r.configured) {
        $('usdt-wallet').innerHTML = `<p class="hint">${r.error ? `<span style="color:#ff5968">${esc(r.error)}</span> ` : ''}Not set up yet. It uses the same 12 words as <b>LTC_MNEMONIC</b>; for a different wallet add <b>BSC_MNEMONIC</b> in Railway. Optional: <b>USDT_MAX_SEND</b>.</p>`;
        $('usdt-form').style.display = 'none';
      } else {
        const lowBnb = r.sendsLeft !== null && r.sendsLeft !== undefined && r.sendsLeft < 3;
        $('usdt-wallet').innerHTML = `
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            <div style="flex:1;min-width:200px"><small style="color:#8d909a;font-weight:800;text-transform:uppercase;font-size:11px">Site wallet (BNB Smart Chain)</small><div style="font-family:monospace;font-size:13px;word-break:break-all">${esc(r.address)}</div></div>
            <div style="padding:8px 12px;border-radius:10px;background:#1d212b"><small style="color:#8d909a;font-weight:800;text-transform:uppercase;font-size:11px">USDT</small><div style="font-size:18px;font-weight:900;color:#26a17b">${r.balance === undefined ? '-' : money(r.balance)}</div></div>
            <div style="padding:8px 12px;border-radius:10px;background:#1d212b"><small style="color:#8d909a;font-weight:800;text-transform:uppercase;font-size:11px">BNB for fees</small><div style="font-size:18px;font-weight:900;color:${lowBnb ? '#ff5968' : '#f3ba2f'}">${r.bnb === undefined ? '-' : amt(r.bnb, 'BNB')}</div><small style="color:#9aa0ad">${r.sendsLeft === undefined || r.sendsLeft === null ? '' : `enough for ~${r.sendsLeft} sends`}</small></div>
            <button id="usdt-reload" class="btn gray sm">Refresh</button>
          </div>${lowBnb ? `<p class="hint" style="color:#ff5968">Low on BNB. Send a little BNB on <b>BNB Smart Chain (BEP20)</b> to the address above, about $1-2 is enough for many sends.</p>` : ''}${r.error ? `<p class="hint" style="color:#ff5968">${esc(r.error)}</p>` : ''}`;
        $('usdt-reload').onclick = loadUsdt;
        $('usdt-form').style.display = '';
      }
      $('usdt-sends').innerHTML = (r.sends || []).length ? `<small style="color:#8d909a;font-weight:800;text-transform:uppercase;font-size:11px">Last sends</small>` + r.sends.map(x => `
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:6px 0;border-bottom:1px solid #2a2e37;font-size:13px">
          <b style="color:#26a17b">${money(x.usdt)} USDT</b>
          <span style="font-family:monospace;color:#c7cbd4">${esc(x.to.slice(0, 8))}…${esc(x.to.slice(-6))}</span>
          <span style="color:#8d909a">${esc(x.by)} · ${new Date(x.ts).toLocaleString()}${x.note ? ' · ' + esc(x.note) : ''}</span>
          <a href="https://bscscan.com/tx/${esc(x.txid)}" target="_blank" rel="noopener" style="margin-left:auto;color:#4da3ff">View tx</a>
        </div>`).join('') : '';
    } catch (err) { $('usdt-wallet').innerHTML = `<p class="hint" style="color:#ff5968">${esc(err.message)}</p>`; }
  }
  $('usdt-amt').oninput = () => { usdtAll = false; };
  $('usdt-max').onclick = () => { usdtAll = true; $('usdt-amt').value = usdtInfo && usdtInfo.balance !== undefined ? String(usdtInfo.balance) : ''; };
  $('usdt-send').onclick = async () => {
    const to = $('usdt-to').value.trim(), value = Number($('usdt-amt').value.replace(',', '.'));
    if (!to) return toast('Enter the address', 'err');
    if (!usdtAll && !(value > 0)) return toast('Enter an amount', 'err');
    const what = usdtAll ? 'ALL the USDT' : `${value} USDT`;
    if (!(await confirmBox({ title: 'Send USDT?', text: `Send ${what} on BNB Smart Chain (BEP20) to ${to}? Crypto sends cannot be undone, check the address and the network.`, ok: 'Send', danger: true }))) return;
    $('usdt-send').disabled = true;
    try {
      const r = await api('/api/admin/usdt/send', { method: 'POST', body: { to, amount: value, all: usdtAll, note: $('usdt-note').value } });
      toast(`Sent ${r.send.usdt} USDT`, 'ok');
      $('usdt-to').value = $('usdt-amt').value = $('usdt-note').value = ''; usdtAll = false;
      setTimeout(loadUsdt, 4000);
    } catch (err) { toast(err.message, 'err'); }
    $('usdt-send').disabled = false;
  };
  loadUsdt();
  $('ad-addr').onkeydown = e => { if (e.key === 'Enter') adCheck(); };
  $('ad-saved').onclick = e => {
    const b = e.target.closest('[data-ad-pick]');
    if (!b) return;
    const [coin, address] = b.dataset.adPick.split('|');
    $('ad-coin').value = coin; $('ad-addr').value = address;
    adCheck();
  };
  loadBotLog();

  function renderBots(all) {
    for (const [id, role] of [['bot-list', 'deposit'], ['wbot-list', 'withdraw']]) {
      const bots = all.filter(b => (b.role || 'deposit') === role);
      $(id).innerHTML = bots.length
      ? bots.map(b => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid #e0edfb;flex-wrap:wrap">
          ${b.avatar ? `<img src="${esc(b.avatar)}" alt="" style="width:32px;height:32px;border-radius:50%">` : ''}
          <b style="min-width:110px">${esc(b.username)}</b>
          <span style="color:${b.online ? '#00efa0' : '#ff5968'};font-weight:800">● ${b.online ? 'Online' : 'Offline'}</span>
          <input class="in" data-bot-link="${esc(b.id)}" value="${esc(b.link)}" style="flex:1;min-width:180px">
          <button class="btn sm ${b.online ? 'gray' : 'mint'}" data-bot-toggle="${esc(b.id)}" data-on="${b.online ? '0' : '1'}">${b.online ? 'Set offline' : 'Set online'}</button>
          <button class="btn red sm" data-bot-del="${esc(b.id)}">🗑</button>
        </div>`).join('')
      : `<p class="hint">${role === 'deposit' ? 'No deposit bots yet. Deposits are not possible until you add one.' : 'No withdraw bots yet: the deposit bots handle withdrawals.'}</p>`;
    }
  }

  const addBot = async (role, pre) => {
    try {
      const r = await api('/api/admin/bots/add', { method: 'POST', body: { username: $(pre + '-name').value, link: $(pre + '-link').value, role } });
      $(pre + '-name').value = ''; $(pre + '-link').value = '';
      renderBots(r.bots);
      toast(role === 'withdraw' ? 'Withdraw bot added' : 'Deposit bot added', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
  $('bot-add').onclick = () => addBot('deposit', 'bot');
  $('wbot-add').onclick = () => addBot('withdraw', 'wbot');

  const botListClick = async e => {
    const t = e.target.closest('[data-bot-toggle]');
    const d = e.target.closest('[data-bot-del]');
    try {
      if (t) {
        const r = await api('/api/admin/bots/update', { method: 'POST', body: { id: t.dataset.botToggle, online: t.dataset.on === '1' } });
        renderBots(r.bots);
      }
      if (d) {
        if (!(await confirmBox({ title: 'Remove bot', text: 'Remove this bot from the list?', ok: 'Remove', danger: true }))) return;
        const r = await api('/api/admin/bots/delete', { method: 'POST', body: { id: d.dataset.botDel } });
        renderBots(r.bots);
        toast('Bot removed', 'ok');
      }
    } catch (err) { toast(err.message, 'err'); }
  };

  $('bot-list').onclick = $('wbot-list').onclick = botListClick;
  $('bot-list').onchange = $('wbot-list').onchange = async e => {
    const input = e.target.closest('[data-bot-link]');
    if (!input) return;
    try {
      const r = await api('/api/admin/bots/update', { method: 'POST', body: { id: input.dataset.botLink, link: input.value } });
      renderBots(r.bots);
      toast('Join link saved', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };

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
      const r = await api('/api/admin/catalog', {
        method: 'POST', body: { base: $('a-name').value, image: $('a-img').value, value: $('a-val').value, variant: $('a-var').value, shiny: $('a-shiny').checked }
      });
      toast(r.updated ? `${r.item.name} updated` : `${r.item.name} added`, 'ok');
      $('a-name').value = $('a-img').value = $('a-val').value = ''; $('a-shiny').checked = false; setPreview();
      await load();
    } catch (err) { toast(err.message, 'err'); }
  };

  /* the edit window of one catalog item */
  function editCatalogItem(c) {
    if (!c) return;
    const box = document.createElement('div');
    box.className = 'cat-edit';
    box.innerHTML = `
      <div class="cat-edit-card">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
          <img id="ce-prev" src="${esc(c.image)}" alt="" style="width:64px;height:64px;object-fit:contain">
          <div style="flex:1"><b style="font-size:17px">Edit pet</b><div class="hint" style="margin:2px 0 0">id ${esc(c.id)}</div></div>
          <button class="btn gray sm" data-ce="x">✕</button>
        </div>
        <label class="hint">Name (without Golden / Rainbow / Shiny)</label><input class="in" id="ce-name" maxlength="60" value="${esc(c.base || c.name)}" style="width:100%;margin-bottom:8px">
        <label class="hint">Image URL</label><input class="in" id="ce-img" value="${esc(c.image)}" style="width:100%;margin-bottom:8px">
        <label class="hint">Value</label><input class="in" id="ce-val" type="number" min="0" step="1" value="${esc(c.value)}" style="width:100%;margin-bottom:8px">
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
          <select class="in" id="ce-var">${['normal', 'golden', 'rainbow'].map(a => `<option value="${a}" ${(c.variant || 'normal') === a ? 'selected' : ''}>${a[0].toUpperCase() + a.slice(1)}</option>`).join('')}</select>
          <label><input type="checkbox" id="ce-shiny" ${c.shiny ? 'checked' : ''}> Shiny</label>
          ${c.manual ? '<label title="The automatic RAP update will change this value again"><input type="checkbox" id="ce-auto"> Follow RAP again</label>' : ''}
        </div>
        <label style="display:flex;gap:8px;align-items:center;margin:6px 0 12px"><input type="checkbox" id="ce-own"> Also change the copies players already own</label>
        <div style="display:flex;gap:8px"><button class="btn" data-ce="save" style="flex:1">Save</button><button class="btn gray" data-ce="x">Cancel</button></div>
      </div>`;
    overlay.appendChild(box);
    box.querySelector('#ce-img').oninput = e => { box.querySelector('#ce-prev').src = e.target.value; };
    box.onclick = async e => {
      const b = e.target.closest('[data-ce]');
      if (e.target === box || (b && b.dataset.ce === 'x')) return box.remove();
      if (!b) return;
      try {
        const body = {
          id: c.id, base: box.querySelector('#ce-name').value, image: box.querySelector('#ce-img').value, value: box.querySelector('#ce-val').value,
          variant: box.querySelector('#ce-var').value, shiny: box.querySelector('#ce-shiny').checked,
          ...(box.querySelector('#ce-auto') && box.querySelector('#ce-auto').checked ? { manual: false } : {}),
          applyToOwned: box.querySelector('#ce-own').checked
        };
        const r = await api('/api/admin/catalog/update', { method: 'POST', body });
        toast(r.changed ? `Saved, ${r.changed} owned copies updated` : 'Saved', 'ok');
        box.remove();
        await load();
        catRender();
      } catch (err) { toast(err.message, 'err'); }
    };
  }

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
      if (button.dataset.action === 'edit') {
        editCatalogItem(catalogCache.find(c => c.id === id));
        return;
      }
      if (button.dataset.action === 'delete') {
        if (!(await confirmBox({ title: 'Delete item', text: 'Are you sure you want to delete this catalog item?', ok: 'Delete', danger: true }))) return;
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

  $('adm-users').addEventListener('click', async e => {
    const b = e.target.closest('[data-ipban]');
    if (!b) return;
    e.stopImmediatePropagation();
    const ok = await confirmBox({ title: 'IP ban ' + b.dataset.name, text: b.dataset.ips ? `Ban these IPs and the account: ${b.dataset.ips}?` : 'No IP is known for this player yet. The account will not be IP banned.', ok: 'IP ban', danger: true });
    if (!ok) return;
    try {
      const r = await api('/api/admin/ipban', { method: 'POST', body: { userId: b.dataset.ipban } });
      toast(`${r.ips.length} IP${r.ips.length === 1 ? '' : 's'} banned`, 'ok');
      await load();
    } catch (err) { toast(err.message, 'err'); }
  }, true);

  function renderIpBans(list) {
    $('ip-list').innerHTML = list.length ? list.map(b => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid #2a2e39;flex-wrap:wrap">
        <code style="font-weight:800">${esc(b.ip)}</code>
        <span class="hint" style="margin:0;flex:1">${b.user ? esc(b.user) + ' · ' : ''}${b.reason ? esc(b.reason) + ' · ' : ''}by ${esc(b.by)} · ${esc(ago(b.ts))}</span>
        <button class="btn sm mint" data-ipunban="${esc(b.ip)}">Unban</button>
      </div>`).join('') : '<p class="hint" style="margin:0">No banned IPs.</p>';
  }
  $('ip-add').onclick = async () => {
    try {
      await api('/api/admin/ipban', { method: 'POST', body: { ip: $('ip-addr').value, reason: $('ip-why').value } });
      $('ip-addr').value = ''; $('ip-why').value = '';
      toast('IP banned', 'ok');
      await load();
    } catch (err) { toast(err.message, 'err'); }
  };
  $('ip-list').onclick = async e => {
    const b = e.target.closest('[data-ipunban]');
    if (!b) return;
    try { await api('/api/admin/ipunban', { method: 'POST', body: { ip: b.dataset.ipunban } }); toast('IP unbanned', 'ok'); await load(); }
    catch (err) { toast(err.message, 'err'); }
  };

  $('adm-users').onclick = async e => {
    const sp = e.target.closest('[data-support]');
    if (sp) {
      const on = sp.dataset.state === '1';
      try {
        await api('/api/admin/support', { method: 'POST', body: { id: sp.dataset.support, on } });
        toast(on ? 'Support role given' : 'Support role removed', 'ok');
        await load();
      } catch (err) { toast(err.message, 'err'); }
      return;
    }

    const st = e.target.closest('[data-stats]');
    if (st) { openStats(st.dataset.stats); return; }

    const ci = e.target.closest('[data-clearinv]');
    if (ci) {
      const ok = await confirmBox({
        title: 'Delete all pets',
        text: `Delete ALL ${ci.dataset.count} pets (${ci.dataset.val}) of ${ci.dataset.name}? This cannot be undone.`,
        ok: 'Delete all', danger: true
      });
      if (!ok) return;
      try {
        const r = await api('/api/admin/inventory/clear', { method: 'POST', body: { id: ci.dataset.clearinv } });
        toast(`${r.count} pets deleted`, 'ok');
        await load();
      } catch (err) { toast(err.message, 'err'); }
      return;
    }

    const mu = e.target.closest('[data-mute]');
    if (mu) {
      const doMute = mu.dataset.state === '1';
      const answer = await confirmBox({
        title: doMute ? 'Mute user' : 'Unmute user',
        text: doMute
          ? 'The user will not be able to chat, and all of their chat messages will be deleted.'
          : 'Allow this user to chat again?',
        ok: doMute ? 'Mute' : 'Unmute',
        danger: doMute,
        select: doMute ? {
          label: 'Duration',
          value: '60',
          options: [['10', '10 minutes'], ['60', '1 hour'], ['360', '6 hours'], ['1440', '24 hours'], ['10080', '7 days'], ['-1', 'Permanent']]
        } : null
      });
      if (!answer) return;
      try {
        await api('/api/admin/mute', { method: 'POST', body: { id: mu.dataset.mute, minutes: doMute ? Number(answer.value) : 0 } });
        toast(doMute ? 'User muted' : 'User unmuted', 'ok');
        await load();
      } catch (err) { toast(err.message, 'err'); }
      return;
    }

    const iv = e.target.closest('[data-inv]');
    if (iv) { openInv(iv.dataset.inv); return; }

    const r = e.target.closest('[data-role]');
    if (r) {
      const make = r.dataset.state === '1';
      const answer = await confirmBox({
        title: make ? 'Make admin' : 'Remove admin',
        text: make
          ? 'Are you sure you want to give this user admin access? They will be able to use the whole admin panel.'
          : 'Are you sure you want to remove this user\'s admin access?',
        ok: make ? 'Make admin' : 'Remove admin',
        danger: !make,
        checkbox: make ? { label: 'Show the ADMIN tag in chat', checked: true } : null
      });
      if (!answer) return;
      try {
        await api('/api/admin/role', { method: 'POST', body: { id: r.dataset.role, admin: make, tag: make ? answer.checked : true } });
        toast(make ? 'Admin access given' : 'Admin access removed', 'ok');
        await load();
      } catch (err) { toast(err.message, 'err'); }
      return;
    }

    const tg = e.target.closest('[data-tag]');
    if (tg) {
      const on = tg.dataset.state === '1';
      try {
        await api('/api/admin/role', { method: 'POST', body: { id: tg.dataset.tag, admin: true, tag: on } });
        toast(on ? 'ADMIN chat tag is now shown' : 'ADMIN chat tag is now hidden', 'ok');
        await load();
      } catch (err) { toast(err.message, 'err'); }
      return;
    }

    const b = e.target.closest('[data-ban]');
    if (!b) return;
    const ban = b.dataset.state === '1';
    if (ban && !(await confirmBox({ title: 'Ban user', text: 'Are you sure you want to ban this user?', ok: 'Ban', danger: true }))) return;
    try {
      await api('/api/admin/ban', { method: 'POST', body: { id: b.dataset.ban, ban } });
      toast(ban ? 'User banned' : 'User unbanned', 'ok');
      await load();
    } catch (err) { toast(err.message, 'err'); }
  };

  let usersCache = [];
  let statsUser = null;

  function ago(ts) {
    if (!ts) return 'never';
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 1440) return Math.floor(m / 60) + ' h ago';
    return Math.floor(m / 1440) + ' d ago';
  }

  function renderUsers() {
    const q = ($('u-q').value || '').trim().toLowerCase();
    const f = $('u-f').value;
    const sort = $('u-s').value;

    const list = usersCache.filter(u => {
      if (q && !u.username.toLowerCase().includes(q) && !(u.nickname || '').toLowerCase().includes(q)) return false;
      if (f === 'online') return u.online;
      if (f === 'offline') return !u.online;
      if (f === 'admin') return u.isAdmin;
      if (f === 'support') return u.support;
      if (f === 'banned') return u.banned || u.muted;
      return true;
    });

    list.sort((a, b) => {
      if (sort === 'bet') return b.totalBet - a.totalBet;
      if (sort === 'value') return b.value - a.value;
      if (sort === 'name') return a.username.localeCompare(b.username);
      return (Number(b.online) - Number(a.online)) || ((b.lastSeen || 0) - (a.lastSeen || 0));
    });

    const online = usersCache.filter(u => u.online).length;
    $('u-count').textContent = `${list.length} shown · ${online} online · ${usersCache.length} total`;

    $('adm-users').innerHTML = list.length
      ? `<div class="u-grid">${list.slice(0, 120).map((u, k) => `
        <div class="u-card ${u.banned ? 'is-banned' : ''}" style="animation-delay:${Math.min(k, 24) * 18}ms">
          <div class="u-top">
            <div class="u-av">${u.avatar ? `<img src="${esc(u.avatar)}" alt="">` : `<span>${esc((u.nickname || u.username).charAt(0).toUpperCase())}</span>`}<i class="${u.online ? 'on' : ''}"></i></div>
            <div class="u-id">
              <b>${u.nickname ? esc(u.nickname) : '<i style="color:#ffb52e">no nickname</i>'}</b>
              <small>@${esc(u.username)} · ${u.online ? '<span style="color:#22c55e">online</span>' : esc(ago(u.lastSeen))}</small>
            </div>
          </div>
          <div class="u-tags">
            ${u.isAdmin ? '<span class="u-tag owner">Owner</span>' : ''}${u.support ? '<span class="u-tag sup">Support</span>' : ''}
            ${u.banned ? '<span class="u-tag ban">Banned</span>' : ''}${u.ipBanned ? '<span class="u-tag ban">IP banned</span>' : ''}${u.muted ? '<span class="u-tag mute">Muted</span>' : ''}
            <span class="u-tag">${esc(u.rank || '')}</span>
          </div>
          <div class="u-stats">
            <div><small>Items</small><b>${u.items}</b></div>
            <div><small>Value</small><b>${fmt(u.value)}</b></div>
            <div><small>Bet</small><b>${fmt(u.totalBet)}</b></div>
          </div>
          <div class="u-acts">
            <button class="btn sm gray" data-inv="${esc(u.id)}">🎒 Items</button>
            <button class="btn sm gray" data-stats="${esc(u.id)}">📊 Stats</button>
            ${!u.isAdmin ? `<button class="btn sm gray" data-mute="${esc(u.id)}" data-state="${u.muted ? '0' : '1'}">${u.muted ? '🔊 Unmute' : '🔇 Mute'}</button>` : ''}
            ${!u.isAdmin ? `<button class="btn sm ${u.support ? 'mint' : 'gray'}" data-support="${esc(u.id)}" data-state="${u.support ? '0' : '1'}">${u.support ? '🎧 Support ✓' : '🎧 Support'}</button>` : ''}
            ${u.isAdmin ? `<button class="btn sm gray" data-tag="${esc(u.id)}" data-state="${u.adminTag ? '0' : '1'}">Tag: ${u.adminTag ? 'ON' : 'OFF'}</button>` : ''}
            <button class="btn sm gray" data-role="${esc(u.id)}" data-state="${u.isAdmin ? '0' : '1'}">${u.isAdmin ? 'Remove admin' : '👑 Admin'}</button>
            ${u.items ? `<button class="btn sm red" data-clearinv="${esc(u.id)}" data-name="${esc(u.nickname || u.username)}" data-count="${u.items}" data-val="${esc(fmt(u.value))}">🗑 Pets</button>` : ''}
            <button class="btn sm ${u.banned ? 'mint' : 'red'}" data-ban="${esc(u.id)}" data-state="${u.banned ? '0' : '1'}">${u.banned ? 'Unban' : '⛔ Ban'}</button>
            ${!u.isAdmin && !u.ipBanned ? `<button class="btn sm red" data-ipban="${esc(u.id)}" data-name="${esc(u.nickname || u.username)}" data-ips="${esc((u.ips || []).join(', '))}">🚫 IP ban</button>` : ''}
          </div>
          ${u.ips && u.ips.length ? `<div class="u-ips" title="Last IPs">IP: ${u.ips.slice(0, 3).map(esc).join(', ')}${u.ips.length > 3 ? ` +${u.ips.length - 3}` : ''}</div>` : ''}
        </div>`).join('')}</div>` + (list.length > 120 ? '<p class="hint">Showing the first 120. Use the search to narrow it down.</p>' : '')
      : '<p class="hint">No users match.</p>';
  }


  function openStats(userId) {
    const u = usersCache.find(x => x.id === userId);
    if (!u) return;

    statsUser = userId;

    const field = (id, label, value) => `
      <div><small>${label}</small>
      <input id="${id}" class="in" type="number" step="0.01" value="${esc(value)}" style="width:100%"></div>`;

    $('adm-stats').innerHTML = `
      <div style="background:#f5faff;padding:14px;border-radius:12px;margin-top:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px">
          <b>${esc(u.username)}'s stats</b>
          <button class="btn gray sm" id="st-close">Close</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:10px">
          ${field('st-bet', 'Total bet', u.totalBet)}
          ${field('st-won', 'Total won', u.totalWon)}
          ${field('st-lost', 'Total lost', u.totalLost)}
          ${field('st-profit', 'Profit', u.profit)}
        </div>
        <button class="btn" id="st-save" style="width:100%">Save stats</button>
        <p class="hint">The rank follows total bet. Every change is written to the server log.</p>
      </div>`;

    $('adm-stats').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  $('adm-stats').onclick = async e => {
    if (e.target.closest('#st-close')) { $('adm-stats').innerHTML = ''; statsUser = null; return; }
    if (!e.target.closest('#st-save') || !statsUser) return;

    try {
      await api('/api/admin/stats', {
        method: 'POST',
        body: {
          id: statsUser,
          totalBet: $('st-bet').value, totalWon: $('st-won').value,
          totalLost: $('st-lost').value, profit: $('st-profit').value
        }
      });
      toast('Stats saved', 'ok');
      await load();
      openStats(statsUser);
    } catch (err) { toast(err.message, 'err'); }
  };

  let invUser = null;

  async function openInv(userId) {
    try {
      invUser = userId;
      const data = await api('/api/admin/inventory?id=' + encodeURIComponent(userId));

      $('adm-inv').innerHTML = `
        <div style="background:#f5faff;padding:14px;border-radius:12px;margin-top:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <b>${esc(data.username)}'s inventory (${data.items.length})</b>
            <button class="btn gray sm" id="inv-close">Close</button>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;max-height:340px;overflow-y:auto">
            ${data.items.length ? data.items.map(i => `
              <div style="border:2px solid #e0edfb;border-radius:10px;padding:8px;text-align:center">
                <img src="${esc(i.image)}" alt="" style="width:60px;height:60px;object-fit:contain">
                <div style="font-weight:700;font-size:12px">${esc(i.name)}</div>
                ${tags(i)}
                <div>${fmt(i.value)}</div>
                <button class="btn red sm" data-delitem="${esc(i.uid)}" data-name="${esc(i.name)}" style="margin-top:6px;width:100%">Delete</button>
              </div>`).join('') : '<p class="hint">This inventory is empty.</p>'}
          </div>
        </div>`;

      $('adm-inv').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) { toast(err.message, 'err'); }
  }

  $('adm-inv').onclick = async e => {
    if (e.target.closest('#inv-close')) { $('adm-inv').innerHTML = ''; invUser = null; return; }

    const d = e.target.closest('[data-delitem]');
    if (!d || !invUser) return;

    if (!(await confirmBox({
      title: 'Delete item',
      text: 'Are you sure you want to delete "' + d.dataset.name + '" from this player\'s inventory? This cannot be undone.',
      ok: 'Delete', danger: true
    }))) return;

    try {
      await api('/api/admin/inventory/delete', { method: 'POST', body: { id: invUser, uid: d.dataset.delitem } });
      toast('Item deleted', 'ok');
      await openInv(invUser);
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

  $('tax-save').onclick = async () => {
    try {
      await api('/api/admin/tax', { method: 'POST', body: { percent: $('tax-pct').value, receiver: $('tax-rcv').value } });
      toast('Tax settings saved', 'ok');
      await load();
    } catch (err) { toast(err.message, 'err'); }
  };

  $('adm-log').onclick = async e => {
    if (e.target.closest('#ul-add')) {
      try {
        await api('/api/admin/updatelog', { method: 'POST', body: { title: $('ul-title').value, text: $('ul-text').value } });
        toast('Note added', 'ok');
        await load();
      } catch (err) { toast(err.message, 'err'); }
      return;
    }

    const d = e.target.closest('[data-note-del]');
    if (!d) return;
    if (!(await confirmBox({ title: 'Delete note', text: 'Delete this update note?', ok: 'Delete', danger: true }))) return;

    try {
      await api('/api/admin/updatelog/delete', { method: 'POST', body: { id: d.dataset.noteDel } });
      toast('Note deleted', 'ok');
      await load();
    } catch (err) { toast(err.message, 'err'); }
  };

  $('bt-add').onclick = async () => {
    try {
      await api('/api/admin/bounty', { method: 'POST', body: { username: $('bt-user').value, itemId: $('bt-item').value } });
      $('bt-user').value = '';
      toast('Bounty placed!', 'ok');
      await load();
    } catch (err) { toast(err.message, 'err'); }
  };

  $('bt-list').onclick = async e => {
    const b = e.target.closest('[data-bt-cancel]');
    if (!b) return;
    if (!(await confirmBox({ title: 'Cancel bounty', text: 'Remove this bounty?', ok: 'Remove', danger: true }))) return;
    try {
      await api('/api/admin/bounty/cancel', { method: 'POST', body: { id: b.dataset.btCancel } });
      toast('Bounty removed', 'ok');
      await load();
    } catch (err) { toast(err.message, 'err'); }
  };

  /* event prize: a pet from my own inventory, or a catalog item */
  let myInv = [], evPick = '', evSrc = 'inv';
  function renderEvInv() {
    const q = $('ev-inv-q').value.trim().toLowerCase();
    const list = myInv.filter(i => !q || i.name.toLowerCase().includes(q)).sort((a, b) => b.value - a.value);
    $('ev-inv').innerHTML = list.length
      ? list.slice(0, 200).map(i => `
        <button type="button" class="ev-pet ${i.uid === evPick ? 'on' : ''}" data-ev-pick="${esc(i.uid)}" title="${esc(i.name)}">
          <img src="${esc(i.image)}" alt="" loading="lazy">
          <b>${esc(i.name)}</b>
          <small>${tags(i)} ${fmt(i.value)}</small>
        </button>`).join('')
      : `<p class="hint" style="grid-column:1/-1;text-align:center;padding:16px">${myInv.length ? 'No pet matches your search.' : 'Your inventory is empty. Deposit pets or use the Catalog.'}</p>`;
    const sel = myInv.find(i => i.uid === evPick);
    $('ev-inv-sel').innerHTML = sel ? `Prize: <b>${esc(sel.name)}</b> (${fmt(sel.value)})` : 'Click a pet to use it as the prize.';
  }
  $('ev-inv-q').oninput = renderEvInv;
  $('ev-inv').onclick = e => {
    const b = e.target.closest('[data-ev-pick]');
    if (!b) return;
    evPick = evPick === b.dataset.evPick ? '' : b.dataset.evPick;
    renderEvInv();
  };
  overlay.querySelectorAll('[data-ev-src]').forEach(b => {
    b.onclick = () => {
      evSrc = b.dataset.evSrc;
      overlay.querySelectorAll('[data-ev-src]').forEach(x => x.classList.toggle('on', x === b));
      $('ev-inv-box').style.display = evSrc === 'inv' ? '' : 'none';
      $('ev-item').style.display = evSrc === 'cat' ? '' : 'none';
    };
  });

  async function startEvent(kind) {
    try {
      if (evSrc === 'inv' && !evPick) { toast('Pick a pet from your inventory', 'err'); return; }
      const prize = evSrc === 'inv' ? { invUid: evPick } : { itemId: $('ev-item').value };
      const body = kind === 'wheel'
        ? { ...prize, seconds: $('ev-wsec').value }
        : { ...prize, seconds: $('ev-ssec').value, word: $('ev-word').value };
      await api('/api/admin/event/' + kind, { method: 'POST', body });
      toast('Event started!', 'ok');
      if (evSrc === 'inv') { evPick = ''; await load(); }
    } catch (err) { toast(err.message, 'err'); }
  }

  $('ev-wheel').onclick = () => startEvent('wheel');
  $('ev-scr').onclick = () => startEvent('scramble');
  $('ev-cancel').onclick = async () => {
    if (!(await confirmBox({ title: 'Cancel event', text: 'Are you sure you want to cancel the running event?', ok: 'Cancel event', danger: true }))) return;
    try {
      await api('/api/admin/event/cancel', { method: 'POST', body: {} });
      toast('Event cancelled', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };

  $('an-send').onclick = () => announce(false);
  $('an-clear').onclick = () => announce(true);

  load().catch(err => { toast(err.message, 'err'); overlay.remove(); });
}

/* ================= SOCKET CHAT ================= */

io.use((socket, next) => {
  socket.token = socket.handshake.auth && socket.handshake.auth.token;
  socket.isBot = validBotKey(socket.handshake.auth && socket.handshake.auth.botKey);
  socket.user = socket.isBot ? null : userFromToken(socket.token);
  if (maintenanceOn() && !socket.isBot && !(socket.user && isAdmin(socket.user))) return next(new Error('maintenance'));
  next();
});

io.on('connection', socket => {
  if (socket.isBot) {
    socket.join('bots');
    console.log('Discord bot connected.');
    socket.on('disconnect', () => console.log('Discord bot disconnected.'));
    return;
  }
  if (socket.user) {
    const uid = socket.user.id;
    socket.join(`u:${uid}`);

    /* the same player with several tabs counts once */
    socketsByUser.set(uid, (socketsByUser.get(uid) || 0) + 1);
    socket.on('disconnect', () => {
      const left = (socketsByUser.get(uid) || 1) - 1;
      if (left <= 0) socketsByUser.delete(uid); else socketsByUser.set(uid, left);
      const u = S.users[uid];
      if (u) u.lastSeen = now();
    });
  }
  if (socket.user && isAdmin(socket.user)) socket.join('admins');
  emitOnlineSoon();

  /* a socket that floods events is dropped and the IP gets a strike */
  let eventCount = 0;
  const floodTimer = setInterval(() => { eventCount = 0; }, 10000);
  socket.onAny(() => {
    if (++eventCount > 40) {
      strike(socket._ip);
      socket.disconnect(true);
    }
  });
  socket.on('disconnect', () => clearInterval(floodTimer));

  socket.on('chat:send', (payload, ack) => {
    if (socket.user && !S.users[socket.user.id]?.nickname) {
      if (typeof ack === 'function') ack({ error: 'Choose a nickname first' });
      return;
    }
    const callback = typeof ack === 'function' ? ack : () => {};
    const user = userFromToken(socket.token);
    if (!user) return callback({ error: 'Login to chat' });

    if ((user.mutedUntil || 0) > now()) {
      if (user.mutedUntil >= MUTE_FOREVER) return callback({ error: 'You are muted.' });
      const mins = Math.max(1, Math.ceil((user.mutedUntil - now()) / 60000));
      return callback({ error: `You are muted for ${mins} more minute(s).` });
    }

    if (!isAdmin(user) && (user.totalBet || 0) <= 0) return callback({ error: 'Place a bet to chat' });

    let text = typeof payload === 'string' ? payload : payload && payload.text;
    if (typeof text !== 'string') return callback({ error: 'Invalid message' });

    text = text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160);
    if (!text) return callback({ error: 'Empty message' });

    const t = now();
    if (t - (lastChat.get(user.id) || 0) < 1200) return callback({ error: 'Slow down' });
    lastChat.set(user.id, t);

    const admin = isAdmin(user);
    const showTag = admin && user.adminTag !== false;

    if (admin && text === '/clear') {
      S.chat = [];
      io.emit('chat:clear');
      return callback({ ok: true });
    }

    if (!admin && /(https?:|www\.|discord\.gg|\.gg\/|\.com|\.net|\.xyz|\.ru|\.io)/i.test(text)) {
      return callback({ error: 'Links are not allowed in chat' });
    }

    /* reply: keep a short copy of the message it answers */
    let reply = null;
    const replyId = payload && typeof payload.replyTo === 'string' ? payload.replyTo.slice(0, 20) : '';
    if (replyId) {
      const orig = S.chat.find(m => m.id === replyId);
      if (orig) reply = { id: orig.id, name: String(orig.user && orig.user.username || 'PetDuel').slice(0, 30), text: String(orig.text || '').slice(0, 80) };
    }

    pushChat({
      id: rid(4),
      user: { ...publicUser(user), rank: rankOf(user.totalBet) },
      rank: rankOf(user.totalBet),
      text, ts: t, admin: showTag,
      ...(!admin && user.support === true ? { support: true } : {}),
      ...(reply ? { reply } : {})
    });
    callback({ ok: true });
  });

  socket.on('disconnect', () => emitOnlineSoon());
});

/* ================= FRONTEND ================= */

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/health', (req, res) => {
  res.json({ ok: true, storage: mongoColl ? 'mongodb' : 'memory-only' });
});

/* ================= ITEM AUDIT (no dupes, ever) =================
   Items are removed from one place and added to another inside the same synchronous step, so a race
   cannot duplicate them. As a second safety net every item has a unique id and this audit checks that
   no id exists in two places. If it ever finds one, the extra copy in the inventory is removed and admins are notified. */

function auditItems() {
  const places = new Map();
  const add = (uid, where, isInventory, holder) => {
    if (!uid) return;
    if (!places.has(uid)) places.set(uid, []);
    places.get(uid).push({ where, isInventory, holder });
  };

  for (const u of Object.values(S.users)) {
    for (const i of u.inventory) add(i.uid, `inventory of ${u.username}`, true, u);
  }

  for (const m of Object.values(S.matches)) {
    if (m.state === 'finished') continue;
    [...m.hostItems, ...m.oppItems].forEach(i => add(i.uid, `match ${m.id}`, false));
  }
  for (const w of S.botWithdrawals || []) if (w.status === 'pending') w.items.forEach(i => add(i.uid, `bot withdraw ${w.id}`, false));

  if (JP && JP.state !== 'finished') JP.entries.forEach(e => e.items.forEach(i => add(i.uid, `jackpot ${JP.id}`, false)));

  for (const g of Object.values(S.giveaways)) g.items.forEach(i => add(i.uid, `giveaway ${g.id}`, false));
  for (const w of S.withdrawals) {
    if (w.status === 'pending') w.items.forEach(i => add(i.uid, `withdraw ${w.id}`, false));
  }

  let removed = 0;

  for (const [uid, list] of places) {
    if (list.length < 2) continue;

    const keep = list.find(x => !x.isInventory) || list[0];

    for (const entry of list) {
      if (entry === keep || !entry.isInventory) continue;
      const user = entry.holder;
      const index = user.inventory.findIndex(i => i.uid === uid);
      if (index >= 0) { user.inventory.splice(index, 1); removed += 1; emitMe(user); }
    }

    console.error(`[SECURITY] Duplicate item ${uid} found in: ${list.map(x => x.where).join(' | ')}`);
  }

  if (removed) {
    notifyAdmins('security', `Item audit removed ${removed} duplicated item(s). Check the server logs.`);
    markDirty();
  }
}

setInterval(auditItems, 30 * 1000);

/* clean up small in-memory maps */
setInterval(() => {
  const t = now();
  for (const [k, v] of lastChat) if (t - v > 10 * 60 * 1000) lastChat.delete(k);
  for (const [k, v] of lastGuess) if (t - v > 10 * 60 * 1000) lastGuess.delete(k);
  for (const [k, v] of blockedIps) if (v <= t) blockedIps.delete(k);
  for (const [k, v] of strikes) if (t - v.t > 10 * 60 * 1000) strikes.delete(k);
  for (const [k, v] of captchas) if (v.exp < t) captchas.delete(k);
}, 60 * 1000);

/* never show stack traces to visitors */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err.status || err.statusCode);
  res.status(status >= 400 && status < 600 ? status : 400).json({ error: 'Bad request' });
});

/* one failing request must never take the whole site down */
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err && err.message ? err.message : err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err && err.stack ? err.stack : err));

/* ================= PS99 AUTOMATIC DEPOSIT (in-game bot) =================
   1. Deposit, step 3: POST /api/deposit/init opens a 10 minute session for the player's Roblox name
      (renewed after every deposit, so they can trade again in the same server).
   2. The in-game bot asks GET /api/bot/verify-player/:robloxUsername  -> { allowed: true | false }
   3. After the trade: POST /api/bot/confirm-deposit { tradeId, robloxUsername, items: [{ name, pt, sh, amount }] }
      name = the pet's id in PS99 ("Huge Cat"; a full name like "Shiny Rainbow Huge Cat" also works),
      pt = 1 golden / 2 rainbow (or golden: true / rainbow: true / variant: "golden"), sh = shiny (or shiny: true),
      amount = how many of that pet (default 1). Each pet is matched with the catalog by name + variant + shiny and
      added to the inventory with the catalog value and picture. Pets that are not in the catalog are not added;
      admins get a notification. Each tradeId is handled once (409 on repeats, also after a restart).
   4. The deposit window polls GET /api/deposit/status every 2 seconds and shows the new pets.
   Both bot routes need the header x-bot-secret = the Railway variable BOT_SECRET (or BOT_SECRET_KEY).
   They are open to requests from anywhere (no CORS / origin check): the secret is the only key. */

/* one pet row from the bot -> { base, variant, shiny, label } */
function rowPet(r) {
  const parsed = ps99Parse((r && (r.name || r.id)) || '');
  const v = String((r && r.variant) || '').toLowerCase();
  const variant = r && (r.pt === 2 || r.rainbow === true || v === 'rainbow') ? 'rainbow'
    : r && (r.pt === 1 || r.golden === true || v === 'golden') ? 'golden' : parsed.variant;
  const shiny = Boolean(r && (r.sh === true || r.shiny === true)) || parsed.shiny;
  return { base: parsed.base.slice(0, 80), variant, shiny, label: ps99FullName(parsed.base || '(no name)', variant, shiny) };
}
/* one pet for the bot to hand over */
function botItem(i) {
  const p = i.base ? { base: i.base, variant: i.variant || 'normal', shiny: Boolean(i.shiny) } : ps99Parse(i.name);
  return { name: p.base, id: p.base, pt: p.variant === 'golden' ? 1 : p.variant === 'rainbow' ? 2 : 0, sh: p.shiny,
    variant: p.variant, shiny: p.shiny, golden: p.variant === 'golden', rainbow: p.variant === 'rainbow', fullName: i.name, amount: 1 };
}

const DEPOSIT_SESSION_MS = 10 * 60 * 1000;
const DEPOSIT_GRACE_MS = 5 * 60 * 1000;      /* a trade started just before the end can still be confirmed */
/* robloxUsername (trim + lower case) -> { userId, robloxUsername, startedAt, expiresAt }; saved in S.depositSessions */
const activeSessions = {
  get: k => (S.depositSessions || {})[k],
  set: (k, v) => { S.depositSessions = { ...(S.depositSessions || {}), [k]: v }; markDirty(); },
  delete: k => { if (S.depositSessions && S.depositSessions[k]) { delete S.depositSessions[k]; markDirty(); } },
  entries: () => Object.entries(S.depositSessions || {})
};
const sessionKey = name => String(name || '').trim().toLowerCase();

/* what the in-game bot asked and what it got: Railway log + the last 60 lines in the admin panel (Bots tab) */
const botLog = [];
function logBot(text) {
  const line = `[BOT] ${text}`;
  console.log(line);
  botLog.unshift({ ts: now(), text });
  if (botLog.length > 60) botLog.length = 60;
}
const sessionsText = () => {
  const t = now();
  const list = activeSessions.entries().map(([k, v]) => `${k} (${v.expiresAt > t ? Math.ceil((v.expiresAt - t) / 60000) + ' min left' : 'expired'})`);
  return list.length ? list.join(', ') : 'none';
};
/* the secret of the in-game bot: Railway variable BOT_SECRET (BOT_SECRET_KEY also works); spaces / new lines around it are ignored */
const botSecret = () => String(process.env.BOT_SECRET || process.env.BOT_SECRET_KEY || '').trim();
const autoDepositOn = () => Boolean(botSecret());

function gameBotSecretOk(req) {
  const key = botSecret();
  const got = String(req.headers['x-bot-secret'] || '').trim();
  if (!key || !got) return false;
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(got).digest(), crypto.createHash('sha256').update(key).digest());
}

/* middleware for the in-game bot routes */
function gameBotOnly(req, res, next) {
  if (!autoDepositOn()) {
    logBot(`${req.method} ${req.path} -> 503: BOT_SECRET is not set in Railway`);
    return bad(res, 'BOT_SECRET is not set on the server', 503);
  }
  if (!gameBotSecretOk(req)) {
    const got = String(req.headers['x-bot-secret'] || '').trim();
    logBot(`${req.method} ${req.path} -> 403: ${got ? `wrong x-bot-secret (sent ${got.length} characters, the server expects ${botSecret().length})` : 'no x-bot-secret header'}`);
    return bad(res, 'Forbidden', 403);
  }
  next();
}

const tradeDone = id => (S.amTrades || []).includes(id);
function rememberTrade(id) { S.amTrades = [id, ...(S.amTrades || []).filter(x => x !== id)].slice(0, 5000); }

setInterval(() => {
  const t = now();
  for (const [k, sess] of activeSessions.entries()) if (sess.expiresAt + DEPOSIT_GRACE_MS < t) activeSessions.delete(k);
}, 60 * 1000);

const sessionView = sess => (sess ? { startedAt: sess.startedAt, expiresAt: sess.expiresAt } : null);

/* ================= ADMIN: CRYPTO ADDRESS LOOKUP =================
   Reads public blockchain data for one address (nothing is moved, no keys are used):
   BTC / LTC: total received, total sent, balance and number of transactions (mempool-style APIs);
   ETH / SOL: current balance (public RPC). USD values from Binance (CoinGecko as backup). */
const ADDR_COINS = {
  btc: { name: 'Bitcoin', symbol: 'BTC', decimals: 8, api: 'https://mempool.space/api', re: /^(bc1[a-z0-9]{20,90}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/ },
  ltc: { name: 'Litecoin', symbol: 'LTC', decimals: 8, api: 'https://litecoinspace.org/api', re: /^(ltc1[a-z0-9]{20,90}|[LM3][a-km-zA-HJ-NP-Z1-9]{25,34})$/ },
  eth: { name: 'Ethereum', symbol: 'ETH', decimals: 18, rpc: 'https://ethereum-rpc.publicnode.com', re: /^0x[0-9a-fA-F]{40}$/ },
  sol: { name: 'Solana', symbol: 'SOL', decimals: 9, rpc: 'https://api.mainnet-beta.solana.com', re: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ }
};
const addrPriceCache = { t: 0, p: {} };
async function coinPrices() {
  if (now() - addrPriceCache.t < 60000 && addrPriceCache.p.btc) return addrPriceCache.p;
  let p = {};
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbols=' + encodeURIComponent('["BTCUSDT","LTCUSDT","ETHUSDT","SOLUSDT"]'), { signal: AbortSignal.timeout(8000) });
    for (const x of await r.json()) p[x.symbol.replace('USDT', '').toLowerCase()] = Number(x.price);
  } catch { /* backup below */ }
  if (!p.btc) {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,litecoin,ethereum,solana&vs_currencies=usd', { signal: AbortSignal.timeout(8000) });
      const g = await r.json();
      p = { btc: g.bitcoin && g.bitcoin.usd, ltc: g.litecoin && g.litecoin.usd, eth: g.ethereum && g.ethereum.usd, sol: g.solana && g.solana.usd };
    } catch { /* no prices */ }
  }
  addrPriceCache.t = now(); addrPriceCache.p = p;
  return p;
}
const fromUnits = (v, d) => Number(BigInt(v)) / 10 ** d;

app.post('/api/admin/addr', auth, adminOnly, async (req, res) => {
  const coin = String(req.body.coin || '').toLowerCase();
  const c = ADDR_COINS[coin];
  const address = String(req.body.address || '').trim();
  if (!c) return bad(res, 'Pick a coin');
  if (!c.re.test(address)) return bad(res, `That is not a valid ${c.name} address`);
  try {
    const out = { coin, name: c.name, symbol: c.symbol, address, received: null, sent: null, balance: null, pending: null, txCount: null, full: Boolean(c.api) };
    if (c.api) {
      const r = await fetch(`${c.api}/address/${address}`, { signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error(`${new URL(c.api).host} answered ${r.status}`);
      const d = await r.json();
      const cs = d.chain_stats || {}, ms = d.mempool_stats || {};
      out.received = fromUnits(cs.funded_txo_sum || 0, c.decimals);
      out.sent = fromUnits(cs.spent_txo_sum || 0, c.decimals);
      out.balance = fromUnits((cs.funded_txo_sum || 0) - (cs.spent_txo_sum || 0), c.decimals);
      out.pending = fromUnits((ms.funded_txo_sum || 0) - (ms.spent_txo_sum || 0), c.decimals);
      out.txCount = (cs.tx_count || 0) + (ms.tx_count || 0);
    } else {
      const body = coin === 'eth'
        ? { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }
        : { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address, { commitment: 'finalized' }] };
      const r = await fetch(c.rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message || 'RPC error');
      out.balance = fromUnits(coin === 'eth' ? BigInt(d.result) : BigInt(d.result.value), c.decimals);
    }
    const price = (await coinPrices())[coin] || null;
    out.price = price;
    const usd = v => (v === null || !price ? null : round2(v * price));
    out.usd = { received: usd(out.received), sent: usd(out.sent), balance: usd(out.balance) };
    res.json(out);
  } catch (error) {
    bad(res, `Could not read the address: ${error.name === 'TimeoutError' ? 'the blockchain API did not answer in time' : error.message}`, 502);
  }
});

/* ================= ADMIN: SEND LTC FROM THE SITE WALLET =================
   The wallet key lives only in the Railway variable LTC_WIF (WIF private key, starts with T or 6).
   The wallet address is the native SegWit (ltc1…) address of that key; send LTC to it to fund it.
   Optional LTC_MAX_SEND caps one send (in LTC). Keep only small amounts in this hot wallet. */
const LTC_NET = { messagePrefix: '\x19Litecoin Signed Message:\n', bech32: 'ltc', bip32: { public: 0x019da462, private: 0x019d9cfe }, pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 };
const LTC_API = 'https://litecoinspace.org/api';
let ltcLib = null, ltcWalletCache = null, ltcSending = false;
/* LTC_MNEMONIC: a 12/24 word secret phrase (Trust Wallet etc.). The first native SegWit address
   m/84'/2'/0'/0/0 is used, the same LTC address Trust Wallet shows. LTC_PATH can change the path. */
function ltcWallet() {
  const wif = String(process.env.LTC_WIF || '').trim();
  const words = String(process.env.LTC_MNEMONIC || '').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
  const path = String(process.env.LTC_PATH || "m/84'/2'/0'/0/0").trim();
  const id = wif || (words && words + '|' + path);
  if (!id) return null;
  if (ltcWalletCache && ltcWalletCache.wif === id) return ltcWalletCache;
  if (!ltcLib) {
    const bitcoin = require('bitcoinjs-lib');
    const ecc = require('@bitcoinerlab/secp256k1');
    bitcoin.initEccLib(ecc);
    ltcLib = { bitcoin, ecc, ECPair: require('ecpair').ECPairFactory(ecc) };
  }
  let key;
  if (wif) key = ltcLib.ECPair.fromWIF(wif, LTC_NET);
  else {
    const bip39 = require('bip39');
    if (!bip39.validateMnemonic(words)) throw new Error('bad mnemonic');
    const node = require('bip32').BIP32Factory(ltcLib.ecc).fromSeed(bip39.mnemonicToSeedSync(words)).derivePath(path);
    key = ltcLib.ECPair.fromPrivateKey(Buffer.from(node.privateKey), { network: LTC_NET });
  }
  const pay = ltcLib.bitcoin.payments.p2wpkh({ pubkey: Buffer.from(key.publicKey), network: LTC_NET });
  ltcWalletCache = { wif: id, key, address: pay.address, script: pay.output };
  return ltcWalletCache;
}
const ltcJson = async (path, opts = {}) => {
  const r = await fetch(LTC_API + path, { ...opts, signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`litecoinspace.org: ${text.slice(0, 200) || r.status}`);
  try { return JSON.parse(text); } catch { return text; }
};
const LITS = 1e8;
const ltcVsize = (ins, outs) => Math.ceil(10.5 + 68 * ins + 31 * outs);

app.get('/api/admin/ltc/wallet', auth, adminOnly, async (req, res) => {
  const sends = (S.ltcSends || []).slice(0, 30);
  let w;
  try { w = ltcWallet(); } catch (error) { return res.json({ configured: false, error: 'LTC_WIF / LTC_MNEMONIC is not valid (check the key or the words)', sends }); }
  if (!w) return res.json({ configured: false, sends });
  try {
    const d = await ltcJson(`/address/${w.address}`);
    const cs = d.chain_stats || {}, ms = d.mempool_stats || {};
    const balance = (cs.funded_txo_sum - cs.spent_txo_sum) / LITS;
    const pending = ((ms.funded_txo_sum || 0) - (ms.spent_txo_sum || 0)) / LITS;
    const price = (await coinPrices()).ltc || null;
    res.json({ configured: true, address: w.address, balance, pending, price, usd: price ? round2(balance * price) : null, maxSend: Number(process.env.LTC_MAX_SEND) || null, sends });
  } catch (error) {
    res.json({ configured: true, address: w.address, error: error.message, sends });
  }
});

app.post('/api/admin/ltc/send', auth, adminOnly, async (req, res) => {
  let w;
  try { w = ltcWallet(); } catch { return bad(res, 'LTC_WIF / LTC_MNEMONIC is not valid (check the key or the words)'); }
  if (!w) return bad(res, 'The LTC wallet is not set up (add LTC_MNEMONIC or LTC_WIF in Railway)');
  const to = String(req.body.to || '').trim();
  const sendAll = req.body.all === true;
  const amount = Number(req.body.amount);
  let toScript;
  try { toScript = ltcLib.bitcoin.address.toOutputScript(to, LTC_NET); } catch { return bad(res, 'That is not a valid Litecoin address'); }
  if (to === w.address) return bad(res, 'That is the site wallet itself');
  if (!sendAll && !(amount > 0)) return bad(res, 'Enter an amount');
  const max = Number(process.env.LTC_MAX_SEND) || 0;
  if (max && !sendAll && amount > max) return bad(res, `One send can be at most ${max} LTC`);
  if (ltcSending) return bad(res, 'Another send is in progress, try again in a few seconds');
  ltcSending = true;
  try {
    const utxos = (await ltcJson(`/address/${w.address}/utxo`)).filter(u => u.status && u.status.confirmed).sort((a, b) => b.value - a.value);
    if (!utxos.length) return bad(res, 'The wallet has no confirmed LTC');
    let feeRate = 10;
    try { feeRate = Math.max(10, Math.ceil(Number((await ltcJson('/v1/fees/recommended')).fastestFee) || 0)); } catch { /* keep 10 lits/vB */ }
    feeRate = Math.min(feeRate, 200);

    const want = sendAll ? 0 : Math.round(amount * LITS);
    let picked = [], total = 0, fee = 0, change = 0, value = 0;
    if (sendAll) {
      picked = utxos; total = utxos.reduce((a, u) => a + u.value, 0);
      fee = ltcVsize(picked.length, 1) * feeRate;
      value = total - fee;
    } else {
      for (const u of utxos) {
        picked.push(u); total += u.value;
        fee = ltcVsize(picked.length, 2) * feeRate;
        if (total >= want + fee) break;
      }
      if (total < want + fee) return bad(res, `Not enough LTC: the wallet has ${(total / LITS).toFixed(8)} LTC confirmed, this needs ${((want + fee) / LITS).toFixed(8)} LTC with the network fee`);
      value = want;
      change = total - want - fee;
      if (change < 5000) { fee += change; change = 0; }
    }
    if (max && value > max * LITS) return bad(res, `One send can be at most ${max} LTC`);
    if (value < 10000) return bad(res, 'The amount is too small to send');

    const psbt = new ltcLib.bitcoin.Psbt({ network: LTC_NET });
    for (const u of picked) psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script: w.script, value: u.value } });
    psbt.addOutput({ script: toScript, value });
    if (change) psbt.addOutput({ script: w.script, value: change });
    psbt.signAllInputs(w.key);
    psbt.finalizeAllInputs();
    const hex = psbt.extractTransaction().toHex();
    const txid = String(await ltcJson('/tx', { method: 'POST', body: hex, headers: { 'Content-Type': 'text/plain' } })).trim();

    const rec = { id: rid(5), txid, to, ltc: value / LITS, fee: fee / LITS, note: clip(req.body.note || '', 120), by: req.user.username, ts: now() };
    S.ltcSends = [rec, ...(S.ltcSends || [])].slice(0, 500);
    markDirty();
    notifyAdmins('ltc', `${req.user.username} sent ${rec.ltc} LTC to ${to}`);
    console.log(`[ltc] ${req.user.username} sent ${rec.ltc} LTC to ${to} tx ${txid}`);
    res.json({ ok: true, send: rec });
  } catch (error) {
    bad(res, `Send failed: ${error.message}`, 502);
  } finally {
    ltcSending = false;
  }
});

/* ================= ADMIN: SEND USDT (BEP20, BNB Smart Chain) =================
   Wallet: BSC_MNEMONIC (12 words; if missing LTC_MNEMONIC is used, so one Trust Wallet phrase covers both)
   or BSC_PRIVATE_KEY. Address = m/44'/60'/0'/0/0, the same BNB/USDT address Trust Wallet shows.
   The network fee is paid in BNB, so keep a little BNB in that address. USDT_MAX_SEND caps one send. */
const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955'; // the real Tether USD on BNB Smart Chain
const BSC_RPCS = () => [process.env.BSC_RPC, 'https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io'].filter(Boolean);
let bscCache = null, usdtSending = false;
function bscWallet() {
  const pk = String(process.env.BSC_PRIVATE_KEY || '').trim();
  const words = String(process.env.BSC_MNEMONIC || process.env.LTC_MNEMONIC || '').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
  const id = pk || words;
  if (!id) return null;
  if (bscCache && bscCache.id === id) return bscCache;
  const { ethers } = require('ethers');
  const signer = pk ? new ethers.Wallet(pk.startsWith('0x') ? pk : '0x' + pk) : ethers.HDNodeWallet.fromPhrase(words, undefined, "m/44'/60'/0'/0/0");
  bscCache = { id, ethers, signer, address: signer.address };
  return bscCache;
}
async function bscProvider() {
  const { ethers } = require('ethers');
  let last;
  for (const url of BSC_RPCS()) {
    try {
      const pr = new ethers.JsonRpcProvider(url, 56, { staticNetwork: true });
      await pr.getBlockNumber();
      return pr;
    } catch (error) { last = error; }
  }
  throw new Error('No BNB Chain RPC answered' + (last ? ` (${last.shortMessage || last.message})` : ''));
}
const USDT_ABI = ['function balanceOf(address) view returns (uint256)', 'function transfer(address to, uint256 amount) returns (bool)'];

app.get('/api/admin/usdt/wallet', auth, adminOnly, async (req, res) => {
  const sends = (S.usdtSends || []).slice(0, 30);
  let w;
  try { w = bscWallet(); } catch { return res.json({ configured: false, error: 'BSC_MNEMONIC / BSC_PRIVATE_KEY is not valid', sends }); }
  if (!w) return res.json({ configured: false, sends });
  try {
    const pr = await bscProvider();
    const token = new w.ethers.Contract(USDT_BSC, USDT_ABI, pr);
    const [raw, bnbRaw, feeData] = await Promise.all([token.balanceOf(w.address), pr.getBalance(w.address), pr.getFeeData()]);
    const gasPrice = feeData.gasPrice || 1000000000n;
    const feeBnb = Number(w.ethers.formatEther(gasPrice * 65000n));
    const bnb = Number(w.ethers.formatEther(bnbRaw));
    res.json({ configured: true, address: w.address, balance: Number(w.ethers.formatUnits(raw, 18)), bnb, feeBnb, sendsLeft: feeBnb > 0 ? Math.floor(bnb / feeBnb) : null, maxSend: Number(process.env.USDT_MAX_SEND) || null, sends });
  } catch (error) {
    res.json({ configured: true, address: w.address, error: error.shortMessage || error.message, sends });
  }
});

app.post('/api/admin/usdt/send', auth, adminOnly, async (req, res) => {
  let w;
  try { w = bscWallet(); } catch { return bad(res, 'BSC_MNEMONIC / BSC_PRIVATE_KEY is not valid'); }
  if (!w) return bad(res, 'The USDT wallet is not set up (add BSC_MNEMONIC in Railway)');
  const { ethers } = w;
  const to = String(req.body.to || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return bad(res, 'That is not a valid BEP20 (0x…) address');
  if (to.toLowerCase() === w.address.toLowerCase()) return bad(res, 'That is the site wallet itself');
  if (to.toLowerCase() === USDT_BSC.toLowerCase()) return bad(res, 'That is the USDT contract, not a wallet');
  const sendAll = req.body.all === true;
  const amount = Number(req.body.amount);
  if (!sendAll && !(amount > 0)) return bad(res, 'Enter an amount');
  const max = Number(process.env.USDT_MAX_SEND) || 0;
  if (usdtSending) return bad(res, 'Another send is in progress, try again in a few seconds');
  usdtSending = true;
  try {
    const pr = await bscProvider();
    const signer = w.signer.connect(pr);
    const token = new ethers.Contract(USDT_BSC, USDT_ABI, signer);
    const have = await token.balanceOf(w.address);
    const value = sendAll ? have : ethers.parseUnits(amount.toFixed(6), 18);
    if (value <= 0n) return bad(res, 'The wallet has no USDT');
    if (value > have) return bad(res, `Not enough USDT: the wallet has ${ethers.formatUnits(have, 18)} USDT`);
    if (max && value > ethers.parseUnits(String(max), 18)) return bad(res, `One send can be at most ${max} USDT`);
    const [gas, feeData, bnb] = await Promise.all([token.transfer.estimateGas(to, value), pr.getFeeData(), pr.getBalance(w.address)]);
    const gasPrice = feeData.gasPrice || 1000000000n;
    const gasLimit = gas * 12n / 10n;
    if (bnb < gasLimit * gasPrice) return bad(res, `Not enough BNB for the network fee: need about ${ethers.formatEther(gasLimit * gasPrice)} BNB, the wallet has ${ethers.formatEther(bnb)} BNB. Send a little BNB (BEP20) to ${w.address}`);
    const tx = await token.transfer(to, value, { gasLimit, gasPrice });
    const rec = { id: rid(5), txid: tx.hash, to, usdt: Number(ethers.formatUnits(value, 18)), note: clip(req.body.note || '', 120), by: req.user.username, ts: now() };
    S.usdtSends = [rec, ...(S.usdtSends || [])].slice(0, 500);
    markDirty();
    notifyAdmins('usdt', `${req.user.username} sent ${rec.usdt} USDT to ${to}`);
    console.log(`[usdt] ${req.user.username} sent ${rec.usdt} USDT to ${to} tx ${tx.hash}`);
    res.json({ ok: true, send: rec });
  } catch (error) {
    bad(res, `Send failed: ${error.shortMessage || error.message}`, 502);
  } finally {
    usdtSending = false;
  }
});

app.get('/api/admin/botlog', auth, adminOnly, (req, res) => {
  res.json({ on: autoDepositOn(), sessions: sessionsText(), log: botLog });
});

app.post('/api/deposit/init', auth, actionLimit, (req, res) => {
  if (!autoDepositOn()) return bad(res, 'Automatic deposits are not set up yet', 503);
  const user = req.user;
  if (pendingBotWithdraw(user.id)) return bad(res, 'Finish or cancel your withdrawal first: the bot gives you your pets in that trade');
  const key = sessionKey(user.username);
  const old = activeSessions.get(key);
  const live = old && old.expiresAt > now();
  const sess = { userId: user.id, robloxUsername: user.username, startedAt: live ? old.startedAt : now(), expiresAt: now() + DEPOSIT_SESSION_MS };
  activeSessions.set(key, sess);
  logBot(`deposit session ${live ? 'renewed' : 'opened'} for "${user.username}" (key "${key}", 10 min)`);
  res.json({ status: 'ready', robloxUsername: user.username, ...sessionView(sess) });
});

app.get('/api/deposit/status', auth, (req, res) => {
  const sess = activeSessions.get(sessionKey(req.user.username));
  const live = sess && sess.expiresAt > now() ? sess : null;
  const since = Number(req.query.since) || 0;
  res.json({
    hasPendingSession: Boolean(live), session: sessionView(live),
    received: req.user.inventory.filter(i => i.depositedAt && i.depositedAt >= since).map(publicItem)
  });
});

app.get('/api/bot/verify-player/:robloxUsername', gameBotOnly, (req, res) => {
  const asked = String(req.params.robloxUsername || '');
  const key = sessionKey(asked);
  /* a waiting withdrawal of this player comes first: the bot gives the pets */
  const w = pendingWithdrawByName(key);
  if (w) {
    const wu = S.users[w.userId];
    if (wu && !wu.banned) {
      w.botSeenAt = now();
      markDirty();
      logBot(`verify-player "${asked}" -> allowed=true mode=withdraw session ${w.id}: ${w.items.map(itemText).join(', ')}`);
      return res.json({ allowed: true, mode: 'withdraw', sessionId: w.id, items: w.items.map(botItem) });
    }
  }
  const sess = activeSessions.get(key);
  const user = sess && S.users[sess.userId];
  const reason = !sess ? 'no deposit session for this name (the player has to press Deposit on the site first)'
    : sess.expiresAt <= now() ? 'the deposit session expired'
    : !user ? 'the site account was not found'
    : user.banned ? 'the site account is banned' : '';
  logBot(`verify-player "${asked}" (key "${key}") -> allowed=${!reason}${reason ? ` (${reason})` : ' mode=deposit'} · open sessions: ${sessionsText()}`);
  res.json(reason ? { allowed: false } : { allowed: true, mode: 'deposit' });
});

app.post('/api/bot/confirm-deposit', gameBotOnly, (req, res) => {
  const tradeId = String(req.body.tradeId || '').trim();
  const name = String(req.body.robloxUsername || '').trim();
  const rows = Array.isArray(req.body.items) ? req.body.items : null;
  if (!/^[\w:.\-]{1,100}$/.test(tradeId)) return bad(res, 'tradeId is missing or invalid');
  if (tradeDone(tradeId)) return res.status(409).json({ success: false, error: 'This trade was already processed', tradeId });
  if (!name || !rows || rows.length > 100) return bad(res, 'robloxUsername and items (max 100) are required');

  const key = sessionKey(name);
  const sess = activeSessions.get(key);
  if (!sess || sess.expiresAt + DEPOSIT_GRACE_MS < now()) {
    logBot(`confirm-deposit "${name}" trade ${tradeId} -> 403 (no deposit session) · open sessions: ${sessionsText()}`);
    return res.status(403).json({ success: false, error: 'No active deposit session for this player' });
  }
  const user = S.users[sess.userId];
  if (!user) return res.status(404).json({ success: false, error: 'Player not found on the site' });

  /* catalog index: base name (trim + lower case + single spaces) + variant + shiny */
  const byKey = new Map(S.catalog.map(c => [ps99KeyOf(c), c]));
  const credited = [], unmatched = [];
  const at = now();
  let count = 0;
  for (const r of rows) {
    const p = rowPet(r);
    const amount = Math.max(1, Math.min(50, Math.floor(Number(r && (r.amount ?? r._am)) || 1)));
    const label = `${amount > 1 ? amount + 'x ' : ''}${p.label}`;
    if (!p.base || ['slot', 'partneroffer'].includes(p.base.toLowerCase().replace(/ /g, ''))) {
      unmatched.push({ name: p.base, label });
      logBot(`WARNING trade ${tradeId}: "${p.base || '(no name)'}" is not a pet name, nothing added`);
      continue;
    }
    const c = byKey.get(ps99Key(p.base, p.variant, p.shiny));
    if (!c) {
      unmatched.push({ name: p.base, variant: p.variant, shiny: p.shiny, label });
      logBot(`WARNING trade ${tradeId}: "${label}" is not in the catalog (name + variant + shiny), nothing added`);
      continue;
    }
    for (let n = 0; n < amount && count < 200; n++, count++) {
      user.inventory.push({ ...newItem(c), depositedAt: at, tradeId });
      credited.push({ name: c.name, value: c.value, label: c.name });
    }
  }

  rememberTrade(tradeId);
  sess.expiresAt = now() + DEPOSIT_SESSION_MS;     /* the session stays open for another trade */
  const total = round2(credited.reduce((t, c) => t + c.value, 0));
  if (credited.length) addTransaction(user, 'Deposit', tradeId, total);
  markDirty();
  emitMe(user);
  io.to('u:' + user.id).emit('deposit:done', { credited: credited.length, total });
  notifyAdmins('withdraw', `📥 Bot deposit by ${nick(user)} (${user.username}): ${credited.map(c => c.label).join(', ') || 'no catalog pets'} · ${fmtV(total)}` +
    (unmatched.length ? ` · NOT IN CATALOG: ${unmatched.map(u => u.label).join(', ')}` : ''));
  logBot(`confirm-deposit "${name}" trade ${tradeId} -> ${credited.length} pet(s) added${unmatched.length ? `, not in catalog: ${unmatched.map(u => u.label).join(', ')}` : ''}`);
  res.json({ success: true, credited: credited.length, total, unmatched });
});

/* ================= PS99 AUTOMATIC WITHDRAW (in-game bot) =================
   1. The player picks pets and presses Withdraw: POST /api/withdraw/request takes them out of the inventory into a
      saved withdraw record (S.botWithdrawals, kept in MongoDB) = the withdraw session (its id is the sessionId).
   2. verify-player answers { allowed: true, mode: "withdraw", sessionId, items: [{ name, pt, sh, variant, shiny, fullName, amount }] }
      (name = the PS99 id like "Huge Cat", pt 0 normal / 1 golden / 2 rainbow, sh = shiny).
   3. When the pets are handed over the bot calls POST /api/bot/confirm-withdraw { sessionId, robloxUsername, items }:
      the record is completed; pets the bot did not hand over go back to the player.
   4. Cancel (POST /api/withdraw/cancel) or 15 minutes without a trade: the pets go back to the inventory.
      Cancel is refused for 3 minutes after the bot started trading with the player (the pets may already be given). */
const WD_SESSION_MS = 15 * 60 * 1000;
const WD_BOT_LOCK_MS = 3 * 60 * 1000;
const WD_MAX_ITEMS = 18;
const itemText = i => i.name;
const pendingBotWithdraw = userId => (S.botWithdrawals || []).find(w => w.userId === userId && w.status === 'pending') || null;
const pendingWithdrawByName = key => (S.botWithdrawals || []).find(w => w.status === 'pending' && sessionKey(w.robloxUsername) === key && w.expiresAt > now()) || null;

function wdView(w) {
  if (!w) return null;
  return {
    id: w.id, status: w.status, ts: w.ts, expiresAt: w.expiresAt, items: w.items.map(publicItem), value: valueOf(w.items),
    returned: (w.returned || []).length,
    canCancel: w.status === 'pending' && !(w.botSeenAt && now() - w.botSeenAt < WD_BOT_LOCK_MS)
  };
}

function refundBotWithdraw(w, status) {
  if (!w || w.status !== 'pending') return false;
  w.status = status;
  w.doneAt = now();
  const user = S.users[w.userId];
  if (user) {
    user.inventory.push(...w.items);
    addTransaction(user, 'Withdraw Refund', w.id, valueOf(w.items));
    emitMe(user);
    io.to('u:' + user.id).emit('withdraw:update', wdView(w));
  }
  markDirty();
  return true;
}

setInterval(() => {
  const t = now();
  for (const w of S.botWithdrawals || []) {
    if (w.status !== 'pending' || w.expiresAt > t) continue;
    if (w.botSeenAt && t - w.botSeenAt < WD_BOT_LOCK_MS) continue; /* the bot is in the middle of the trade */
    refundBotWithdraw(w, 'expired');
    logBot(`withdraw ${w.id} of "${w.robloxUsername}": no trade in 15 minutes, ${w.items.length} pet(s) returned`);
  }
}, 30 * 1000);

app.post('/api/withdraw/request', auth, actionLimit, (req, res) => {
  if (!autoDepositOn()) return bad(res, 'Automatic withdrawals are not set up yet', 503);
  const user = req.user;
  if (pendingBotWithdraw(user.id)) return bad(res, 'You already have a withdrawal waiting. Trade the bot or cancel it first.');
  const uids = selectionToUids(req.body);
  if (!pickItems(user, uids, WD_MAX_ITEMS)) return bad(res, `Select 1-${WD_MAX_ITEMS} pets from your inventory`);
  const items = takeItems(user, uids, WD_MAX_ITEMS);
  const w = { id: 'wd-' + rid(10), userId: user.id, nickname: nick(user), robloxUsername: user.username, items, status: 'pending', ts: now(), expiresAt: now() + WD_SESSION_MS };
  S.botWithdrawals = [w, ...(S.botWithdrawals || [])].slice(0, 2000);
  /* a waiting deposit session of the same player is closed: the next trade is the withdrawal */
  activeSessions.delete(sessionKey(user.username));
  addTransaction(user, 'Withdraw Request', w.id, -valueOf(items));
  markDirty();
  emitMe(user);
  notifyAdmins('withdraw', `📤 Bot withdraw by ${nick(user)} (${user.username}): ${items.map(itemText).join(', ')} · ${fmtV(valueOf(items))}`);
  logBot(`withdraw session ${w.id} opened for "${user.username}": ${items.map(itemText).join(', ')}`);
  res.json({ ok: true, withdraw: wdView(w) });
});

app.get('/api/withdraw/status', auth, (req, res) => {
  const list = S.botWithdrawals || [];
  const w = pendingBotWithdraw(req.user.id) || list.find(x => x.userId === req.user.id && x.id === String(req.query.id || '')) || null;
  res.json({ withdraw: wdView(w) });
});

app.post('/api/withdraw/cancel', auth, actionLimit, (req, res) => {
  const w = pendingBotWithdraw(req.user.id);
  if (!w) return bad(res, 'You have no withdrawal waiting');
  if (w.botSeenAt && now() - w.botSeenAt < WD_BOT_LOCK_MS) return bad(res, 'The bot is trading with you right now. Wait a few minutes before cancelling.');
  refundBotWithdraw(w, 'cancelled');
  logBot(`withdraw ${w.id} cancelled by the player, pets returned`);
  res.json({ ok: true, withdraw: wdView(w) });
});

app.post('/api/bot/confirm-withdraw', gameBotOnly, (req, res) => {
  const sessionId = String(req.body.sessionId || '').trim();
  const name = String(req.body.robloxUsername || '').trim();
  const rows = Array.isArray(req.body.items) ? req.body.items : null;
  const w = (S.botWithdrawals || []).find(x => x.id === sessionId);
  if (!w) { logBot(`confirm-withdraw ${sessionId || '(no sessionId)'} -> 404 (unknown session)`); return res.status(404).json({ success: false, error: 'Unknown withdraw session' }); }
  if (w.status !== 'pending') { logBot(`confirm-withdraw ${sessionId} -> 409 (already ${w.status})`); return res.status(409).json({ success: false, error: `This withdrawal is already ${w.status}` }); }
  if (sessionKey(name) !== sessionKey(w.robloxUsername)) {
    logBot(`confirm-withdraw ${sessionId} -> 403 (robloxUsername "${name}" is not "${w.robloxUsername}")`);
    return res.status(403).json({ success: false, error: 'robloxUsername does not match this withdraw session' });
  }

  /* which pets were handed over: the list the bot sends (no list = everything) */
  let delivered = w.items, back = [];
  if (rows && rows.length) {
    const given = new Map();
    for (const r of rows) {
      const p = rowPet(r);
      const k = ps99Key(p.base, p.variant, p.shiny);
      given.set(k, (given.get(k) || 0) + Math.max(1, Math.min(50, Math.floor(Number(r && (r.amount ?? r._am)) || 1))));
    }
    delivered = []; back = [];
    for (const item of w.items) {
      const k = ps99KeyOf(item);
      if ((given.get(k) || 0) > 0) { given.set(k, given.get(k) - 1); delivered.push(item); } else back.push(item);
    }
  }
  w.status = 'completed';
  w.doneAt = now();
  w.items = delivered;
  w.returned = back;
  const user = S.users[w.userId];
  if (user) {
    if (back.length) { user.inventory.push(...back); addTransaction(user, 'Withdraw Refund', w.id, valueOf(back)); }
    emitMe(user);
    io.to('u:' + user.id).emit('withdraw:update', wdView(w));
    if (delivered.length) systemChat(`${nick(user)} successfully withdrew ${delivered.length} pet${delivered.length === 1 ? '' : 's'} worth ${fmtV(valueOf(delivered))}! 🎉`, { withdraw: true });
  }
  if (back.length) notifyAdmins('security', `Bot withdraw ${w.id} of ${w.robloxUsername}: ${back.length} pet(s) not handed over were returned: ${back.map(itemText).join(', ')}`);
  markDirty();
  logBot(`confirm-withdraw ${sessionId} "${name}" -> completed, ${delivered.length} given${back.length ? `, ${back.length} returned` : ''}`);
  res.json({ success: true, delivered: delivered.length, returned: back.length });
});

/* ================= START ================= */

(async () => {
  await initDb();
  ensureDefaultBot();
  scaleAllValues();
  loadPs99Catalog();
  resumeJackpot();
  auditItems();
  resumeMatches();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Pet Duel running on port ${PORT}`);
    console.log(mongoColl ? 'Storage: MongoDB' : 'Storage: MEMORY ONLY (resets on restart)');
    loadBots();
  });
})();

setInterval(loadBots, 10 * 60 * 1000);
