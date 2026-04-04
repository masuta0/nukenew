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
const { preloadQuizzes } = require('./utils/quiz');
const { addXp, loadData: loadLevelData } = require('./utils/level');
const verify = require('./utils/verify');
const ticket = require('./utils/ticket');
const { setupWeekly, loadWeeklyData } = require('./utils/weeklyManager');
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

// === 設定 ===
const ACTIVE_ROLE_ID = '1425643672900472964';
const TOKEN = process.env.TOKEN;
const PORT = process.env.PORT || 3000;
const WEEKLY_CHANNEL_ID = process.env.WEEKLY_CHANNEL_ID || null;

const APP_DATA_DIR = path.join(__dirname, 'app-data');
if (!fs.existsSync(APP_DATA_DIR)) fs.mkdirSync(APP_DATA_DIR, { recursive: true });

// === process-level safety handlers ===
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});

// === Discord Client ===
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

// === Expressサーバ ===
const app = express();
app.get('/', (req, res) => res.send('Bot is running'));
app.listen(PORT, () => console.log('Server listening on port ' + PORT));

// === Interaction処理 ===
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
    } else if (interaction.isModalSubmit && interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('ticket_')) {
        await ticket.modalHandler(interaction);
      } else if (interaction.customId.startsWith('verify_')) {
        await verify.modalHandler(interaction);
      } else {
        console.warn('未処理のモーダルID:', interaction.customId);
      }
    }
  } catch (err) {
    console.error('interactionCreate error:', err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: '⚠️ エラーが発生しました。',
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: '⚠️ エラーが発生しました。',
          ephemeral: true,
        });
      }
    } catch (e) {
      console.error('followUp/reply error:', e);
    }
  }
});

