'use strict';

/* =====================================================================
   TeamFlow — BGL Buy & Sell ticket bot
   Standalone Discord bot (no connection to petduel.win or any other site).
   - A panel with Buy / Sell / Support buttons
   - Each button opens a private ticket channel for that customer + staff
   - Staff can Claim and Close a ticket; a transcript is saved on close
   Honest by design: the bot NEVER posts fake "payment received / deal
   complete" messages. Staff confirm every deal by hand inside the ticket.
   ===================================================================== */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, Partials, PermissionFlagsBits, ChannelType,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, Events
} = require('discord.js');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
let banner = null; try { banner = require('./banner'); } catch (e) { console.warn('banner images off:', e.message); }
const TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const ONLY_GUILD = (process.env.GUILD_ID || '').trim();
const P = String(process.env.PREFIX || CONFIG.prefix || '!').trim() || '!';
const COLOR = parseInt(String(CONFIG.color || '#2bd38a').replace('#', ''), 16);
const BRAND = CONFIG.brand || 'TeamFlow';

if (!TOKEN) { console.error('DISCORD_TOKEN is missing in the .env file.'); process.exit(1); }

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel]
});

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const brandFooter = { text: `${BRAND} · ${CONFIG.subtitle || ''}`.trim() };
const embed = (title, desc) => new EmbedBuilder().setColor(COLOR).setFooter(brandFooter).setTimestamp()
  .setTitle(title || null).setDescription(desc || null);

const isStaff = member => Boolean(member) && (
  member.permissions.has(PermissionFlagsBits.ManageChannels) ||
  member.roles.cache.some(r => (CONFIG.staffRoleNames || []).some(n => norm(n) === norm(r.name)))
);
const staffRoleIds = guild => (CONFIG.staffRoleNames || [])
  .map(n => guild.roles.cache.find(r => norm(r.name) === norm(n))).filter(Boolean).map(r => r.id);

function findChannel(guild, id, name, types) {
  if (id) { const c = guild.channels.cache.get(String(id)); if (c) return c; }
  const want = norm(name);
  return guild.channels.cache.find(c => types.includes(c.type) && norm(c.name) === want) ||
    guild.channels.cache.find(c => types.includes(c.type) && norm(c.name).includes(want)) || null;
}
const ticketCategory = g => findChannel(g, CONFIG.ticketCategoryId, CONFIG.channelNames.ticketCategory, [ChannelType.GuildCategory]);
const completedChannel = g => findChannel(g, CONFIG.completedChannelId, CONFIG.channelNames.completed, [ChannelType.GuildText]);
const logChannel = g => findChannel(g, CONFIG.logChannelId, CONFIG.channelNames.log, [ChannelType.GuildText]);
const optionById = id => (CONFIG.options || []).find(o => o.id === id);

const DATA_DIR = (() => { for (const d of ['/app/data', path.join(__dirname, 'data')]) { try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch { /* next */ } } return __dirname; })();
const DEALS_FILE = path.join(DATA_DIR, 'deals.json');
function nextDealNo() {
  let store = { count: 0 };
  try { store = JSON.parse(fs.readFileSync(DEALS_FILE, 'utf8')); } catch { /* new file */ }
  store.count = (store.count || 0) + 1;
  try { fs.writeFileSync(DEALS_FILE, JSON.stringify(store)); } catch { /* ignore */ }
  return store.count;
}
const methodById = v => (CONFIG.methods || []).find(m => m.id === String(v || '').toLowerCase() || norm(m.label) === norm(v));

