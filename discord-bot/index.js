'use strict';

/* =====================================================================
   PetDuel Discord bot
   - everything the old bot did: tickets, giveaways, coinflip, announce,
     moderation and logs
   - connected to petduel.win: account linking, rank roles, live site
     events, withdraw approvals and every admin panel action
   ===================================================================== */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { io: ioClient } = require('socket.io-client');
const {
  Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, PermissionFlagsBits,
  ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, Events
} = require('discord.js');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const BOT_KEY = (process.env.BOT_KEY || '').trim();
const ONLY_GUILD = (process.env.GUILD_ID || '').trim();
const SITE = String(CONFIG.siteUrl || 'https://petduel.win').replace(/\/+$/, '');
const COLOR = parseInt(String(CONFIG.color || '#F5A623').replace('#', ''), 16);
const CH = CONFIG.channels;
const EPHEMERAL = 64;
/* commands start with this prefix (config.json "prefix", or PREFIX in .env); default ! */
const P = String(process.env.PREFIX || CONFIG.prefix || '!').trim() || '!';

if (!TOKEN) {
  console.error('DISCORD_TOKEN is missing in the .env file.');
  process.exit(1);
}
if (!BOT_KEY) console.warn('BOT_KEY is missing in the .env file: site features (link, ranks, withdrawals, /site ...) will not work.');

/* ---------------- small helpers ---------------- */

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const loadJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch { return fallback; } };
const saveJson = (file, data) => fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));

/* PS99 values are diamonds: 28930000000 -> 28.93B */
const fmt = n => {
  const v = Number(n || 0), a = Math.abs(v);
  for (const [d, u] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (a >= d) return (v / d).toLocaleString('en-US', { maximumFractionDigits: 2 }) + u;
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
};
const short = n => {
  n = Number(n || 0);
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e9) return s + +(a / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return s + +(a / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return s + +(a / 1e3).toFixed(1) + 'K';
  return fmt(n);
};
const gem = '💎';
const ago = ts => {
  if (!ts) return 'never';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)} h ago`;
  return `${Math.floor(m / 1440)} d ago`;
};
const petLabel = p => p.name;
const embed = (title, description) => {
  const e = new EmbedBuilder().setColor(COLOR).setFooter({ text: 'PetDuel · petduel.win' }).setTimestamp();
  if (title) e.setTitle(title);
  if (description) e.setDescription(description);
  return e;
};
const actorOf = interaction => `${interaction.user.username}`;

/* ---------------- petduel.win API ---------------- */

async function site(method, apiPath, body, actor) {
  if (!BOT_KEY) throw new Error('The bot has no BOT_KEY, so it cannot reach the site.');
  const res = await fetch(SITE + apiPath, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Bot-Key': BOT_KEY, 'X-Bot-Actor': actor || 'bot' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: `Site error (HTTP ${res.status})` }; }
  if (!res.ok) throw new Error(data.error || `Site error (HTTP ${res.status})`);
  return data;
}

/* ---------------- Discord client ---------------- */

const BASE_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildModeration];
const PRIVILEGED = [GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent];
let client = null;
let privileged = true;

function makeClient(withPrivileged) {
  const c = new Client({
    intents: withPrivileged ? [...BASE_INTENTS, ...PRIVILEGED] : BASE_INTENTS,
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember]
  });
  attachHandlers(c);
  return c;
}

async function start() {
  client = makeClient(true);
  try {
    await client.login(TOKEN);
  } catch (error) {
    if (/disallowed intents/i.test(String(error && error.message))) {
      console.warn('\n  Server Members Intent / Message Content Intent are off in the Developer Portal.');
      console.warn('  !!! Prefix commands (!help, !link ...) NEED the Message Content Intent: without it the bot cannot read commands.');
      console.warn('  Join/leave logs and deleted message text are also disabled.');
      console.warn('  Turn them on: discord.com/developers > your app > Bot > Privileged Gateway Intents.\n');
      privileged = false;
      try { client.destroy(); } catch { /* ignore */ }
      client = makeClient(false);
      await client.login(TOKEN);
    } else {
      console.error('Login failed:', error.message);
      if (/token/i.test(error.message)) console.error('Check DISCORD_TOKEN in the .env file.');
      process.exit(1);
    }
  }
}

/* ---------------- server setup: channels, roles, panels ---------------- */

const staffRoles = guild => guild.roles.cache.filter(r =>
  !r.managed && r.id !== guild.id && (CONFIG.staffRoleNames.includes(r.name) || r.permissions.has(PermissionFlagsBits.ManageMessages)));

/* finds a channel: by the ID in config.json (channelIds), otherwise by name, ignoring emojis and
   decorations, so "🪙┃coinflips" or "coinflips-🪙" both match "coinflips" */
const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function findChannel(guild, name) {
  if (!guild) return null;
  const key = Object.keys(CH).find(k => CH[k] === name);
  const id = key && CONFIG.channelIds && CONFIG.channelIds[key];
  if (id) {
    const byId = guild.channels.cache.get(String(id));
    if (byId) return byId;
  }
  const text = guild.channels.cache.filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement);
  const want = norm(name);
  return text.find(c => c.name === name) || text.find(c => norm(c.name) === want) ||
    text.find(c => norm(c.name).endsWith(want) || norm(c.name).startsWith(want)) || null;
}

let siteRanks = [];

async function ensureRoles(guild) {
  const want = [...siteRanks.map(r => ({ name: r.name, color: r.color })), { name: CONFIG.linkedRole, color: '#00EFA0' }];
  for (const r of want) {
    if (guild.roles.cache.find(x => x.name === r.name)) continue;
    try { await guild.roles.create({ name: r.name, color: r.color, reason: 'PetDuel rank role' }); }
    catch (error) { console.warn(`Could not create role ${r.name}: ${error.message}`); }
  }
  await removeOldRoles(guild);
  await setRoleIcons(guild);
}

/* roles listed in config.json "deleteRoles" (Red Team, Blue Team...) are deleted, whatever their emoji or case */
async function removeOldRoles(guild) {
  const kill = (CONFIG.deleteRoles || []).map(norm).filter(Boolean);
  if (!kill.length) return;
  for (const role of guild.roles.cache.values()) {
    if (role.managed || role.id === guild.id || !kill.includes(norm(role.name))) continue;
    try { await role.delete('PetDuel: removed old role'); console.log(`  Deleted role "${role.name}"`); }
    catch (error) { console.warn(`  Could not delete role "${role.name}": ${error.message} (move the bot's role above it)`); }
  }
}

/* every role that has a picture in role-icons/<role name>.png gets it as its role icon.
   Discord shows role icons only on servers with Boost level 2 (7+ boosts). Roles that already have an icon keep it,
   unless config.json "replaceRoleIcons" is true. */
async function setRoleIcons(guild) {
  if (CONFIG.roleIcons === false) return;
  if (!guild.features.includes('ROLE_ICONS')) {
    console.log(`  Role icons skipped in "${guild.name}": the server needs Boost level 2 for role icons.`);
    return;
  }
  const dir = path.join(__dirname, 'role-icons');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.png')); } catch { return; }
  let done = 0;
  for (const f of files) {
    const role = guild.roles.cache.find(r => norm(r.name) === norm(f.slice(0, -4)));
    if (!role || role.managed || (role.icon && !CONFIG.replaceRoleIcons)) continue;
    try { await role.setIcon(fs.readFileSync(path.join(dir, f)), 'PetDuel role icon'); done++; }
    catch (error) { console.warn(`  Could not set the icon of "${role.name}": ${error.message}`); }
  }
  if (done) console.log(`  Role icons set: ${done}`);
}

