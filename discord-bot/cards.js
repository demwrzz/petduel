'use strict';

/* =====================================================================
   PetDuel image cards for Discord
   - coinflip result: animated GIF (the coin spins, lands, the winner glows)
   - giveaway winner: animated GIF (confetti, the prize bounces)
   - new coinflip, new giveaway, jackpot winner: PNG cards
   Drawn with @napi-rs/canvas, GIFs encoded with gifenc. Every function returns
   { buffer, name } or throws; the caller falls back to a plain embed.
   ===================================================================== */

const path = require('path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

GlobalFonts.registerFromPath(path.join(__dirname, 'fonts', 'InterDisplay-Black.otf'), 'PDBlack');
GlobalFonts.registerFromPath(path.join(__dirname, 'fonts', 'InterDisplay-Bold.otf'), 'PDBold');

const PINK = '#ff3d9a', PINK2 = '#ff8ad0', PURPLE = '#8b5cf6', VIOLET = '#c64bff', GOLD = '#ffd166', ORANGE = '#ff9f43';

const fmt = n => {
  const v = Number(n || 0), a = Math.abs(v);
  for (const [d, u] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (a >= d) return +(v / d).toFixed(2) + u;
  return String(Math.round(v));
};

/* ---------- images (cached) ---------- */
const cache = new Map();
async function img(url) {
  if (!url || !/^https:\/\//.test(url)) return null;
  if (cache.has(url)) return cache.get(url);
  let out = null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(7000), headers: { 'User-Agent': 'PetDuelBot/1.0' } });
    if (r.ok) out = await loadImage(Buffer.from(await r.arrayBuffer()));
  } catch { out = null; }
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(url, out);
  return out;
}

/* ---------- drawing helpers ---------- */
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function background(ctx, W, H, t = 0) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1d1238'); g.addColorStop(1, '#0f0b1f');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const blob = (x, y, r, c, a) => {
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, c.replace('A', a)); rg.addColorStop(1, c.replace('A', 0));
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  };
  blob(W * .15 + Math.sin(t) * 10, H * .1, W * .55, 'rgba(198,75,255,A)', .35);
  blob(W * .9, H * .95 + Math.cos(t) * 8, W * .5, 'rgba(255,61,154,A)', .32);
  /* soft diagonal light */
  ctx.save(); ctx.globalAlpha = .05; ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.moveTo(W * .55, 0); ctx.lineTo(W * .7, 0); ctx.lineTo(W * .45, H); ctx.lineTo(W * .3, H); ctx.fill(); ctx.restore();
  /* chroma line at the bottom */
  const line = ctx.createLinearGradient(0, 0, W, 0);
  ['#ff3d9a', '#ff8ad0', '#c64bff', '#ff4fb8', '#ff3d9a'].forEach((c, i, a) => line.addColorStop(i / (a.length - 1), c));
  ctx.fillStyle = line; ctx.fillRect(0, H - 4, W, 4);
}

function text(ctx, s, x, y, { size = 20, font = 'PDBlack', color = '#fff', align = 'left', base = 'alphabetic', max } = {}) {
  ctx.font = `${size}px ${font}`;
  ctx.textAlign = align; ctx.textBaseline = base;
  let v = String(s ?? '');
  if (max) while (v.length > 1 && ctx.measureText(v).width > max) v = v.slice(0, -2) + '…';
  ctx.fillStyle = color; ctx.fillText(v, x, y);
  return ctx.measureText(v).width;
}

function gradText(ctx, s, x, y, size, align = 'center', colors = ['#ffffff', PINK2, PINK]) {
  ctx.font = `${size}px PDBlack`; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  const w = ctx.measureText(s).width, x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  const g = ctx.createLinearGradient(x0, 0, x0 + w, 0);
  colors.forEach((c, i) => g.addColorStop(i / (colors.length - 1), c));
  ctx.save(); ctx.shadowColor = 'rgba(255,61,154,.6)'; ctx.shadowBlur = 18; ctx.fillStyle = g; ctx.fillText(s, x, y); ctx.restore();
}