/* ---------------- the buy/sell panel ---------------- */
function panelEmbed() {
  const lines = (CONFIG.options || []).map(o => `${o.emoji || '•'} **${o.label}** — ${o.blurb}`);
  return embed(`${BRAND} — ${CONFIG.subtitle || 'Buy & Sell'}`,
    `Open a ticket below and a staff member will help you.\n\n${lines.join('\n')}\n\n` +
    `**Payment:** ${(CONFIG.paymentMethods || []).join(' · ')}\n` +
    `Please stay in the ticket until a staff member confirms your order. Never send anything to someone who DMs you first.`);
}
const panelButtons = () => new ActionRowBuilder().addComponents(
  (CONFIG.options || []).map(o => new ButtonBuilder().setCustomId(`tf_open:${o.id}`).setLabel(o.label)
    .setEmoji(o.emoji || '🎫').setStyle(o.id === 'buy' ? ButtonStyle.Success : o.id === 'sell' ? ButtonStyle.Primary : ButtonStyle.Secondary)));
/* with a rendered banner image when possible, otherwise a plain embed */
async function panelMessage() {
  const e = panelEmbed(), components = [panelButtons()];
  if (banner) {
    try { const buf = await banner.panelBanner(CONFIG); return { embeds: [e.setImage('attachment://panel.png')], components, files: [new AttachmentBuilder(buf, { name: 'panel.png' })] }; }
    catch (err) { console.warn('panel banner failed:', err.message); }
  }
  return { embeds: [e], components };
}

const ticketControls = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('tf_claim').setLabel('Claim').setEmoji('✋').setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId('tf_close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger));

/* ---------------- open a ticket ---------------- */
async function openTicket(interaction, optId) {
  const guild = interaction.guild;
  const opt = optionById(optId) || { id: optId, label: optId };
  const mine = guild.channels.cache.filter(c => c.type === ChannelType.GuildText && c.topic && c.topic.startsWith(`tf:${interaction.user.id}:`));
  if (mine.size >= (CONFIG.maxOpenTicketsPerUser || 2)) {
    return interaction.reply({ content: `You already have ${mine.size} open ticket(s). Please use those first.`, flags: 64 });
  }
  await interaction.deferReply({ flags: 64 });

  const category = ticketCategory(guild);
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
    ...staffRoleIds(guild).map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageMessages] }))
  ];
  let ch;
  try {
    ch = await guild.channels.create({
      name: `${opt.id}-${interaction.user.username}`.slice(0, 90).replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
      type: ChannelType.GuildText,
      parent: category ? category.id : undefined,
      topic: `tf:${interaction.user.id}:${opt.id}`,
      permissionOverwrites: overwrites
    });
  } catch (error) {
    return interaction.editReply({ content: `Could not open a ticket: ${error.message}. Ask an admin to give me **Manage Channels** and move my role up.` });
  }

  const e = embed(`${opt.emoji || ''} ${opt.label} ticket`.trim(),
    `Hey ${interaction.user}, thanks for opening a ticket!\n\n**Please tell us:**\n` +
    `• How much **${CONFIG.currency}** you want to ${opt.id === 'sell' ? 'sell' : opt.id === 'buy' ? 'buy' : 'trade'}\n` +
    `• Your preferred **payment method** (${(CONFIG.paymentMethods || []).join(' / ')})\n` +
    `• Your **GrowID** (Growtopia username)\n\n` +
    `A staff member will be with you shortly. Only deal with staff inside this ticket — never with someone who DMs you.`);
  const staffPing = staffRoleIds(guild).map(id => `<@&${id}>`).join(' ');
  const payload = { content: `${interaction.user} ${staffPing}`.trim(), embeds: [e], components: [ticketControls()] };
  if (banner) { try { payload.files = [new AttachmentBuilder(await banner.ticketBanner(CONFIG, opt), { name: 'ticket.png' })]; payload.embeds = [e.setImage('attachment://ticket.png')]; } catch { /* plain embed */ } }
  await ch.send(payload);
  await interaction.editReply({ content: `Your ticket is open: ${ch}` });
  const log = logChannel(guild);
  if (log && log.id !== ch.id) log.send({ embeds: [embed('🎫 Ticket opened', `**${opt.label}** · ${interaction.user} · ${ch}`)] }).catch(() => {});
}