/* posts a message only once: when the channel has nothing from the bot yet */
async function postOnce(channel, payload) {
  if (!channel) return;
  try {
    const recent = await channel.messages.fetch({ limit: 20 });
    if (recent.some(m => m.author.id === channel.client.user.id)) return;
    await channel.send(payload);
  } catch (error) { console.warn(`Could not post in #${channel.name}: ${error.message}`); }
}

const ticketPanel = () => ({
  embeds: [embed('🎫 Support Tickets', 'Need help with a deposit, a withdrawal or anything else?\nPress the button below and a private channel opens with our staff.\n\n**Tip:** link your account with `!link` first so staff can see your Pet Duel info.')],
  components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket_open').setLabel('Open a ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary))]
});

async function setupGuild(guild) {
  if (ONLY_GUILD && guild.id !== ONLY_GUILD) return;
  try {
    await guild.members.fetchMe();
    await guild.roles.fetch();
    await guild.channels.fetch();
    /* the bot never creates channels: it uses the ones that already exist */
    const missing = Object.keys(CH).filter(k => !findChannel(guild, CH[k]));
    if (missing.length) console.log(`  Not found in "${guild.name}" (ok, those messages are skipped or go to another channel): ${missing.map(k => CH[k]).join(', ')}`);
    await ensureRoles(guild);

    if (!CONFIG.postInfoMessages) { await registerCommands(guild); console.log(`Ready in "${guild.name}".`); return; }
    await postOnce(findChannel(guild, CH.openTicket), ticketPanel());
    await postOnce(findChannel(guild, CH.website), {
      embeds: [embed('🌐 petduel.win', `**Pet Simulator 99 PvP duels**: coinflip, jackpot, giveaways and events.\n\n👉 **${SITE}**\n\nLink your account with \`!link\` (get the code on the site: Profile > Link Discord) to get your rank role!`)],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Open Pet Duel').setStyle(ButtonStyle.Link).setURL(SITE))]
    });
    await postOnce(findChannel(guild, CH.rules), { embeds: [embed('📜 Server Rules', [
      '1. Be respectful. No hate speech, threats or harassment.',
      '2. No scamming, impersonating staff or bots, or asking for pets in DMs.',
      '3. No spam, advertising or links to other sites.',
      '4. Only trade with the deposit bot shown on petduel.win.',
      '5. You must be 18+ and allowed to use Pet Duel where you live.',
      '6. Staff will **never** DM you asking for pets or your password.',
      '',
      '⚠️ Pet Duel is not responsible for item losses due to rollbacks, bans or trade restrictions by Pet Simulator 99 / BIG Games moderators or Roblox. **Deposit and play at your own risk.**',
      '🎮 Pet Duel is for entertainment only. Gems and values have no monetary value.'
    ].join('\n'))] });
    await postOnce(findChannel(guild, CH.howToPlay), { embeds: [embed('🎮 How to play', [
      `**1. Log in** on ${SITE} with your Roblox account and choose a nickname.`,
      '**2. Deposit:** Wallet > Deposit. Join the bot\'s private server and trade your pets (add at least 6 food items). An admin confirms it.',
      '**3. Play:** create or join a **Coinflip** (pick paw or cat), or join the **Jackpot**: the bigger your share, the bigger your chance.',
      '**4. Withdraw:** Wallet > select pets > Withdraw. An admin sends them to you in game.',
      '**5. Link Discord:** Profile > Link Discord on the site, then `!link CODE` here for your rank role.',
      '',
      'Every result is provably fair. Questions? Open a ticket.'
    ].join('\n'))] });

    await registerCommands(guild);
    console.log(`Ready in "${guild.name}".`);
  } catch (error) {
    console.error(`Setup failed in "${guild.name}": ${error.message}`);
    if (/Missing Permissions|Missing Access/i.test(error.message)) console.error('  Give the bot the Administrator permission (or Manage Channels + Manage Roles).');
  }
}

/* ---------------- slash commands ---------------- */

const STAFF = PermissionFlagsBits.ManageMessages;
const ADMIN = PermissionFlagsBits.ManageGuild;