function avatar(ctx, image, name, x, y, r, { ring = null, glow = 0, dim = false } = {}) {
  ctx.save();
  if (dim) ctx.globalAlpha = .35;
  if (glow) { ctx.shadowColor = ring || PINK; ctx.shadowBlur = glow; }
  ctx.beginPath(); ctx.arc(x, y, r + (ring ? 5 : 0), 0, Math.PI * 2);
  ctx.fillStyle = ring || '#2a2547'; ctx.fill();
  ctx.shadowBlur = 0;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.closePath();
  ctx.fillStyle = '#2a2547'; ctx.fill();
  ctx.clip();
  if (image) ctx.drawImage(image, x - r, y - r, r * 2, r * 2);
  else text(ctx, String(name || '?').charAt(0).toUpperCase(), x, y + r * .36, { size: r, align: 'center', color: '#d9d3f2' });
  ctx.restore();
}

function petTile(ctx, image, x, y, s) {
  ctx.save();
  rr(ctx, x, y, s, s, s * .22); ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1.5; ctx.stroke();
  if (image) { rr(ctx, x + 3, y + 3, s - 6, s - 6, s * .18); ctx.clip(); ctx.drawImage(image, x + 3, y + 3, s - 6, s - 6); }
  ctx.restore();
}

function petsRow(ctx, pics, count, cx, y, s, gap = 8) {
  const shown = pics.slice(0, 5);
  const more = count - shown.length;
  const w = shown.length * s + (shown.length - 1) * gap + (more > 0 ? gap + 46 : 0);
  let x = cx - w / 2;
  for (const p of shown) { petTile(ctx, p, x, y, s); x += s + gap; }
  if (more > 0) text(ctx, `+${more}`, x + 4, y + s / 2 + 7, { size: 20, color: '#c9b8ff' });
}

function pill(ctx, s, x, y, { bg = 'rgba(255,255,255,.1)', color = '#fff', size = 13, align = 'center' } = {}) {
  ctx.font = `${size}px PDBlack`;
  const w = ctx.measureText(s).width + 22, h = size + 12;
  const x0 = align === 'center' ? x - w / 2 : x;
  rr(ctx, x0, y, w, h, h / 2); ctx.fillStyle = bg; ctx.fill();
  text(ctx, s, x0 + w / 2, y + h / 2 + size * .36, { size, align: 'center', color });
  return w;
}

