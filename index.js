// index.js
require('dotenv').config();
const cron = require('node-cron');
const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActivityType,
  ChannelType,
} = require('discord.js');

const music = require('./utils/music');
const { initFaceRecognition, isSimilarFace, registerFace } = require('./utils/face');
const { registerSlashCommands, handleSlashCommand, handleButtonInteraction } = require('./commands/slash');
const handlePrefixMessage = require('./commands/prefix');
const { chat } = require('./utils/ai');
const { ensureDropboxInit } = require('./utils/storage');
const { acquireSingletonLock, startSingletonHeartbeat } = require('./utils/singleton');
const { preloadQuizzes } = require('./utils/quiz');
const { addXp, loadData: loadLevelData } = require('./utils/level');
const verify = require('./utils/verify');
const ticket = require('./utils/ticket');
const { setupWeekly, loadWeeklyData, handleMessage: handleWeeklyMessage } = require('./utils/weeklyManager');
const antiRaid = require('./utils/anti-raid');
const {
  handleMemberJoin,
  handleReactionAdd,
  handleRoleUpdate,
  handleAuditLogEntry,
  handleMessageUpdate,
  onGuildMemberUpdate,
  onGuildBanAdd,
  onGuildMemberRemove,
} = antiRaid;
const {
  addMessage,
  loadActivity,
  resetMonthlyActivity,
  updateActiveRoles,
} = require('./utils/activity');

// === anti-raid 追加ハンドラのインポート ===
const {
  handleBotAdd,
  handleGuildUpdate,
  handleChannelCreate,
  handleChannelUpdate,
  handleRoleCreate,
  handleRoleDelete,
} = antiRaid;

// === 設定 ===
const ACTIVE_ROLE_ID = process.env.ACTIVE_ROLE_ID;
const TOKEN = process.env.TOKEN;
const PORT = process.env.PORT || 3000;
const WEEKLY_CHANNEL_ID = process.env.WEEKLY_CHANNEL_ID || null;
const FACE_LOG_CHANNEL = process.env.FACE_LOG_CHANNEL;

if (!TOKEN) {
  console.error('❌ ERROR: TOKEN が .env に設定されていません。');
  process.exit(1);
}

const APP_DATA_DIR = path.join(__dirname, 'app-data');
if (!fs.existsSync(APP_DATA_DIR)) fs.mkdirSync(APP_DATA_DIR, { recursive: true });

process.on('uncaughtException', (err) => { console.error('🚨 uncaughtException:', err); });
process.on('unhandledRejection', (reason) => { console.error('🚨 unhandledRejection:', reason); });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildBans,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

const app = express();
app.get('/', (req, res) => res.send('Bot is running'));
app.listen(PORT, () => console.log('Server listening on port ' + PORT));

// 同一 messageId の二重処理を防止（誤って複数回イベントが届くケース対策）
const processedMessageIds = new Map();
const MESSAGE_DEDUP_TTL_MS = 5 * 60 * 1000;

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (interaction.isButton()) {
      if (interaction.customId.startsWith('ticket_')) {
        await ticket.buttonHandler(interaction);
      } else if (interaction.customId.startsWith('role_button_')) {
        await handleButtonInteraction(interaction);
      } else {
        await verify.buttonHandler(interaction);
      }
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('ticket_')) {
        await ticket.modalHandler(interaction);
      } else if (interaction.customId.startsWith('verify_')) {
        await verify.modalHandler(interaction);
      }
    }
  } catch (err) {
    console.error('interactionCreate error:', err);
  }
});

// === 【修正】 高速・頑丈な ready イベント ===
client.once('clientReady', async () => {
  console.log('🚀 Bot logged in as ' + client.user.tag);

  const initTasks = [
    { name: 'Face Recognition', fn: async () => { await initFaceRecognition(); } },
    { name: 'Default Face Registration', fn: async () => {
        const localFacePath = path.join(__dirname, 'face.jpg');
        if (fs.existsSync(localFacePath)) { await registerFace(localFacePath); } 
        else { await registerFace('https://i.imgur.com/DkoHDM9.jpg'); }
    }},
    { name: 'Dropbox Storage', fn: async () => { await ensureDropboxInit(); } },
    { name: 'Activity Data', fn: async () => { await loadActivity(); } },
    { name: 'Level Data', fn: async () => { await loadLevelData(); } },
    { name: 'Quiz Data', fn: async () => { preloadQuizzes(); } },
    { name: 'Weekly Data', fn: async () => { await loadWeeklyData(); } },
    { name: 'Verify Panel', fn: async () => { await verify.restoreVerifyMessage(client); } },
    { name: 'Weekly Setup', fn: async () => { setupWeekly(client, WEEKLY_CHANNEL_ID); } },
    { name: 'Slash Commands', fn: async () => { await registerSlashCommands(client); } },
  ];

  console.log('⏳ Initializing all systems in parallel...');
  const results = await Promise.allSettled(initTasks.map(task => task.fn()));

  results.forEach((result, index) => {
    const taskName = initTasks[index].name;
    if (result.status === 'fulfilled') {
      console.log(`✅ ${taskName} initialized`);
    } else {
      console.error(`❌ ${taskName} failed:`, result.reason.message || result.reason);
    }
  });

  console.log('✨ Bot startup sequence completed.');

  setInterval(() => {
    for (const guildTracker of antiRaid.similarityTracker.values()) {
      antiRaid.cleanupSimilarityTracker(guildTracker, antiRaid.SIMILARITY_HASH_EXPIRY_MS);
    }
  }, antiRaid.CLEANUP_INTERVAL_MS);

  const start = Date.now();
  setInterval(() => {
    const elapsed = Date.now() - start;
    const h = Math.floor(elapsed / 1000 / 60 / 60);
    const m = Math.floor((elapsed / 1000 / 60) % 60);
    const s = Math.floor((elapsed / 1000) % 60);
    try {
      client.user.setActivity(`Running | ${h}h ${m}m ${s}s`, { type: ActivityType.Watching });
    } catch {}
  }, 5000);
});