function commandList() {
  const pet = o => o.setName('pet').setDescription('Pet from the site catalog').setRequired(true).setAutocomplete(true);
  return [
    new SlashCommandBuilder().setName('help').setDescription('Show all commands'),
    new SlashCommandBuilder().setName('website').setDescription('Link to petduel.win'),
    new SlashCommandBuilder().setName('link').setDescription('Link your Pet Duel account (get the code on the site: Profile > Link Discord)')
      .addStringOption(o => o.setName('code').setDescription('Code from the site, like PD-1A2B3C').setRequired(true)),
    new SlashCommandBuilder().setName('unlink').setDescription('Unlink your Pet Duel account'),
    new SlashCommandBuilder().setName('profile').setDescription('Pet Duel stats of a player')
      .addUserOption(o => o.setName('user').setDescription('Discord member (must be linked)'))
      .addStringOption(o => o.setName('nickname').setDescription('Nickname on the site')),
    new SlashCommandBuilder().setName('rank').setDescription('Show your rank and update your rank role'),
    new SlashCommandBuilder().setName('leaderboard').setDescription('Top players on Pet Duel')
      .addStringOption(o => o.setName('type').setDescription('Which list').addChoices(
        { name: 'Top Profit', value: 'profit' }, { name: 'Top Wager', value: 'totalBet' }, { name: 'Least Profit', value: 'least' })),
    new SlashCommandBuilder().setName('stats').setDescription('Live Pet Duel stats'),
    new SlashCommandBuilder().setName('games').setDescription('Open coinflips you can join right now'),
    new SlashCommandBuilder().setName('coinflip').setDescription('Flip a coin for fun')
      .addStringOption(o => o.setName('side').setDescription('Your side').addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' })),

    new SlashCommandBuilder().setName('announce').setDescription('Post an announcement').setDefaultMemberPermissions(ADMIN)
      .addStringOption(o => o.setName('title').setDescription('Title').setRequired(true))
      .addStringOption(o => o.setName('message').setDescription('Text (use \\n for new lines)').setRequired(true))
      .addBooleanOption(o => o.setName('everyone').setDescription('Ping @everyone'))
      .addBooleanOption(o => o.setName('site').setDescription('Also show it in the banner on petduel.win')),
    new SlashCommandBuilder().setName('ticketpanel').setDescription('Post the ticket button here').setDefaultMemberPermissions(ADMIN),
    new SlashCommandBuilder().setName('giveaway').setDescription('Discord giveaways').setDefaultMemberPermissions(ADMIN)
      .addSubcommand(s => s.setName('start').setDescription('Start a giveaway in #giveaways')
        .addStringOption(o => o.setName('prize').setDescription('Prize').setRequired(true))
        .addIntegerOption(o => o.setName('minutes').setDescription('Duration in minutes').setRequired(true).setMinValue(1).setMaxValue(60 * 24 * 30))
        .addIntegerOption(o => o.setName('winners').setDescription('Number of winners').setMinValue(1).setMaxValue(20))
        .addBooleanOption(o => o.setName('linked_only').setDescription('Only members with a linked Pet Duel account can join')))
      .addSubcommand(s => s.setName('end').setDescription('End a giveaway now').addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true)))
      .addSubcommand(s => s.setName('reroll').setDescription('Pick new winners').addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true))),
    new SlashCommandBuilder().setName('clear').setDescription('Delete messages').setDefaultMemberPermissions(STAFF)
      .addIntegerOption(o => o.setName('amount').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName('timeout').setDescription('Timeout a member').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
      .addIntegerOption(o => o.setName('minutes').setDescription('Minutes').setRequired(true).setMinValue(1).setMaxValue(40320))
      .addStringOption(o => o.setName('reason').setDescription('Reason')),
    new SlashCommandBuilder().setName('kick').setDescription('Kick a member').setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
      .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason')),
    new SlashCommandBuilder().setName('ban').setDescription('Ban a member').setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason')),

    new SlashCommandBuilder().setName('withdrawals').setDescription('Pending withdrawals on the site (admins)'),
    new SlashCommandBuilder().setName('site').setDescription('Manage petduel.win').setDefaultMemberPermissions(ADMIN)
      .addSubcommand(s => s.setName('maintenance').setDescription('Close or open the site')
        .addBooleanOption(o => o.setName('on').setDescription('true = close the site, false = open it').setRequired(true))
        .addStringOption(o => o.setName('message').setDescription('Message on the closed screen')))
      .addSubcommand(s => s.setName('say').setDescription('Send a PetDuel system message in the site chat')
        .addStringOption(o => o.setName('text').setDescription('Message').setRequired(true)))
      .addSubcommand(s => s.setName('bot').setDescription('Set a deposit bot online or offline')
        .addStringOption(o => o.setName('name').setDescription('Deposit bot').setRequired(true).setAutocomplete(true))
        .addBooleanOption(o => o.setName('online').setDescription('Online?').setRequired(true)))
      .addSubcommand(s => s.setName('block').setDescription('Block countries (two-letter codes, empty = nobody)')
        .addStringOption(o => o.setName('countries').setDescription('For example: TR or TR,DE (write none to unblock)').setRequired(true))),
    new SlashCommandBuilder().setName('player').setDescription('Manage a Pet Duel player').setDefaultMemberPermissions(ADMIN)
      .addSubcommand(s => s.setName('info').setDescription('Full player info').addStringOption(o => o.setName('nickname').setDescription('Nickname or Roblox name').setRequired(true)))
      .addSubcommand(s => s.setName('mute').setDescription('Mute in the site chat')
        .addStringOption(o => o.setName('nickname').setDescription('Nickname or Roblox name').setRequired(true))
        .addIntegerOption(o => o.setName('minutes').setDescription('Minutes (-1 = forever, 0 = unmute)').setRequired(true)))
      .addSubcommand(s => s.setName('ban').setDescription('Ban or unban on the site')
        .addStringOption(o => o.setName('nickname').setDescription('Nickname or Roblox name').setRequired(true))
        .addBooleanOption(o => o.setName('ban').setDescription('true = ban, false = unban').setRequired(true)))
      .addSubcommand(s => s.setName('give').setDescription('Give pets (for confirmed deposits)')
        .addStringOption(o => o.setName('nickname').setDescription('Nickname or Roblox name').setRequired(true))
        .addStringOption(pet)
        .addIntegerOption(o => o.setName('qty').setDescription('How many').setMinValue(1).setMaxValue(50)))
      .addSubcommand(s => s.setName('gems').setDescription('Give gems (PS99 diamonds), e.g. 17.5b')
        .addStringOption(o => o.setName('nickname').setDescription('Nickname or Roblox name').setRequired(true))
        .addStringOption(o => o.setName('amount').setDescription('Amount: 17.5b, 500m, 1t or a number').setRequired(true)))
      .addSubcommand(s => s.setName('clearpets').setDescription('Delete ALL pets of a player')
        .addStringOption(o => o.setName('nickname').setDescription('Nickname or Roblox name').setRequired(true))),
    new SlashCommandBuilder().setName('match').setDescription('Coinflip tools').setDefaultMemberPermissions(ADMIN)
      .addSubcommand(s => s.setName('cancel').setDescription('Cancel a coinflip (pets go back)').addStringOption(o => o.setName('id').setDescription('Match ID').setRequired(true))),
    new SlashCommandBuilder().setName('event').setDescription('Start a site event').setDefaultMemberPermissions(ADMIN)
      .addSubcommand(s => s.setName('wheel').setDescription('Wheel event').addStringOption(pet)
        .addIntegerOption(o => o.setName('seconds').setDescription('Join time 15-600').setMinValue(15).setMaxValue(600)))
      .addSubcommand(s => s.setName('scramble').setDescription('Word scramble').addStringOption(pet)
        .addIntegerOption(o => o.setName('seconds').setDescription('Time 30-600').setMinValue(30).setMaxValue(600))
        .addStringOption(o => o.setName('word').setDescription('Word (empty = random)')))
      .addSubcommand(s => s.setName('cancel').setDescription('Cancel the running event'))
  ].map(c => c.toJSON());
}

/* the bot works with prefix commands now: the old / commands are removed from Discord (server and global) */
let globalCleared = false;
async function registerCommands(guild) {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try { await rest.put(Routes.applicationGuildCommands(guild.client.user.id, guild.id), { body: [] }); }
  catch (error) { console.warn(`Could not remove the / commands in "${guild.name}": ${error.message}`); }
  if (!globalCleared) {
    globalCleared = true;
    try { await rest.put(Routes.applicationCommands(guild.client.user.id), { body: [] }); } catch { /* none */ }
  }
}

/* ---------------- logs ---------------- */

async function log(guild, title, description, color) {
  const ch = guild && findChannel(guild, CH.botLogs);
  if (!ch) return;
  const e = embed(title, String(description || '').slice(0, 4000));
  if (color) e.setColor(color);
  ch.send({ embeds: [e] }).catch(() => {});
}

/* ---------------- rank roles ---------------- */

async function syncMemberRank(guild, discordId, rank) {
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return;
  const rankNames = siteRanks.map(r => r.name);
  const target = guild.roles.cache.find(r => r.name === rank);
  const linked = guild.roles.cache.find(r => r.name === CONFIG.linkedRole);
  const remove = member.roles.cache.filter(r => rankNames.includes(r.name) && r.name !== rank);
  try {
    if (remove.size) await member.roles.remove([...remove.keys()], 'PetDuel rank changed');
    if (target && !member.roles.cache.has(target.id)) await member.roles.add(target, 'PetDuel rank');
    if (linked && !member.roles.cache.has(linked.id)) await member.roles.add(linked, 'PetDuel account linked');
  } catch (error) {
    console.warn(`Could not set roles for ${member.user.username}: ${error.message} (move the bot role above the rank roles)`);
  }
}

async function removeSiteRoles(guild, discordId) {
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return;
  const names = [...siteRanks.map(r => r.name), CONFIG.linkedRole];
  const remove = member.roles.cache.filter(r => names.includes(r.name));
  if (remove.size) await member.roles.remove([...remove.keys()], 'PetDuel account unlinked').catch(() => {});
}

async function syncAllRanks() {
  if (!BOT_KEY || !client || !client.isReady()) return;
  try {
    const { list } = await site('GET', '/api/bot/linked');
    for (const guild of client.guilds.cache.values()) {
      if (ONLY_GUILD && guild.id !== ONLY_GUILD) continue;
      for (const u of list) await syncMemberRank(guild, u.discordId, u.rank);
    }
  } catch (error) { console.warn('Rank sync failed:', error.message); }
}

/* ---------------- live site events ---------------- */

let socket = null;

