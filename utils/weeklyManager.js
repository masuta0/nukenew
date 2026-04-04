// utils/weeklyManager.js
require('dotenv').config();
const { PermissionsBitField } = require('discord.js');
const { uploadToDropbox, downloadFromDropbox, ensureDropboxInit } = require('./storage');

const REQUIRED_MESSAGES = 300;
const COOLDOWN_TIME = 10 * 1000; // 10秒クールダウン
const DROPBOX_WEEKLY_PATH = '/app-data/userWeeklyMessages.json';

let messageCounts = {}; // { 'guildId_userId': count }
let cooldowns = new Set();

async function loadWeeklyData() {
  try {
    await ensureDropboxInit();
    const data = await downloadFromDropbox(DROPBOX_WEEKLY_PATH);
    messageCounts = data ? JSON.parse(data) : {};
    console.log('✅ 週間メッセージデータをDropboxからロードしました');
  } catch (err) {
    console.error('❌ 週間メッセージデータのロードに失敗:', err);
    messageCounts = {};
  }
}

/**
 * Dropboxへデータ保存
 */
async function saveWeeklyData() {
  try {
    await uploadToDropbox(DROPBOX_WEEKLY_PATH, JSON.stringify(messageCounts, null, 2));
    console.log('✅ 週間メッセージデータをDropboxに保存しました');
  } catch (err) {
    console.error('❌ 週間メッセージデータの保存に失敗:', err);
  }
}

/**
 * メッセージカウント処理
 */
async function handleMessage(message, weeklyChannelId) {
  if (!message.guild || !message.member || message.author.bot) return;

  const key = `${message.guild.id}_${message.author.id}`;
  if (cooldowns.has(key)) return;

  if (!messageCounts[key]) messageCounts[key] = 0;
  messageCounts[key]++;

  cooldowns.add(key);
  setTimeout(() => cooldowns.delete(key), COOLDOWN_TIME);

  if (messageCounts[key] === REQUIRED_MESSAGES) {
    const channel = message.guild.channels.cache.get(weeklyChannelId);
    if (channel?.isTextBased()) {
      await channel.permissionOverwrites.edit(message.member, { SendMessages: true });
      await channel.send(
        `🎉 ${message.member} が週間メッセージ300達成！\n宣伝チャンネルが開放されました！`
      );
    }
  }

  await saveWeeklyData();
}

/**
 * 週末リセット（日本時間 日曜23:59）
 */
async function resetWeeklyChannel(client, weeklyChannelId) {
  for (const guild of client.guilds.cache.values()) {
    const channel = guild.channels.cache.get(weeklyChannelId);
    if (!channel?.isTextBased()) continue;

    // チャンネル権限リセット
    await channel.permissionOverwrites.set([]);
  }

  // メッセージカウントリセット
  messageCounts = {};
  await saveWeeklyData();

  console.log('✅ 週間メッセージカウント＆チャンネル権限をリセットしました (日本時間 日曜23:59)');
}

/**
 * Botにイベント登録 & 自動リセット
 */
function setupWeekly(client, weeklyChannelId) {
  client.on('messageCreate', async (message) => {
    await handleMessage(message, weeklyChannelId);
  });

  // 1分ごとに日本時間チェック
  setInterval(async () => {
    const now = new Date();
    const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000); // 日本時間
    if (jst.getDay() === 0 && jst.getHours() === 23 && jst.getMinutes() === 59) {
      await resetWeeklyChannel(client, weeklyChannelId);
    }
  }, 60 * 1000);
}

module.exports = { setupWeekly, loadWeeklyData, resetWeeklyChannel };