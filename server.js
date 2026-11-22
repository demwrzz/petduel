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
  settings: { taxPercent: 0, taxReceiver: 'auto', taxIdx: 0, elveUrl: '' },
  updateNotes: [],
  jpHistory: [],
  processedTrades: [],
  /* MM2 withdrawals handled by the in-game bot (the items wait here until the trade) */
  botWithdrawals: [],
  /* deposit bots, managed in the admin panel: { id, username, link, online } */
  bots: []
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
/* two games share the site: Adopt Me (default) and Murder Mystery 2. Items, bots, games, giveaways, jackpots and stats each belong to one. */
const GAMES = ['adoptme', 'mm2'];
const GAME_NAMES = { adoptme: 'Adopt Me', mm2: 'MM2' };
const cleanGame = v => (v === 'mm2' ? 'mm2' : 'adoptme');
/* Adopt Me can be switched off in the admin panel: nothing new can be played, deposited or withdrawn with it */
const adoptMeOff = () => S.settings.adoptMeOff === true;
/* MM2 switched off: it disappears from the site; MM2 items stay saved in the inventories (nothing is deleted) */
const mm2Off = () => S.settings.mm2Off === true;
const gameOff = g => (cleanGame(g) === 'mm2' ? mm2Off() : adoptMeOff());
const offMsg = g => `${GAME_NAMES[cleanGame(g)]} is currently disabled`;
const AM_OFF_MSG = 'Adopt Me is currently disabled';
const gameOf = x => cleanGame(x && x.game);
/* the one game of a list of items, or null when it mixes games */
const gameOfItems = items => { const g = gameOf(items[0]); return items.every(i => gameOf(i) === g) ? g : null; };
const emptyStats = () => ({ bet: 0, won: 0, lost: 0, profit: 0 });
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

const itemLine = items => clip(
  items.map(i =>
    `${i.name}${i.age && i.age !== 'normal' ? ' (' + i.age + ')' : ''}${i.fly ? ' F' : ''}${i.ride ? ' R' : ''} - ${i.value}`
  ).join('\n') || '-'
);

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
/* all values on the site are x1000 (a 117 pet is now 117,000); rank limits follow the same scale */
const VALUE_SCALE = 1000;
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
  for (const sj of Object.values(savedJackpots)) (sj && sj.entries || []).forEach(e => { items(e.items); e.value = x(e.value); });

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
function bump(user, d, game) {
  if (d.bet)    user.totalBet  = round2(user.totalBet + d.bet);
  if (d.won)    user.totalWon  = round2(user.totalWon + d.won);
  if (d.lost)   user.totalLost = round2((user.totalLost || 0) + d.lost);
  if (d.profit) user.profit    = round2(user.profit + d.profit);
  /* the same numbers per game (Adopt Me / MM2) */
  const g = user.gstats[cleanGame(game)];
  for (const k of ['bet', 'won', 'lost', 'profit']) if (d[k]) g[k] = round2(g[k] + d[k]);
}

function addTransaction(user, type, id, amount, game) {
  user.tx.unshift({ type, id, ts: now(), amount: round2(amount), ...(game === 'mm2' ? { g: 'mm2' } : {}) });
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
    gstats: user.gstats,
    rank: rankOf(user.totalBet),
    mutedUntil: user.mutedUntil || 0,
    inventory: user.inventory.map(inventoryView)
  };
}

function newItem(c) {
  return {
    uid: rid(12), catalogId: c.id, name: c.name, image: c.image,
    value: c.value, age: c.age, fly: c.fly, ride: c.ride, ...(c.game === 'mm2' ? { game: 'mm2' } : {})
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

  /* a very old second game (ctd) is gone: its items disappear and only its Adopt Me stats stay */
  u.inventory = u.inventory.filter(i => i.game !== 'ctd');
  for (const i of u.inventory) if (i.game !== 'mm2') delete i.game;
  if (u.gstats && u.gstats.ctd) {
    const a = u.gstats.adoptme || {};
    u.totalBet = a.bet || 0; u.totalWon = a.won || 0; u.totalLost = a.lost || 0; u.profit = a.profit || 0;
    delete u.gstats;
  }
  /* stats per game; everything played before MM2 existed was Adopt Me */
  if (!u.gstats) u.gstats = { adoptme: { bet: u.totalBet, won: u.totalWon, lost: u.totalLost, profit: u.profit }, mm2: emptyStats() };
  for (const g of GAMES) u.gstats[g] = { ...emptyStats(), ...(u.gstats[g] || {}) };

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
    jackpots: Object.fromEntries(GAMES.map(g => [g, JPS[g] && JPS[g].state !== 'finished' ? { ...JPS[g], winner: null } : null])),
    jpHistory: S.jpHistory.slice(0, 100),
    chat: S.chat.slice(-60),
    bots: S.bots.map(b => ({ id: b.id, username: b.username, link: b.link, online: b.online !== false, role: botRole(b), ...(b.game === 'mm2' ? { game: 'mm2' } : {}) })),
    eventEscrow: S.eventEscrow || null,
    processedTrades: (S.processedTrades || []).slice(0, 5000),
    botWithdrawals: S.botWithdrawals.slice(0, 2000)
  };
}

/* Adopt Me and MM2 together again.
   Case 1: the data is still "MM2 only" (Adopt Me deleted, flag adoptMeRemoved). The backup saved right before the
     deletion (document backup-before-mm2-only) brings Adopt Me back, and everything MM2 from now is merged in:
     MM2 catalog items, MM2 bots, MM2 items in inventories, MM2 stats, MM2 games / giveaways / withdrawals.
     Newer players and all login sessions are kept.
   Case 2: Adopt Me was already restored without MM2 (flag adoptMeRestored missing mm2Back): the MM2 catalog and
     MM2 bots are taken from the backup again.
   Both run once. */