function connectSite() {
  if (!BOT_KEY) return;
  socket = ioClient(SITE, { auth: { botKey: BOT_KEY }, transports: ['websocket', 'polling'], reconnectionDelayMax: 15000 });
  socket.on('connect', () => console.log('Connected to petduel.win (live events).'));
  socket.on('connect_error', err => console.warn('petduel.win connection failed:', err.message, '(retrying)'));
  socket.on('disconnect', reason => console.warn('petduel.win disconnected:', reason));

  socket.on('bot:event', ev => {
    const target = {
      coinflip: CH.coinflips, bounty: CH.coinflips, jackpot: CH.jackpots,
      giveaway: CH.giveaways, event: CH.giveaways, withdraw: CH.withdrawals
    }[ev.kind];
    if (!target || !ev.embed) return;
    for (const guild of client.guilds.cache.values()) {
      if (ONLY_GUILD && guild.id !== ONLY_GUILD) continue;
      const ch = findChannel(guild, target) ||
        (ev.kind === 'withdraw' ? findChannel(guild, CH.adminChat) : null) ||
        (ev.kind === 'jackpot' || ev.kind === 'bounty' ? findChannel(guild, CH.coinflips) : null);
      if (!ch) continue;
      const e = { ...ev.embed, color: ev.embed.color || COLOR };
      const payload = { embeds: [e] };
      if (ev.kind === 'withdraw' && ev.data && ev.data.withdrawId) payload.components = [withdrawButtons(ev.data.withdrawId)];
      ch.send(payload).catch(error => console.warn(`Could not post in #${target}: ${error.message}`));
    }
  });

  socket.on('bot:unlink', ({ discordId }) => {
    for (const guild of client.guilds.cache.values()) removeSiteRoles(guild, discordId).catch(() => {});
  });
}

const withdrawButtons = id => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`wd_done:${id}`).setLabel('Mark sent').setEmoji('✅').setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`wd_refund:${id}`).setLabel('Refund').setEmoji('↩️').setStyle(ButtonStyle.Danger)
);

/* ---------------- Discord giveaways ---------------- */

let giveaways = loadJson('giveaways.json', {});
const saveGiveaways = () => saveJson('giveaways.json', giveaways);

const giveawayEmbed = g => {
  const ended = g.ended;
  const e = embed(`🎉 ${g.prize}`, ended
    ? (g.winners && g.winners.length ? `**Winner${g.winners.length > 1 ? 's' : ''}:** ${g.winners.map(id => `<@${id}>`).join(', ')}` : 'No valid entries, no winner.')
    : `Press **Join** to enter!\nEnds <t:${Math.floor(g.endsAt / 1000)}:R>\n**Winners:** ${g.count}${g.linkedOnly ? '\n🔗 Only members with a linked Pet Duel account' : ''}`);
  e.addFields({ name: 'Entries', value: String(g.entries.length), inline: true }, { name: 'Hosted by', value: `<@${g.host}>`, inline: true });
  return e;
};
const giveawayRow = (id, ended) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`gw_join:${id}`).setLabel(ended ? 'Ended' : 'Join').setEmoji('🎉').setStyle(ButtonStyle.Success).setDisabled(Boolean(ended)));

function pickWinners(entries, count) {
  const pool = [...entries];
  const out = [];
  while (pool.length && out.length < count) out.push(pool.splice(crypto.randomInt(pool.length), 1)[0]);
  return out;
}

async function endGiveaway(id, reroll = false) {
  const g = giveaways[id];
  if (!g) throw new Error('Giveaway not found');
  if (g.ended && !reroll) throw new Error('This giveaway already ended');
  g.ended = true;
  g.winners = pickWinners(g.entries, g.count);
  saveGiveaways();
  const ch = await client.channels.fetch(g.channelId).catch(() => null);
  if (!ch) return g;
  const msg = await ch.messages.fetch(id).catch(() => null);
  if (msg) await msg.edit({ embeds: [giveawayEmbed(g)], components: [giveawayRow(id, true)] }).catch(() => {});
  await ch.send(g.winners.length
    ? `🎉 Congratulations ${g.winners.map(w => `<@${w}>`).join(', ')}! You won **${g.prize}**! Open a ticket to claim it.`
    : `No valid entries for **${g.prize}**.`).catch(() => {});
  return g;
}

setInterval(() => {
  for (const [id, g] of Object.entries(giveaways)) if (!g.ended && g.endsAt <= Date.now()) endGiveaway(id).catch(() => {});
}, 15000);

/* ---------------- tickets ---------------- */

async function openTicket(interaction) {
  const guild = interaction.guild;
  const existing = guild.channels.cache.find(c => c.topic === `ticket:${interaction.user.id}`);
  if (existing) return interaction.reply({ content: `You already have a ticket: ${existing}`, flags: EPHEMERAL });

  const panel = findChannel(guild, CH.openTicket);
  const parentId = panel ? panel.parentId : null;   /* the ticket opens in the same category as #open-ticket */
  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory] },
    { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
    ...[...staffRoles(guild).values()].map(r => ({ id: r.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }))
  ];
  const ch = await guild.channels.create({
    name: `ticket-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90) || 'ticket',
    type: ChannelType.GuildText, parent: parentId || undefined, topic: `ticket:${interaction.user.id}`, permissionOverwrites: overwrites
  });

  await ch.send({
    content: `${interaction.user} welcome! Describe your problem and a staff member will help you soon.`,
    embeds: [embed('🎫 Ticket', 'For deposits and withdrawals: write your **site nickname**, the **pets** and add **screenshots** of the trade.')],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket_close').setLabel('Close ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger))]
  });

  /* staff instantly see the player's Pet Duel account when it is linked */
  if (BOT_KEY) {
    site('GET', `/api/bot/user?discordId=${interaction.user.id}`).then(({ user }) => ch.send({ embeds: [playerEmbed(user, true)] })).catch(() => {
      ch.send({ content: 'ℹ️ This member has not linked a Pet Duel account (`!link`).' }).catch(() => {});
    });
  }

  await interaction.reply({ content: `Your ticket is open: ${ch}`, flags: EPHEMERAL });
  log(guild, '🎫 Ticket opened', `${interaction.user} opened ${ch}`);
}

async function closeTicket(interaction) {
  const ch = interaction.channel;
  if (!ch.topic || !ch.topic.startsWith('ticket:')) return interaction.reply({ content: 'This is not a ticket.', flags: EPHEMERAL });
  await interaction.reply({ content: '🔒 Closing this ticket in 5 seconds…' });

  /* transcript (up to 1000 messages) for #ticket-logs */
  const all = [];
  let before;
  for (let i = 0; i < 10; i++) {
    const batch = await ch.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || !batch.size) break;
    all.push(...batch.values());
    before = batch.last().id;
  }
  all.reverse();
  const text = all.map(m => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.username}: ${m.content}${m.attachments.size ? ' ' + [...m.attachments.values()].map(a => a.url).join(' ') : ''}${m.embeds.length ? ' [embed]' : ''}`).join('\n');
  const logs = findChannel(interaction.guild, CH.ticketLogs);
  if (logs) {
    const owner = ch.topic.split(':')[1];
    await logs.send({
      embeds: [embed('🎫 Ticket closed', `**Ticket:** #${ch.name}\n**Owner:** <@${owner}>\n**Closed by:** ${interaction.user}\n**Messages:** ${all.length}`)],
      files: [new AttachmentBuilder(Buffer.from(text || '(empty)', 'utf8'), { name: `${ch.name}.txt` })]
    }).catch(() => {});
  }
  setTimeout(() => ch.delete('Ticket closed').catch(() => {}), 5000);
}

/* ---------------- embeds for site data ---------------- */

function playerEmbed(u, staffView) {
  const e = embed(`${u.nickname}`, `${u.online ? '🟢 Online now' : `⚫ Last seen ${ago(u.lastSeen)}`}${u.banned ? '\n⛔ **Banned**' : ''}${u.muted ? '\n🔇 Muted' : ''}`);
  if (u.avatar) e.setThumbnail(u.avatar);
  e.addFields(
    { name: 'Rank', value: u.rank, inline: true },
    { name: 'Total bet', value: `${gem} ${fmt(u.totalBet)}`, inline: true },
    { name: 'Profit', value: `${gem} ${u.profit > 0 ? '+' : ''}${fmt(u.profit)}`, inline: true },
    { name: 'Total won', value: `${gem} ${fmt(u.totalWon)}`, inline: true },
    { name: 'Total lost', value: `${gem} ${fmt(u.totalLost)}`, inline: true },
    { name: 'Inventory', value: `${u.items} pets · ${gem} ${fmt(u.inventoryValue)}`, inline: true }
  );
  if (staffView) {
    e.addFields({ name: 'Roblox name', value: u.robloxName || '-', inline: true }, { name: 'Site ID', value: u.id, inline: true });
    if (u.topPets && u.topPets.length) e.addFields({ name: 'Top pets', value: u.topPets.map(p => `${petLabel(p)} · ${gem} ${fmt(p.value)}`).join('\n') });
    if (u.pendingWithdrawals && u.pendingWithdrawals.length) {
      e.addFields({ name: 'Pending withdrawals', value: u.pendingWithdrawals.map(w => `\`${w.id}\` · ${w.items} pets · ${gem} ${fmt(w.value)} · ${ago(w.ts)}`).join('\n') });
    }
  }
  return e;
}

