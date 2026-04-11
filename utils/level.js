// utils/level.js
const fs = require('fs');
const path = require('path');
const { uploadToDropbox, downloadFromDropbox, ensureDropboxInit } = require('./storage');
 
const LOCAL_LEVEL_DATA_PATH = path.join(__dirname, '../app-data/userLevels.json');
const DROPBOX_LEVEL_DATA_PATH = '/app-data/userLevels.json';
 
let userLevels = {};
 
// ===== XPクールダウン・スパム検知 =====
const xpCooldown     = new Set();        // 5秒クールダウン中のユーザー
const lastMsgContent = new Map();        // 最後のメッセージ内容（同一文検知）
const lastMsgTime    = new Map();        // 最後のメッセージ時刻（間隔検知）
 
const COOLDOWN_MS       = 5 * 1000;     // 5秒クールダウン
const MIN_INTERVAL_MS   = 5 * 1000;     // 5秒未満の連投はXP無効
const MIN_MSG_LENGTH    = 2;            // 2文字未満はXP無効
const XP_MIN            = 5;
const XP_MAX            = 15;
 
// 短文・笑い系のみの投稿パターン（XP無効）
const SHORT_ONLY_PATTERN = /^[\s　wｗ草笑ｗｗwww。。、、…！？!?\-ー~〜]+$/u;
 
// ログチャンネルマッピング（guildId → channelId）
const levelLogChannels = {
  '1420924251824848988': '1425643757902106704',
};
 
// ===================================================================
//  XP計算式: Level N に到達するための累積XP = 50 * N^1.5
//  例) Lv1→50  Lv5→約559  Lv10→約1581
// ===================================================================
function xpRequiredForLevel(level) {
  if (level <= 0) return 0;
  return Math.floor(50 * Math.pow(level, 1.5));
}
 
// 累積XPから現在レベルを計算
function getLevelFromXp(totalXp) {
  let level = 0;
  while (xpRequiredForLevel(level + 1) <= totalXp) {
    level++;
  }
  return level;
}
 
// ===================================================================
//  データロード
// ===================================================================
async function loadData() {
  try {
    await ensureDropboxInit();
    const data = await downloadFromDropbox(DROPBOX_LEVEL_DATA_PATH);
    if (data && data.trim() !== '') {
      const parsed = JSON.parse(data);
      userLevels = { ...userLevels, ...parsed };
    } else {
      console.warn('⚠️ Dropboxのレベルデータが空、スキップ');
    }
  } catch (err) {
    console.warn('⚠️ Dropboxロード失敗、ローカルを確認:', err.message);
  }
 
  try {
    if (fs.existsSync(LOCAL_LEVEL_DATA_PATH)) {
      const localData = JSON.parse(fs.readFileSync(LOCAL_LEVEL_DATA_PATH, 'utf-8'));
      userLevels = { ...userLevels, ...localData };
    }
  } catch (err) {
    console.error('❌ ローカルロード失敗:', err);
  }
}
 
// ===================================================================
//  データ保存
// ===================================================================
async function saveData() {
  if (!userLevels || Object.keys(userLevels).length === 0) {
    console.warn('⚠️ userLevelsが空のため保存をスキップ');
    return;
  }
  try {
    fs.writeFileSync(LOCAL_LEVEL_DATA_PATH, JSON.stringify(userLevels, null, 2));
  } catch (err) {
    console.error('❌ ローカル保存失敗:', err);
  }
  try {
    await ensureDropboxInit();
    await uploadToDropbox(DROPBOX_LEVEL_DATA_PATH, JSON.stringify(userLevels, null, 2));
  } catch (err) {
    console.error('❌ Dropbox保存失敗:', err);
  }
}
 
// ===================================================================
//  メッセージ有効性チェック
// ===================================================================
function isValidMessageContent(content) {
  if (!content || content.trim().length < MIN_MSG_LENGTH) return false;
  if (SHORT_ONLY_PATTERN.test(content.trim())) return false;
  return true;
}
 
// ===================================================================
//  レベルロール自動付与（「level数字」を含むロール名を対象）
// ===================================================================
async function assignLevelRole(member, newLevel) {
  try {
    const guild = member.guild;
 
    // ロール名から "level+数字" を抽出
    const levelRoles = [];
    for (const role of guild.roles.cache.values()) {
      const match = role.name.match(/level\s*(\d+)/i);
      if (match) {
        levelRoles.push({ role, threshold: parseInt(match[1], 10) });
      }
    }
    if (levelRoles.length === 0) return;
 
    levelRoles.sort((a, b) => a.threshold - b.threshold);
 
    // 付与すべきロール: 現在レベル以下で最大のもの
    const toGrant  = [...levelRoles].reverse().find(lr => newLevel >= lr.threshold);
    // 削除対象: 付与ロール以外のlevelロール
    const toRemove = levelRoles.filter(lr => !toGrant || lr.role.id !== toGrant.role.id);
 
    for (const { role } of toRemove) {
      if (member.roles.cache.has(role.id)) {
        await member.roles.remove(role, 'レベルロール更新').catch(() => {});
      }
    }
    if (toGrant && !member.roles.cache.has(toGrant.role.id)) {
      await member.roles.add(toGrant.role, `レベル${newLevel}到達`).catch(() => {});
    }
  } catch (err) {
    console.error('❌ レベルロール付与失敗:', err.message);
  }
}
 