async function restoreBothGames(d) {
  if (!d || !mongoColl) return d;
  const isMM = x => x && x.game === 'mm2';
  const byId = (list, key = 'id') => new Set((list || []).map(x => x && x[key]));
  const backupDoc = (d.settings && (d.settings.adoptMeRemoved || !d.settings.mm2Back))
    ? await mongoColl.findOne({ _id: 'backup-before-mm2-only' }) : null;
  const b = backupDoc && backupDoc.data;

  if (d.settings && d.settings.adoptMeRemoved) {
    if (!b) { console.error('[RESTORE] Adopt Me was removed but no backup was found'); return d; }
    const users = Object.assign({}, b.users || {});
    let added = 0;
    for (const [id, cur] of Object.entries(d.users || {})) {
      if (!users[id]) { users[id] = { ...cur }; added++; continue; }
      const u = users[id];
      /* MM2 items the player has now (Adopt Me items come from the backup) */
      const have = byId(u.inventory, 'uid');
      u.inventory = [...(u.inventory || []), ...(cur.inventory || []).filter(i => isMM(i) && !have.has(i.uid))];
      /* stats: Adopt Me from the backup, MM2 as they are now */
      const am = (u.gstats && u.gstats.adoptme) || { bet: u.totalBet || 0, won: u.totalWon || 0, lost: u.totalLost || 0, profit: u.profit || 0 };
      const mm = (cur.gstats && cur.gstats.mm2) || (u.gstats && u.gstats.mm2) || { bet: 0, won: 0, lost: 0, profit: 0 };
      u.gstats = { adoptme: am, mm2: mm };
      u.totalBet = (am.bet || 0) + (mm.bet || 0); u.totalWon = (am.won || 0) + (mm.won || 0);
      u.totalLost = (am.lost || 0) + (mm.lost || 0); u.profit = (am.profit || 0) + (mm.profit || 0);
      const seenTx = new Set((u.tx || []).map(t => `${t.id}|${t.type}|${t.ts}`));
      u.tx = [...(cur.tx || []).filter(t => t.g === 'mm2' && !seenTx.has(`${t.id}|${t.type}|${t.ts}`)), ...(u.tx || [])]
        .sort((x, y) => (y.ts || 0) - (x.ts || 0)).slice(0, 300);
      for (const k of ['nickname', 'nickChangedAt', 'discordId', 'discordTag', 'support', 'banned', 'mutedUntil', 'avatar', 'lastSeen']) if (cur[k] !== undefined) u[k] = cur[k];
    }
    const merge = (old, now, key = 'id') => { const ids = byId(old, key); return [...(old || []), ...(now || []).filter(x => isMM(x) && !ids.has(x[key]))]; };
    const out = {
      ...b,
      users,
      sessions: { ...(b.sessions || {}), ...(d.sessions || {}) },
      catalog: merge(b.catalog, d.catalog),
      bots: merge(b.bots, d.bots),
      withdrawals: merge(b.withdrawals, d.withdrawals),
      history: merge(b.history, d.history),
      jpHistory: merge(b.jpHistory, d.jpHistory),
      matches: { ...(b.matches || {}), ...Object.fromEntries(Object.entries(d.matches || {}).filter(([, m]) => isMM(m))) },
      giveaways: { ...(b.giveaways || {}), ...Object.fromEntries(Object.entries(d.giveaways || {}).filter(([, g]) => isMM(g))) },
      jackpots: { adoptme: (b.jackpots && b.jackpots.adoptme) || b.jackpot || null, mm2: (d.jackpots && d.jackpots.mm2) || (b.jackpots && b.jackpots.mm2) || null },
      chat: d.chat || b.chat,
      settings: { ...(b.settings || {}), mm2Back: true }
    };
    delete out.jackpot;
    delete out.settings.adoptMeRemoved;
    dirty = true;
    console.log(`[RESTORE] Adopt Me + MM2: ${Object.keys(users).length} players (${added} newer kept), ${out.catalog.length} catalog items (${out.catalog.filter(isMM).length} MM2)`);
    return out;
  }

  if (d.settings && !d.settings.mm2Back) {
    d.settings.mm2Back = true;
    dirty = true;
    if (b) {
      const cat = byId(d.catalog), bots = byId(d.bots);
      const addCat = (b.catalog || []).filter(c => isMM(c) && !cat.has(c.id));
      const addBots = (b.bots || []).filter(x => isMM(x) && !bots.has(x.id));
      d.catalog = [...(d.catalog || []), ...addCat];
      d.bots = [...(d.bots || []), ...addBots];
      console.log(`[RESTORE] MM2 back: ${addCat.length} MM2 catalog items and ${addBots.length} MM2 bots taken from the backup`);
    }
  }
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
      const d = await restoreBothGames(doc.data);
      S.users = Object.assign(Object.create(null), d.users || {});
      Object.values(S.users).forEach(ensureUser);
      S.sessions = Object.assign(Object.create(null), d.sessions || {});
      S.catalog = d.catalog || [];
      S.catalog = S.catalog.filter(c => c.game !== 'ctd');
      S.catalog.forEach(c => { if (c.game !== 'mm2') delete c.game; });
      S.history = d.history || [];
      S.withdrawals = d.withdrawals || [];
      S.announcement = d.announcement || null;
      S.notifications = d.notifications || [];
      S.bounties = d.bounties || [];
      S.settings = { taxPercent: 0, taxReceiver: 'auto', taxIdx: 0, elveUrl: '', ...(d.settings || {}) };
      S.bots = Array.isArray(d.bots) ? d.bots : [];
      botsFromDb = Array.isArray(d.bots);
      S.updateNotes = d.updateNotes || [];
      S.giveaways = Object.assign(Object.create(null), d.giveaways || {});
      S.matches = Object.assign(Object.create(null), d.matches || {});
      S.chat = Array.isArray(d.chat) ? d.chat.slice(-60) : [];
      savedJackpots = d.jackpots || { adoptme: d.jackpot || null };
      S.jpHistory = Array.isArray(d.jpHistory) ? d.jpHistory : [];
      S.processedTrades = Array.isArray(d.processedTrades) ? d.processedTrades : [];
      S.botWithdrawals = Array.isArray(d.botWithdrawals) ? d.botWithdrawals : [];
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
/* the bots that send withdrawals of a game; while that game has no withdraw bot, its deposit bots do it */
function withdrawBotPool(game) {
  const mine = S.bots.filter(b => gameOf(b) === game);
  const w = mine.filter(b => botRole(b) === 'withdraw');
  return w.length ? w : mine.filter(b => botRole(b) === 'deposit');
}
let wdBotTurn = 0;
function pickWithdrawBot(game) {
  const online = withdrawBotPool(game).filter(b => b.online !== false);
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

/* players only see the start and the last letter of a bot's name (ltcspace -> ltcs***e) */
const maskName = n => (n.length <= 5 ? n.slice(0, 2) + '***' + n.slice(-1) : n.slice(0, 4) + '***' + n.slice(-1));
const publicBots = (full = false) => S.bots.map(b => {
  const p = botProfiles.get(b.username.toLowerCase()) || {};
  const name = p.username || b.username;
  return {
    id: b.id, username: full ? name : maskName(name), ...(full ? { robloxId: p.robloxId || null } : {}),
    avatar: p.avatar || null, link: b.link, joinLink: b.link, online: b.online !== false, role: botRole(b), game: gameOf(b)
  };
});

/* kept for older clients: the first bot */
const firstBot = () => publicBots().find(b => b.role === 'deposit' && b.game === 'adoptme') || null;

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

app.use(async (req, res, next) => {
  if (req.query.staff && req.query.staff === staffKey()) {
    res.setHeader('Set-Cookie', staffCookieHeader());
    return res.redirect('/');
  }
  if (!blockList().length || req.path === '/health' || req.path === '/api/whereami') return next();
  if (hasStaffCookie(req.headers.cookie) || reqHasBotKey(req) || (req.headers['x-bot-secret'] && gameBotSecretOk(req))) return next();
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

const socketIp = socket => {
  const xff = String(socket.handshake.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : socket.handshake.address;
};

io.use(async (socket, next) => {
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
  if (!maintenanceOn() || reqHasBotKey(req) || (req.headers['x-bot-secret'] && gameBotSecretOk(req))) return next();
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
    game: gameOf(match),
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
    id: g.id, host: g.host, game: gameOf(g), items: g.items.map(publicItem), value: g.value,
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
    jackpot: publicJackpot(JPS.adoptme),
    jackpots: Object.fromEntries(GAMES.map(g => [g, publicJackpot(JPS[g])])),
    discord: DISCORD_INVITE,
    config: {
      range: RANGE, maxItems: MAX_ITEMS, ranks: RANKS,
      tax: Number(S.settings.taxPercent) || 0,
      captcha: { mode: TURNSTILE_SECRET && TURNSTILE_SITE_KEY ? 'turnstile' : 'builtin', siteKey: TURNSTILE_SITE_KEY },
      robloxLogin: oauthOn(),
      autoBot: autoDepositOn() ? DEPOSIT_BOT_NAME : '',
      autoBotLink: autoDepositOn() ? autoBotLink() : '',
      autoBotOnline: autoDepositOn() && autoBotOnline(),
      adoptMeOff: adoptMeOff(),
      mm2Off: mm2Off()
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
    rank: rankOf(u.totalBet), totalBet: round2(u.totalBet), totalWon: round2(u.totalWon), totalLost: round2(u.totalLost || 0), profit: round2(u.profit), gstats: u.gstats,
    items: u.inventory.length, inventoryValue: round2(valueOf(u.inventory)),
    topPets: [...u.inventory].sort((a, b) => b.value - a.value).slice(0, 5).map(i => ({ name: i.name, age: i.age, fly: i.fly, ride: i.ride, value: i.value })),
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
    jackpot: JPS.adoptme ? { state: JPS.adoptme.state, total: JPS.adoptme.total, players: JPS.adoptme.entries.length } : null,
    jackpots: Object.fromEntries(GAMES.map(g => [g, JPS[g] ? { state: JPS[g].state, total: JPS[g].total, players: JPS[g].entries.length } : null])),
    giveaways: Object.keys(S.giveaways).length, pendingWithdrawals: S.withdrawals.filter(w => w.status === 'pending').length,
    maintenance: maintenanceOn(), bots: publicBots(true).map(b => ({ id: b.id, username: b.username, online: b.online, role: b.role, game: b.game })),
    ranks: RANKS.map(r => ({ name: r.name, min: r.min, color: r.color })),
    event: EVENT ? { type: EVENT.type, status: EVENT.status } : null
  });
});

app.get('/api/bot/games', botOnly, (req, res) => {
  res.json({ list: Object.values(S.matches).filter(m => m.state === 'waiting').sort((a, b) => b.hostValue - a.hostValue).slice(0, 10)
    .map(m => ({ id: m.id, game: gameOf(m), gameName: GAME_NAMES[gameOf(m)], host: nick(m.host), value: m.hostValue, pets: m.hostItems.length, maxJoin: m.maxJoin || 0 })) });
});

app.get('/api/bot/withdrawals', botOnly, (req, res) => {
  res.json({ list: S.withdrawals.filter(w => w.status === 'pending').slice(0, 25).map(w => {
    const u = S.users[w.user.id];
    return { id: w.id, game: gameOf(w), gameName: GAME_NAMES[gameOf(w)], bot: w.bot ? w.bot.username : '', nickname: nick(u || w.user), robloxName: u ? u.username : w.user.username, value: w.value, ts: w.ts,
      items: w.items.map(i => `${i.age === 'mega' ? 'Mega ' : i.age === 'neon' ? 'Neon ' : ''}${i.name}${i.fly ? ' F' : ''}${i.ride ? ' R' : ''}`) };
  }) });
});

app.get('/api/bot/catalog', botOnly, (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  res.json({ list: S.catalog.filter(c => !q || c.name.toLowerCase().includes(q)).sort((a, b) => b.value - a.value).slice(0, 25)
    .map(c => ({ id: c.id, game: gameOf(c), label: `${c.game === 'mm2' ? '[MM2] ' : ''}${c.age === 'mega' ? 'Mega ' : c.age === 'neon' ? 'Neon ' : ''}${c.name}${c.fly ? ' F' : ''}${c.ride ? ' R' : ''} (${c.value})` })) });
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
    gstats: user.gstats,
    rows: user.tx.slice((page - 1) * perPage, page * perPage),
    page, pages,
    /* every game result with its time, oldest first, for the profit graph (1D / 3D / 7D / 30D / All) */
    games: user.tx.filter(t => GAME_TX.test(t.type)).map(t => ({ ts: t.ts, a: t.amount, g: t.g === 'mm2' ? 'mm2' : 'adoptme' })).reverse()
  });
});

/* profit after each of the player's last 60 games (coinflip + jackpot), oldest first, for the graph */
const GAME_TX = /^(Coinflip|Jackpot) (Win|Loss|Tax)$/;
function profitSeries(user, game) {
  const games = (user.tx || []).filter(t => GAME_TX.test(t.type) && (!game || (t.g === 'mm2' ? 'mm2' : 'adoptme') === game)).slice(0, 60).reverse();
  const recent = games.reduce((t, g) => t + Number(g.amount || 0), 0);
  let run = round2(Number(game ? user.gstats[game].profit : user.profit || 0) - recent);
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
      series: profitSeries(user),
      gstats: user.gstats,
      gseries: Object.fromEntries(GAMES.map(g => [g, profitSeries(user, g)]))
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

  const game = gameOf(match);
  bump(host, { bet: match.hostValue }, game);
  bump(opponent, { bet: match.oppValue }, game);
  bump(winner, { won: round2(loserStake - tax.value), profit: round2(loserStake - tax.value) }, game);
  bump(loser, { lost: loserStake, profit: -loserStake }, game);

  addTransaction(winner, 'Coinflip Win', match.id, round2(loserStake - tax.value), game);

  if (tax.receiver && tax.items.length) {
    addTransaction(winner, 'Coinflip Tax', match.id, -tax.value, game);
    addTransaction(tax.receiver, 'Tax Received', match.id, tax.value, game);
    notifyAdmins('tax', `💰 Tax (${GAME_NAMES[game]}): ${tax.items.length} item(s) worth ${tax.value} from a coinflip went to ${tax.receiver.username}`);
    emitMe(tax.receiver);
  }
  addTransaction(loser, 'Coinflip Loss', match.id, -loserStake, game);

  S.history.unshift(publicMatch(match));
  if (S.history.length > 500) S.history.length = 500;

  claimBounty(winner, loser, match);

  sendWebhook(WEBHOOK_CF, {
    title: '🪙 Coinflip finished',
    color: 0x00efa0,
    fields: [
      { name: 'Game', value: GAME_NAMES[game], inline: true },
      { name: 'Winner', value: clip(nick(winner), 100), inline: true },
      { name: 'Loser', value: clip(nick(loser), 100), inline: true },
      { name: 'Pot', value: String(round2(match.hostValue + match.oppValue)), inline: true },
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
  const game = gameOfItems(selected);
  if (gameOff(game)) return bad(res, offMsg(game));
  if (!game) return bad(res, 'Use items of one game only (Adopt Me or MM2)');

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
    winnerSide: null, winnerId: null, maxJoin, game
  };

  S.matches[id] = match;
  io.emit('match:new', publicMatch(match));

  sendWebhook(WEBHOOK_CF, {
    title: '🪙 New coinflip',
    color: 0x4da3ff,
    fields: [
      { name: 'Game', value: GAME_NAMES[game], inline: true },
      { name: 'Host', value: clip(nick(user), 100), inline: true },
      { name: 'Value', value: String(match.hostValue), inline: true },
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
  if (gameOff(gameOf(match))) return bad(res, offMsg(gameOf(match)));

  const joinLimit = match.maxJoin || MAX_ITEMS;
  if (Array.isArray(uids) && uids.length > joinLimit) return bad(res, `This game allows at most ${joinLimit} pet${joinLimit === 1 ? '' : 's'}`);

  const selected = pickItems(user, uids, joinLimit);
  if (!selected) return bad(res, 'Invalid item selection');
  if (!selected.every(i => gameOf(i) === gameOf(match))) return bad(res, `This is a ${GAME_NAMES[gameOf(match)]} game: join with ${GAME_NAMES[gameOf(match)]} items only`);

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
const RISK_TEXT = 'PetDuel is not responsible for any item losses due to rollbacks, bans, or trade restrictions applied by Adopt Me moderators or Roblox. Deposit and play at your own risk.';
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
      addTransaction(winner, 'Giveaway Win', g.id, g.value, gameOf(g));

      sendWebhook(WEBHOOK_GW, {
        title: '🎉 Giveaway ended',
        color: 0xffb52e,
        fields: [
          { name: 'Game', value: GAME_NAMES[gameOf(g)], inline: true },
          { name: 'Host', value: clip(nick(g.host), 100), inline: true },
          { name: 'Winner', value: clip(nick(winner), 100), inline: true },
          { name: 'Entrants', value: String(eligible.length), inline: true },
          { name: 'Value', value: String(g.value), inline: true },
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
  const game = gameOfItems(picked);
  if (!game) return bad(res, 'A giveaway can only have items of one game');
  if (gameOff(game)) return bad(res, offMsg(game));

  const items = takeItems(user, uids, 5);

  const g = {
    id: rid(8), host: publicUser(user), game, items, value: valueOf(items),
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
      { name: 'Game', value: GAME_NAMES[game], inline: true },
      { name: 'Host', value: clip(nick(user), 100), inline: true },
      { name: 'Value', value: String(g.value), inline: true },
      { name: 'Mode', value: mode, inline: true },
      { name: 'Ends', value: `<t:${Math.floor(g.endsAt / 1000)}:R>`, inline: true },
      { name: 'Min total bet', value: String(g.minBet), inline: true },
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
  /* requirements count only the bets of this giveaway's game: MM2 bets do not unlock Adopt Me giveaways and the other way round */
  const game = gameOf(g);
  const wagered = user.gstats[game].bet;

  if (wagered < g.minBet) return bad(res, `You need ${g.minBet} total ${GAME_NAMES[game]} bet to enter`);

  if (g.minRank && rankIndex(g.minRank) >= 0 && rankIndex(rankOf(wagered)) < rankIndex(g.minRank)) {
    return bad(res, `You need the ${g.minRank} rank (or higher) in ${GAME_NAMES[game]} to enter`);
  }

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
  { version: '4.6', title: 'Support: mute only', changes: [
    'Support members can only mute (up to 24 h); withdrawals are handled by admins only (site and Discord)',
    'Every Support mute / unmute shows up in the admin notification bell with who, whom, how long and the reason',
    'Optional "Delete messages" box when muting: off keeps the player\'s chat messages, on removes them',
    'Pet values: exact pet names only, amvgg fields read directly, import corrects the values of pets already in the catalog',
    'Events: pick the prize from your own inventory (it comes back to you if nobody wins, the event is cancelled or the server restarts) or from the catalog',
    'A Christmas dog walks to the end of the typing text at the top of the site',
    'Separate withdraw bots: the admin panel has Deposit bots and Withdraw bots; each withdraw request gets an online withdraw bot that players see in their wallet'
  ] },
  { version: '5.0', title: 'MM2 game mode', changes: [
    'Murder Mystery 2 next to Adopt Me: a switch at the top picks the game; coinflips, the jackpot, the inventory, deposits and withdrawals follow it',
    'Admin: Adopt Me catalog and MM2 catalog (Add MM2 Item, game filter in the catalog browser); every deposit / withdraw bot belongs to one game',
    'One jackpot per game with its own history; coinflips can only be joined with items of the same game',
    'Stats and profit are kept per game (profile and player card have Adopt Me / MM2 tabs); the total still decides the rank',
    'Giveaways belong to one game and only that game\'s bets count for their requirements (MM2 bets do not unlock Adopt Me giveaways)',
    'Withdraw requests are per game: the admin list, the bell and the Discord bot show the game and the bot',
    'Adopt Me is back on; MM2 is switched off and removed from the site (MM2 items stay saved). Admins can switch each game on or off',
    'MM2 bot: one deposit session lasts an hour and stays open after a trade (trade again in the same server); no codes shown; the bot is set offline automatically when it stops sending its heartbeat; catalog items can be edited (✏️)',
    'MM2 automatic deposits: Deposit > MM2 opens a 15 minute session, the in-game bot (iemre547) accepts the trade and the items appear in the inventory by themselves',
    'Adopt Me and MM2 are both back after the short MM2-only time: Adopt Me pets, catalog, bots and stats come from the backup, MM2 items and the MM2 catalog are kept'
  ] },
  { version: '4.5', title: 'Support team and amvgg values', changes: [
    'Support role: admins give / remove it in the admin panel. Support members get a blue SUPPORT tag and a Support Panel (mark withdrawals as sent, mute up to 24 h)',
    'Pet values from amvgg.com (default) or elvebredd.com: type a pet name to fill all 12 versions, or import every pet at once (x1000, versions already in the catalog are skipped)'
  ] },
  { version: '4.4', title: 'Webhooks removed', changes: [
    'Discord webhooks are removed: the PetDuel Discord bot posts coinflips, jackpots, giveaways, events and withdraw requests itself'
  ] },
  { version: '4.3', title: 'Discord bot connection', changes: [
    'The PetDuel Discord bot connects with a secret key (only its hash is in the code): it can use every admin action, gets every site event live and is not affected by the country block or maintenance',
    'Players link their Discord account: Profile > Link Discord gives a code for /link in Discord'
  ] },
  { version: '4.2', title: 'Chat replies, system messages, new profile', changes: [
    'Chat: reply to messages; system messages come from "PetDuel" with the logo and a glowing green SYSTEM tag',
    'Every 30 minutes a deposit-risk reminder is posted in the chat (not repeated if nobody wrote since)',
    'When an admin marks a withdrawal as sent, the chat shows "X successfully withdrew N pets worth V"',
    'Profile opens as a window: stats, profit graph with 1D / 3D / 7D / 30D / All, and the transaction table with pages'
  ] },
  { version: '4.1', title: 'Values x1000, new profile card and leaderboard', changes: [
    'Every value on the site is multiplied by 1000 once (catalog, inventories, games, stats, history, giveaways, withdrawals); rank limits and elvebredd lookups use the same scale',
    'Lobby shows short values (55K, 1.2M)',
    'Player card: animated stats and a profit graph of the last games; leaderboard with a top 3 podium and Top Profit / Top Wager / Least Profit'
  ] },
  { version: '4.0', title: 'Admins cancel games', changes: [
    'Admins can cancel any coinflip that is waiting or counting down (lobby and match window); pets go back to both players and a chat message is posted'
  ] },
  { version: '3.9', title: 'Default bot fix', changes: [
    'DedokAmp is no longer added back automatically: the default bot is only created once on a brand-new database, so removed bots stay removed'
  ] },
  { version: '3.8', title: 'Jackpot history, new wheel and scramble', changes: [
    'Public jackpot history (last 100 rounds, saved): winner, pot, chance, players, seed and roll to verify',
    'Wheel event: smooth spin that slows down onto the eliminated player, ticking pointer, rim lights, avatars, elimination flash, winner screen with confetti',
    'Word scramble: flip-in tiles, tap letters to spell, shuffle, time bar, hints (first letter at 50%, last at 75%), live guess counter, confetti for the winner'
  ] },
  { version: '3.7', title: 'Jackpot survives restarts', changes: [
    'The running jackpot round is saved and continues after a restart (waiting, countdown or rolling); the winner is the same because it comes from the round seed'
  ] },
  { version: '3.6', title: 'Games and chat survive restarts', changes: [
    'Open coinflips and the last 60 chat messages are saved in the database: a restart / deploy no longer cancels games or clears the chat',
    'Games that were already joined when the server restarted are played to the end with their original (provably fair) result'
  ] },
  { version: '3.5', title: 'No withdrawals while bots are offline', changes: [
    'Withdraw requests are refused while every deposit bot is offline; the wallet shows a notice and disables the button'
  ] },
  { version: '3.4', title: 'Country block in the admin panel', changes: [
    'Admin panel: Country block box (Block Turkey / any codes / Unblock all), saved in the database; BLOCK_COUNTRIES in Railway still works too'
  ] },
  { version: '3.3', title: 'Entertainment-only notices, better country detection', changes: [
    '"For entertainment only, gems have no monetary value" in the footer, Terms of Service, FAQ, login and deposit screens',
    'Country block falls back to an IP lookup when Cloudflare sends no country; /api/whereami shows what the server sees'
  ] },
  { version: '3.2', title: 'Country block', changes: [
    'BLOCK_COUNTRIES (e.g. TR) shows visitors from those countries a "not available in your country" page (uses Cloudflare CF-IPCountry); API and live connection are blocked too',
    'STAFF_KEY: open /?staff=KEY once and a cookie lets staff in from a blocked country'
  ] },
  { version: '3.1', title: 'Safer deposit flow, giveaway delete', changes: [
    'Deposit is 3 steps: 1) "Deposit at your own risk" with an I acknowledge checkbox, 2) trade rules incl. at least 6 food items per trade, 3) the bot (masked name, shown big) and the Join private server button',
    'Admins see a delete button on every giveaway card; pets go back to the host unless unticked'
  ] },
  { version: '3.0', title: 'Long giveaways', changes: [
    'Giveaway duration has no practical limit: days, hours and minutes in Advanced mode; Easy mode also has 1 hour and 1 day',
    'Giveaways are saved in the database and survive restarts / deploys (before, a restart returned the items to the host)',
    'Giveaway card shows every pet with its picture, name, badges and value; the timer shows days and hours'
  ] },
  { version: '2.9', title: 'Nicknames, masked bot names, delete all pets', changes: [
    'Every player must choose a site nickname (3-16 letters, numbers or _, unique) before playing; it is shown everywhere instead of the Roblox name (chat, games, leaderboard, webhooks). Can be changed once every 7 days',
    'Admin users list shows nickname + Roblox name; search, Give Items and bounties accept either',
    'Admin: "Delete all pets" button next to every player who has pets',
    'Deposit bots are shown masked to players (ltcspace -> ltcs***e); admins still see the full name'
  ] },
  { version: '2.8', title: 'Maintenance mode', changes: [
    'Admin panel: Close / Open the site. While closed only admins can use the site; everyone else sees a big PET DUEL "officially closed" screen with an optional message',
    'Players are disconnected right away and come back automatically when the site is opened again; admins see a red maintenance bar'
  ] },
  { version: '2.7', title: 'Sign in with Roblox', changes: [
    'Official Roblox OAuth login (one click, no code) next to the bio code login; shown once ROBLOX_CLIENT_ID and ROBLOX_CLIENT_SECRET are set',
    'PKCE + state check; the session token is handed over with a one-time ticket, never in a URL'
  ] },
  { version: '2.6', title: 'New login screen', changes: [
    'Login is one card: username, terms checkbox, Login button and the captcha inside the card (Turnstile or built-in image)',
    'Full screen on phones; step 2 shows the code with a Copy button and short instructions; "Use another username" goes back'
  ] },
  { version: '2.5', title: 'Wallet counter and update banner', changes: [
    'Wallet balance counts up / down (starts slow, speeds up, 1-1.8 s) instead of the falling gems',
    'Wallet only shows pending withdrawals',
    'Home banner shows a short note about the latest update when there is no admin announcement (admin announcements still win)'
  ] },
  { version: '2.4', title: 'Pet limits, withdraw status and Discord pictures', changes: [
    'Create Coinflip: choose how many pets the opponent may join with (1, 2, 3, 5, 10 or any); the server enforces it',
    'Wallet: players see their withdraw requests (pending / sent / refunded); the wallet opens with an animation',
    'Profile history pages are shortened (1 … 4 5 6 … 42) instead of one button per page',
    'Discord moved to the right end of the menu',
    'Webhooks: avatar, author and the most valuable pet picture in every embed; new coinflip and withdraw request webhooks; URLs can be pasted at the top of server.js'
  ] },
  { version: '2.3', title: 'Owner tag, catalog browser and smoother pages', changes: [
    'Purple glowing "Owner" tag instead of ADMIN in chat and on profiles',
    'Admin: Open Catalog shows the whole catalog in an animated window with name search, version filter and sorting',
    'Animated sort menu in the lobby; "Create Coinflip" button; Discord is the first item in the menu',
    'Create Coinflip: the side picker is two small coins next to Clear; the match window has no status pill any more',
    'Phones: the event and jackpot pages no longer jump while you watch'
  ] },
  { version: '2.2', title: 'New lobby, info pages and easier pet adding', changes: [
    'Coinflip lobby rebuilt: Player vs Player, all pets in one row with badges, value and join range on the right, Join / View buttons',
    'Sort games by value or newest; game count and total value in the toolbar',
    'Updates (public), Terms of Service, Provably Fair and FAQ next to Discord',
    'Admin: add a pet with all 12 versions at once; known pets fill their picture automatically; elvebredd fills every value',
    'Elvebredd parser can no longer freeze the server (this caused the 502 errors)'
  ] },
  { version: '2.1', title: 'New match view, countdown and pet tooltips', changes: [
    'Match window: big VS in the middle while waiting, site logo on top, win chance bars and "Created ... ago"',
    'New 3-2-1 countdown with a ring that empties smoothly, in the lobby and in the match window',
    'Open games glow; pets show round M / N / F / R badges and a soft glow for Mega and Neon',
    'Hover or tap a pet to see its full name and value',
    'Animated "Online now" on profiles',
    'Elvebredd lookup stops after 20 seconds and shows a clear error instead of an error page'
  ] },
  { version: '2.0', title: 'Deposit bots, elvebredd values and a new look', changes: [
    'Deposit lists every bot with its Online / Offline status; offline bots cannot be joined',
    'Admin panel: add / remove deposit bots, change join links and switch each bot online or offline',
    'Admin panel: type a pet name, pick Normal / Neon / Mega and Fly / Ride, and the value and image are fetched from elvebredd.com',
    'Rubik font and a paw print background'
  ] },
  { version: '1.9', title: 'Simpler site, chat rule and admin search', changes: [
    'Back to a single game (Adopt Me): everything about the second game and the withdraw wager requirement was removed',
    'Chat: you need to place a bet before you can write ("Place a bet to chat")',
    'Admin panel: search players by name, filter online / offline / admins / banned, sort by last seen, bet or value',
    'Profiles show when a player was last seen',
    'Coinflip flips as soon as the 3-2-1 countdown ends; the games counter next to History is gone',
    'Active coinflip value is shown under Coinflip and the jackpot pot under Jackpot in the top menu',
    'New rank icons and a calmer look'
  ] },
  { version: '1.8', title: 'Tax, captcha, auto select and online counter', changes: [
    'Coinflip tax: admins set a rate (0–20%) and the receiver; taxed items go to an admin account and a bell notification is sent',
    'Captcha when logging in and when entering a giveaway (Cloudflare Turnstile if configured, built-in image captcha otherwise)',
    'Join match: "Auto select" picks the smallest items that fit the required value range',
    'Coinflip item limit raised from 8 to 20; "Select All" removed from create/join and kept in the wallet',
    'Online counter counts each logged-in player once (not tabs) and is shown only after login',
    'Admin panel: update log'
  ] },
  { version: '1.7', title: 'Security', changes: [
    'Per-IP rate limits, automatic temporary IP blocks, request timeouts, socket limits and a short cache for the public state',
    'Content security policy, safer lookups and no stack traces for visitors',
    'Item audit every 30 seconds: no item id may exist in two places; database revision lock against double instances'
  ] },
  { version: '1.6', title: 'Bounty', changes: [
    'Bounty: admins put a bounty on a player, the first player who beats them wins the prize and everyone sees a congratulation popup'
  ] },
  { version: '1.5', title: 'Pet Duel, mobile and jackpot', changes: [
    'Site renamed to Pet Duel and an independence notice added in the footer',
    'Mobile: floating chat button, chat opens full screen, menu row with Jackpot, Leaderboard and Discord',
    'Coinflip animation is the same as the replay; the result is shown when the coin stops',
    'Jackpot: 60 second rounds, avatars on the ring, provably fair verify button',
    'Gems fall when the wallet changes; circular item previews; active games value'
  ] },
  { version: '1.4', title: 'Moderation, ranks and events', changes: [
    'Mute (all chat messages of the player are deleted), ban, item delete, stats editing and admin roles with a chat tag option',
    '30 ranks and a minimum rank for giveaways',
    'Wheel and word scramble events with an announcement banner',
    'Tips from the profile card and the admin notification bell'
  ] },
  { version: '1.0', title: 'Launch', changes: [
    'Roblox login, coinflip with provably fair hash, 3D coin, history and replay',
    'Giveaways, live chat, leaderboard, announcements and admin panel with catalog and item grants',
    'Manual withdraw requests',
    'Discord webhooks for giveaways and coinflips'
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

/* one jackpot round per game */
const JPS = { adoptme: null, mm2: null };
const jpTimers = { adoptme: [], mm2: [] };
let savedJackpots = {};

/* after a restart: continue the saved rounds (their result is fixed by their seed, so nothing changes) */
function resumeJackpot() {
  for (const game of GAMES) resumeJackpotOf(game, savedJackpots[game]);
  savedJackpots = {};
}

function resumeJackpotOf(game, j) {
  if (!j || !Array.isArray(j.entries) || !j.entries.length || j.state === 'finished') return newJackpot(game);

  jpTimers[game].forEach(clearTimeout);
  jpTimers[game] = [];
  j.winner = null;
  j.game = game;
  JPS[game] = j;
  jpRecalc(j);

  if (j.state === 'countdown') {
    const left = Math.max(3000, Number(j.endsAt || 0) - now());
    j.endsAt = now() + left;
    jpLater(j, () => rollJackpot(j), left);
  } else if (j.state === 'rolling') {
    /* roll again: same seed, same winner, the wheel animation plays once more */
    j.state = 'countdown';
    j.endsAt = now() + 3000;
    jpLater(j, () => rollJackpot(j), 3000);
  } else {
    j.state = 'waiting';
  }
  console.log(`Resumed jackpot round ${j.id} (${j.state}, ${j.entries.length} player(s)).`);
  emitJackpot(j);
}

function jpLater(j, fn, ms) { jpTimers[j.game].push(setTimeout(fn, ms)); }

function publicJackpot(j) {
  if (!j) return null;

  const out = {
    id: j.id,
    game: j.game,
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

function newJackpot(game) {
  jpTimers[game].forEach(clearTimeout);
  jpTimers[game] = [];

  const seed = rid(32);
  const j = {
    id: rid(8), game, state: 'waiting', seed, hash: sha(seed),
    entries: [], total: 0, endsAt: 0, rollEndsAt: 0,
    winnerId: null, roll: null, winner: null
  };

  JPS[game] = j;
  emitJackpot(j);
}

function jpRecalc(j) {
  for (const e of j.entries) e.value = valueOf(e.items);
  j.total = round2(j.entries.reduce((t, e) => t + e.value, 0));
}

function rollJackpot(j) {
  if (JPS[j.game] !== j || j.state !== 'countdown') return;

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

  jpLater(j, () => finishJackpot(j), JP_ROLL_MS);
}

function finishJackpot(j) {
  if (JPS[j.game] !== j || j.state !== 'rolling') return;

  const winEntry = j.winner;
  const winner = S.users[winEntry.user.id];
  const allItems = j.entries.flatMap(e => e.items);

  j.state = 'finished';
  j.winnerId = winEntry.user.id;

  /* public history: who won, how much, with what chance, and the seed to verify it */
  S.jpHistory.unshift({
    id: j.id, game: j.game, total: j.total, finishedAt: now(),
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

    bump(u, { bet: e.value }, j.game);

    if (e === winEntry) {
      const gain = round2(j.total - e.value);
      bump(u, { won: gain, profit: gain }, j.game);
      addTransaction(u, 'Jackpot Win', j.id, gain, j.game);
    } else {
      bump(u, { lost: e.value, profit: -e.value }, j.game);
      addTransaction(u, 'Jackpot Loss', j.id, -e.value, j.game);
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
      { name: 'Game', value: GAME_NAMES[j.game], inline: true },
      { name: 'Winner', value: clip(nick(winEntry.user), 100), inline: true },
      { name: 'Pot', value: String(j.total), inline: true },
      { name: 'Chance', value: `${round2((winEntry.value / j.total) * 100)}%`, inline: true },
      { name: 'Players', value: j.entries.map(e => `${nick(e.user)}: ${e.value}`).join('\n').slice(0, 1000) },
      { name: 'Round / Hash', value: clip(`${j.id}\n${j.hash}`, 300) }
    ],
    timestamp: new Date().toISOString()
  }, { thumb: winEntry.user, author: winEntry.user, image: topImage(j.entries.flatMap(e => e.items)) });

  emitJackpot(j);
  jpLater(j, () => newJackpot(j.game), JP_RESULT_MS);
}

app.get('/api/jackpot/history', (req, res) => {
  const game = req.query.game ? cleanGame(req.query.game) : null;
  res.json({ list: S.jpHistory.filter(r => !game || cleanGame(r.game) === game).slice(0, 50) });
});

app.post('/api/jackpot/join', auth, actionLimit, (req, res) => {
  const user = req.user;
  const j = JPS[cleanGame(req.body.game)];
  if (gameOff(req.body.game)) return bad(res, offMsg(req.body.game));

  if (!j || (j.state !== 'waiting' && j.state !== 'countdown')) {
    return bad(res, 'This round is already rolling. Join the next round.');
  }

  const uids = selectionToUids(req.body);
  const selected = pickItems(user, uids, JP_MAX_JOIN_ITEMS);

  if (!selected) return bad(res, `Select 1–${JP_MAX_JOIN_ITEMS} valid items`);
  if (valueOf(selected) <= 0) return bad(res, 'Value too low');
  if (!selected.every(i => gameOf(i) === j.game)) return bad(res, `This is the ${GAME_NAMES[j.game]} jackpot: use ${GAME_NAMES[j.game]} items only`);

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
    jpLater(j, () => rollJackpot(j), JP_TIME * 1000);
  }

  emitJackpot(j);
  emitMe(user);
  res.json({ ok: true });
});

/* a lone player can take their items back while nobody else has joined */
app.post('/api/jackpot/leave', auth, actionLimit, (req, res) => {
  const j = JPS[cleanGame(req.body.game)];

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
   or withdrawn twice) and an admin sends them by hand in Adopt Me. */

app.post('/api/withdraw', auth, actionLimit, (req, res) => {
  const user = req.user;
  const uids = selectionToUids(req.body);

  /* one request = one game; it is sent by an online withdraw bot of that game */
  const chosen = pickItems(user, uids, 50);
  if (!chosen) return bad(res, 'Invalid item selection');
  const game = gameOfItems(chosen);
  if (!game) return bad(res, 'Withdraw items of one game at a time (Adopt Me or MM2)');
  if (gameOff(game)) return bad(res, offMsg(game));
  const wdBot = pickWithdrawBot(game);
  if (!wdBot) {
    return bad(res, `${GAME_NAMES[game]} withdrawals are paused while our ${GAME_NAMES[game]} withdraw bots are offline. Please try again when a bot is back online.`);
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
    game,
    bot: { id: wdBot.id, username: wdBot.username },
    ts: now()
  };

  S.withdrawals.unshift(request);
  notifyAdmins('withdraw', `[${GAME_NAMES[game]}] ${user.username} requested a withdraw worth ${request.value} (${items.length} item${items.length === 1 ? '' : 's'}, bot ${wdBot.username})`);
  sendWebhook(WEBHOOK_WD, {
    title: `📤 ${GAME_NAMES[game]} withdraw request`,
    color: 0xffb52e,
    fields: [
      { name: 'Game', value: GAME_NAMES[game], inline: true },
      { name: 'Bot', value: clip(wdBot.username, 100), inline: true },
      { name: 'Player', value: clip(nick(user), 100), inline: true },
      { name: 'Value', value: String(request.value), inline: true },
      { name: `Pets (${items.length})`, value: itemLine(items) }
    ],
    timestamp: new Date().toISOString()
  }, { thumb: user, author: user, image: topImage(items), data: { withdrawId: request.id } });
  addTransaction(user, 'Withdraw Request', request.id, -request.value, game);
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
      id: w.id, game: gameOf(w), status: w.status, value: w.value, ts: w.ts, doneAt: w.doneAt || 0,
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

function cleanItem(body) {
  const name = String(body.name || '').trim().slice(0, 40);
  const image = String(body.image || '').trim();
  const value = round2(Number(body.value));

  if (!name) return null;
  if (!/^https:\/\/[^\s"'<>]{4,400}$/.test(image)) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1e9) return null;

  if (body.game === 'mm2') return { name, image, value, age: 'normal', fly: false, ride: false, game: 'mm2' };
  return {
    name, image, value,
    age: ['normal', 'neon', 'mega'].includes(body.age) ? body.age : 'normal',
    fly: Boolean(body.fly),
    ride: Boolean(body.ride)
  };
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
  if (S.bots.some(b => b.username.toLowerCase() === username.toLowerCase() && gameOf(b) === cleanGame(req.body.game) && botRole(b) === (req.body.role === 'withdraw' ? 'withdraw' : 'deposit'))) return bad(res, 'This bot is already in the list');

  const b = { id: rid(6), username, link, online: req.body.online !== false, role: req.body.role === 'withdraw' ? 'withdraw' : 'deposit', ...(req.body.game === 'mm2' ? { game: 'mm2' } : {}) };
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
  if (req.body.game === 'mm2') b.game = 'mm2'; else if (req.body.game === 'adoptme') delete b.game;
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

/* ================= ADMIN: ELVEBREDD VALUE LOOKUP =================
   The admin types a pet name and picks Normal / Neon / Mega + Fly / Ride; the server reads the
   value list of elvebredd.com and returns that pet's value and image so it can be added to the catalog.
   The site has no documented API, so the parser is tolerant: it reads JSON endpoints or the JSON embedded
   in the page and finds every object that has a name and value fields. If elvebredd changes its site,
   set the exact data URL in the admin panel (or ELVE_URL in Render > Environment). */

/* value sites: amvgg.com (default) or elvebredd.com, chosen in the admin panel */
const VALUE_SOURCES = {
  amvgg: { name: 'amvgg.com', origin: 'https://amvgg.com', urls: [
    'https://amvgg.com/values/pets', 'https://amvgg.com/api/values/pets', 'https://amvgg.com/api/pets',
    'https://amvgg.com/api/values', 'https://amvgg.com/api/items', 'https://amvgg.com/values'
  ] },
  elvebredd: { name: 'elvebredd.com', origin: 'https://elvebredd.com', urls: [
    'https://elvebredd.com/api/values', 'https://elvebredd.com/api/pets', 'https://elvebredd.com/api/items',
    'https://elvebredd.com/values', 'https://elvebredd.com/'
  ] }
};
const valueSource = () => VALUE_SOURCES[S.settings.valueSource] || VALUE_SOURCES.amvgg;
const ELVE_ORIGIN = 'https://elvebredd.com';
const ELVE_TTL = 15 * 60 * 1000;
let elveCache = { ts: 0, pets: [], source: '' };
let elveLoading = null;

const normName = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function numberOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

const NAME_KEYS = ['name', 'title', 'item_name', 'itemName', 'petName', 'pet_name'];
const IMAGE_KEYS = ['image', 'img', 'imageUrl', 'image_url', 'imageURL', 'icon', 'picture', 'thumbnail', 'src'];

/* finds every "pet-like" object (a name + at least one numeric value field) anywhere in the data */
function collectPets(root, base) {
  const out = [];
  const seen = new Set();

  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 10 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(x => walk(x, depth + 1)); return; }

    const nameKey = NAME_KEYS.find(k => typeof node[k] === 'string' && node[k].trim());
    if (nameKey) {
      /* value fields, also nested ones like { neon: { fly_ride: 12 } } (the path becomes "neon.fly_ride") */
      const VALUE_HINT = /val|price|worth|normal|regular|default|neon|mega|fly|ride|potion|nopot/i;
      const NOT_VALUE = /(^|[._])(id|rank|demand|trend|count|qty|amount|change|percent|pct|rarity|tier|order|index|sort|time|date|created|updated|stock|score|rating)([._]|$)/i;
      const values = {};
      const take = (obj, prefix, depth) => {
        for (const [k, v] of Object.entries(obj)) {
          const key = prefix ? `${prefix}.${k}` : k;
          if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) { take(v, key, depth + 1); continue; }
          if (!VALUE_HINT.test(key) || NOT_VALUE.test(key)) continue;
          const n = numberOf(v);
          if (n !== null && n >= 0) values[key] = n;
        }
      };
      take(node, '', 0);
      if (Object.keys(values).length) {
        let image = '';
        const imageKey = IMAGE_KEYS.find(k => typeof node[k] === 'string' && node[k].trim());
        if (imageKey) {
          try { image = new URL(node[imageKey].trim(), base).href; } catch { image = ''; }
        }
        out.push({ name: node[nameKey].trim(), image, values });
      }
    }
    Object.values(node).forEach(v => walk(v, depth + 1));
  };

  walk(root, 0);
  return out;
}

/* Returns the JSON array/object that starts at text[start], using a string-aware bracket scanner.
   Linear time and capped in length, so a huge page can never lock up the server. */
function sliceJson(text, start, maxLen = 3 * 1024 * 1024) {
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  const end = Math.min(text.length, start + maxLen);
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return c === close ? text.slice(start, i + 1) : null;
    }
  }
  return null;
}

function scriptBodies(text, test) {
  const out = [];
  let pos = 0;
  while (out.length < 50) {
    const s = text.indexOf('<script', pos);
    if (s < 0) break;
    const tagEnd = text.indexOf('>', s);
    const e = text.indexOf('</script>', tagEnd);
    if (tagEnd < 0 || e < 0) break;
    if (test(text.slice(s, tagEnd + 1))) out.push(text.slice(tagEnd + 1, e));
    pos = e + 9;
  }
  return out;
}

/* tries to read JSON from a response body: plain JSON, Next.js data, or JSON blobs in <script> tags */
function extractJson(text) {
  const found = [];
  const tryParse = t => { try { found.push(JSON.parse(t)); return true; } catch { return false; } };

  const t = text.trim();
  if ((t.startsWith('{') || t.startsWith('[')) && tryParse(t)) return found;

  for (const body of scriptBodies(text, tag => /__NEXT_DATA__|application\/(ld\+)?json/i.test(tag))) tryParse(body);

  /* Next.js app router streams its data as self.__next_f.push([1,"..."]) chunks */
  let joined = '';
  let pos = 0;
  const marker = 'self.__next_f.push(';
  while (joined.length < 6 * 1024 * 1024) {
    const s = text.indexOf(marker, pos);
    if (s < 0) break;
    const arr = sliceJson(text, s + marker.length);
    if (!arr) { pos = s + marker.length; continue; }
    pos = s + marker.length + arr.length;
    try { const v = JSON.parse(arr); if (typeof v[1] === 'string') joined += v[1]; } catch { /* ignore */ }
  }

  /* inside that data, every array of objects that mentions "name" is a candidate */
  let tries = 0;
  pos = 0;
  while (joined && tries < 200) {
    const s = joined.indexOf('[{', pos);
    if (s < 0) break;
    tries++;
    const arr = sliceJson(joined, s, 1024 * 1024);
    if (arr && arr.includes('"name"') && tryParse(arr)) pos = s + arr.length;
    else pos = s + 2;
  }
  return found;
}

async function fetchText(url, ms = 7000) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(ms),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'application/json, text/html;q=0.9, */*;q=0.8'
    }
  });
  if (!response.ok) {
    const blocked = [401, 403, 429, 503].includes(response.status);
    throw new Error(blocked ? `blocked by the site (HTTP ${response.status})` : `HTTP ${response.status}`);
  }
  const type = response.headers.get('content-type') || '';
  if (!/json|html|text|javascript/i.test(type)) throw new Error('not a web page');
  return (await response.text()).slice(0, 6 * 1024 * 1024);
}

/* ---------- amvgg.com: exact format ----------
   The values page is a Next.js page; its data comes in self.__next_f.push chunks. Every pet is an object like
   {"id":"…","name":"Shadow Dragon","regularValue":"3.775","npRegularValue":"4.55","fValue":…,"rValue":…,
    "neonValue":…,"npNeonValue":…,"nfValue":…,"nrValue":…,"megaValue":…,"npMegaValue":…,"mfValue":…,"mrValue":…}
   np = no potion, regular / neon / mega = fly ride, f = fly, r = ride. Pictures: /items/<name>.webp */
const AMV_FIELDS = {
  'normal-none': 'npRegularValue', 'normal-f': 'fValue', 'normal-r': 'rValue', 'normal-fr': 'regularValue',
  'neon-none': 'npNeonValue', 'neon-f': 'nfValue', 'neon-r': 'nrValue', 'neon-fr': 'neonValue',
  'mega-none': 'npMegaValue', 'mega-f': 'mfValue', 'mega-r': 'mrValue', 'mega-fr': 'megaValue'
};

async function loadAmvgg(deadlineMs, url) {
  const text = await fetchText(url || 'https://amvgg.com/values/pets', deadlineMs);
  return parseAmvgg(text);
}

function parseAmvgg(text) {
  let joined = '';
  let pos = 0;
  const marker = 'self.__next_f.push(';
  if (!text.includes('self.__next_f.push(')) joined = text;
  while (joined.length < 8 * 1024 * 1024) {
    const st = text.indexOf(marker, pos);
    if (st < 0) break;
    const arr = sliceJson(text, st + marker.length);
    if (!arr) { pos = st + marker.length; continue; }
    pos = st + marker.length + arr.length;
    try { const v = JSON.parse(arr); if (typeof v[1] === 'string') joined += v[1]; } catch { /* ignore */ }
  }
  const pets = new Map();
  pos = 0;
  while (pets.size < 5000) {
    const st = joined.indexOf('{"id":"', pos);
    if (st < 0) break;
    const obj = sliceJson(joined, st, 20000);
    pos = st + 7;
    if (!obj || !obj.includes('"npRegularValue"')) continue;
    try {
      const d = JSON.parse(obj);
      if (!d.name) continue;
      const amv = {};
      for (const [key, field] of Object.entries(AMV_FIELDS)) {
        const n = numberOf(d[field]);
        amv[key] = n !== null && n > 0 ? n : null;
      }
      /* pets with a single price per age (no potion split on amvgg): that price counts for every potion */
      for (const age of ['normal', 'neon', 'mega']) {
        const base = amv[`${age}-fr`];
        if (base === null) continue;
        for (const pot of ['none', 'f', 'r']) if (amv[`${age}-${pot}`] === null) amv[`${age}-${pot}`] = base;
      }
      const name = String(d.name).trim();
      pets.set(normName(name), { name, image: `https://amvgg.com/items/${encodeURIComponent(name)}.webp`, values: {}, amv });
    } catch { /* ignore */ }
  }
  if (pets.size < 5) throw new Error('amvgg.com page has no pet data');
  return [...pets.values()];
}

async function loadElve(force) {
  if (!force && elveCache.pets.length && now() - elveCache.ts < ELVE_TTL) return elveCache;
  if (elveLoading) return elveLoading;

  elveLoading = (async () => {
    const src = valueSource();
    const custom = String(S.settings.elveUrl || E.ELVE_URL || '').trim();
    const queue = custom ? [custom, ...src.urls] : [...src.urls];
    const tried = new Set();
    const errors = [];

    /* amvgg: always read its exact format (field names map straight to the 12 versions) */
    if (src === VALUE_SOURCES.amvgg) {
      try {
        const amvUrl = /^https:\/\/(www\.)?amvgg\.com\//.test(custom) ? custom : 'https://amvgg.com/values/pets';
        const pets = await loadAmvgg(15000, amvUrl);
        elveCache = { ts: now(), pets, source: amvUrl };
        return elveCache;
      } catch (error) {
        errors.push(`amvgg format: ${error.name === 'TimeoutError' ? 'timed out' : error.message}`);
      }
    }
    /* Cloudflare in front of the site cuts requests after ~100 s, so the whole lookup must stay short */
    const deadline = now() + 20000;

    while (queue.length && tried.size < 8 && deadline - now() > 1500) {
      const url = queue.shift();
      if (tried.has(url)) continue;
      tried.add(url);
      try {
        const text = await fetchText(url, Math.min(7000, deadline - now()));
        if (text.includes('"npRegularValue"')) {
          try { const amvPets = parseAmvgg(text); elveCache = { ts: now(), pets: amvPets, source: url }; return elveCache; } catch { /* fall through */ }
        }
        const pets = [];
        for (const data of extractJson(text)) pets.push(...collectPets(data, url));

        if (pets.length >= 5) {
          const byKey = new Map();
          for (const p of pets) if (!byKey.has(normName(p.name))) byKey.set(normName(p.name), p);
          elveCache = { ts: now(), pets: [...byKey.values()], source: url };
          return elveCache;
        }

        /* an HTML page: follow the API / JSON links it mentions */
        const links = text.match(/["'](\/api\/[^"'\s<>]{1,120}|https:\/\/(?:elvebredd|amvgg)\.com\/[^"'\s<>]{1,120}\.json)["']/g) || [];
        for (const l of links.slice(0, 8)) {
          try { queue.push(new URL(l.slice(1, -1), url).href); } catch { /* ignore */ }
        }
        errors.push(`${url}: no pet data`);
      } catch (error) {
        errors.push(`${url.replace(src.origin, '') || '/'}: ${error.name === 'TimeoutError' ? 'timed out' : error.message}`);
      }
    }
    throw new Error(`Could not read ${src.name} values. ` + errors.slice(0, 4).join(' | ') +
      '. You can still add the item by hand, or paste the exact data URL under "Data source".');
  })();

  try { return await elveLoading; } finally { elveLoading = null; }
}

/* sorts a value key into (age, potion), e.g. "nvalue - fly&ride" -> neon + fly&ride */
function classifyKey(key) {
  const k = key.toLowerCase();
  let age = 'normal';
  if (/mega|^m[\s_.-]*val|^mvalue/.test(k)) age = 'mega';
  else if (/neon|^n[\s_.-]*val|^nvalue/.test(k)) age = 'neon';

  const fly = /fly|(^|[^a-z])f([^a-z]|$)/.test(k) || /fr$|flyride|fly&ride/.test(k);
  const ride = /ride|fr$/.test(k) || /(^|[^a-z])r([^a-z]|$)/.test(k.replace(/^r[\s_-]*value/, ''));
  const potion = fly && ride ? 'fr' : fly ? 'f' : ride ? 'r' : 'none';
  return { age, potion };
}

function pickValue(pet, age, fly, ride) {
  const want = fly && ride ? 'fr' : fly ? 'f' : ride ? 'r' : 'none';
  const keys = Object.keys(pet.values).map(key => ({ key, ...classifyKey(key) }));
  const sameAge = keys.filter(k => k.age === age);

  /* fly-only and ride-only usually share a price; use one when the other is missing */
  const order = want === 'f' ? ['f', 'r'] : want === 'r' ? ['r', 'f'] : [want];
  for (const p of order) {
    const hit = sameAge.find(k => k.potion === p);
    if (hit) return { key: hit.key, value: pet.values[hit.key] };
  }

  /* a list with a single plain "value" field: only the normal, no-potion price exists */
  if (age === 'normal' && want === 'none' && keys.length === 1) return { key: keys[0].key, value: pet.values[keys[0].key] };
  return null;
}

/* the 12 versions of one pet in the site's scale (null = the value site has no price for it) */
function petVariants(pet) {
  if (pet.amv) {
    const out = {};
    for (const [key, v] of Object.entries(pet.amv)) out[key] = v === null ? null : round2(v * VALUE_SCALE);
    return out;
  }
  const out = {};
  for (const age of ['normal', 'neon', 'mega']) {
    for (const [pot, fly, ride] of [['none', false, false], ['f', true, false], ['r', false, true], ['fr', true, true]]) {
      const picked = pickValue(pet, age, fly, ride);
      out[`${age}-${pot}`] = picked ? round2(picked.value * VALUE_SCALE) : null;
    }
  }
  return out;
}

/* import every pet of the value site into the catalog (values x1000); versions already in the catalog are skipped */
app.post('/api/admin/values/import', auth, adminOnly, async (req, res) => {
  let data;
  try { data = await loadElve(true); } catch (error) { return bad(res, error.message, 502); }
  const onlyNormal = req.body.mode === 'normal';
  const have = new Map(S.catalog.filter(c => gameOf(c) === 'adoptme').map(c => [`${normName(c.name)}|${c.age || 'normal'}|${Boolean(c.fly)}|${Boolean(c.ride)}`, c]));
  let added = 0, skipped = 0, updated = 0, noImage = 0;
  for (const pet of data.pets) {
    if (!/^https:\/\//.test(pet.image)) { noImage++; continue; }
    const name = pet.name.slice(0, 40);
    for (const [key, value] of Object.entries(petVariants(pet))) {
      if (value === null || value <= 0) continue;
      const [age, pot] = key.split('-');
      if (onlyNormal && pot !== 'none') continue;
      const fly = pot === 'f' || pot === 'fr', ride = pot === 'r' || pot === 'fr';
      const k = `${normName(name)}|${age}|${fly}|${ride}`;
      const old = have.get(k);
      if (old) {
        /* already in the catalog: keep the item, correct its value */
        if (old.value !== value) { old.value = value; updated++; } else skipped++;
        continue;
      }
      const item = { id: rid(8), name, image: pet.image, value, age, fly, ride };
      have.set(k, item);
      S.catalog.push(item);
      added++;
    }
  }
  markDirty();
  console.log(`[ADMIN] ${req.user.username} imported ${added} catalog items from ${valueSource().name}`);
  res.json({ ok: true, added, updated, skipped, pets: data.pets.length, noImage, source: valueSource().name });
});

app.get('/api/admin/elve', auth, adminOnly, async (req, res) => {
  const name = String(req.query.name || '').trim().slice(0, 60);
  if (normName(name).length < 2) return bad(res, 'Enter a pet name');

  let data;
  try { data = await loadElve(req.query.refresh === '1'); }
  catch (error) { return bad(res, error.message, 502); }

  const q = normName(name);
  /* exact name only: "Dragon" never picks "Shadow Dragon" */
  const exact = data.pets.find(p => normName(p.name) === q);
  const similar = data.pets
    .filter(p => normName(p.name) !== q && normName(p.name).includes(q))
    .slice(0, 8)
    .map(p => p.name);

  if (!exact) {
    return bad(res, similar.length ? `No pet named exactly "${name}". Did you mean: ${similar.join(', ')}?` : `No pet named exactly "${name}" on ${valueSource().name}`, 404);
  }

  const variants = petVariants(exact);

  res.json({
    ok: true, name: exact.name, image: /^https:\/\//.test(exact.image) ? exact.image : '',
    variants, source: data.source, similar
  });
});

app.post('/api/admin/elve/source', auth, adminOnly, (req, res) => {
  const url = String(req.body.url || '').trim();
  if (url && !/^https:\/\/[^\s"'<>]{4,400}$/.test(url)) return bad(res, 'The data URL must start with https://');
  if (req.body.source && VALUE_SOURCES[req.body.source]) S.settings.valueSource = req.body.source;
  S.settings.elveUrl = url;
  elveCache = { ts: 0, pets: [], source: '' };
  markDirty();
  res.json({ ok: true });
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
      muted: (u.mutedUntil || 0) > now()
    })),
    withdrawals: S.withdrawals.filter(w => w.status === 'pending').map(w => ({ ...w, botName: w.bot ? (publicWdBot(w.bot, true) || {}).username : '' })),
    bounties: publicBounties(),
    settings: S.settings,
    admins: Object.values(S.users).filter(u => isAdmin(u)).map(u => ({ id: u.id, username: u.username })),
    updateLog: UPDATE_LOG,
    updateNotes: S.updateNotes,
    bots: publicBots(true),
    myInventory: req.user.inventory.map(i => ({ uid: i.uid, name: i.name, image: i.image, value: i.value, age: i.age, fly: i.fly, ride: i.ride })),
    elveUrl: S.settings.elveUrl || '',
    valueSource: S.settings.valueSource || 'amvgg',
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
  const what = gameOf(w) === 'mm2' ? `MM2 item${n === 1 ? '' : 's'}` : `pet${n === 1 ? '' : 's'}`;
  systemChat(`${nick(owner || w.user)} successfully withdrew ${n} ${what} worth ${Number(w.value).toLocaleString('en-US')}! 🎉`, { withdraw: true });
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
      uid: i.uid, name: i.name, image: i.image, value: i.value,
      age: i.age, fly: i.fly, ride: i.ride
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

app.post('/api/admin/mm2', auth, adminOnly, (req, res) => {
  S.settings.mm2Off = req.body.off !== false;
  markDirty();
  stateCache.t = 0;
  io.emit('adoptme:update', {});
  console.log(`[ADMIN] ${req.user.username} turned MM2 ${S.settings.mm2Off ? 'off' : 'on'}`);
  res.json({ ok: true, off: S.settings.mm2Off });
});

app.post('/api/admin/adoptme', auth, adminOnly, (req, res) => {
  S.settings.adoptMeOff = req.body.off !== false;
  markDirty();
  stateCache.t = 0;
  io.emit('adoptme:update', { off: S.settings.adoptMeOff });
  console.log(`[ADMIN] ${req.user.username} turned Adopt Me ${S.settings.adoptMeOff ? 'off' : 'on'}`);
  res.json({ ok: true, off: S.settings.adoptMeOff });
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
  if (!item) return bad(res, 'Invalid item. Image must be a valid https:// URL.');
  /* MM2: the same name again only updates its value and picture */
  if (item.game === 'mm2') {
    const same = S.catalog.find(c => c.game === 'mm2' && c.name.toLowerCase() === item.name.toLowerCase());
    if (same) { same.value = item.value; same.image = item.image; markDirty(); return res.json({ ok: true, item: same, updated: true }); }
  }
  item.id = rid(8);
  S.catalog.push(item);
  markDirty();
  res.json({ ok: true, item });
});

/* one pet name + picture, many versions (normal / neon / mega × fly / ride): each becomes its own catalog item */
app.post('/api/admin/catalog/bulk', auth, adminOnly, (req, res) => {
  const variants = Array.isArray(req.body.variants) ? req.body.variants.slice(0, 12) : [];
  if (!variants.length) return bad(res, 'Fill the value of at least one version');

  const name = String(req.body.name || '').trim();
  let image = String(req.body.image || '').trim();
  if (!image) {
    const known = S.catalog.find(c => gameOf(c) === 'adoptme' && c.name.toLowerCase() === name.toLowerCase());
    if (known) image = known.image;
  }

  const items = [];
  for (const v of variants) {
    const item = cleanItem({ name, image, value: v.value, age: v.age, fly: v.fly, ride: v.ride });
    if (!item) return bad(res, 'Check the name, the image URL (must start with https://) and the values');
    items.push(item);
  }

  let added = 0, updated = 0;
  for (const item of items) {
    const existing = S.catalog.find(c => gameOf(c) === 'adoptme' && c.name.toLowerCase() === item.name.toLowerCase() &&
      c.age === item.age && Boolean(c.fly) === item.fly && Boolean(c.ride) === item.ride);
    if (existing) {
      existing.value = item.value;
      existing.image = item.image;
      updated++;
    } else {
      item.id = rid(8);
      S.catalog.push(item);
      added++;
    }
  }
  markDirty();
  res.json({ ok: true, added, updated });
});

/* change a catalog item: only the value (the box on the card) or everything (the edit window) */
app.post('/api/admin/catalog/update', auth, adminOnly, (req, res) => {
  const item = S.catalog.find(x => x.id === req.body.id);
  const value = round2(Number(req.body.value));
  if (!item || !Number.isFinite(value) || value < 0 || value > 1e9) return bad(res, 'Invalid value');
  if (req.body.name !== undefined) {
    const name = String(req.body.name || '').trim().slice(0, 40);
    const image = String(req.body.image || '').trim();
    if (!name) return bad(res, 'Enter a name');
    if (!/^https:\/\/[^\s"'<>]{4,400}$/.test(image)) return bad(res, 'The image must be a https:// link');
    item.name = name;
    item.image = image;
    if (item.game !== 'mm2') {
      item.age = ['normal', 'neon', 'mega'].includes(req.body.age) ? req.body.age : 'normal';
      item.fly = Boolean(req.body.fly);
      item.ride = Boolean(req.body.ride);
    }
  }
  item.value = value;
  /* optional: the same change for the copies players already own */
  let changed = 0;
  if (req.body.applyToOwned) {
    for (const u of Object.values(S.users)) {
      let hit = false;
      for (const i of u.inventory) {
        if (i.catalogId !== item.id) continue;
        i.name = item.name; i.image = item.image; i.value = item.value;
        if (item.game !== 'mm2') { i.age = item.age; i.fly = item.fly; i.ride = item.ride; }
        changed++; hit = true;
      }
      if (hit) emitMe(u);
    }
  }
  markDirty();
  console.log(`[ADMIN] ${req.user.username} edited catalog item ${item.id} (${item.name})${changed ? `, ${changed} owned copies updated` : ''}`);
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

      <div style="margin-bottom:16px;padding:14px;border-radius:12px;border:1px solid #343842;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <img src="/assets/xmas-dog.png" alt="" style="width:28px;height:28px;object-fit:contain">
        <b style="font-size:15px">Adopt Me</b>
        <span id="am-state" style="font-weight:800"></span>
        <span style="flex:1"></span>
        <button id="am-toggle" class="btn sm"></button>
        <p class="hint" style="margin:0;width:100%">While Adopt Me is disabled the site opens on MM2, Adopt Me shows "Currently disabled" and no Adopt Me coinflip, jackpot, giveaway or withdraw can be started.</p>
      </div>
      <div style="margin-bottom:16px;padding:14px;border-radius:12px;border:1px solid #343842;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <img src="/assets/mm2-knife.png" alt="" style="width:28px;height:28px;object-fit:contain">
        <b style="font-size:15px">MM2</b>
        <span id="mm-state" style="font-weight:800"></span>
        <span style="flex:1"></span>
        <button id="mm-toggle" class="btn sm"></button>
        <p class="hint" style="margin:0;width:100%">While MM2 is off it is removed from the site: no MM2 menu, deposit, withdraw, coinflip, jackpot or giveaway, and the MM2 bot is told not to trade. MM2 items stay saved in the players' inventories and come back when MM2 is turned on again.</p>
      </div>

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

      <h4 style="margin:0 0 8px">📤 Pending Withdrawals</h4>
      <div id="adm-wd" style="margin-bottom:16px"></div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px">
        <div style="background:#f5faff;padding:14px;border-radius:12px;grid-column:1 / -1">
          <h4 style="margin-bottom:10px">➕ Add Adopt Me Pet</h4>
          <div style="display:grid;grid-template-columns:1fr 1fr 70px;gap:8px;align-items:center;margin-bottom:8px">
            <input id="a-name" class="in" list="a-names" autocomplete="off" placeholder="Pet name (e.g. Shadow Dragon)">
            <input id="a-img" class="in" placeholder="Image URL (https://...), filled automatically if known">
            <img id="a-prev" alt="" style="width:64px;height:64px;object-fit:contain;justify-self:center;visibility:hidden">
          </div>
          <datalist id="a-names"></datalist>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
            <select id="e-site" class="in" style="height:32px;padding:0 8px" title="Value site"><option value="amvgg">amvgg.com</option><option value="elvebredd">elvebredd.com</option></select>
            <button id="e-fetch" class="btn gray sm">⚡ Get all values</button>
            <button id="a-clear" class="btn gray sm">Clear</button>
            <span id="e-msg" class="hint" style="margin:0;align-self:center"></span>
          </div>
          <div style="display:grid;grid-template-columns:70px repeat(4,1fr);gap:6px;margin-bottom:10px">
            <span></span><small style="text-align:center;font-weight:800">No potion</small><small style="text-align:center;font-weight:800">Fly</small><small style="text-align:center;font-weight:800">Ride</small><small style="text-align:center;font-weight:800">Fly Ride</small>
            <b style="align-self:center">Normal</b><input class="in" type="number" min="0" step="0.01" data-var="normal-none" placeholder="—" style="width:100%;min-width:0"><input class="in" type="number" min="0" step="0.01" data-var="normal-f" placeholder="—" style="width:100%;min-width:0"><input class="in" type="number" min="0" step="0.01" data-var="normal-r" placeholder="—" style="width:100%;min-width:0"><input class="in" type="number" min="0" step="0.01" data-var="normal-fr" placeholder="—" style="width:100%;min-width:0"><b style="align-self:center">Neon</b><input class="in" type="number" min="0" step="0.01" data-var="neon-none" placeholder="—" style="width:100%;min-width:0"><input class="in" type="number" min="0" step="0.01" data-var="neon-f" placeholder="—" style="width:100%;min-width:0"><input class="in" type="number" min="0" step="0.01" data-var="neon-r" placeholder="—" style="width:100%;min-width:0"><input class="in" type="number" min="0" step="0.01" data-var="neon-fr" placeholder="—" style="width:100%;min-width:0"><b style="align-self:center">Mega</b><input class="in" type="number" min="0" step="0.01" data-var="mega-none" placeholder="—" style="width:100%;min-width:0"><input class="in" type="number" min="0" step="0.01" data-var="mega-f" placeholder="—" style="width:100%;min-width:0"><input class="in" type="number" min="0" step="0.01" data-var="mega-r" placeholder="—" style="width:100%;min-width:0"><input class="in" type="number" min="0" step="0.01" data-var="mega-fr" placeholder="—" style="width:100%;min-width:0">
          </div>
          <button id="a-add" class="btn" style="width:100%">Add / update filled variants</button>
          <p class="hint">Type the pet name once, fill the value of every version you want (leave the rest empty) and press the button: each filled box becomes its own catalog item. If the pet is already in the catalog its picture is filled in for you and existing versions only get their value updated.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid #343842">
            <button id="imp-all" class="btn sm">📥 Import ALL pets (every version)</button>
            <button id="imp-normal" class="btn gray sm">📥 Import all pets (normal only)</button>
            <span id="imp-msg" class="hint" style="margin:0;align-self:center"></span>
          </div>
          <p class="hint">Import takes every pet from the selected value site with its picture and value x1000. Pets / versions that are already in the catalog are skipped.</p>
          <details style="margin-top:6px"><summary class="hint" style="cursor:pointer">Exact data URL (only if the automatic search fails)</summary>
            <input id="e-src" class="in" style="width:100%;margin:6px 0" placeholder="Optional exact data URL (empty = automatic)">
            <button id="e-src-save" class="btn gray sm">Save</button>
          </details>
        </div>

        <div style="background:#f5faff;padding:14px;border-radius:12px;border:1px solid #5a4122">
          <h4 style="margin-bottom:10px;display:flex;align-items:center;gap:8px"><img src="/assets/mm2-knife.png" alt="" style="width:26px;height:26px;object-fit:contain">Add MM2 Item</h4>
          <input id="m-name" class="in" list="m-names" autocomplete="off" style="width:100%;margin-bottom:8px" placeholder="Item name (e.g. Chroma Fang)">
          <datalist id="m-names"></datalist>
          <div style="display:grid;grid-template-columns:1fr 64px;gap:8px;align-items:center;margin-bottom:8px">
            <input id="m-img" class="in" placeholder="Image URL (https://...)">
            <img id="m-prev" alt="" style="width:56px;height:56px;object-fit:contain;justify-self:center;visibility:hidden">
          </div>
          <input id="m-val" class="in" type="number" min="0" step="0.01" style="width:100%;margin-bottom:8px" placeholder="Value (site scale, e.g. 5000)">
          <button id="m-add" class="btn" style="width:100%">Add / update MM2 item</button>
          <p class="hint">MM2 items have no Neon / Mega / Fly / Ride. Typing an MM2 item that is already in the catalog fills its picture and value; adding it again only updates them. MM2 items can only be played, withdrawn and given away with other MM2 items.</p>
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
        <div style="display:grid;grid-template-columns:auto 1fr 2fr auto;gap:8px">
          <select id="bot-game" class="in"><option value="adoptme">Adopt Me</option><option value="mm2">MM2</option></select>
          <input id="bot-name" class="in" maxlength="20" placeholder="Deposit bot Roblox username">
          <input id="bot-link" class="in" placeholder="Join link (https://www.roblox.com/share?...)">
          <button id="bot-add" class="btn">Add deposit bot</button>
        </div>
        <p class="hint">Players trade their pets / items to these bots. Pick the game of each bot: players choose Adopt Me or MM2 in the Deposit window and only see that game's bots. Players cannot join an offline bot.</p>
      </div>

      <h4 style="margin:16px 0 8px">📤 Withdraw bots</h4>
      <div style="background:#f5faff;padding:14px;border-radius:12px">
        <div id="wbot-list" data-role="withdraw" style="margin-bottom:10px"></div>
        <div style="display:grid;grid-template-columns:auto 1fr 2fr auto;gap:8px">
          <select id="wbot-game" class="in"><option value="adoptme">Adopt Me</option><option value="mm2">MM2</option></select>
          <input id="wbot-name" class="in" maxlength="20" placeholder="Withdraw bot Roblox username">
          <input id="wbot-link" class="in" placeholder="Join link (https://www.roblox.com/share?...)">
          <button id="wbot-add" class="btn">Add withdraw bot</button>
        </div>
        <p class="hint">These bots send the pets out. Every withdraw request gets one online withdraw bot (in turns); the player sees its name and private server in the wallet. Withdrawals are paused while every withdraw bot is offline. Every game has its own withdraw bots; while a game has no withdraw bot, its deposit bots handle its withdrawals.</p>
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
            <select id="cat-game" class="in"><option value="">All games</option><option value="adoptme">Adopt Me</option><option value="mm2">MM2</option></select>
            <select id="cat-age" class="in"><option value="">All versions</option><option value="normal">Normal</option><option value="neon">Neon</option><option value="mega">Mega</option></select>
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

      <h4 style="margin:16px 0 8px">📋 Update log</h4>
      <div id="adm-log"></div>
    </div>`;

  document.body.appendChild(overlay);
  const $ = id => document.getElementById(id);

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
  $('cat-game').onchange = () => catRender();
  $('cat-sort').onchange = () => catRender();
  const varKey = (age, fly, ride) => `${age}-${fly && ride ? 'fr' : fly ? 'f' : ride ? 'r' : 'none'}`;
  const setPreview = () => {
    const v = $('a-img').value.trim();
    if (/^https:\/\//.test(v)) { $('a-prev').src = v; $('a-prev').style.visibility = 'visible'; }
    else { $('a-prev').removeAttribute('src'); $('a-prev').style.visibility = 'hidden'; }
  };
  $('a-img').oninput = setPreview;
  const setMPreview = () => {
    const v = $('m-img').value.trim();
    if (/^https:\/\//.test(v)) { $('m-prev').src = v; $('m-prev').style.visibility = 'visible'; }
    else { $('m-prev').removeAttribute('src'); $('m-prev').style.visibility = 'hidden'; }
  };
  $('m-img').oninput = setMPreview;
  $('m-name').onchange = () => {
    const same = catalogCache.find(c => c.game === 'mm2' && c.name.toLowerCase() === $('m-name').value.trim().toLowerCase());
    if (!same) return;
    if (!$('m-img').value.trim()) { $('m-img').value = same.image; setMPreview(); }
    if ($('m-val').value === '') $('m-val').value = same.value;
  };
  $('m-add').onclick = async () => {
    try {
      const r = await api('/api/admin/catalog', { method: 'POST', body: { game: 'mm2', name: $('m-name').value, image: $('m-img').value, value: $('m-val').value } });
      toast(r.updated ? 'MM2 item updated' : 'MM2 item added', 'ok');
      $('m-name').value = ''; $('m-img').value = ''; $('m-val').value = ''; setMPreview();
      await load();
    } catch (err) { toast(err.message, 'err'); }
  };

  /* typing a pet that is already in the catalog fills its picture and current values */
  $('a-name').onchange = () => {
    const n = $('a-name').value.trim().toLowerCase();
    const same = catalogCache.filter(c => c.name.toLowerCase() === n);
    if (!same.length) return;
    if (!$('a-img').value.trim()) { $('a-img').value = same[0].image; setPreview(); }
    for (const c of same) {
      const box = overlay.querySelector(`[data-var="${varKey(c.age, c.fly, c.ride)}"]`);
      if (box && box.value === '') box.value = c.value;
    }
    $('e-msg').textContent = `${same.length} version(s) already in the catalog`;
  };

  async function load() {
    const data = await api('/api/admin/data');

    $('adm-wd').innerHTML = data.withdrawals.length
      ? data.withdrawals.map(w => `
        <div style="border:1px solid #343842;border-radius:8px;padding:10px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
            <b>${esc(w.user.username)}</b>
            <span style="padding:1px 7px;border-radius:5px;font-size:11px;font-weight:900;${w.game === 'mm2' ? 'background:rgba(255,160,40,.15);color:#ffb547' : 'background:rgba(0,239,160,.12);color:#00efa0'}">${w.game === 'mm2' ? 'MM2' : 'ADOPT ME'}</span>
            ${w.botName ? `<span style="color:#4da3ff;font-weight:800">🤖 ${esc(w.botName)}</span>` : ''}
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

    const catCard = item => {
      return `
        <div style="border:2px solid #e0edfb;border-radius:12px;padding:10px;text-align:center">
          <img src="${esc(item.image)}" alt="" style="width:70px;height:70px;object-fit:contain">
          <div style="font-weight:700">${esc(item.name)}</div>
          ${item.game === 'mm2' ? '<span style="display:inline-block;padding:1px 6px;border-radius:5px;background:rgba(255,160,40,.15);color:#ffb547;font-size:10px;font-weight:900">MM2</span>' : tags(item)}
          <input class="in" type="number" min="0" step="0.01" value="${esc(item.value)}" data-value-id="${esc(item.id)}" style="width:100%;margin:8px 0">
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
      const cg = $('cat-game').value;
      const sort = $('cat-sort').value;
      const list = data.catalog
        .filter(i => (!q || i.name.toLowerCase().includes(q)) && (!age || (i.age || 'normal') === age) && (!cg || (i.game === 'mm2' ? 'mm2' : 'adoptme') === cg))
        .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'value-asc' ? a.value - b.value : b.value - a.value);
      $('cat-shown').textContent = `${list.length} / ${data.catalog.length}`;
      $('adm-cat').innerHTML = list.length
        ? `<div class="cat-grid">${list.slice(0, 400).map((item, i) => catCard(item).replace('<div style="border', `<div class="cat-card" style="animation-delay:${Math.min(i, 30) * 18}ms;border`)).join('')}</div>`
        : `<p class="hint" style="text-align:center;padding:30px">${data.catalog.length ? 'No pet matches your search.' : 'No items yet.'}</p>`;
    };
    $('cat-count').textContent = `(${data.catalog.length})`;
    catRender();

    catalogCache = data.catalog || [];
    $('a-names').innerHTML = [...new Set(catalogCache.filter(c => c.game !== 'mm2').map(c => c.name))].map(n => `<option value="${esc(n)}"></option>`).join('');
    $('m-names').innerHTML = [...new Set(catalogCache.filter(c => c.game === 'mm2').map(c => c.name))].map(n => `<option value="${esc(n)}"></option>`).join('');
    usersCache = data.users;
    renderUsers();
    $('g-users').innerHTML = data.users.map(u => `<option value="${esc(u.username)}"></option>`).join('');

    const prevItem = $('ev-item').value;
    $('ev-item').innerHTML = data.catalog.length
      ? data.catalog.map(i => `<option value="${esc(i.id)}">${i.game === 'mm2' ? '[MM2] ' : ''}${esc(i.name)} (${fmt(i.value)})</option>`).join('')
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
    amOff = Boolean(data.settings && data.settings.adoptMeOff === true);
    mmOff = Boolean(data.settings && data.settings.mm2Off === true);
    renderMm();
    if (document.activeElement !== $('mt-text')) $('mt-text').value = data.maintenanceText || '';
    renderMaint();
    $('e-src').value = data.elveUrl || '';
    $('e-site').value = data.valueSource || 'amvgg';

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
  let amOff = true, mmOff = false;
  function renderMm() {
    $('mm-state').textContent = mmOff ? '● Off (removed from the site)' : '● On';
    $('mm-state').style.color = mmOff ? '#ff5968' : '#00efa0';
    $('mm-toggle').textContent = mmOff ? 'Turn MM2 on' : 'Turn MM2 off';
    $('mm-toggle').className = mmOff ? 'btn sm' : 'btn red sm';
  }
  $('mm-toggle').onclick = async () => {
    try {
      const r = await api('/api/admin/mm2', { method: 'POST', body: { off: !mmOff } });
      mmOff = r.off;
      renderMm();
      toast(mmOff ? 'MM2 turned off' : 'MM2 turned on', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
  function renderAm() {
    $('am-state').textContent = amOff ? '● Currently disabled' : '● Enabled';
    $('am-state').style.color = amOff ? '#ff5968' : '#00efa0';
    $('am-toggle').textContent = amOff ? 'Enable Adopt Me' : 'Disable Adopt Me';
    $('am-toggle').className = amOff ? 'btn sm' : 'btn red sm';
  }
  $('am-toggle').onclick = async () => {
    try {
      const r = await api('/api/admin/adoptme', { method: 'POST', body: { off: !amOff } });
      amOff = r.off;
      renderAm();
      toast(amOff ? 'Adopt Me disabled' : 'Adopt Me enabled', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
  function renderMaint() {
    $('mt-state').textContent = mtOn ? '● ON: the site is closed' : '● OFF: the site is open';
    renderAm();
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

  function renderBots(all) {
    for (const [id, role] of [['bot-list', 'deposit'], ['wbot-list', 'withdraw']]) {
      const bots = all.filter(b => (b.role || 'deposit') === role);
      $(id).innerHTML = bots.length
      ? bots.map(b => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid #e0edfb;flex-wrap:wrap">
          ${b.avatar ? `<img src="${esc(b.avatar)}" alt="" style="width:32px;height:32px;border-radius:50%">` : ''}
          <select class="in" data-bot-game="${esc(b.id)}" style="height:30px;padding:0 6px;width:auto">${['adoptme', 'mm2'].map(g => `<option value="${g}" ${(b.game || 'adoptme') === g ? 'selected' : ''}>${g === 'mm2' ? 'MM2' : 'Adopt Me'}</option>`).join('')}</select>
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
      const r = await api('/api/admin/bots/add', { method: 'POST', body: { username: $(pre + '-name').value, link: $(pre + '-link').value, role, game: $(pre + '-game').value } });
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
    const gsel = e.target.closest('[data-bot-game]');
    if (gsel) {
      try {
        const r = await api('/api/admin/bots/update', { method: 'POST', body: { id: gsel.dataset.botGame, game: gsel.value } });
        renderBots(r.bots);
        toast('Bot game: ' + (gsel.value === 'mm2' ? 'MM2' : 'Adopt Me'), 'ok');
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    const input = e.target.closest('[data-bot-link]');
    if (!input) return;
    try {
      const r = await api('/api/admin/bots/update', { method: 'POST', body: { id: input.dataset.botLink, link: input.value } });
      renderBots(r.bots);
      toast('Join link saved', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };

  async function elveFetch() {
    const name = $('a-name').value.trim();
    if (!name) { toast('Enter a pet name', 'err'); return; }
    $('e-msg').textContent = 'Loading values…';
    $('e-fetch').disabled = true;
    try {
      const r = await api('/api/admin/elve?name=' + encodeURIComponent(name));
      $('a-name').value = r.name;
      if (r.image) { $('a-img').value = r.image; setPreview(); }
      let n = 0;
      overlay.querySelectorAll('[data-var]').forEach(b => { b.value = ''; });
      for (const [key, value] of Object.entries(r.variants || {})) {
        const box = overlay.querySelector(`[data-var="${key}"]`);
        if (box && value !== null) { box.value = value; n++; }
      }
      $('e-msg').textContent = `${r.name}: ${n} values filled${r.image ? '' : ' (no picture found, paste the image URL)'}`;
    } catch (err) {
      $('e-msg').textContent = err.message;
      toast(err.message, 'err');
    } finally {
      $('e-fetch').disabled = false;
    }
  }

  $('e-fetch').onclick = () => elveFetch();
  $('a-clear').onclick = () => {
    $('a-name').value = ''; $('a-img').value = ''; setPreview(); $('e-msg').textContent = '';
    overlay.querySelectorAll('[data-var]').forEach(b => { b.value = ''; });
  };

  $('e-site').onchange = async () => {
    try {
      await api('/api/admin/elve/source', { method: 'POST', body: { url: $('e-src').value, source: $('e-site').value } });
      toast('Value site: ' + $('e-site').value + '.com', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
  const runImport = async mode => {
    const site = $('e-site').value + '.com';
    if (!(await confirmBox({ title: 'Import pets', text: `Add every pet from ${site} to the catalog (${mode === 'normal' ? 'normal versions only' : 'all versions'}, values x1000)? Pets already in the catalog keep their item but get the correct value.`, ok: 'Import' }))) return;
    $('imp-msg').textContent = `Loading ${site}…`;
    $('imp-all').disabled = $('imp-normal').disabled = true;
    try {
      const r = await api('/api/admin/values/import', { method: 'POST', body: { mode } });
      $('imp-msg').textContent = `${r.pets} pets found on ${r.source}: ${r.added} added, ${r.updated || 0} values corrected, ${r.skipped} already correct${r.noImage ? `, ${r.noImage} without picture skipped` : ''}`;
      toast(`${r.added} catalog items added`, 'ok');
      await load();
    } catch (err) { $('imp-msg').textContent = err.message; toast(err.message, 'err'); }
    finally { $('imp-all').disabled = $('imp-normal').disabled = false; }
  };
  $('imp-all').onclick = () => runImport('all');
  $('imp-normal').onclick = () => runImport('normal');

  $('e-src-save').onclick = async () => {
    try {
      await api('/api/admin/elve/source', { method: 'POST', body: { url: $('e-src').value, source: $('e-site').value } });
      toast('Data source saved', 'ok');
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
    const variants = [...overlay.querySelectorAll('[data-var]')]
      .filter(b => b.value.trim() !== '')
      .map(b => {
        const [age, pot] = b.dataset.var.split('-');
        return { age, fly: pot === 'f' || pot === 'fr', ride: pot === 'r' || pot === 'fr', value: b.value };
      });
    if (!variants.length) return toast('Fill the value of at least one version', 'err');
    try {
      const r = await api('/api/admin/catalog/bulk', {
        method: 'POST', body: { name: $('a-name').value, image: $('a-img').value, variants }
      });
      toast(`${r.added} added, ${r.updated} updated`, 'ok');
      $('a-clear').onclick();
      await load();
    } catch (err) { toast(err.message, 'err'); }
  };

  /* the edit window of one catalog item */
  function editCatalogItem(c) {
    if (!c) return;
    const am = c.game !== 'mm2';
    const box = document.createElement('div');
    box.className = 'cat-edit';
    box.innerHTML = `
      <div class="cat-edit-card">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
          <img id="ce-prev" src="${esc(c.image)}" alt="" style="width:64px;height:64px;object-fit:contain">
          <div style="flex:1"><b style="font-size:17px">Edit catalog item</b><div class="hint" style="margin:2px 0 0">${am ? 'Adopt Me' : 'MM2'} · id ${esc(c.id)}</div></div>
          <button class="btn gray sm" data-ce="x">✕</button>
        </div>
        <label class="hint">Name</label><input class="in" id="ce-name" maxlength="40" value="${esc(c.name)}" style="width:100%;margin-bottom:8px">
        <label class="hint">Image URL</label><input class="in" id="ce-img" value="${esc(c.image)}" style="width:100%;margin-bottom:8px">
        <label class="hint">Value</label><input class="in" id="ce-val" type="number" min="0" step="0.01" value="${esc(c.value)}" style="width:100%;margin-bottom:8px">
        ${am ? `<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
          <select class="in" id="ce-age">${['normal', 'neon', 'mega'].map(a => `<option value="${a}" ${(c.age || 'normal') === a ? 'selected' : ''}>${a[0].toUpperCase() + a.slice(1)}</option>`).join('')}</select>
          <label><input type="checkbox" id="ce-fly" ${c.fly ? 'checked' : ''}> Fly</label>
          <label><input type="checkbox" id="ce-ride" ${c.ride ? 'checked' : ''}> Ride</label>
        </div>` : ''}
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
        const body = { id: c.id, name: box.querySelector('#ce-name').value, image: box.querySelector('#ce-img').value, value: box.querySelector('#ce-val').value, applyToOwned: box.querySelector('#ce-own').checked };
        if (am) { body.age = box.querySelector('#ce-age').value; body.fly = box.querySelector('#ce-fly').checked; body.ride = box.querySelector('#ce-ride').checked; }
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
      ? list.slice(0, 100).map(u => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px;border-bottom:1px solid #e0edfb;flex-wrap:wrap">
          <span style="display:flex;align-items:center;gap:8px;min-width:150px">
            <i style="width:9px;height:9px;border-radius:50%;background:${u.online ? '#22c55e' : '#8b93a3'};display:inline-block"></i>
            <b>${u.nickname ? esc(u.nickname) : '<i style="color:#ffb52e">no nickname</i>'}${u.banned ? ' (banned)' : ''}${u.muted ? ' (muted)' : ''}</b>
            <small style="color:#8d909a">Roblox: ${esc(u.username)}</small>
            <small>${u.online ? 'online' : esc(ago(u.lastSeen))}</small>
          </span>
          <span>${u.items} items · ${fmt(u.value)} · bet ${fmt(u.totalBet)}</span>
          <span style="display:flex;gap:6px;flex-wrap:wrap">
            ${!u.isAdmin ? `<button class="btn sm gray" data-mute="${esc(u.id)}" data-state="${u.muted ? '0' : '1'}">${u.muted ? 'Unmute' : 'Mute'}</button>` : ''}
            <button class="btn sm gray" data-inv="${esc(u.id)}">Items</button>
            ${u.items ? `<button class="btn sm red" data-clearinv="${esc(u.id)}" data-name="${esc(u.nickname || u.username)}" data-count="${u.items}" data-val="${esc(fmt(u.value))}">Delete all pets</button>` : ''}
            <button class="btn sm gray" data-stats="${esc(u.id)}">Stats</button>
            ${u.isAdmin ? `<button class="btn sm gray" data-tag="${esc(u.id)}" data-state="${u.adminTag ? '0' : '1'}">Tag: ${u.adminTag ? 'ON' : 'OFF'}</button>` : ''}
            ${!u.isAdmin ? `<button class="btn sm ${u.support ? 'mint' : 'gray'}" data-support="${esc(u.id)}" data-state="${u.support ? '0' : '1'}">${u.support ? 'Support ✓' : 'Make support'}</button>` : ''}
            <button class="btn sm gray" data-role="${esc(u.id)}" data-state="${u.isAdmin ? '0' : '1'}">${u.isAdmin ? 'Remove admin' : 'Make admin'}</button>
            <button class="btn sm ${u.banned ? 'mint' : 'red'}" data-ban="${esc(u.id)}" data-state="${u.banned ? '0' : '1'}">${u.banned ? 'Unban' : 'Ban'}</button>
          </span>
        </div>`).join('') + (list.length > 100 ? '<p class="hint">Showing the first 100. Use the search to narrow it down.</p>' : '')
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
  for (const w of S.botWithdrawals) if (w.status === 'pending') w.items.forEach(i => add(i.uid, `bot withdraw ${w.id}`, false));

  for (const J of Object.values(JPS)) if (J && J.state !== 'finished') J.entries.forEach(e => e.items.forEach(i => add(i.uid, `jackpot ${J.id}`, false)));

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

/* ================= MM2 AUTO DEPOSIT (in-game bot) =================
   1. The player presses Deposit (MM2): POST /api/deposit/init opens a 15 minute session for their Roblox name.
   2. The in-game bot gets a trade request and asks GET /api/bot/verify-player/:robloxUsername (header x-bot-secret).
   3. After the trade the bot sends POST /api/bot/confirm-deposit { tradeId, robloxUsername, items: [{ name, amount }] }.
      Every item is matched by name with the MM2 catalog and added to the player's inventory (MongoDB, like every
      other item). Each tradeId is handled only once (409 on repeats, also after a restart).
   4. The deposit window polls GET /api/deposit/status every 2 seconds and shows the new items.
   Railway variables: BOT_SECRET_KEY (required, same value in the bot), DEPOSIT_BOT_NAME (optional, default iemre547). */

const DEPOSIT_BOT_NAME = String(E.DEPOSIT_BOT_NAME || 'iemre547').trim();
const DEPOSIT_SESSION_MS = 60 * 60 * 1000;   /* one hour, renewed after every deposit: trade again and again in the same server */
const DEPOSIT_GRACE_MS = 10 * 60 * 1000;   /* a trade started just before the end can still be confirmed */
const activeSessions = new Map();          /* robloxUsername (trim, lower case) -> { robloxUsername, userId, verificationCode, expiresAt, startedAt } */
const processedTrades = new Set();         /* filled from S.processedTrades at start */
const sessionKey = name => String(name || '').trim().toLowerCase();
const autoDepositOn = () => Boolean(E.BOT_SECRET_KEY);

/* MM2: one bot does deposits and withdrawals. Its private server link is the link of the MM2 bot in the admin
   panel with the same name (any role), or else the first online MM2 bot. */
function autoBotLink() {
  const mm = S.bots.filter(b => b.game === 'mm2' && b.link);
  const same = mm.find(b => b.username.toLowerCase() === DEPOSIT_BOT_NAME.toLowerCase());
  const pick = same || mm.find(b => b.online !== false);
  return pick ? pick.link : '';
}

/* The in-game bot is online while it keeps talking to the site: POST /api/bot/heartbeat every ~15 seconds
   (every verify / confirm counts too). No sign of life for 45 seconds, or { status: "offline" }: offline.
   Then MM2 deposits and withdrawals are paused and the MM2 bot in the admin list shows Offline. */
const BOT_TIMEOUT_MS = 45 * 1000;
let botLastSeen = 0, botForcedOff = false, botWasOnline = null;
/* automatic detection is turned off for now (BOT_AUTO_STATUS = false): the MM2 bot's Online / Offline switch in the
   admin panel decides. Turn it back on with BOT_AUTO_STATUS = true. */
const BOT_AUTO_STATUS = false;
const manualBotOnline = () => {
  const b = S.bots.find(x => x.game === 'mm2' && x.username.toLowerCase() === DEPOSIT_BOT_NAME.toLowerCase());
  return b ? b.online !== false : true;
};
const autoBotOnline = () => BOT_AUTO_STATUS ? (!botForcedOff && now() - botLastSeen < BOT_TIMEOUT_MS) : manualBotOnline();
function botAlive() { botLastSeen = now(); botForcedOff = false; syncBotOnline(); }
function syncBotOnline() {
  if (!BOT_AUTO_STATUS) return;
  const on = autoBotOnline();
  if (on === botWasOnline) return;
  botWasOnline = on;
  let touched = false;
  for (const b of S.bots) if (b.game === 'mm2' && b.username.toLowerCase() === DEPOSIT_BOT_NAME.toLowerCase() && (b.online !== false) !== on) { b.online = on; touched = true; }
  if (touched) { markDirty(); emitBots(); }
  stateCache.t = 0;
  io.emit('autobot:status', { online: on });
  console.log(`[BOT] ${DEPOSIT_BOT_NAME} is ${on ? 'online' : 'offline'}`);
}
setInterval(syncBotOnline, 5000);

function gameBotSecretOk(req) {
  const key = String(E.BOT_SECRET_KEY || '');
  const got = String(req.headers['x-bot-secret'] || '');
  if (!key || !got) return false;
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(got).digest(), crypto.createHash('sha256').update(key).digest());
}

function gameBotOnly(req, res, next) {
  if (!autoDepositOn()) return bad(res, 'BOT_SECRET_KEY is not set on the server', 503);
  if (!gameBotSecretOk(req)) return bad(res, 'Forbidden', 403);
  if (req.path !== '/api/bot/heartbeat') botAlive();
  next();
}

app.post('/api/bot/heartbeat', gameBotOnly, (req, res) => {
  if (String(req.body.status || '').toLowerCase() === 'offline') { botForcedOff = true; botLastSeen = 0; syncBotOnline(); }
  else botAlive();
  res.json({ ok: true, online: autoBotOnline() });
});

/* the player's MM2 items, newest deposits first */
const mm2Inventory = user => user.inventory.filter(i => i.game === 'mm2').map(i => ({
  id: i.uid, name: i.name, amount: 1, value: i.value, image: i.image, depositedAt: i.depositedAt || 0
})).sort((a, b) => b.depositedAt - a.depositedAt);

function sessionView(sess) {
  return sess ? { botUsername: DEPOSIT_BOT_NAME, verificationCode: sess.verificationCode, expiresAt: sess.expiresAt, startedAt: sess.startedAt } : null;
}

setInterval(() => {
  const t = now();
  for (const [k, sess] of activeSessions) if (sess.expiresAt + DEPOSIT_GRACE_MS < t) activeSessions.delete(k);
}, 60 * 1000);

/* the player starts a deposit (always for the Roblox account they are logged in with) */
app.post('/api/deposit/init', auth, actionLimit, (req, res) => {
  if (mm2Off()) return bad(res, offMsg('mm2'));
  if (!autoDepositOn()) return bad(res, 'Automatic deposits are not set up yet', 503);
  if (!autoBotOnline()) return bad(res, 'The MM2 bot is offline right now. Please try again in a few minutes.', 409);
  const user = req.user;
  const asked = String(req.body.robloxUsername || '').trim();
  if (asked && sessionKey(asked) !== sessionKey(user.username)) return bad(res, `You can only deposit from your own Roblox account (${user.username})`);
  const key = sessionKey(user.username);
  const busy = activeSessions.get(key);
  if (busy && busy.type === 'withdraw') return bad(res, 'Finish or cancel your withdrawal first');
  const old = busy;
  const sess = {
    type: 'deposit', robloxUsername: user.username, userId: user.id,
    verificationCode: old && old.expiresAt > now() ? old.verificationCode : String(crypto.randomInt(100000, 1000000)),
    startedAt: old && old.expiresAt > now() ? old.startedAt : now(),
    expiresAt: now() + DEPOSIT_SESSION_MS
  };
  activeSessions.set(key, sess);
  res.json({ status: 'ready', ...sessionView(sess) });
});

/* the deposit window asks every 2 seconds */
app.get('/api/deposit/status', auth, (req, res) => {
  const sess = activeSessions.get(sessionKey(req.user.username));
  const live = sess && sess.type !== 'withdraw' && sess.expiresAt > now() ? sess : null;
  res.json({ username: req.user.username, inventory: mm2Inventory(req.user), hasPendingSession: Boolean(live), session: sessionView(live) });
});

/* the in-game bot: may this player trade with me? */
app.get('/api/bot/verify-player/:robloxUsername', gameBotOnly, (req, res) => {
  if (mm2Off()) return res.json({ allowed: false });
  const sess = activeSessions.get(sessionKey(req.params.robloxUsername));
  const ok = Boolean(sess && sess.expiresAt > now() && S.users[sess.userId] && !S.users[sess.userId].banned);
  if (!ok) return res.json({ allowed: false });
  if (sess.type === 'withdraw') {
    const w = S.botWithdrawals.find(x => x.id === sess.withdrawId && x.status === 'pending');
    if (!w) return res.json({ allowed: false });
    /* the bot is trading now: the player cannot cancel for a few minutes (the items may already be handed over) */
    w.botSeenAt = now();
    markDirty();
    return res.json({ allowed: true, type: 'withdraw', items: groupItems(w.items), verificationCode: sess.verificationCode, expiresAt: sess.expiresAt });
  }
  res.json({ allowed: true, type: 'deposit', verificationCode: sess.verificationCode, expiresAt: sess.expiresAt });
});

/* the in-game bot: the trade is done, credit the items */
app.post('/api/bot/confirm-deposit', gameBotOnly, (req, res) => {
  const tradeId = String(req.body.tradeId || '').trim();
  const name = String(req.body.robloxUsername || '').trim();
  const rows = Array.isArray(req.body.items) ? req.body.items : null;
  if (!/^[\w:.\-]{1,100}$/.test(tradeId)) return bad(res, 'tradeId is missing or invalid');
  if (processedTrades.has(tradeId)) return res.status(409).json({ error: 'This trade was already processed', tradeId });
  if (!name || !rows || !rows.length || rows.length > 100) return bad(res, 'robloxUsername and 1-100 items are required');

  const items = [];
  for (const r of rows) {
    const itemName = String((r && r.name) || '').trim().slice(0, 80);
    const amount = Math.floor(Number(r && r.amount === undefined ? 1 : r && r.amount));
    if (!itemName || !(amount >= 1 && amount <= 500)) return bad(res, 'Every item needs a name and an amount of 1-500');
    items.push({ name: itemName, amount });
  }

  const key = sessionKey(name);
  const sess = activeSessions.get(key);
  if (!sess || sess.type === 'withdraw' || sess.expiresAt + DEPOSIT_GRACE_MS < now()) return res.status(403).json({ error: 'No active deposit session for this player' });
  const user = S.users[sess.userId];
  if (!user) return res.status(404).json({ error: 'Player not found on the site' });

  /* match with the MM2 catalog: the value and the picture come from there */
  const byName = new Map(S.catalog.filter(c => c.game === 'mm2').map(c => [normName(c.name), c]));
  const credited = [], unmatched = [];
  const at = now();
  for (const it of items) {
    const c = byName.get(normName(it.name));
    if (!c) { unmatched.push(it); continue; }
    for (let k = 0; k < it.amount; k++) user.inventory.push({ ...newItem(c), depositedAt: at, tradeId });
    credited.push({ name: c.name, amount: it.amount, value: round2(c.value * it.amount) });
  }

  processedTrades.add(tradeId);
  S.processedTrades = [tradeId, ...(S.processedTrades || []).filter(x => x !== tradeId)].slice(0, 5000);
  /* the session stays open (and is renewed), so the player can send the bot another trade right away */
  sess.expiresAt = now() + DEPOSIT_SESSION_MS;
  const total = round2(credited.reduce((t, c) => t + c.value, 0));
  if (credited.length) addTransaction(user, 'Deposit', tradeId, total, 'mm2');
  markDirty();
  emitMe(user);
  io.to('u:' + user.id).emit('deposit:done', { credited, unmatched, total });
  notifyAdmins('withdraw', `📥 MM2 deposit by ${nick(user)} (${user.username}): ${credited.map(c => `${c.amount}x ${c.name}`).join(', ') || 'nothing matched'} · ${total}` +
    (unmatched.length ? ` · NOT IN CATALOG: ${unmatched.map(u => `${u.amount}x ${u.name}`).join(', ')} (add them to the MM2 catalog and give them by hand)` : ''));
  console.log(`[DEPOSIT] ${user.username} trade ${tradeId}: ${credited.length} matched, ${unmatched.length} unmatched`);
  res.json({ success: true, inventory: mm2Inventory(user), credited, unmatched });
});

/* ================= MM2 AUTOMATIC WITHDRAW (in-game bot) =================
   1. The player picks MM2 items and presses Withdraw: POST /api/withdraw/init takes them out of the inventory into a
      saved withdraw record (S.botWithdrawals, kept in MongoDB, so a restart never loses them) and opens a
      15 minute session of type "withdraw".
   2. verify-player answers { allowed: true, type: "withdraw", items: [{ name, amount }] } to the bot.
   3. After handing the items over the bot calls POST /api/bot/confirm-withdraw { tradeId, robloxUsername, items }.
      Items it did not hand over go back to the player.
   4. Cancel (POST /api/withdraw/cancel) or 15 minutes without a trade: everything goes back to the inventory.
      Cancel is refused for 3 minutes after the bot started trading with the player. */

const WD_SESSION_MS = 15 * 60 * 1000;
const WD_BOT_LOCK_MS = 3 * 60 * 1000;
const WD_MAX_ITEMS = 20;

function groupItems(items) {
  const m = new Map();
  for (const i of items) m.set(i.name, (m.get(i.name) || 0) + 1);
  return [...m].map(([name, amount]) => ({ name, amount }));
}

function wdView(w) {
  if (!w) return null;
  return {
    id: w.id, status: w.status, botUsername: DEPOSIT_BOT_NAME, verificationCode: w.verificationCode, expiresAt: w.expiresAt, ts: w.ts,
    items: w.items.map(publicItem), grouped: groupItems(w.items), value: valueOf(w.items),
    canCancel: w.status === 'pending' && !(w.botSeenAt && now() - w.botSeenAt < WD_BOT_LOCK_MS)
  };
}

const pendingBotWithdraw = userId => S.botWithdrawals.find(w => w.userId === userId && w.status === 'pending') || null;

/* give the items back and close the record (cancel / expired) */
function refundBotWithdraw(w, status) {
  if (!w || w.status !== 'pending') return false;
  w.status = status;
  w.doneAt = now();
  const user = S.users[w.userId];
  if (user) { user.inventory.push(...w.items); emitMe(user); }
  const key = sessionKey(w.robloxUsername);
  const sess = activeSessions.get(key);
  if (sess && sess.withdrawId === w.id) activeSessions.delete(key);
  markDirty();
  if (user) io.to('u:' + user.id).emit('withdraw:update', wdView(w));
  return true;
}

/* sessions are in memory: after a restart they are rebuilt from the saved records */
function resumeBotWithdrawals() {
  for (const w of S.botWithdrawals) {
    if (w.status !== 'pending') continue;
    activeSessions.set(sessionKey(w.robloxUsername), { type: 'withdraw', robloxUsername: w.robloxUsername, userId: w.userId, withdrawId: w.id, verificationCode: w.verificationCode, startedAt: w.ts, expiresAt: w.expiresAt });
  }
}

setInterval(() => {
  const t = now();
  for (const w of S.botWithdrawals) {
    if (w.status !== 'pending' || w.expiresAt > t) continue;
    if (w.botSeenAt && t - w.botSeenAt < WD_BOT_LOCK_MS) continue; /* the bot is in the middle of the trade */
    refundBotWithdraw(w, 'expired');
    console.log(`[WITHDRAW] ${w.robloxUsername}: no trade in 15 minutes, ${w.items.length} item(s) returned`);
  }
}, 30 * 1000);

app.post('/api/withdraw/init', auth, actionLimit, (req, res) => {
  if (mm2Off()) return bad(res, offMsg('mm2'));
  if (!autoDepositOn()) return bad(res, 'Automatic withdrawals are not set up yet', 503);
  if (!autoBotOnline()) return bad(res, 'The MM2 bot is offline right now. Please try again in a few minutes.', 409);
  const user = req.user;
  if (pendingBotWithdraw(user.id)) return bad(res, 'You already have a withdrawal waiting. Trade the bot or cancel it first.');
  const uids = selectionToUids(req.body);
  const picked = pickItems(user, uids, WD_MAX_ITEMS);
  if (!picked) return bad(res, `Select 1-${WD_MAX_ITEMS} items from your inventory`);
  if (!picked.every(i => i.game === 'mm2')) return bad(res, 'Only MM2 items can be withdrawn with the bot');
  /* a waiting deposit session of this player is replaced by the withdrawal */
  const items = takeItems(user, uids, WD_MAX_ITEMS);
  const w = {
    id: rid(8), userId: user.id, nickname: nick(user), robloxUsername: user.username, items,
    verificationCode: String(crypto.randomInt(100000, 1000000)), status: 'pending', ts: now(), expiresAt: now() + WD_SESSION_MS
  };
  S.botWithdrawals.unshift(w);
  if (S.botWithdrawals.length > 2000) S.botWithdrawals.length = 2000;
  activeSessions.set(sessionKey(user.username), { type: 'withdraw', robloxUsername: user.username, userId: user.id, withdrawId: w.id, verificationCode: w.verificationCode, startedAt: w.ts, expiresAt: w.expiresAt });
  addTransaction(user, 'Withdraw Request', w.id, -valueOf(items), 'mm2');
  markDirty();
  emitMe(user);
  notifyAdmins('withdraw', `📤 MM2 bot withdraw by ${nick(user)} (${user.username}): ${groupItems(items).map(g => `${g.amount}x ${g.name}`).join(', ')} · ${valueOf(items)}`);
  res.json({ status: 'ready', withdraw: wdView(w), inventory: mm2Inventory(user) });
});

app.get('/api/withdraw/status', auth, (req, res) => {
  const w = pendingBotWithdraw(req.user.id) || S.botWithdrawals.find(x => x.userId === req.user.id && x.id === String(req.query.id || '')) || null;
  res.json({ withdraw: wdView(w), inventory: mm2Inventory(req.user) });
});

app.post('/api/withdraw/cancel', auth, actionLimit, (req, res) => {
  const w = pendingBotWithdraw(req.user.id);
  if (!w) return bad(res, 'You have no withdrawal waiting');
  if (w.botSeenAt && now() - w.botSeenAt < WD_BOT_LOCK_MS) return bad(res, 'The bot is trading with you right now. Wait a few minutes before cancelling.');
  refundBotWithdraw(w, 'cancelled');
  addTransaction(req.user, 'Withdraw Refund', w.id, valueOf(w.items), 'mm2');
  res.json({ ok: true, withdraw: wdView(w), inventory: mm2Inventory(req.user) });
});

app.post('/api/bot/confirm-withdraw', gameBotOnly, (req, res) => {
  const tradeId = String(req.body.tradeId || '').trim();
  const name = String(req.body.robloxUsername || '').trim();
  const rows = Array.isArray(req.body.items) ? req.body.items : [];
  if (!/^[\w:.\-]{1,100}$/.test(tradeId)) return bad(res, 'tradeId is missing or invalid');
  if (processedTrades.has(tradeId)) return res.status(409).json({ error: 'This trade was already processed', tradeId });
  const key = sessionKey(name);
  const sess = activeSessions.get(key);
  const w = sess && sess.type === 'withdraw' ? S.botWithdrawals.find(x => x.id === sess.withdrawId && x.status === 'pending') : null;
  if (!w) return res.status(403).json({ error: 'No active withdraw session for this player' });

  /* what the bot says it handed over, by name */
  const given = new Map();
  for (const r of rows) {
    const n = normName(r && r.name);
    const a = Math.floor(Number(r && r.amount === undefined ? 1 : r && r.amount));
    if (n && a > 0) given.set(n, (given.get(n) || 0) + Math.min(a, 500));
  }
  const delivered = [], back = [];
  for (const item of w.items) {
    const n = normName(item.name);
    if ((given.get(n) || 0) > 0) { given.set(n, given.get(n) - 1); delivered.push(item); } else back.push(item);
  }
  const extra = [...given].filter(([, a]) => a > 0);

  processedTrades.add(tradeId);
  S.processedTrades = [tradeId, ...(S.processedTrades || []).filter(x => x !== tradeId)].slice(0, 5000);
  w.status = 'completed';
  w.doneAt = now();
  w.tradeId = tradeId;
  w.delivered = delivered.length;
  activeSessions.delete(key);
  const user = S.users[w.userId];
  if (user && back.length) {
    /* items the bot did not hand over stay with the player */
    user.inventory.push(...back);
    addTransaction(user, 'Withdraw Refund', w.id, valueOf(back), 'mm2');
  }
  w.items = delivered;
  markDirty();
  if (user) {
    emitMe(user);
    io.to('u:' + user.id).emit('withdraw:update', wdView(w));
    const n = delivered.length;
    if (n) systemChat(`${nick(user)} successfully withdrew ${n} MM2 item${n === 1 ? '' : 's'} worth ${Number(valueOf(delivered)).toLocaleString('en-US')}! 🎉`, { withdraw: true });
  }
  if (back.length || extra.length) {
    notifyAdmins('security', `MM2 withdraw ${w.id} of ${w.robloxUsername}: ${back.length} item(s) not handed over (returned to the player)` +
      (extra.length ? `; the bot reported extra items: ${extra.map(([n, a]) => `${a}x ${n}`).join(', ')}` : ''));
  }
  console.log(`[WITHDRAW] ${w.robloxUsername} trade ${tradeId}: ${delivered.length} delivered, ${back.length} returned`);
  res.json({ success: true, delivered: groupItems(delivered), returned: groupItems(back) });
});

/* ================= START ================= */

(async () => {
  await initDb();
  ensureDefaultBot();
  scaleAllValues();
  for (const t of S.processedTrades || []) processedTrades.add(t);
  resumeBotWithdrawals();
  if (!S.settings.gamesV2) {
    S.settings.adoptMeOff = false;
    S.settings.mm2Off = true;
    S.settings.gamesV2 = true;
    markDirty();
    console.log('[GAMES] Adopt Me on, MM2 off');
  }
  if (!S.settings.botAutoStatusOffFix) {
    for (const b of S.bots) if (b.game === 'mm2' && b.username.toLowerCase() === DEPOSIT_BOT_NAME.toLowerCase()) b.online = true;
    S.settings.botAutoStatusOffFix = true;
    markDirty();
  }
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