/* ---------------- close a ticket (with transcript) ---------------- */
async function closeTicket(channel, byUser) {
  if (!channel.topic || !channel.topic.startsWith('tf:')) return false;
  const all = [];
  let before;
  for (let i = 0; i < 10; i++) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || !batch.size) break;
    all.push(...batch.values());
    before = batch.last().id;
  }
  all.reverse();
  const text = all.map(m => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content}` +
    (m.attachments.size ? ' ' + [...m.attachments.values()].map(a => a.url).join(' ') : '') + (m.embeds.length ? ' [embed]' : '')).join('\n');
  const log = logChannel(channel.guild);
  if (log) {
    const opener = channel.topic.split(':')[1];
    await log.send({
      embeds: [embed('🔒 Ticket closed', `**Ticket:** #${channel.name}\n**Opened by:** <@${opener}>\n**Closed by:** ${byUser}\n**Messages:** ${all.length}`)],
      files: [new AttachmentBuilder(Buffer.from(text || '(empty)', 'utf8'), { name: `${channel.name}.txt` })]
    }).catch(() => {});
  }
  setTimeout(() => channel.delete('Ticket closed').catch(() => {}), 4000);
  return true;
}

/* ================= !bglkur : back up, then rebuild the server as TeamFlow =================
   Admin only. Takes a JSON backup of every channel + its recent messages, then (after a confirm
   button) deletes the old channels and creates the TeamFlow channels. The backup is uploaded to the
   new log channel AND DMed to whoever ran it, so nothing is lost for good. */
const pendingWipe = new Map(); // key: `${guildId}:${userId}` -> { backup, at }
const isAdminMember = m => Boolean(m) && (m.permissions.has(PermissionFlagsBits.Administrator) || m.id === m.guild.ownerId);

async function buildBackup(guild) {
  const out = { guild: guild.name, id: guild.id, savedAt: new Date().toISOString(), channels: [] };
  const texts = [...guild.channels.cache.values()].filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement);
  for (const c of guild.channels.cache.values()) {
    const entry = { name: c.name, type: c.type, parent: c.parent ? c.parent.name : null, topic: c.topic || null, messages: [] };
    if (texts.includes(c)) {
      const batch = await c.messages.fetch({ limit: 100 }).catch(() => null);
      if (batch) entry.messages = [...batch.values()].reverse().map(m => ({ t: new Date(m.createdTimestamp).toISOString(), a: m.author.tag, c: m.content, att: [...m.attachments.values()].map(x => x.url), embeds: m.embeds.length }));
    }
    out.channels.push(entry);
  }
  return out;
}

async function doWipeAndSetup(guild, invoker, backup) {
  const keep = new Set((CONFIG.setup.keepChannelNames || []).map(norm));
  const before = [...guild.channels.cache.values()]; // snapshot of the OLD channels (these get deleted)
  const created = new Set();
  const mk = async opts => { const c = await guild.channels.create(opts); created.add(c.id); return c; };

  /* TeamFlow structure */
  const tfCat = await mk({ name: CONFIG.setup.infoCategory || 'TeamFlow', type: ChannelType.GuildCategory });
  const rules = await mk({ name: CONFIG.setup.rulesChannel || 'rules', type: ChannelType.GuildText, parent: tfCat.id });
  const prices = await mk({ name: CONFIG.setup.pricesChannel || 'prices', type: ChannelType.GuildText, parent: tfCat.id });
  const panel = await mk({ name: CONFIG.channelNames.panel || 'buy-sell', type: ChannelType.GuildText, parent: tfCat.id });
  const ticketsCat = await mk({ name: CONFIG.channelNames.ticketCategory || 'tickets', type: ChannelType.GuildCategory });
  const log = await mk({ name: CONFIG.channelNames.log || 'ticket-logs', type: ChannelType.GuildText, parent: ticketsCat.id,
    permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }, ...staffRoleIds(guild).map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel] }))] });
  const completed = await mk({ name: CONFIG.channelNames.completed || 'completed-deals', type: ChannelType.GuildText, parent: tfCat.id,
    permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages] }, ...staffRoleIds(guild).map(id => ({ id, allow: [PermissionFlagsBits.SendMessages] }))] });

  const file = new AttachmentBuilder(Buffer.from(JSON.stringify(backup, null, 2), 'utf8'), { name: `backup-${guild.id}-${Date.now()}.json` });
  await log.send({ embeds: [embed('🗄️ Server backup', `Backup of the old server taken before the TeamFlow setup by ${invoker}. Keep this file safe.`)], files: [file] }).catch(() => {});
  await rules.send({ embeds: [embed(`${BRAND} — Rules`, CONFIG.setup.rulesText || 'Rules')] }).catch(() => {});
  await prices.send({ embeds: [embed(`${BRAND} — Prices`, CONFIG.setup.pricesText || 'Prices')] }).catch(() => {});
  await panel.send(await panelMessage()).catch(() => {});
  await completed.send({ embeds: [embed('✅ Completed deals', 'Finished buys and sells are logged here by staff with `!done`. Every entry is a real deal handled inside a ticket.')] }).catch(() => {});

  /* delete the old channels */
  let deleted = 0, failed = 0;
  for (const c of before) {
    if (created.has(c.id) || keep.has(norm(c.name))) continue;
    try { await c.delete('TeamFlow setup (!bglkur)'); deleted++; } catch { failed++; }
  }
  return { deleted, failed, panel, log };
}