// ===================================================================
//  レベルアップ処理
// ===================================================================
async function handleLevelUp(member, newLevel) {
  const logChannelId = levelLogChannels[member.guild.id];
  const logChannel = logChannelId
    ? member.guild.channels.cache.get(logChannelId)
    : member.guild.systemChannel;
 
  if (logChannel) {
    await logChannel
      .send(`🎉 ${member} がレベル **${newLevel}** に到達しました！`)
      .catch(() => {});
  }
 
  await assignLevelRole(member, newLevel);
}
 
// ===================================================================
//  XP付与（messageCreate時に呼ぶ）
// ===================================================================
async function addXp(member, messageContent = '') {
  if (!member?.id || !member.guild) return;
 
  const userId  = member.id;
  const guildId = member.guild.id;
 
  // ① 5秒クールダウンチェック
  if (xpCooldown.has(userId)) return;
 
  // ② 荒らし判定チェック（anti-raidと連携）
  try {
    const antiRaid = require('./anti-raid');
    // CONFIRMED_RAID状態はXP完全無効
    if (antiRaid.confirmedRaidUsers?.has(userId)) return;
    // スコアが閾値の70%以上もXP停止
    const threshold = antiRaid.currentCfg?.()?.THRESHOLD ?? 20;
    if ((antiRaid.getScore?.(userId) ?? 0) >= threshold * 0.7) return;
  } catch (_) {
    // anti-raidが読み込めなくても続行
  }
 
  // ③ メッセージ内容チェック（短すぎ・笑い系単体）
  if (messageContent && !isValidMessageContent(messageContent)) return;
 
  // ④ 同一内容の連投チェック（コピペ・連投は無効）
  if (messageContent) {
    const trimmed = messageContent.trim();
    if (lastMsgContent.get(userId) === trimmed) return;
    lastMsgContent.set(userId, trimmed);
  }
 
  // ⑤ 送信間隔チェック（5秒未満の連投はXP無効）
  const now      = Date.now();
  const lastTime = lastMsgTime.get(userId) ?? 0;
  if (now - lastTime < MIN_INTERVAL_MS) return;
  lastMsgTime.set(userId, now);
 
  // ⑥ XP付与
  if (!userLevels[guildId]) userLevels[guildId] = {};
  if (!userLevels[guildId][userId]) {
    userLevels[guildId][userId] = { xp: 0, level: 0 };
  }
 
  const userData = userLevels[guildId][userId];
  const oldLevel = getLevelFromXp(userData.xp);
  const xpGain   = Math.floor(Math.random() * (XP_MAX - XP_MIN + 1)) + XP_MIN; // 5〜15
  userData.xp   += xpGain;
 
  const newLevel  = getLevelFromXp(userData.xp);
  userData.level  = newLevel;
 
  if (newLevel > oldLevel) {
    await handleLevelUp(member, newLevel);
  }
 
  await saveData();
 
  // 5秒クールダウンセット
  xpCooldown.add(userId);
  setTimeout(() => xpCooldown.delete(userId), COOLDOWN_MS);
}
 
// ===================================================================
//  タイムアウト・処罰ユーザーへのXPペナルティ
// ===================================================================
async function penalizeUser(guildId, userId, resetAll = false) {
  if (!userLevels[guildId]?.[userId]) return;
  if (resetAll) {
    userLevels[guildId][userId] = { xp: 0, level: 0 };
  } else {
    // XPを20%カット
    const newXp = Math.floor((userLevels[guildId][userId].xp ?? 0) * 0.8);
    userLevels[guildId][userId].xp    = newXp;
    userLevels[guildId][userId].level = getLevelFromXp(newXp);
  }
  await saveData();
}
 
// ===================================================================
//  ユーティリティ
// ===================================================================
function getLevelData(guildId, userId) {
  const data = userLevels[guildId]?.[userId];
  if (!data) return { level: 0, xp: 0 };
  const level = getLevelFromXp(data.xp);
  return { level, xp: data.xp };
}
 
async function setLevelAndXp(guildId, userId, level, xp) {
  if (!userLevels[guildId]) userLevels[guildId] = {};
  userLevels[guildId][userId] = { level, xp };
  await saveData();
}
 
function calculateRequiredXp(level) {
  return xpRequiredForLevel(level);
}
 
module.exports = {
  loadData,
  addXp,
  getLevelData,
  setLevelAndXp,
  calculateRequiredXp,
  penalizeUser,
  xpRequiredForLevel,
  getLevelFromXp,
};