// === Readyイベント ===
client.once('ready', async () => {
  console.log('Logged in as ' + client.user.tag);

  try {
    // 顔認識初期化
    await initFaceRecognition();
    console.log('Face recognition initialized');

    // Debug: check yt-dlp availability and PATH
    try {
      const which = spawnSync('which', ['yt-dlp'], { encoding: 'utf8' });
      console.log('DEBUG: which yt-dlp status=', which.status, 'stdout=', which.stdout && which.stdout.trim());
    } catch (e) {
      console.log('DEBUG: which yt-dlp failed:', e);
    }
    console.log('DEBUG: process.env.PATH=', process.env.PATH);
    try {
      console.log('DEBUG: utils/music._hasYtDlp =', music._hasYtDlp);
    } catch (e) {
      console.log('DEBUG: failed to read music._hasYtDlp', e);
    }

    // デフォルト顔登録: ローカルの face.jpg を優先して登録する
    try {
      const localFacePath = path.join(__dirname, 'face.jpg');
      if (fs.existsSync(localFacePath)) {
        await registerFace(localFacePath);
        console.log('Face registered from local face.jpg');
      } else {
        await registerFace('https://i.imgur.com/DkoHDM9.jpg');
        console.log('Face registered from fallback URL');
      }
    } catch (faceError) {
      console.error('Face registration failed:', faceError.message || faceError);
      console.log('Skipping face registration...');
    }

    // Dropbox初期化
    await ensureDropboxInit();

    // データロード
    await loadActivity();
    await loadLevelData();
    preloadQuizzes();
    await loadWeeklyData();

    // 認証パネル自動再設置
    await verify.restoreVerifyMessage(client);
    console.log('✅ 認証パネル自動再設置完了');

    // 週次処理セットアップ
    setupWeekly(client, WEEKLY_CHANNEL_ID);

    // スラッシュコマンド登録
    await registerSlashCommands(client);
    console.log('Slash commands registered');
  } catch (err) {
    console.error('Ready event initialization error:', err);
  }

  // 定期処理: アンチレイド類似顔ハッシュクリア
  setInterval(() => {
    for (const guildTracker of antiRaid.similarityTracker.values()) {
      antiRaid.cleanupSimilarityTracker(guildTracker, antiRaid.SIMILARITY_HASH_EXPIRY_MS);
    }
  }, antiRaid.CLEANUP_INTERVAL_MS);
  console.log('[Anti-Raid] Hash cleanup started.');

  // 定期処理: Botステータス更新
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

// === 類似顔検出処理 ===
async function handleFaceMatch(message) {
  try {
    await message.delete();
  } catch (e) {
    // ignore
  }

  const member = message.member;
  let timeoutResult = '❌ タイムアウト失敗';
  let timeoutTag = '不明';

  if (member && member.manageable) {
    try {
      await member.timeout(7 * 24 * 60 * 60 * 1000, 'Face image auto timeout');
      timeoutResult = '✅ タイムアウト成功';
      timeoutTag = member.user.tag;
      console.log('⏱️ 1週間タイムアウト: ' + timeoutTag);
    } catch (err) {
      console.error('⛔ タイムアウトエラー:', err);
    }
  }

  try {
    const logChannel = await client.channels.fetch('1422418574730989638');
    if (logChannel && logChannel.isTextBased()) {
      await logChannel.send({
        content:
          `🧹 類似顔画像を削除しました\n` +
          `👤 投稿者: ${timeoutTag} (<@${message.author.id}>)\n` +
          `📨 メッセージID: ${message.id}\n` +
          `⏱️ タイムアウト結果: ${timeoutResult}\n` +
          `📍 チャンネル: <#${message.channel.id}>`,
        allowedMentions: { users: [], roles: [] },
      });
    }
  } catch (logErr) {
    console.error('📛 ログ送信エラー:', logErr);
  }

  console.log('🧹 類似顔画像を削除: ' + message.id);
}

// === メッセージ処理（統合版） ===
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    // DM専用処理
    if (message.channel.type === ChannelType.DM) {
      await antiRaid.handleDirectMessage(message);
      return;
    }

    // ギルドメッセージのみ以降の処理を行う
    if (!message.guild) return;

    // 添付画像チェック
    for (const attachment of message.attachments.values()) {
      if (attachment.contentType?.startsWith('image/')) {
        if (await isSimilarFace(attachment.url)) {
          await handleFaceMatch(message);
          return;
        }
      }
    }

    // 本文内画像リンクチェック
    const urls = message.content.match(/https?:\/\/[^\s]+/g) || [];
    for (const url of urls) {
      if (url.match(/\.(jpg|jpeg|png|webp)$/i)) {
        if (await isSimilarFace(url)) {
          await handleFaceMatch(message);
          return;
        }
      }
    }

    // アンチレイド処理
    await antiRaid.handleMessage(message);

    // アクティブロール処理
    if (message.author.id) {
      await addMessage(message.guild.id, message.author.id, client, ACTIVE_ROLE_ID);
    }

    // レベルXP加算
    if (message.member) await addXp(message.member);

    // プレフィックスコマンド処理
    await handlePrefixMessage(client, message);

  } catch (err) {
    console.error('messageCreate processing error:', err);
  }
});

// === 毎月1日にアクティビティリセット ===
cron.schedule('0 0 1 * *', async () => {
  try {
    await resetMonthlyActivity(client);
  } catch (err) {
    console.error('Monthly reset failed:', err);
  }
});

// === 追加イベントハンドラ ===
client.on('messageUpdate', handleMessageUpdate);
client.on('guildMemberAdd', handleMemberJoin);
client.on('guildMemberRemove', onGuildMemberRemove);
client.on('guildMemberUpdate', onGuildMemberUpdate);
client.on('guildBanAdd', onGuildBanAdd);
client.on('roleUpdate', handleRoleUpdate);
client.on('messageReactionAdd', handleReactionAdd);
client.on('guildAuditLogEntryCreate', handleAuditLogEntry);

// === ログイン ===
client.login(TOKEN);