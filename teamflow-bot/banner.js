'use strict';

/* TeamFlow image banners for the panel and tickets (drawn with @napi-rs/canvas).
   Each function returns a PNG Buffer or throws; the bot falls back to a plain embed on failure. */

const path = require('path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

GlobalFonts.registerFromPath(path.join(__dirname, 'fonts', 'InterDisplay-Black.otf'), 'TFBlack');
GlobalFonts.registerFromPath(path.join(__dirname, 'fonts', 'InterDisplay-Bold.otf'), 'TFBold');

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function hexToRgb(h) {
  const v = String(h || '#2bd38a').replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgb = a => `rgb(${a[0]},${a[1]},${a[2]})`;

function background(ctx, W, H, accent) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#0f1a17'); g.addColorStop(1, '#0a0f14');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const blob = (x, y, r, c, a) => {
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${a})`); rg.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  };
  blob(W * 0.16, H * 0.1, W * 0.5, accent, 0.33);
  blob(W * 0.92, H * 1.0, W * 0.45, [77, 163, 255], 0.18);
  ctx.save(); ctx.globalAlpha = 0.05; ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.moveTo(W * 0.6, 0); ctx.lineTo(W * 0.72, 0); ctx.lineTo(W * 0.5, H); ctx.lineTo(W * 0.38, H); ctx.fill(); ctx.restore();
  ctx.fillStyle = rgb(accent); ctx.fillRect(0, H - 5, W, 5);
}

function text(ctx, s, x, y, { size = 20, font = 'TFBlack', color = '#fff', align = 'left' } = {}) {
  ctx.font = `${size}px ${font}`; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color; ctx.fillText(String(s ?? ''), x, y);
}

function gradText(ctx, s, x, y, size, accent, align = 'left') {
  ctx.font = `${size}px TFBlack`; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  const w = ctx.measureText(s).width, x0 = align === 'left' ? x : align === 'center' ? x - w / 2 : x - w;
  const g = ctx.createLinearGradient(x0, 0, x0 + w, 0);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.55, rgb(mix(accent, [255, 255, 255], 0.35))); g.addColorStop(1, rgb(accent));
  ctx.save(); ctx.shadowColor = `rgba(${accent[0]},${accent[1]},${accent[2]},0.55)`; ctx.shadowBlur = 18; ctx.fillStyle = g; ctx.fillText(s, x, y); ctx.restore();
}

/* a stylized blue gem (BGL = blue gem lock motif) */
function gem(ctx, cx, cy, s) {
  ctx.save(); ctx.translate(cx, cy);
  const g = ctx.createLinearGradient(0, -s, 0, s);
  g.addColorStop(0, '#9fe9ff'); g.addColorStop(1, '#1f7fe0');
  ctx.shadowColor = 'rgba(79,163,255,0.7)'; ctx.shadowBlur = 30;
  ctx.beginPath();
  ctx.moveTo(0, -s); ctx.lineTo(s * 0.92, -s * 0.28); ctx.lineTo(s * 0.58, s); ctx.lineTo(-s * 0.58, s); ctx.lineTo(-s * 0.92, -s * 0.28); ctx.closePath();
  ctx.fillStyle = g; ctx.fill(); ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = s * 0.03;
  ctx.beginPath(); ctx.moveTo(-s * 0.92, -s * 0.28); ctx.lineTo(s * 0.92, -s * 0.28); ctx.moveTo(0, -s); ctx.lineTo(-s * 0.4, -s * 0.28); ctx.lineTo(0, s); ctx.moveTo(0, -s); ctx.lineTo(s * 0.4, -s * 0.28); ctx.lineTo(0, s); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath(); ctx.moveTo(-s * 0.22, -s * 0.9); ctx.lineTo(0, -s * 0.5); ctx.lineTo(-s * 0.1, -s * 0.52); ctx.closePath(); ctx.fill();
  ctx.restore();
}

function chip(ctx, label, x, y, accent) {
  ctx.font = '19px TFBlack';
  const w = ctx.measureText(label).width + 40, h = 40;
  rr(ctx, x, y, w, h, h / 2); ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fill();
  ctx.strokeStyle = `rgba(${accent[0]},${accent[1]},${accent[2]},0.5)`; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.beginPath(); ctx.arc(x + 20, y + h / 2, 5, 0, Math.PI * 2); ctx.fillStyle = rgb(accent); ctx.fill();
  text(ctx, label, x + 34, y + h / 2 + 7, { size: 19, color: '#eafff7' });
  return w;
}

function panelBanner(cfg) {
  const accent = hexToRgb(cfg.color);
  const W = 1000, H = 340, c = createCanvas(W, H), ctx = c.getContext('2d');
  background(ctx, W, H, accent);
  gem(ctx, 820, 150, 92);
  for (const [gx, gy, gs] of [[700, 70, 26], [910, 250, 30], [760, 268, 18]]) gem(ctx, gx, gy, gs);
  text(ctx, (cfg.brand || 'TeamFlow').toUpperCase(), 64, 92, { size: 20, color: rgb(mix(accent, [255, 255, 255], 0.3)) });
  gradText(ctx, (cfg.brand || 'TeamFlow'), 60, 168, 82, accent);
  text(ctx, (cfg.subtitle || 'BGL Buy & Sell').toUpperCase(), 66, 212, { size: 30, font: 'TFBlack', color: '#eafff7' });
  text(ctx, 'Open a ticket below · fast, safe, staff-handled trades', 66, 246, { size: 19, font: 'TFBold', color: '#9fb6ad' });
  let x = 66; const y = 268;
  for (const o of (cfg.options || [])) x += chip(ctx, o.label, x, y, accent) + 10;
  return c.encode('png');
}

function ticketBanner(cfg, opt) {
  const accent = hexToRgb(cfg.color);
  const W = 1000, H = 190, c = createCanvas(W, H), ctx = c.getContext('2d');
  background(ctx, W, H, accent);
  gem(ctx, 900, 95, 56);
  text(ctx, (cfg.brand || 'TeamFlow').toUpperCase() + ' · TICKET', 54, 70, { size: 18, color: rgb(mix(accent, [255, 255, 255], 0.3)) });
  gradText(ctx, opt.label || 'Ticket', 50, 132, 54, accent);
  text(ctx, 'A staff member will be with you shortly', 54, 166, { size: 18, font: 'TFBold', color: '#9fb6ad' });
  return c.encode('png');
}

module.exports = { panelBanner, ticketBanner };
