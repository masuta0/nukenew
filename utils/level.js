// utils/level.js
const fs = require(‘fs’);
const path = require(‘path’);
const { uploadToDropbox, downloadFromDropbox, ensureDropboxInit } = require(’./storage’);

const LOCAL_LEVEL_DATA_PATH = path.join(__dirname, ‘../app-data/userLevels.json’);
const DROPBOX_LEVEL_DATA_PATH = ‘/app-data/userLevels.json’;
const LEVEL_SETTINGS_PATH = path.join(__dirname, ‘./levels.json’);

let userLevels = {};
let levelSettings = {};
const xpCooldown = new Set();
const COOLDOWN_TIME = 30 * 1000;

const levelLogChannels = {
“1420924251824848988”: “1425643757902106704”,
};

// データロード
async function loadData() {
// Dropbox優先でロード
try {
await ensureDropboxInit();
const data = await downloadFromDropbox(DROPBOX_LEVEL_DATA_PATH);
if (data && data.trim() !== “”) {
const parsed = JSON.parse(data);
userLevels = { …userLevels, …parsed };
} else {
console.warn(‘⚠️ Dropboxのユーザーレベルデータが空、初期化せずスキップ’);
}
} catch (err) {
console.warn(‘⚠️ Dropboxロード失敗、ローカルを確認します:’, err.message);
}

// ローカルファイルもあればマージ
try {
if (fs.existsSync(LOCAL_LEVEL_DATA_PATH)) {
const localData = JSON.parse(fs.readFileSync(LOCAL_LEVEL_DATA_PATH, ‘utf-8’));
userLevels = { …userLevels, …localData };
}
} catch (err) {
console.error(‘❌ ローカルロード失敗:’, err);
// userLevels = {}; ← ここで初期化しない
}

// レベル設定ロード
try {
if (fs.existsSync(LEVEL_SETTINGS_PATH)) {
levelSettings = JSON.parse(fs.readFileSync(LEVEL_SETTINGS_PATH, ‘utf-8’));
} else {
console.warn(‘⚠️ レベル設定が存在しないため初期作成’);
levelSettings = {
“1”: { xp: 100, roleId: null, message: “レベル1到達！” },
“2”: { xp: 250, roleId: null, message: “レベル2到達！” },
“3”: { xp: 500, roleId: null, message: “レベル3到達！” }
};
fs.writeFileSync(LEVEL_SETTINGS_PATH, JSON.stringify(levelSettings, null, 2));
}
} catch (err) {
console.error(‘❌ レベル設定ロード失敗:’, err);
// levelSettings = {}; ← 初期化不要
}
}

// データ保存
async function saveData() {
if (!userLevels || Object.keys(userLevels).length === 0) {
console.warn(“⚠️ userLevelsが空のため保存をスキップします”);
return;
}
try {
fs.writeFileSync(LOCAL_LEVEL_DATA_PATH, JSON.stringify(userLevels, null, 2));
} catch (err) {
console.error(‘❌ ローカル保存失敗:’, err);
}

try {
await ensureDropboxInit();
await uploadToDropbox(DROPBOX_LEVEL_DATA_PATH, JSON.stringify(userLevels, null, 2));
} catch (err) {
console.error(‘❌ Dropbox保存失敗:’, err);
}
}

// XP付与
async function addXp(member) {
if (!member?.id || !member.guild) return;
if (xpCooldown.has(member.id)) return;

const guildId = member.guild.id;
const userId = member.id;

if (!userLevels[guildId]) userLevels[guildId] = {};
if (!userLevels[guildId][userId]) {
// 既存データなければ初期化
userLevels[guildId][userId] = { level: 0, xp: 0 };
}

const userData = userLevels[guildId][userId];
const oldLevel = userData.level;

userData.xp += Math.floor(Math.random() * 6) + 5;

let newLevel = oldLevel;
while (levelSettings[newLevel + 1] && userData.xp >= levelSettings[newLevel + 1].xp) newLevel++;

if (newLevel > oldLevel) {
userData.level = newLevel;
await handleLevelUp(member, newLevel);
}

await saveData();

xpCooldown.add(member.id);
setTimeout(() => xpCooldown.delete(member.id), COOLDOWN_TIME);
}

// レベルアップ処理
async function handleLevelUp(member, newLevel) {
const data = levelSettings[newLevel];
if (!data) return;

const msg = data.message.replace(”{user}”, member.user.tag);

// 送信先チャンネル取得
const logChannelId = levelLogChannels[member.guild.id];
let logChannel = logChannelId ? member.guild.channels.cache.get(logChannelId) : member.guild.systemChannel;
if (logChannel) {
await logChannel.send(`🎉 ${member} ${msg}`);
}

// レベルに対応するロール付与
if (data.roleId) {
const role = member.guild.roles.cache.get(data.roleId);
if (role) await member.roles.add(role).catch(() => {});
}
}

// ユーティリティ
function getLevelData(guildId, userId) {
return (userLevels[guildId]?.[userId]) || { level: 0, xp: 0 };
}

async function setLevelAndXp(guildId, userId, level, xp) {
if (!userLevels[guildId]) userLevels[guildId] = {};
userLevels[guildId][userId] = { level, xp };
await saveData();
}

function calculateRequiredXp(level) {
return levelSettings[level]?.xp || null;
}

module.exports = {
loadData,
addXp,
getLevelData,
setLevelAndXp,
calculateRequiredXp
};