async function catalogChoices(focused) {
  const { list } = await site('GET', `/api/bot/catalog?q=${encodeURIComponent(focused)}`);
  return list.map(c => ({ name: c.label.slice(0, 100), value: c.id }));
}

/* ---------------- prefix commands ----------------
   "!giveaway start "Huge Cat" 60 2" works like /giveaway start with the same options in the same order.
   Users: @mention or ID. Yes / no: true, false, on, off, yes, no. Text with spaces: in "quotes"; the last text
   option takes the rest of the message. Permissions are the same as the old / commands had. */
const OPT = { SUB: 1, GROUP: 2, STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, CHANNEL: 7, ROLE: 8, NUMBER: 10 };
let COMMANDS = null;
const commandsByName = () => (COMMANDS ||= new Map(commandList().map(c => [c.name, c])));

function tokens(text) {
  const out = [], re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text))) out.push({ v: m[1] ?? m[2] ?? m[3], quoted: m[3] === undefined, start: m.index });
  return out;
}

const optName = o => (o.required ? `<${o.name}>` : `[${o.name}:…]`);
function usage(cmd, sub) {
  if (sub) return `${P}${cmd.name} ${sub.name} ${(sub.options || []).map(optName).join(' ')}`.trim();
  const subs = (cmd.options || []).filter(o => o.type === OPT.SUB);
  if (subs.length) return subs.map(x => `${P}${cmd.name} ${x.name} ${(x.options || []).map(optName).join(' ')}`.trim()).join('\n');
  return `${P}${cmd.name} ${(cmd.options || []).map(optName).join(' ')}`.trim();
}

async function parseValue(o, raw, msg) {
  if (o.type === OPT.INTEGER || o.type === OPT.NUMBER) {
    const n = o.type === OPT.INTEGER ? parseInt(raw, 10) : parseFloat(raw);
    if (!Number.isFinite(n)) throw new Error(`\`${o.name}\` must be a number`);
    if (o.min_value !== undefined && n < o.min_value) throw new Error(`\`${o.name}\` must be at least ${o.min_value}`);
    if (o.max_value !== undefined && n > o.max_value) throw new Error(`\`${o.name}\` must be at most ${o.max_value}`);
    return n;
  }
  if (o.type === OPT.BOOLEAN) {
    const v = String(raw).toLowerCase();
    if (['true', 'yes', 'on', '1', 'evet', 'acik'].includes(v)) return true;
    if (['false', 'no', 'off', '0', 'hayir', 'kapali'].includes(v)) return false;
    throw new Error(`\`${o.name}\` must be true or false`);
  }
  if (o.type === OPT.USER) {
    const id = (String(raw).match(/^<@!?(\d+)>$/) || String(raw).match(/^(\d{15,25})$/) || [])[1];
    if (!id) throw new Error(`\`${o.name}\`: mention a member or paste their ID`);
    return msg.client.users.fetch(id);
  }
  /* options that used autocomplete: a typed name is turned into the site's id */
  if (o.name === 'pet') {
    const { list } = await site('GET', `/api/bot/catalog?q=${encodeURIComponent(raw)}`);
    const hit = list.find(c => c.id === raw) || list.find(c => c.label.toLowerCase().startsWith(raw.toLowerCase())) || list[0];
    if (!hit) throw new Error(`No catalog pet matches "${raw}"`);
    return hit.id;
  }
  if (o.name === 'name' && o.autocomplete) {
    const { bots } = await site('GET', '/api/bot/stats');
    const hit = bots.find(b => b.id === raw || b.username.toLowerCase() === raw.toLowerCase());
    if (!hit) throw new Error(`No deposit bot named "${raw}"`);
    return hit.id;
  }
  return raw;
}

function toPayload(content) {
  const p = typeof content === 'string' ? { content } : { ...content };
  delete p.flags; delete p.ephemeral;
  p.allowedMentions = { repliedUser: false, parse: [] };
  return p;
}

async function handlePrefix(msg) {
  if (msg.author.bot || !msg.guild || !msg.content.startsWith(P)) return;
  if (ONLY_GUILD && msg.guild.id !== ONLY_GUILD) return;
  const body = msg.content.slice(P.length);
  const words = tokens(body);
  if (!words.length) return;
  const name = words[0].v.toLowerCase();
  const cmd = commandsByName().get(name);
  if (!cmd) return;

  if (cmd.default_member_permissions && !(msg.member && msg.member.permissions.has(BigInt(cmd.default_member_permissions)))) {
    return msg.reply(toPayload('⛔ You do not have permission to use this command.')).catch(() => {});
  }

  let rest = words.slice(1), sub = null, opts = cmd.options || [];
  const subs = opts.filter(o => o.type === OPT.SUB);
  if (subs.length) {
    sub = subs.find(x => rest[0] && x.name === rest[0].v.toLowerCase());
    if (!sub) return msg.reply(toPayload(`ℹ️ Usage:\n\`\`\`\n${usage(cmd)}\n\`\`\``)).catch(() => {});
    rest = rest.slice(1);
    opts = sub.options || [];
  }

  const values = {};
  try {
    /* name:value anywhere sets that option (handy for optional ones: qty:3 everyone:true) */
    const named = {};
    rest = rest.filter(t => {
      const m = !t.quoted && t.v.match(/^([a-z_]+):(.+)$/i);
      const o = m && opts.find(x => x.name === m[1].toLowerCase());
      if (!o) return true;
      named[o.name] = m[2];
      return false;
    });
    for (let k = 0; k < opts.length; k++) {
      const o = opts[k];
      if (named[o.name] !== undefined) { values[o.name] = await parseValue(o, named[o.name], msg); continue; }
      if (!rest.length) {
        if (o.required) throw new Error(`\`${o.name}\` is missing`);
        continue;
      }
      /* text: a "quoted" value is one value; otherwise it takes the rest when no required option comes after it */
      let raw;
      const noRequiredAfter = opts.slice(k + 1).every(x => !x.required);
      if (o.type === OPT.STRING && !rest[0].quoted && noRequiredAfter) { raw = rest.map(t => t.v).join(' '); rest = []; }
      else raw = rest.shift().v;
      values[o.name] = await parseValue(o, raw, msg);
    }
  } catch (error) {
    return msg.reply(toPayload(`❌ ${error.message}\nUsage: \`${usage(cmd, sub)}\``)).catch(() => {});
  }

  /* a /link code is private: the command message is removed */
  if (name === 'link') msg.delete().catch(() => {});

  const get = n => (values[n] === undefined ? null : values[n]);
  let last = null;
  const i = {
    commandName: name, user: msg.author, member: msg.member, guild: msg.guild, channel: msg.channel, client: msg.client,
    deferred: false, replied: false, isPrefix: true,
    isRepliable: () => true,
    options: { getSubcommand: () => (sub ? sub.name : null), getString: get, getInteger: get, getNumber: get, getBoolean: get, getUser: get },
    async deferReply() { this.deferred = true; msg.channel.sendTyping().catch(() => {}); },
    async reply(c) { this.replied = true; last = await (name === 'link' ? msg.channel.send(toPayload(c)) : msg.reply(toPayload(c))); return last; },
    async editReply(c) { if (last) return last.edit(toPayload(c)); return this.reply(c); },
    async followUp(c) { return msg.channel.send(toPayload(c)); }
  };
  try { await handleCommand(i); }
  catch (error) {
    console.warn(`Command error (${P}${name}):`, error.message);
    i.editReply(`❌ ${error.message}`).catch(() => {});
  }
}