async function handleFaceMatch(message) {
  try { await message.delete(); } catch (e) {}
  const member = message.member;
  let timeoutResult = '❌ 失敗';
  let timeoutTag = '不明';

  if (member && member.manageable) {
    try {
      await member.timeout(7 * 24 * 60 * 60 * 1000, 'Face image auto timeout');
      timeoutResult = '✅ 成功';
      timeoutTag = member.user.tag;
    } catch (err) { console.error('Timeout error:', err); }
  }

  try {
    if (!FACE_LOG_CHANNEL) return;
    const logChannel = await client.channels.fetch(FACE_LOG_CHANNEL);
    if (logChannel && logChannel.isTextBased()) {
      await logChannel.send({
        content: `🧹 類似顔画像を削除しました\n👤 投稿者: ${timeoutTag} (<@${message.author.id}>)\n⏱️ タイムアウト: ${timeoutResult}`,
        allowedMentions: { users: [], roles: [] },
      });
    }
  } catch (logErr) { console.error('Log error:', logErr); }
}

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    const now = Date.now();
    const processedAt = processedMessageIds.get(message.id);
    if (processedAt && now - processedAt < MESSAGE_DEDUP_TTL_MS) return;
    processedMessageIds.set(message.id, now);
    for (const [id, ts] of processedMessageIds.entries()) {
      if (now - ts > MESSAGE_DEDUP_TTL_MS) processedMessageIds.delete(id);
    }

    if (message.channel.type === ChannelType.DM) {
      await antiRaid.handleDirectMessage(message);
      return;
    }
    if (!message.guild) return;

    const attachments = message.attachments.values();
    for (const attachment of attachments) {
      if (attachment.contentType?.startsWith('image/')) {
        if (await isSimilarFace(attachment.url)) {
          await handleFaceMatch(message);
          return;
        }
      }
    }

    const urls = message.content.match(/https?:\/\/[^\s]+/g) || [];
    for (const url of urls) {
      if (url.match(/\.(jpg|jpeg|png|webp)$/i)) {
        if (await isSimilarFace(url)) {
          await handleFaceMatch(message);
          return;
        }
      }
    }

    await antiRaid.handleMessage(message);
    await handleWeeklyMessage(message, WEEKLY_CHANNEL_ID);
    if (message.author.id && ACTIVE_ROLE_ID) {
      await addMessage(message.guild.id, message.author.id, client, ACTIVE_ROLE_ID);
    }
    if (message.member) await addXp(message.member);
    await handlePrefixMessage(client, message);

  } catch (err) {
    console.error('messageCreate processing error:', err);
  }
});

cron.schedule('0 0 1 * *', async () => {
  try { await resetMonthlyActivity(client); } catch (err) { console.error('Monthly reset failed:', err); }
});

client.on('messageUpdate', handleMessageUpdate);
client.on('guildMemberAdd', handleMemberJoin);
client.on('guildMemberRemove', onGuildMemberRemove);
client.on('guildMemberUpdate', onGuildMemberUpdate);
client.on('guildBanAdd', onGuildBanAdd);
client.on('roleUpdate', handleRoleUpdate);
client.on('messageReactionAdd', handleReactionAdd);
client.on('guildAuditLogEntryCreate', handleAuditLogEntry);
// 追加イベントハンドラーの登録
client.on('guildMemberAdd', handleBotAdd);
client.on('guildUpdate', handleGuildUpdate);
client.on('channelCreate', handleChannelCreate);
client.on('channelUpdate', handleChannelUpdate);
client.on('roleCreate', handleRoleCreate);
client.on('roleDelete', handleRoleDelete);

async function boot() {
  const singletonEnabled = (process.env.BOT_SINGLETON_ENABLED || 'false').toLowerCase() === 'true';
  if (singletonEnabled) {
    const instanceId = `${process.env.HOSTNAME || 'local'}-${process.pid}`;
    const lockResult = await acquireSingletonLock(instanceId);
    if (!lockResult.acquired) {
      console.warn(`⏸️ 別インスタンスが稼働中のためDiscordログインをスキップします: ${lockResult.reason}`);
      return;
    }
    console.log(`🔒 Singleton lock 獲得: ${instanceId}`);
    startSingletonHeartbeat(instanceId);
  }
  await client.login(TOKEN);
}

boot().catch((err) => {
  console.error('❌ Boot failed:', err);
  process.exit(1);
});