/* ---------------- events ---------------- */
client.once(Events.ClientReady, c => {
  console.log(`\n  Logged in as ${c.user.tag} — ${BRAND} ${CONFIG.subtitle || ''}\n`);
  const presence = () => c.user.setPresence({ activities: [{ name: `${CONFIG.currency} Buy & Sell · open a ticket`, type: 3 }], status: 'online' });
  presence();
  setInterval(presence, 10 * 60 * 1000);
});

client.on(Events.MessageCreate, async msg => {
  if (!msg.guild || msg.author.bot || (ONLY_GUILD && msg.guild.id !== ONLY_GUILD)) return;
  if (!msg.content.startsWith(P)) return;
  const [cmd, ...args] = msg.content.slice(P.length).trim().split(/\s+/);
  const name = (cmd || '').toLowerCase();
  const staff = isStaff(msg.member);

  if (name === 'panel') {
    if (!staff) return;
    await msg.channel.send(await panelMessage()).catch(e => msg.reply(`Could not post the panel: ${e.message}`));
    msg.delete().catch(() => {});
    return;
  }
  if (name === 'bglkur' || name === 'setup') {
    if (!isAdminMember(msg.member)) return msg.reply('Only a server admin / owner can run this.');
    const status = await msg.channel.send({ embeds: [embed('🗄️ Backing up the server…', 'Reading every channel and its recent messages. This can take a moment.')] }).catch(() => null);
    let backup;
    try { backup = await buildBackup(msg.guild); }
    catch (error) { return msg.channel.send({ embeds: [embed('Backup failed', `Nothing was changed. ${error.message}`)] }); }
    const file = new AttachmentBuilder(Buffer.from(JSON.stringify(backup, null, 2), 'utf8'), { name: `backup-${msg.guild.id}.json` });
    await msg.author.send({ content: 'TeamFlow setup — here is the backup of your server (channels + recent messages). Keep it safe.', files: [file] }).catch(() => {});
    pendingWipe.set(`${msg.guild.id}:${msg.author.id}`, { backup, at: Date.now() });
    const channelCount = msg.guild.channels.cache.size;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('bgl_confirm').setLabel('Yes, wipe & set up TeamFlow').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('bgl_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary));
    if (status) status.delete().catch(() => {});
    await msg.channel.send({ embeds: [embed('⚠️ Confirm server wipe',
      `Backup saved (also DMed to you).

This will **delete ${channelCount} channels** (everything except: ${(CONFIG.setup.keepChannelNames || []).map(n => '`' + n + '`').join(', ') || 'none'}) and set up the **${BRAND}** channels: rules, prices, buy-sell panel, tickets, ticket-logs.

**This cannot be undone.** Press the button within 2 minutes.`)], components: [row] });
    return;
  }
  if (name === 'rate') {
    if (!staff) return;
    const v = Number(args[0]);
    if (v > 0) { CONFIG.rate.bglToEur = v; return msg.reply({ embeds: [embed('Rate updated (this session)', `1 BGL = ${CONFIG.rate.currencySymbol || '€'}${v}. To make it permanent, change \`rate.bglToEur\` in config.json.`)] }); }
    return msg.reply({ embeds: [embed('Current rate', `1 BGL = ${CONFIG.rate.currencySymbol || '€'}${CONFIG.rate.bglToEur}`)] });
  }
  if (name === 'done' || name === 'deal') {
    if (!staff) return msg.reply('Only staff can log a completed deal.');
    const inTicket = msg.channel.topic && msg.channel.topic.startsWith('tf:');
    const type = /^(buy|sell|b|s)$/i.test(args[0] || '') ? (/^b/i.test(args[0]) ? 'buy' : 'sell') : null;
    if (!type) return msg.reply(`Usage: \`${P}done <buy|sell> <bgl> [eur] [@customer] [method]\`  e.g. \`${P}done buy 5 20 @user usdt\``);
    const nums = args.filter(a => /^[0-9]+(\.[0-9]+)?$/.test(a)).map(Number);
    const bgl = nums[0];
    if (!(bgl > 0)) return msg.reply('Enter the BGL amount, e.g. `' + P + 'done buy 5`.');
    const eur = nums[1] != null ? nums[1] : Math.round(bgl * (CONFIG.rate.bglToEur || 0) * 100) / 100;
    const method = methodById(args.find(a => methodById(a))) || (CONFIG.methods || [])[0] || { id: '', label: '—' };
    let customer = msg.mentions.users.first();
    if (!customer && inTicket) { const opener = msg.channel.topic.split(':')[1]; customer = await client.users.fetch(opener).catch(() => null); }
    const completed = completedChannel(msg.guild);
    if (!completed) return msg.reply('No completed-deals channel found. Run `' + P + 'bglkur` or create a channel named `' + (CONFIG.channelNames.completed || 'completed-deals') + '`.');
    const deal = {
      id: String(nextDealNo()).padStart(4, '0'), type, bgl: String(bgl), eur: String(eur), method: method.id,
      customer: customer ? (customer.globalName || customer.username) : 'Customer',
      customerAvatar: customer ? customer.displayAvatarURL({ extension: 'png', size: 128 }) : null,
      staff: msg.author.globalName || msg.author.username, staffAvatar: msg.author.displayAvatarURL({ extension: 'png', size: 128 }),
      date: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
    };
    try {
      let files = null;
      if (banner) { try { files = [new AttachmentBuilder(await banner.dealCard(deal, CONFIG), { name: 'deal.gif' })]; } catch (e) { console.warn('deal card failed:', e.message); } }
      const e = embed(null, `**${type === 'buy' ? 'Bought' : 'Sold'} ${deal.bgl} BGL** for ${CONFIG.rate.currencySymbol || '€'}${deal.eur} via ${method.label} · ${customer ? `<@${customer.id}>` : 'customer'} · handled by ${msg.author}`).setTitle(`✅ Deal #${deal.id} completed`);
      await completed.send(files ? { embeds: [e.setImage('attachment://deal.gif')], files } : { embeds: [e] });
      await msg.reply({ embeds: [embed('Logged ✅', `Deal #${deal.id} posted in ${completed}.`)] });
    } catch (error) { msg.reply(`Could not log the deal: ${error.message}`); }
    return;
  }
  if (name === 'close') {
    if (!staff) return msg.reply('Only staff can close tickets.');
    if (!(await closeTicket(msg.channel, msg.author))) return msg.reply('This is not a ticket channel.');
    msg.channel.send({ embeds: [embed('🔒 Closing', 'Saving transcript and closing in a few seconds…')] }).catch(() => {});
    return;
  }
  if ((name === 'add' || name === 'remove') && staff && msg.channel.topic && msg.channel.topic.startsWith('tf:')) {
    const user = msg.mentions.users.first();
    if (!user) return msg.reply(`Usage: \`${P}${name} @user\``);
    await msg.channel.permissionOverwrites.edit(user.id, { ViewChannel: name === 'add', SendMessages: name === 'add', ReadMessageHistory: name === 'add' }).catch(() => {});
    return msg.reply(`${name === 'add' ? 'Added' : 'Removed'} ${user}.`);
  }
  if (name === 'help') {
    return msg.reply({ embeds: [embed(`${BRAND} commands`,
      `**Admin:** \`${P}bglkur\` (back up + wipe the old channels and set up TeamFlow)\n` +
      `**Staff:** \`${P}panel\` · \`${P}done <buy|sell> <bgl> [eur] [@customer] [method]\` (log a completed deal) · \`${P}rate [eur]\` · \`${P}close\` · \`${P}add @user\` · \`${P}remove @user\`\n` +
      `Customers just press the buttons on the panel.`)] });
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (!interaction.isButton() || !interaction.guild) return;
    const [action, arg] = interaction.customId.split(':');
    if (ONLY_GUILD && interaction.guild.id !== ONLY_GUILD) return;

    if (action === 'bgl_cancel') {
      pendingWipe.delete(`${interaction.guild.id}:${interaction.user.id}`);
      return interaction.update({ embeds: [embed('Cancelled', 'Nothing was changed.')], components: [] }).catch(() => {});
    }
    if (action === 'bgl_confirm') {
      if (!isAdminMember(interaction.member)) return interaction.reply({ content: 'Only a server admin / owner can confirm.', flags: 64 });
      const key = `${interaction.guild.id}:${interaction.user.id}`;
      const pend = pendingWipe.get(key);
      if (!pend || Date.now() - pend.at > 120000) { pendingWipe.delete(key); return interaction.reply({ content: 'This confirmation expired. Run the command again.', flags: 64 }); }
      pendingWipe.delete(key);
      await interaction.update({ embeds: [embed('🧹 Setting up TeamFlow…', 'Creating channels and removing the old ones. Give me a moment.')], components: [] }).catch(() => {});
      try {
        const r = await doWipeAndSetup(interaction.guild, interaction.user, pend.backup);
        await r.log.send({ embeds: [embed('✅ TeamFlow set up', `${r.deleted} old channel(s) removed${r.failed ? `, ${r.failed} could not be deleted (Community server channels are protected — remove them by hand)` : ''}. Panel is in ${r.panel}.`)] }).catch(() => {});
      } catch (error) {
        await interaction.channel?.send?.({ embeds: [embed('Setup error', `${error.message}. Make sure my role is at the TOP with **Administrator** (or Manage Channels + Manage Roles).`)] }).catch(() => {});
      }
      return;
    }

    if (action === 'tf_open') return openTicket(interaction, arg);

    if (action === 'tf_claim') {
      if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can claim tickets.', flags: 64 });
      await interaction.reply({ embeds: [embed(null, `✋ Claimed by ${interaction.user}. They will help you from here.`)] });
      return;
    }
    if (action === 'tf_close') {
      if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can close tickets.', flags: 64 });
      await interaction.reply({ embeds: [embed('🔒 Closing', 'Saving transcript and closing in a few seconds…')] });
      await closeTicket(interaction.channel, interaction.user);
      return;
    }
  } catch (error) {
    console.warn('Interaction error:', error.message);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) interaction.reply({ content: 'Something went wrong.', flags: 64 }).catch(() => {});
  }
});

client.on('error', e => console.warn('Client error:', e.message));
client.login(TOKEN).catch(e => { console.error('Login failed:', e.message); process.exit(1); });