/* ---------------- command handlers ---------------- */

const reply = (i, content, eph = true) => i.deferred || i.replied
  ? i.editReply(typeof content === 'string' ? { content } : content)
  : i.reply({ ...(typeof content === 'string' ? { content } : content), flags: eph ? EPHEMERAL : undefined });

async function handleCommand(i) {
  const name = i.commandName;
  const sub = i.options.getSubcommand(false);

  if (name === 'help') {
    return reply(i, { embeds: [embed('📖 PetDuel bot', [
      '**Everyone**',
      [`link`, 'unlink', 'profile', 'rank', 'leaderboard', 'stats', 'games', 'website', 'coinflip'].map(c => `\`${P}${c}\``).join(' '),
      '',
      '**Staff / Support**',
      ['clear', 'timeout', 'kick', 'ban'].map(c => `\`${P}${c}\``).join(' '),
      '',
      '**Admins**',
      ['site maintenance|say|bot|block', 'player info|mute|ban|give|clearpets', 'match cancel', 'event wheel|scramble|cancel', 'announce', 'giveaway start|end|reroll', 'ticketpanel'].map(c => `\`${P}${c}\``).join(' '),
      '',
      `Text with spaces goes in "quotes", members as @mention, optional options as name:value. Examples: \`${P}giveaway start "Huge Cat" 60 2\` · \`${P}player give laura "Rainbow Huge Cat" qty:3\``
    ].join('\n'))] });
  }

  if (name === 'website') {
    return reply(i, { embeds: [embed('🌐 petduel.win', `Play Pet Simulator 99 PvP duels: **${SITE}**`)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Open Pet Duel').setStyle(ButtonStyle.Link).setURL(SITE))] }, false);
  }

  if (name === 'coinflip') {
    const side = crypto.randomInt(2) ? 'heads' : 'tails';
    const pick = i.options.getString('side');
    return reply(i, `🪙 The coin landed on **${side}**!${pick ? (pick === side ? ' You win! 🎉' : ' You lose 😢') : ''}`, false);
  }

  if (name === 'link') {
    await i.deferReply({ flags: EPHEMERAL });
    const { user } = await site('POST', '/api/bot/link', { code: i.options.getString('code'), discordId: i.user.id, discordTag: i.user.username }, actorOf(i));
    if (i.guild) await syncMemberRank(i.guild, i.user.id, user.rank);
    log(i.guild, '🔗 Account linked', `${i.user} linked **${user.nickname}** (Roblox: ${user.robloxName})`);
    return reply(i, `✅ Linked to **${user.nickname}**! You got the **${user.rank}** rank role.`);
  }

  if (name === 'unlink') {
    await i.deferReply({ flags: EPHEMERAL });
    await site('POST', '/api/bot/unlink', { discordId: i.user.id }, actorOf(i));
    if (i.guild) await removeSiteRoles(i.guild, i.user.id);
    return reply(i, '✅ Your Pet Duel account was unlinked.');
  }

  if (name === 'profile' || name === 'rank') {
    await i.deferReply({ flags: name === 'rank' ? EPHEMERAL : undefined });
    const member = i.options.getUser('user');
    const nickname = i.options.getString('nickname');
    const q = nickname ? `q=${encodeURIComponent(nickname)}` : `discordId=${(member || i.user).id}`;
    const { user } = await site('GET', `/api/bot/user?${q}`);
    if (name === 'rank') {
      if (i.guild && !nickname && !member) await syncMemberRank(i.guild, i.user.id, user.rank);
      const next = siteRanks.find(r => r.min > user.totalBet);
      return reply(i, `🏅 Your rank: **${user.rank}**${next ? `\nNext: **${next.name}** at ${gem} ${fmt(next.min)} total bet (${gem} ${fmt(next.min - user.totalBet)} to go)` : '\nYou have the highest rank!'}`);
    }
    return reply(i, { embeds: [playerEmbed(user, false)] });
  }

  if (name === 'leaderboard') {
    await i.deferReply();
    const by = i.options.getString('type') || 'profit';
    const res = await fetch(`${SITE}/api/leaderboard?by=${by}`, { headers: { 'X-Bot-Key': BOT_KEY } });
    const { list } = await res.json();
    const medals = ['🥇', '🥈', '🥉'];
    const title = { profit: '🏆 Top Profit', totalBet: '💸 Top Wager', least: '📉 Least Profit' }[by];
    const lines = (list || []).slice(0, 15).map((u, k) => `${medals[k] || `**#${k + 1}**`} ${u.username} · ${gem} ${by !== 'totalBet' && u.value > 0 ? '+' : ''}${fmt(u.value)}`);
    return reply(i, { embeds: [embed(title, lines.join('\n') || 'No players yet.')] });
  }

  if (name === 'stats') {
    await i.deferReply();
    const s = await site('GET', '/api/bot/stats');
    const e = embed('📊 Pet Duel live', s.maintenance ? '🔒 The site is in maintenance mode.' : `👉 ${SITE}`);
    e.addFields(
      { name: 'Online', value: String(s.online), inline: true },
      { name: 'Players', value: String(s.players), inline: true },
      { name: 'Open coinflips', value: `${s.openGames} · ${gem} ${short(s.gamesValue)}`, inline: true },
      { name: 'Jackpot', value: s.jackpot ? `${gem} ${short(s.jackpot.total)} · ${s.jackpot.players} players` : '-', inline: true },
      { name: 'Giveaways', value: String(s.giveaways), inline: true },
      { name: 'Deposit bots', value: s.bots.map(b => `${b.online ? '🟢' : '🔴'} ${b.username.slice(0, 4)}***`).join('\n') || '-', inline: true }
    );
    return reply(i, { embeds: [e] });
  }

  if (name === 'games') {
    await i.deferReply();
    const { list } = await site('GET', '/api/bot/games');
    return reply(i, { embeds: [embed('🪙 Open coinflips', list.length
      ? list.map(m => `**${m.host}** · ${gem} ${short(m.value)} · ${m.pets} pet${m.pets === 1 ? '' : 's'}${m.maxJoin ? ` · max ${m.maxJoin} to join` : ''}`).join('\n') + `\n\nJoin on ${SITE}`
      : 'No open games right now. Create one on the site!')] });
  }

  if (name === 'announce') {
    const title = i.options.getString('title');
    const message = i.options.getString('message').replace(/\\n/g, '\n');
    const ch = findChannel(i.guild, CH.announcements);
    if (!ch) return reply(i, `#${CH.announcements} not found.`);
    await ch.send({ content: i.options.getBoolean('everyone') ? '@everyone' : undefined, embeds: [embed(`📢 ${title}`, message)], allowedMentions: { parse: i.options.getBoolean('everyone') ? ['everyone'] : [] } });
    if (i.options.getBoolean('site')) await site('POST', '/api/admin/announce', { title, text: message.slice(0, 300), chat: true }, actorOf(i)).catch(() => {});
    log(i.guild, '📢 Announcement', `${i.user} posted **${title}**`);
    return reply(i, '✅ Announcement posted.');
  }

  if (name === 'ticketpanel') {
    await i.channel.send(ticketPanel());
    return reply(i, '✅ Ticket panel posted.');
  }

  if (name === 'giveaway') {
    if (sub === 'start') {
      const ch = findChannel(i.guild, CH.giveaways) || i.channel;
      const g = {
        prize: i.options.getString('prize'), count: i.options.getInteger('winners') || 1, host: i.user.id,
        endsAt: Date.now() + i.options.getInteger('minutes') * 60000, entries: [], ended: false, channelId: ch.id,
        linkedOnly: Boolean(i.options.getBoolean('linked_only'))
      };
      const msg = await ch.send({ embeds: [giveawayEmbed(g)], components: [giveawayRow('pending', false)] });
      giveaways[msg.id] = g;
      saveGiveaways();
      await msg.edit({ components: [giveawayRow(msg.id, false)] });
      log(i.guild, '🎉 Giveaway started', `${i.user} started **${g.prize}** in ${ch} (message ${msg.id})`);
      return reply(i, `✅ Giveaway started in ${ch}. Message ID: \`${msg.id}\``);
    }
    const g = await endGiveaway(i.options.getString('message_id'), sub === 'reroll');
    return reply(i, `✅ ${sub === 'reroll' ? 'Rerolled' : 'Ended'}: ${g.winners.length ? g.winners.map(w => `<@${w}>`).join(', ') : 'no winner'}`);
  }

  if (name === 'clear') {
    const deleted = await i.channel.bulkDelete(i.options.getInteger('amount'), true);
    log(i.guild, '🧹 Messages cleared', `${i.user} deleted ${deleted.size} messages in ${i.channel}`);
    return reply(i, `🧹 Deleted ${deleted.size} messages.`);
  }

  if (name === 'timeout' || name === 'kick' || name === 'ban') {
    const target = i.options.getUser('user');
    const reason = i.options.getString('reason') || 'No reason';
    const member = await i.guild.members.fetch(target.id).catch(() => null);
    if (name === 'timeout') {
      if (!member) return reply(i, 'Member not found.');
      await member.timeout(i.options.getInteger('minutes') * 60000, `${reason} (by ${i.user.username})`);
    } else if (name === 'kick') {
      if (!member) return reply(i, 'Member not found.');
      await member.kick(`${reason} (by ${i.user.username})`);
    } else {
      await i.guild.members.ban(target.id, { reason: `${reason} (by ${i.user.username})` });
    }
    log(i.guild, `🔨 ${name[0].toUpperCase() + name.slice(1)}`, `${i.user} → ${target} (${target.username})${name === 'timeout' ? ` for ${i.options.getInteger('minutes')} min` : ''}\n**Reason:** ${reason}`, 0xff5968);
    return reply(i, `✅ ${target.username}: ${name} done.`);
  }

  if (name === 'withdrawals') {
    if (!i.member.permissions.has(PermissionFlagsBits.ManageGuild)) return reply(i, 'Only admins can use this.');
    await i.deferReply({ flags: EPHEMERAL });
    const { list } = await site('GET', '/api/bot/withdrawals');
    if (!list.length) return reply(i, '✅ No pending withdrawals.');
    for (const w of list.slice(0, 10)) {
      await i.followUp({
        flags: EPHEMERAL,
        embeds: [embed(`📤 ${w.nickname}`, `**Roblox:** ${w.robloxName}\n**Value:** ${gem} ${fmt(w.value)}\n**Requested:** ${ago(w.ts)}\n**Pets:** ${w.items.join(', ').slice(0, 900)}`).setFooter({ text: `Withdraw ID ${w.id}` })],
        components: [withdrawButtons(w.id)]
      });
    }
    return reply(i, `📤 ${list.length} pending withdrawal${list.length === 1 ? '' : 's'}:`);
  }

  if (name === 'site') {
    await i.deferReply({ flags: EPHEMERAL });
    if (sub === 'maintenance') {
      const on = i.options.getBoolean('on');
      await site('POST', '/api/admin/maintenance', { on, text: i.options.getString('message') || '' }, actorOf(i));
      log(i.guild, '🔒 Maintenance', `${i.user} turned maintenance **${on ? 'ON' : 'OFF'}**`);
      return reply(i, on ? '🔒 The site is now closed for players.' : '✅ The site is open again.');
    }
    if (sub === 'say') {
      await site('POST', '/api/bot/say', { text: i.options.getString('text') }, actorOf(i));
      return reply(i, '✅ Sent to the site chat.');
    }
    if (sub === 'bot') {
      const { bots } = await site('GET', '/api/bot/stats');
      const want = i.options.getString('name');
      const b = bots.find(x => x.id === want || x.username.toLowerCase() === want.toLowerCase());
      if (!b) return reply(i, 'Bot not found.');
      const online = i.options.getBoolean('online');
      await site('POST', '/api/admin/bots/update', { id: b.id, online }, actorOf(i));
      log(i.guild, '🤖 Deposit bot', `${i.user} set **${b.username}** ${online ? 'online' : 'offline'}`);
      return reply(i, `${online ? '🟢' : '🔴'} **${b.username}** is now ${online ? 'online' : 'offline'}.`);
    }
    if (sub === 'block') {
      const raw = i.options.getString('countries');
      const countries = /^none$/i.test(raw.trim()) ? '' : raw;
      const r = await site('POST', '/api/admin/block', { countries }, actorOf(i));
      log(i.guild, '🌍 Country block', `${i.user} set: ${r.countries.join(', ') || 'nobody blocked'}`);
      return reply(i, r.countries.length ? `🌍 Blocked: ${r.countries.join(', ')}` : '🌍 Nobody is blocked now.');
    }
  }

  if (name === 'player') {
    await i.deferReply({ flags: EPHEMERAL });
    const { user } = await site('GET', `/api/bot/user?q=${encodeURIComponent(i.options.getString('nickname'))}`);
    if (sub === 'info') return reply(i, { embeds: [playerEmbed(user, true)] });
    if (sub === 'mute') {
      const minutes = i.options.getInteger('minutes');
      await site('POST', '/api/admin/mute', { id: user.id, minutes }, actorOf(i));
      log(i.guild, '🔇 Site mute', `${i.user} → **${user.nickname}**: ${minutes === 0 ? 'unmuted' : minutes < 0 ? 'forever' : `${minutes} min`}`);
      return reply(i, `✅ ${user.nickname}: ${minutes === 0 ? 'unmuted' : 'muted'}.`);
    }
    if (sub === 'ban') {
      const ban = i.options.getBoolean('ban');
      await site('POST', '/api/admin/ban', { id: user.id, ban }, actorOf(i));
      log(i.guild, '⛔ Site ban', `${i.user} ${ban ? 'banned' : 'unbanned'} **${user.nickname}**`, 0xff5968);
      return reply(i, `✅ ${user.nickname} ${ban ? 'banned' : 'unbanned'} on the site.`);
    }
    if (sub === 'give') {
      const qty = i.options.getInteger('qty') || 1;
      await site('POST', '/api/admin/grant', { username: user.nickname, catalogId: i.options.getString('pet'), qty }, actorOf(i));
      log(i.guild, '🎁 Pets given', `${i.user} gave ${qty}x pet \`${i.options.getString('pet')}\` to **${user.nickname}**`, 0x00efa0);
      return reply(i, `✅ Gave ${qty} pet${qty === 1 ? '' : 's'} to ${user.nickname}.`);
    }
    if (sub === 'gems') {
      const r = await site('POST', '/api/admin/gems', { username: user.nickname, amount: i.options.getString('amount') }, actorOf(i));
      log(i.guild, '💎 Gems given', `${i.user} gave ${gem} **${fmt(r.item.value)}** gems to **${user.nickname}**`, 0x4da3ff);
      return reply(i, `💎 Gave ${fmt(r.item.value)} gems to ${user.nickname}.`);
    }
    if (sub === 'clearpets') {
      const r = await site('POST', '/api/admin/inventory/clear', { id: user.id }, actorOf(i));
      log(i.guild, '🗑 Pets deleted', `${i.user} deleted all ${r.count} pets (${gem} ${fmt(r.value)}) of **${user.nickname}**`, 0xff5968);
      return reply(i, `🗑 Deleted ${r.count} pets of ${user.nickname}.`);
    }
  }

  if (name === 'match' && sub === 'cancel') {
    await i.deferReply({ flags: EPHEMERAL });
    await site('POST', '/api/admin/match/cancel', { id: i.options.getString('id') }, actorOf(i));
    log(i.guild, '🪙 Coinflip cancelled', `${i.user} cancelled match \`${i.options.getString('id')}\``);
    return reply(i, '✅ Match cancelled, pets returned.');
  }

  if (name === 'event') {
    await i.deferReply({ flags: EPHEMERAL });
    if (sub === 'cancel') {
      await site('POST', '/api/admin/event/cancel', {}, actorOf(i));
      return reply(i, '✅ Event cancelled.');
    }
    const body = sub === 'wheel'
      ? { itemId: i.options.getString('pet'), seconds: i.options.getInteger('seconds') || 60 }
      : { itemId: i.options.getString('pet'), seconds: i.options.getInteger('seconds') || 120, word: i.options.getString('word') || '' };
    await site('POST', `/api/admin/event/${sub}`, body, actorOf(i));
    log(i.guild, '🎉 Site event', `${i.user} started a **${sub}** event`);
    return reply(i, `✅ ${sub === 'wheel' ? 'Wheel' : 'Word scramble'} event started on the site!`);
  }

  return reply(i, 'Unknown command.');
}

/* ---------------- buttons ---------------- */

const isStaff = member => member && (member.permissions.has(PermissionFlagsBits.ManageMessages) || member.roles.cache.some(r => CONFIG.staffRoleNames.includes(r.name)));

async function handleButton(i) {
  const [kind, id] = i.customId.split(':');

  if (kind === 'ticket_open') return openTicket(i);
  if (kind === 'ticket_close') return closeTicket(i);

  if (kind === 'gw_join') {
    const g = giveaways[id];
    if (!g || g.ended) return reply(i, 'This giveaway has ended.');
    if (g.entries.includes(i.user.id)) {
      g.entries = g.entries.filter(x => x !== i.user.id);
      saveGiveaways();
      await i.message.edit({ embeds: [giveawayEmbed(g)] }).catch(() => {});
      return reply(i, 'You left the giveaway.');
    }
    if (g.linkedOnly) {
      try { await site('GET', `/api/bot/user?discordId=${i.user.id}`); }
      catch { return reply(i, '🔗 Link your Pet Duel account first: get a code on petduel.win (Profile > Link Discord), then `!link CODE`.'); }
    }
    g.entries.push(i.user.id);
    saveGiveaways();
    await i.message.edit({ embeds: [giveawayEmbed(g)] }).catch(() => {});
    return reply(i, '🎉 You joined! Press again to leave.');
  }

  if (kind === 'wd_done' || kind === 'wd_refund') {
    if (!i.member.permissions.has(PermissionFlagsBits.ManageGuild)) return reply(i, 'Only admins can handle withdrawals.');
    await i.deferReply({ flags: EPHEMERAL });
    await site('POST', `/api/admin/withdraw/${kind === 'wd_done' ? 'done' : 'refund'}`, { id }, actorOf(i));
    const done = kind === 'wd_done';
    const old = i.message.embeds[0];
    const e = old ? EmbedBuilder.from(old) : embed('📤 Withdrawal');
    e.setColor(done ? 0x00efa0 : 0xff5968).addFields({ name: done ? '✅ Sent' : '↩️ Refunded', value: `by ${i.user} · <t:${Math.floor(Date.now() / 1000)}:R>` });
    await i.message.edit({ embeds: [e], components: [] }).catch(() => {});
    log(i.guild, done ? '✅ Withdrawal sent' : '↩️ Withdrawal refunded', `${i.user} → \`${id}\``, done ? 0x00efa0 : 0xff5968);
    return reply(i, done ? '✅ Marked as sent. The player sees it on the site.' : '↩️ Refunded: the pets are back in the player\'s inventory.');
  }
}

/* ---------------- event wiring ---------------- */

function attachHandlers(c) {
  c.once(Events.ClientReady, async () => {
    console.log(`\n  Logged in as ${c.user.tag}\n`);
    if (BOT_KEY) {
      try { siteRanks = (await site('GET', '/api/bot/stats')).ranks || []; }
      catch (error) { console.warn('Could not reach petduel.win:', error.message); }
    }
    for (const guild of c.guilds.cache.values()) await setupGuild(guild);
    connectSite();
    syncAllRanks();
    setInterval(syncAllRanks, (CONFIG.rankSyncMinutes || 10) * 60000);

    const presence = async () => {
      try {
        const s = BOT_KEY ? await site('GET', '/api/bot/stats') : null;
        c.user.setPresence({ activities: [{ name: s ? `petduel.win · ${s.online} online` : 'petduel.win', type: 3 }], status: 'online' });
      } catch { c.user.setPresence({ activities: [{ name: 'petduel.win', type: 3 }] }); }
    };
    presence();
    setInterval(presence, 60000);
  });

  c.on(Events.GuildCreate, guild => setupGuild(guild));

  c.on(Events.InteractionCreate, async i => {
    try {
      if (i.isAutocomplete()) {
        const focused = i.options.getFocused(true);
        if (focused.name === 'pet') return i.respond(await catalogChoices(focused.value)).catch(() => {});
        if (focused.name === 'name') {
          const { bots } = await site('GET', '/api/bot/stats');
          return i.respond(bots.map(b => ({ name: `${b.online ? '🟢' : '🔴'} ${b.username}`, value: b.id })).slice(0, 25)).catch(() => {});
        }
        return i.respond([]).catch(() => {});
      }
      if (i.isChatInputCommand()) return await handleCommand(i);
      if (i.isButton()) return await handleButton(i);
    } catch (error) {
      console.warn(`Command error (${i.commandName || i.customId}):`, error.message);
      if (i.isRepliable()) reply(i, `❌ ${error.message}`).catch(() => {});
    }
  });

  c.on(Events.MessageCreate, msg => { handlePrefix(msg).catch(error => console.warn('Prefix command error:', error.message)); });

  c.on(Events.GuildMemberAdd, m => log(m.guild, '📥 Member joined', `${m} (${m.user.username})\nAccount created <t:${Math.floor(m.user.createdTimestamp / 1000)}:R>`, 0x00efa0));
  c.on(Events.GuildMemberRemove, m => log(m.guild, '📤 Member left', `${m.user ? m.user.username : 'unknown'} (${m.id})`, 0x8d909a));
  c.on(Events.MessageDelete, msg => {
    if (!msg.guild || (msg.author && msg.author.bot)) return;
    log(msg.guild, '🗑 Message deleted', `**Author:** ${msg.author || 'unknown'}\n**Channel:** ${msg.channel}\n${msg.content ? `**Text:** ${msg.content}` : '(text not available)'}`, 0xff5968);
  });
  c.on(Events.MessageUpdate, (oldMsg, newMsg) => {
    if (!newMsg.guild || (newMsg.author && newMsg.author.bot) || oldMsg.content === newMsg.content) return;
    log(newMsg.guild, '✏️ Message edited', `**Author:** ${newMsg.author}\n**Channel:** ${newMsg.channel}\n**Before:** ${oldMsg.content || '(unknown)'}\n**After:** ${newMsg.content || ''}`, 0xffb52e);
  });
}

process.on('unhandledRejection', err => console.warn('Unhandled:', err && err.message ? err.message : err));
start();