/* the coin: paw side (orange) or cat side (purple), squashed horizontally while it spins */
function coin(ctx, cx, cy, r, side, scaleX = 1) {
  const sx = Math.max(.06, Math.abs(scaleX));
  ctx.save(); ctx.translate(cx, cy); ctx.scale(sx, 1);
  const dog = side === 'dog';
  const g = ctx.createRadialGradient(-r * .3, -r * .35, r * .1, 0, 0, r);
  g.addColorStop(0, dog ? '#ffd29a' : '#e2ccff'); g.addColorStop(1, dog ? '#e0700f' : '#6d28d9');
  ctx.shadowColor = dog ? 'rgba(255,159,67,.7)' : 'rgba(198,75,255,.7)'; ctx.shadowBlur = 24;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = r * .1; ctx.strokeStyle = dog ? '#fff1d6' : '#f3e8ff';
  ctx.beginPath(); ctx.arc(0, 0, r * .74, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#fff';
  if (dog) {
    ctx.beginPath(); ctx.ellipse(0, r * .14, r * .26, r * .21, 0, 0, Math.PI * 2); ctx.fill();
    for (const [x, y] of [[-.3, -.12], [-.11, -.3], [.11, -.3], [.3, -.12]]) { ctx.beginPath(); ctx.ellipse(x * r, y * r, r * .1, r * .12, 0, 0, Math.PI * 2); ctx.fill(); }
  } else {
    ctx.beginPath(); ctx.moveTo(-r * .38, -r * .05); ctx.lineTo(-r * .3, -r * .42); ctx.lineTo(-r * .08, -r * .2);
    ctx.lineTo(r * .08, -r * .2); ctx.lineTo(r * .3, -r * .42); ctx.lineTo(r * .38, -r * .05);
    ctx.quadraticCurveTo(r * .38, r * .34, 0, r * .36); ctx.quadraticCurveTo(-r * .38, r * .34, -r * .38, -r * .05); ctx.fill();
    ctx.fillStyle = '#6d28d9';
    ctx.beginPath(); ctx.arc(-r * .13, r * .02, r * .05, 0, Math.PI * 2); ctx.arc(r * .13, r * .02, r * .05, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

/* ---------- GIF encoding: one palette for every frame keeps colours steady ---------- */
function encodeGif(frames, W, H, { repeat = 0 } = {}) {
  const sample = new Uint8ClampedArray(W * H * 4 * Math.min(3, frames.length));
  const pick = [0, Math.floor(frames.length / 2), frames.length - 1].slice(0, Math.min(3, frames.length));
  pick.forEach((fi, k) => sample.set(frames[fi].data, k * W * H * 4));
  const palette = quantize(sample, 256);
  const gif = GIFEncoder();
  frames.forEach((f, i) => {
    gif.writeFrame(applyPalette(f.data, palette), W, H, { palette: i === 0 ? palette : undefined, delay: f.delay, repeat: i === 0 ? repeat : undefined });
  });
  gif.finish();
  return Buffer.from(gif.bytes());
}

/* ===================== COINFLIP RESULT (animated) ===================== */
async function coinflipEnd(d) {
  const W = 640, H = 340;
  const [ha, oa, ...pets] = await Promise.all([img(d.host.avatar), img(d.opp.avatar), ...d.pets.map(p => img(p.image))]);
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  const frames = [];
  const SPIN = 26, END = 16;
  for (let f = 0; f < SPIN + END; f++) {
    const done = f >= SPIN;
    const t = done ? 1 : f / SPIN;
    background(ctx, W, H, f * .15);
    text(ctx, d.bigOnly ? 'COINFLIP · TITANIC & GEMS ONLY' : 'COINFLIP', W / 2, 34, { size: 14, align: 'center', color: PINK2 });
    gradText(ctx, fmt(d.pot), W / 2, 76, 40);
    const hostDim = done && !d.hostWon, oppDim = done && d.hostWon;
    const pulse = done ? 14 + Math.sin((f - SPIN) * .8) * 8 : 0;
    avatar(ctx, ha, d.host.name, 128, 168, 54, { ring: done && d.hostWon ? GOLD : (d.hostSide === 'dog' ? ORANGE : VIOLET), glow: done && d.hostWon ? 26 + pulse : 0, dim: hostDim });
    avatar(ctx, oa, d.opp.name, W - 128, 168, 54, { ring: done && !d.hostWon ? GOLD : (d.hostSide === 'dog' ? VIOLET : ORANGE), glow: done && !d.hostWon ? 26 + pulse : 0, dim: oppDim });
    text(ctx, d.host.name, 128, 246, { size: 17, align: 'center', max: 200, color: hostDim ? '#6f6890' : '#fff' });
    text(ctx, fmt(d.hostValue), 128, 268, { size: 14, align: 'center', font: 'PDBold', color: hostDim ? '#6f6890' : '#c9b8ff' });
    text(ctx, d.opp.name, W - 128, 246, { size: 17, align: 'center', max: 200, color: oppDim ? '#6f6890' : '#fff' });
    text(ctx, fmt(d.oppValue), W - 128, 268, { size: 14, align: 'center', font: 'PDBold', color: oppDim ? '#6f6890' : '#c9b8ff' });
    /* spin: fast at first, slowing down, landing on the winning side */
    const turns = 7 * (1 - Math.pow(1 - t, 3));
    const angle = turns * Math.PI * 2;
    const face = done ? d.winnerSide : (Math.cos(angle) >= 0 ? d.winnerSide : (d.winnerSide === 'dog' ? 'cat' : 'dog'));
    const lift = done ? 0 : Math.sin(t * Math.PI) * 26;
    coin(ctx, W / 2, 168 - lift, 46, face, done ? 1 : Math.cos(angle));
    if (!done) text(ctx, 'VS', W / 2, 238, { size: 20, align: 'center', color: 'rgba(255,255,255,.35)' });
    if (done) {
      gradText(ctx, 'WINNER', W / 2, 248, 22, 'center', ['#fff', GOLD, PINK2]);
      const ax = d.hostWon ? W / 2 - 60 : W / 2 + 60, dir = d.hostWon ? -1 : 1;
      ctx.fillStyle = GOLD; ctx.beginPath(); ctx.moveTo(ax + dir * 10, 240); ctx.lineTo(ax - dir * 2, 232); ctx.lineTo(ax - dir * 2, 248); ctx.fill();
    }
    petsRow(ctx, pets, d.count, W / 2, 284, 42);
    frames.push({ data: ctx.getImageData(0, 0, W, H).data, delay: done ? (f === SPIN + END - 1 ? 4000 : 90) : 45 });
  }
  return { buffer: encodeGif(frames, W, H, { repeat: -1 }), name: 'coinflip.gif' };
}

/* ===================== GIVEAWAY WINNER (animated) ===================== */
async function giveawayEnd(d) {
  const W = 640, H = 320;
  const [wa, ...pets] = await Promise.all([img(d.winner.avatar), ...d.pets.map(p => img(p.image))]);
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  const colors = [PINK, PINK2, VIOLET, PURPLE, GOLD, '#4fd8ff', '#ffffff'];
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const bits = Array.from({ length: 70 }, () => ({ x: rnd() * W, y: rnd() * H, s: 4 + rnd() * 6, v: 1 + rnd() * 2, r: rnd() * 6, c: colors[Math.floor(rnd() * colors.length)] }));
  const frames = [], N = 30;
  for (let f = 0; f < N; f++) {
    const t = f / N;
    background(ctx, W, H, t * Math.PI * 2);
    /* prize: rays + the best pet bouncing */
    ctx.save(); ctx.translate(165, 158); ctx.rotate(t * Math.PI / 3);
    for (let k = 0; k < 16; k++) { ctx.rotate(Math.PI / 8); ctx.fillStyle = 'rgba(255,190,230,.07)'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(150, -14); ctx.lineTo(150, 14); ctx.fill(); }
    ctx.restore();
    const bob = Math.sin(t * Math.PI * 2) * 7;
    if (pets[0]) { ctx.save(); ctx.shadowColor = 'rgba(255,61,154,.7)'; ctx.shadowBlur = 30; petTile(ctx, pets[0], 95, 88 + bob, 140); ctx.restore(); }
    if (d.count > 1) text(ctx, `+${d.count - 1} more`, 165, 262, { size: 15, align: 'center', color: '#c9b8ff' });
    text(ctx, 'GIVEAWAY WINNER', 340, 72, { size: 16, color: PINK2 });
    avatar(ctx, wa, d.winner.name, 372, 128, 32, { ring: GOLD, glow: 18 + Math.sin(t * Math.PI * 4) * 6 });
    text(ctx, d.winner.name, 416, 138, { size: 26, max: 200 });
    gradText(ctx, fmt(d.value), 340, 210, 44, 'left', ['#ffffff', GOLD, PINK2]);
    text(ctx, `${d.host.name}'s giveaway · ${d.entrants} ${d.entrants === 1 ? 'entry' : 'entries'}`, 340, 244, { size: 14, font: 'PDBold', color: '#b9b2d6', max: 280 });
    /* confetti falling (loops) */
    for (const b of bits) {
      const y = (b.y + t * H * b.v) % (H + 20) - 10;
      ctx.save(); ctx.translate(b.x + Math.sin((t + b.r) * 6) * 6, y); ctx.rotate(b.r + t * 6); ctx.fillStyle = b.c; ctx.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2); ctx.restore();
    }
    frames.push({ data: ctx.getImageData(0, 0, W, H).data, delay: 70 });
  }
  return { buffer: encodeGif(frames, W, H, { repeat: 0 }), name: 'giveaway.gif' };
}

/* ===================== NEW COINFLIP ===================== */
async function coinflipNew(d) {
  const W = 640, H = 280;
  const [ha, ...pets] = await Promise.all([img(d.host.avatar), ...d.pets.map(p => img(p.image))]);
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  background(ctx, W, H);
  avatar(ctx, ha, d.host.name, 92, 104, 50, { ring: d.hostSide === 'dog' ? ORANGE : VIOLET, glow: 16 });
  coin(ctx, 130, 142, 17, d.hostSide);
  text(ctx, 'NEW COINFLIP', 170, 64, { size: 15, color: PINK2 });
  text(ctx, d.host.name, 170, 98, { size: 26, max: 300 });
  gradText(ctx, fmt(d.value), 170, 148, 44, 'left');
  text(ctx, `Join with ${fmt(d.low)} – ${fmt(d.high)}`, 172, 174, { size: 15, font: 'PDBold', color: '#b9b2d6' });
  if (d.bigOnly) {
    ctx.font = '12px PDBlack';
    const w = ctx.measureText('TITANIC & GEMS ONLY').width + 22;
    pill(ctx, 'TITANIC & GEMS ONLY', W - 24 - w, 24, { bg: 'rgba(255,209,102,.16)', color: GOLD, size: 12, align: 'left' });
  }
  petsRow(ctx, pets, d.count, W / 2, 200, 56);
  return { buffer: await canvas.encode('png'), name: 'coinflip.png' };
}

/* ===================== NEW GIVEAWAY ===================== */
async function giveawayNew(d) {
  const W = 640, H = 300;
  const [hostA, ...pets] = await Promise.all([img(d.host.avatar), ...d.pets.map(p => img(p.image))]);
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  background(ctx, W, H);
  ctx.save(); ctx.translate(160, 150);
  for (let k = 0; k < 16; k++) { ctx.rotate(Math.PI / 8); ctx.fillStyle = 'rgba(255,190,230,.08)'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(150, -14); ctx.lineTo(150, 14); ctx.fill(); }
  ctx.restore();
  if (pets[0]) { ctx.save(); ctx.shadowColor = 'rgba(255,61,154,.7)'; ctx.shadowBlur = 30; petTile(ctx, pets[0], 90, 80, 140); ctx.restore(); }
  pill(ctx, 'GIVEAWAY', 330, 44, { bg: PINK, size: 13, align: 'left' });
  text(ctx, d.pets[0] ? d.pets[0].name : 'Pets', 330, 112, { size: 24, max: 290 });
  gradText(ctx, fmt(d.value), 330, 164, 44, 'left');
  avatar(ctx, hostA, d.host.name, 344, 200, 14);
  text(ctx, `by ${d.host.name}`, 366, 206, { size: 15, font: 'PDBold', color: '#d9d3f2', max: 240 });
  const reqs = [d.minBet > 0 ? `MIN BET ${fmt(d.minBet)}` : '', d.minRank ? `${String(d.minRank).toUpperCase()}+ RANK` : ''].filter(Boolean);
  let x = 330; for (const r of reqs) x += pill(ctx, r, x, 228, { size: 11, align: 'left', color: '#e4def7' }) + 8;
  if (d.count > 1) petsRow(ctx, pets.slice(1), d.count - 1, 160, 236, 34, 6);
  return { buffer: await canvas.encode('png'), name: 'giveaway.png' };
}

/* ===================== JACKPOT WINNER ===================== */
async function jackpotEnd(d) {
  const W = 640, H = 300;
  const [wa, ...rest] = await Promise.all([img(d.winner.avatar), ...d.players.map(p => img(p.avatar))]);
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  background(ctx, W, H);
  avatar(ctx, wa, d.winner.name, 110, 120, 62, { ring: GOLD, glow: 30 });
  text(ctx, 'JACKPOT WINNER', 200, 66, { size: 15, color: PINK2 });
  text(ctx, d.winner.name, 200, 102, { size: 28, max: 400 });
  gradText(ctx, fmt(d.total), 200, 156, 48, 'left', ['#ffffff', GOLD, PINK2]);
  text(ctx, `won with ${Number(d.chance).toFixed(2)}% chance`, 202, 184, { size: 15, font: 'PDBold', color: '#b9b2d6' });
  const n = d.players.length, s = 34, gap = 10, w = n * s + (n - 1) * gap;
  let x = W / 2 - w / 2 + s / 2;
  d.players.forEach((p, i) => {
    avatar(ctx, rest[i], p.name, x, 236, s / 2, { ring: p.name === d.winner.name ? GOLD : null });
    text(ctx, `${((p.value / d.total) * 100).toFixed(0)}%`, x, 274, { size: 11, align: 'center', font: 'PDBold', color: '#b9b2d6' });
    x += s + gap;
  });
  return { buffer: await canvas.encode('png'), name: 'jackpot.png' };
}

const RENDER = { coinflip_end: coinflipEnd, coinflip_new: coinflipNew, giveaway_end: giveawayEnd, giveaway_new: giveawayNew, jackpot_end: jackpotEnd };

/* renders a card, gives up after 12 seconds */
async function renderCard(card) {
  const fn = card && RENDER[card.type];
  if (!fn) return null;
  return Promise.race([fn(card), new Promise((_, no) => setTimeout(() => no(new Error('card took too long')), 12000))]);
}

module.exports = { renderCard, fmt };
