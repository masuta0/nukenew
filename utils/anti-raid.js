// utils/anti-raid.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');  // ★ 新機能で使用
const {
  AuditLogEvent,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
} = require('discord.js');

// AI 判定（任意）: utils/ai.js の chat() を使う
const USE_AI_JUDGEMENT = (process.env.ANTI_RAID_USE_AI || 'false').toLowerCase() === 'true';
let chat = null;
if (USE_AI_JUDGEMENT) {
  try {
    ({ chat } = require('./ai'));
  } catch {}
}

// ===== 設定 =====
// ★ 修正: ログチャンネルを nuke-logs に固定（環境変数があればそれも使えるように）
const LOG_CHANNEL_ID = process.env.ANTI_RAID_LOG_CHANNEL_ID || 'nuke-logs'; // 名前かID
const AUTH_CHANNEL_ID = process.env.ANTI_RAID_AUTH_CHANNEL_ID || '1425643775694340158';
const JOIN_LOG_CHANNEL_ID = process.env.JOIN_LOG_CHANNEL_ID || '1425643771206570117';

// ホワイトリスト（ユーザー / ロール）
const WHITELIST_USERS = (process.env.ANTI_RAID_WHITELIST_USERS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const WHITELIST_ROLES = (process.env.ANTI_RAID_WHITELIST_ROLES || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// ===== JSON永続化 =====
const DATA_DIR = path.join(__dirname, '../data');
const SCORE_PATH = path.join(DATA_DIR, 'raidScores.json');
const MARK_PATH = path.join(DATA_DIR, 'raidMarks.json');
const BACKUP_PATH = path.join(DATA_DIR, 'serverBackup.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let scores = {};
let markedUsersStore = {};
let serverBackup = {};

function saveScores() {
  try { fs.writeFileSync(SCORE_PATH, JSON.stringify(scores, null, 2)); } catch {}
}
function saveMarks() {
  try { fs.writeFileSync(MARK_PATH, JSON.stringify(markedUsersStore, null, 2)); } catch {}
}
function saveBackup() {
  try { fs.writeFileSync(BACKUP_PATH, JSON.stringify(serverBackup, null, 2)); } catch {}
}

try { scores = JSON.parse(fs.readFileSync(SCORE_PATH, 'utf8')); } catch {}
try { markedUsersStore = JSON.parse(fs.readFileSync(MARK_PATH, 'utf8')); } catch {}
try { serverBackup = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8')); } catch {}

// ===== 閾値（昼/夜で可変）=====
const NIGHT_START_HOUR = 35; // 意図的に無効化
const NIGHT_END_HOUR = 35;

const cfg = {
  day: {
    THRESHOLD: 30,
    MASS_JOIN: 5,
    KEYWORD: 15,
    SIMILAR: 8,
    CMD_ABUSE: 5,
    REACT_SPAM: 5,
    NEWLINES: 10,
    ZALGO: 10,
    MASS_SPAM: 7,
    WEBHOOK: 20,
    AUDIT_ABUSE: 15,
    ACCOUNT_AGE: 10,
    // ★ 新規: ランダム文字列加点
    RANDOM_STRING: 12,
  },
  night: {
    THRESHOLD: 30,
    MASS_JOIN: 5,
    KEYWORD: 15,
    SIMILAR: 8,
    CMD_ABUSE: 5,
    REACT_SPAM: 5,
    NEWLINES: 10,
    ZALGO: 10,
    MASS_SPAM: 7,
    WEBHOOK: 20,
    AUDIT_ABUSE: 15,
    ACCOUNT_AGE: 10,
    RANDOM_STRING: 12,
  }
};

function currentCfg() {
  const now = new Date();
  const jstHour = (now.getUTCHours() + 9) % 24;
  return (jstHour >= NIGHT_START_HOUR || jstHour < NIGHT_END_HOUR) ? cfg.night : cfg.day;
}

// ===== ルール定数 =====
const RAID_MEMBER_THRESHOLD = 3;
const RAID_TIME_WINDOW = 60 * 1000;
const MASS_SPAM_THRESHOLD = 4;
const MASS_SPAM_WINDOW = 5 * 1000;
const SIMILAR_MESSAGE_THRESHOLD = 5;
const SIMILAR_MESSAGE_LENGTH = 10;
const TIMEOUT_MS = 3 * 60 * 1000;
const MARK_EXPIRE_MS = 48 * 60 * 60 * 1000;
const SIMILARITY_DELETE_THRESHOLD = 15;
const SIMILARITY_TIMEOUT_THRESHOLD = 25;
const SIMILARITY_TIMEOUT_DURATION = 3 * 60 * 1000;
const SIMILARITY_PERCENT_THRESHOLD = 75;
const SIMILARITY_MIN_USERS = 3;
const SIMILARITY_HASH_EXPIRY_MS = 3 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 3 * 60 * 1000;
const MASS_ACTION_WINDOW_MS = 2 * 60 * 1000;
const MASS_ACTION_THRESHOLD = 2;
const PROBATION_MS = 24 * 60 * 60 * 1000;

// 通常会話フィルター（誤検知防止）
const COMMON_WORDS = new Set([
  'おはよう', 'こんにちは', 'こんばんは', 'お疲れ様', 'ありがとう', 'おやすみ',
  'よろしく', 'はい', 'いいえ', 'そうですね', 'わかりました', 'すみません',
  'hello', 'hi', 'thanks', 'thank you', 'yes', 'no', 'ok', 'okay',
  'good morning', 'good night', 'welcome', 'sorry', 'please'
]);

// 基本のNGキーワード（変形検知用に正規化後チェック）
const RAID_KEYWORDS_BASE = [
  'raid by', 'on top', '.ozeu', '.gg/oze', '.gg/dpko', 'ますまにの顔', 'ますまに顔',
  '#mute', 'molmol', '.gg/mol', 'aarr', 'aarr on top', 'arr on top', 'discord.gg'
];
const ALLOWED_INVITE_LINKS = ['discord.gg/9ScuqvxzD7'];
const INVITE_REGEX = /discord(?:app)?\.(?:gg|com\/invite)\/([A-Za-z0-9-]+)/gi;
const MENTION_SPAM_THRESHOLD = 5;
const DANGEROUS_PERMISSIONS = [
  PermissionsBitField.Flags.Administrator, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.KickMembers, PermissionsBitField.Flags.BanMembers, PermissionsBitField.Flags.ManageGuild,
];
const DANGEROUS_PERMS_BITFIELD = new PermissionsBitField().add(...DANGEROUS_PERMISSIONS);
const DANGER_ACTIONS = new Set([
  AuditLogEvent.MemberKick, AuditLogEvent.MemberBanAdd, AuditLogEvent.ChannelCreate, AuditLogEvent.ChannelDelete,
  AuditLogEvent.ChannelUpdate, AuditLogEvent.RoleCreate, AuditLogEvent.RoleDelete, AuditLogEvent.RoleUpdate,
]);

// ★ 新規: 短縮リンクサービス一覧
const SHORTENER_SERVICES = [
  'bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly',
  'adf.ly', 'shorte.st', 'bc.vc', 't.co', 'shorturl.at', 'rb.gy'
];

// ★ 新規: ランダム文字検知パラメータ
const RANDOM_STRING_ENTROPY_THRESHOLD = 0.7;
const RANDOM_STRING_MIN_LENGTH = 12;

// ★ 新規: ノリ連投減衰率
const SAME_USER_SPAM_DECAY = 0.5;

// ★ 新規: 短文連投検知
const SHORT_MESSAGE_THRESHOLD = 20;
const SHORT_MSG_SPAM_COUNT = 5;
const SHORT_MSG_WINDOW = 10000;

// ★ 新規: botコマンド協調攻撃検知
const COMMAND_PREFIXES = ['!', '?', '.', '/', '$', '+', '-', '>', '<'];
const DANGEROUS_BOT_COMMANDS = [
  'ban', 'kick', 'mute', 'warn', 'purge', 'clear', 'lock', 'lockdown',
  'exec', 'eval', 'shutdown', 'reboot', 'reset'
];
const COMMAND_ATTACK_WINDOW_MS = 10 * 1000;
const COMMAND_ATTACK_MIN_USERS = 3;
const COMMAND_ATTACK_MIN_COUNT = 3;
const SUSPICIOUS_COMMAND_SCORE = 10;
const DANGEROUS_COMMAND_SCORE = 20;

// ===== 内部状態 =====
const memberJoinLog = new Map();
const messageHistory = new Map();
const similarityTracker = new Map();
const userCmdTime = new Map();
const userReactTime = new Map();
const userMsgTs = new Map();
const pendingModActions = new Map();
const raidAuthRoles = new Map();
const executorActionLog = new Map();
const probationAdmins = new Map();
const massBanLog = new Map();
const massNukeLog = new Map();
const spamCounts = new Map();
// ★ 新規状態
const shortMsgHistory = new Map();
const commandAttackTracker = new Map();
const userCommandDetails = new Map();
const slowModeChannels = new Map();

// ===== ユーティリティ =====
function hasDangerousPerms(permBits) {
  const perm = new PermissionsBitField(permBits);
  return perm.any(DANGEROUS_PERMS_BITFIELD);
}

function isWhitelisted(member) {
  if (!member) return false;
  if (WHITELIST_USERS.includes(member.id)) return true;
  if (member.roles?.cache?.some(r => WHITELIST_ROLES.includes(r.id))) return true;
  return false;
}

function addScore(userId, amount, isSameUserSpam = false) {
  let finalAmount = amount;
  if (isSameUserSpam) finalAmount = Math.floor(amount * SAME_USER_SPAM_DECAY);
  scores[userId] = (scores[userId] || 0) + finalAmount;
  saveScores();
  return scores[userId];
}

function setScore(userId, value) {
  scores[userId] = value;
  saveScores();
}

function getScore(userId) {
  return scores[userId] || 0;
}

function markUser(userId) {
  markedUsersStore[userId] = Date.now();
  saveMarks();
  setTimeout(() => {
    delete markedUsersStore[userId];
    saveMarks();
    delete scores[userId];
    saveScores();
    userCmdTime.delete(userId);
    userReactTime.delete(userId);
    userMsgTs.delete(userId);
  }, MARK_EXPIRE_MS);
}

function isMarked(userId) {
  const t = markedUsersStore[userId];
  if (!t) return false;
  if (Date.now() - t > MARK_EXPIRE_MS) {
    delete markedUsersStore[userId];
    saveMarks();
    return false;
  }
  return true;
}

// ★ 新規: 文字列正規化（変形対策）
function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ')
    .normalize('NFKC')
    .replace(/[０Ｏо○]/g, 'o')
    .replace(/[１Ｉｌ|]/g, 'l')
    .replace(/[５Ｓｓ$]/g, 's')
    .replace(/[２Ｚｚ]/g, 'z')
    .replace(/[８Ｂｂ]/g, 'b')
    .replace(/[９ｇｑ]/g, 'g')
    .replace(/[．。]/g, '.')
    .replace(/[／]/g, '/')
    .replace(/\.+/g, '.')
    .trim();
}

// ★ 新規: ランダム文字列検出
function isRandomString(text) {
  if (text.length < RANDOM_STRING_MIN_LENGTH) return false;
  const lower = text.toLowerCase();
  for (const word of COMMON_WORDS) if (lower.includes(word)) return false;
  const freq = {};
  for (const ch of text) freq[ch] = (freq[ch] || 0) + 1;
  let entropy = 0;
  const len = text.length;
  for (const ch in freq) {
    const p = freq[ch] / len;
    entropy -= p * Math.log2(p);
  }
  const maxEntropy = Math.log2(Math.min(len, 95));
  const normalizedEntropy = entropy / maxEntropy;
  if (normalizedEntropy > RANDOM_STRING_ENTROPY_THRESHOLD) return true;
  const onlyAlnum = /^[a-zA-Z0-9]+$/.test(text);
  const vowelCount = (text.match(/[aeiouAEIOU]/g) || []).length;
  if (onlyAlnum && vowelCount === 0 && text.length > 8) return true;
  return false;
}

// ★ 新規: 悪意あるリンク判定（正規化後）
function containsMaliciousLink(text) {
  const normalized = normalizeText(text);
  if (/(?:discord\.gg|\.gg)\/[a-z0-9-]+/i.test(normalized)) {
    for (const allowed of ALLOWED_INVITE_LINKS) {
      if (normalized.includes(allowed.toLowerCase())) return false;
    }
    return true;
  }
  for (const kw of RAID_KEYWORDS_BASE) {
    if (normalized.includes(kw.toLowerCase())) return true;
  }
  return false;
}

// ★ 新規: 短縮リンク展開
async function expandShortUrl(url) {
  try {
    const response = await axios.head(url, {
      maxRedirects: 5,
      timeout: 5000,
      validateStatus: status => status >= 200 && status < 400
    });
    return response.request.res.responseUrl || url;
  } catch {
    return url;
  }
}

// ★ 新規: botコマンド抽出
function extractBotCommand(content) {
  const trimmed = content.trim();
  for (const prefix of COMMAND_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      const withoutPrefix = trimmed.slice(prefix.length);
      const cmdMatch = withoutPrefix.match(/^([a-zA-Z0-9_-]+)/);
      if (cmdMatch) return `${prefix}${cmdMatch[1].toLowerCase()}`;
      return prefix;
    }
  }
  return null;
}
function isDangerousBotCommand(command) {
  if (!command) return false;
  const lowerCmd = command.toLowerCase();
  for (const dangerous of DANGEROUS_BOT_COMMANDS) {
    if (lowerCmd.includes(dangerous)) return true;
  }
  return false;
}

// 類似度計算（既存）
function calculateSimilarity(str1, str2) {
  if (str1 === str2) return 100;
  const len1 = str1.length;
  const len2 = str2.length;
  if (len1 === 0) return len2 === 0 ? 100 : 0;
  if (len2 === 0) return 0;
  const matrix = Array(len2 + 1).fill(null).map(() => Array(len1 + 1).fill(null));
  for (let i = 0; i <= len1; i++) matrix[0][i] = i;
  for (let j = 0; j <= len2; j++) matrix[j][0] = j;
  for (let j = 1; j <= len2; j++) {
    for (let i = 1; i <= len1; i++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j - 1][i] + 1,
        matrix[j][i - 1] + 1,
        matrix[j - 1][i - 1] + cost
      );
    }
  }
  const distance = matrix[len2][len1];
  const maxLen = Math.max(len1, len2);
  return Math.round((1 - distance / maxLen) * 100);
}

function isCommonConversation(content) {
  const normalized = content.toLowerCase().trim();
  if (normalized.length < 5) return true;
  const words = normalized.split(/\s+/);
  if (words.length <= 3 && words.every(word => COMMON_WORDS.has(word))) return true;
  if (/^[!？?！。.]+$/.test(normalized)) return true;
  if (/^[\d\s]+$/.test(normalized) || /^[^\w\s]+$/.test(normalized)) return true;
  return false;
}

function snippet(text, maxLength = 30) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

async function safeDelete(message, reason) {
  try { if (message?.deletable) await message.delete(); } catch {}
}

// ★ 修正: ログチャンネル取得（nuke-logs 優先、なければID）
async function getOrCreateLogChannel(guild, channelId = LOG_CHANNEL_ID) {
  if (!guild) return null;
  // もし channelId が "nuke-logs" という名前なら名前検索
  if (channelId === 'nuke-logs') {
    let ch = guild.channels.cache.find(c => c.name === 'nuke-logs' && c.type === ChannelType.GuildText);
    if (ch) return ch;
    try {
      ch = await guild.channels.create({
        name: 'nuke-logs',
        type: ChannelType.GuildText,
        reason: '荒らし対策ログ専用チャンネル',
      });
      return ch;
    } catch { return null; }
  }
  // 従来のID指定
  let ch = channelId && guild.channels.cache.get(channelId);
  if (ch) return ch;
  try {
    ch = await guild.channels.create({
      name: 'bot-logs',
      type: ChannelType.GuildText,
      reason: '荒らし対策ログ',
    });
    return ch;
  } catch {
    return null;
  }
}

async function sendLogEmbed(guild, {
  title,
  member,
  description,
  fields = [],
  color = 0xff0000,
  channelName,
  logChannelId = LOG_CHANNEL_ID,
  content = null
}) {
  const ch = await getOrCreateLogChannel(guild, logChannelId);
  if (!ch) return;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description || '')
    .addFields(
      ...(member ? [{ name: 'ユーザー', value: `${member.user?.tag || 'unknown'} (${member.id})`, inline: false }] : []),
      ...fields,
      ...(content ? [{ name: '問題となったメッセージ', value: `\`\`\`\n${snippet(content, 1000)}\n\`\`\``, inline: false }] : []),
    )
    .setTimestamp();
  if (channelName && channelName.length > 0) {
    embed.setFooter({ text: `チャンネル: #${channelName}` });
  }
  ch.send({ embeds: [embed] }).catch(() => {});
}

async function sendPlainLog(guild, channelId, content) {
  try {
    const ch = await getOrCreateLogChannel(guild, channelId);
    if (ch) await ch.send(content);
  } catch (e) {
    console.error('[anti-raid] Failed to send plain log:', e);
  }
}

async function saveAndStripRoles(member) {
  if (!member?.manageable) return;
  const oldRoles = member.roles.cache.map(r => r.id);
  raidAuthRoles.set(member.id, oldRoles);
  await member.roles.set([], 'Raid対策: 権限一時剥奪');
}

async function restoreRoles(member) {
  const old = raidAuthRoles.get(member.id);
  if (!old) return;
  await member.roles.set(old, 'Raid対策: 認証完了・復元');
  raidAuthRoles.delete(member.id);
  member.send('✅ 認証が完了しました。あなたのロールは元に戻されました。').catch(() => {});
}

async function createOneTimeInvite(guild) {
  try {
    const channel = guild.systemChannel || guild.channels.cache.find(c =>
      c.type === ChannelType.GuildText &&
      c.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.CreateInstantInvite)
    );
    if (!channel) return null;
    const invite = await channel.createInvite({ maxAge: 30*60, maxUses: 1, unique: true, reason: '救済用自動招待リンク' }).catch(() => null);
    return invite?.url || null;
  } catch { return null; }
}

async function isReasonAppropriate(entry, reason) {
  if (!chat) return reason.length > 10;
  const prompt = `以下のDiscordサーバーの操作に対するユーザーの理由が適切かを判断してください。\n\n[操作]: ${AuditLogEvent[entry.action]}\n[理由]: ${reason}\n\n「適切」または「不適切」で回答してください。`;
  const res = await chat(prompt, entry.executor.id);
  return res && res.includes('適切');
}

function backupServerState(guild) {
  try {
    const data = {
      roles: guild.roles.cache.map(r => ({ id: r.id, permissions: r.permissions.bitfield })),
      channels: guild.channels.cache.map(c => ({ id: c.id, type: c.type, name: c.name })),
    };
    serverBackup[guild.id] = data;
    saveBackup();
  } catch (e) { console.error('[anti-raid] backupServerState error:', e); }
}

async function restoreServerState(guild) {
  const data = serverBackup[guild.id];
  if (!data) return;
  try {
    for (const r of data.roles) {
      const role = guild.roles.cache.get(r.id);
      if (role) await role.setPermissions(r.permissions, 'バックアップ復元');
    }
    for (const c of data.channels) {
      const channel = guild.channels.cache.get(c.id);
      if (channel && channel.name !== c.name) await channel.setName(c.name, 'バックアップ復元');
    }
    await sendPlainLog(guild, LOG_CHANNEL_ID, '✅ サーバーをバックアップ状態に復元しました。');
  } catch (e) { console.error('[anti-raid] restoreServerState error:', e); }
}

// ===== 処罰段階 =====
async function punishByScore(member, reason, channelName) {
  if (!member || isWhitelisted(member) || probationAdmins.has(member.id)) return;
  const c = currentCfg();
  const score = getScore(member.id);
  if (score >= Math.floor(c.THRESHOLD * 0.5) && score < c.THRESHOLD) {
    const muteRole = member.guild.roles.cache.find(r => r.name.toLowerCase() === 'muted');
    if (muteRole && !member.roles.cache.has(muteRole.id)) {
      await member.roles.add(muteRole, '荒らし疑い（スコア中間）').catch(() => {});
      await sendLogEmbed(member.guild, { title: '⚠️ 荒らし疑い（Mute）', member, description: `理由: ${reason}\nスコア: ${score}/${c.THRESHOLD}`, channelName, color: 0xffa200 });
      return;
    }
  }
  if (score >= c.THRESHOLD) {
    try {
      await member.timeout(TIMEOUT_MS, reason);
      await sendLogEmbed(member.guild, { title: '🚨 Timeout 適用', member, description: `理由: ${reason}\nスコア: ${score}（閾値 ${c.THRESHOLD} 到達）\nTimeout: ${Math.floor(TIMEOUT_MS / 60000)}分`, channelName });
      setScore(member.id, Math.floor(c.THRESHOLD * 0.5));
      markUser(member.id);
    } catch {
      await saveAndStripRoles(member).catch(() => {});
      await sendLogEmbed(member.guild, { title: '🚨 権限剥奪（代替）', member, description: `Timeout に失敗したためロール剥奪。\n理由: ${reason}\nスコア: ${score}`, channelName });
      markUser(member.id);
    }
  }
}

// ★ 新規: 緊急スローモード（5分後に自動解除）
async function applyEmergencySlowmode(channel, durationSeconds = 10, reason = '荒らし検知') {
  if (!channel || channel.type !== ChannelType.GuildText) return;
  if (slowModeChannels.has(channel.id)) return;
  try {
    const originalRateLimit = channel.rateLimitPerUser;
    await channel.setRateLimitPerUser(durationSeconds, reason);
    slowModeChannels.set(channel.id, { originalRateLimit, timeout: Date.now() });
    await sendLogEmbed(channel.guild, {
      title: '⏱️ 緊急スローモード適用',
      description: `チャンネル: #${channel.name}\nスローモード: ${durationSeconds}秒\n理由: ${reason}\n⏰ 5分後に自動解除します。`,
      color: 0xffa200,
    });
    setTimeout(async () => {
      const data = slowModeChannels.get(channel.id);
      if (data && Date.now() - data.timeout >= 300000) {
        await channel.setRateLimitPerUser(data.originalRateLimit || 0, '荒らし対策自動解除');
        slowModeChannels.delete(channel.id);
        await sendLogEmbed(channel.guild, { title: '✅ スローモード解除', description: `#${channel.name} のスローモードを元に戻しました。`, color: 0x00ff00 });
      }
    }, 300000);
  } catch (e) { console.error('[anti-raid] スローモード適用失敗:', e); }
}

// ===== AI 補助（任意）=====
const AI_ANTI_RAID_PROMPT = `
- 以下の行為のみ「不審」と判定:
1. サーバー破壊（権限乱用/チャンネル大量作成/ロール削除など）
2. Raid 予告や勧誘、荒らし用リンク（https 無しでも .gg を含むなど）
3. 不適切画像の乱用
4. メッセージの大量連投
- それ以外は「問題なし」。過剰検知を避けること。
- 出力形式: 「不審/問題なし | 理由: …」
メッセージ:
`;

async function handleAiJudgement(message) {
  if (!USE_AI_JUDGEMENT || !chat) return;
  const member = message.member;
  if (!member || isWhitelisted(member) || member.permissions?.has(PermissionsBitField.Flags.Administrator)) return;
  try {
    const res = await chat(AI_ANTI_RAID_PROMPT + (message.content || ''), message.author.id);
    if (res && /^不審\b/.test(res)) {
      const reason = (res.split('|')[1] || '').trim() || 'AI判定: 不審';
      const added = addScore(member.id, 10);
      await sendLogEmbed(message.guild, { title: '🤖 AI 不審判定', member, description: `理由: ${reason}\n付与: +10\n現在: ${added}/${currentCfg().THRESHOLD}`, channelName: message.channel?.name, color: 0x6c5ce7, content: message.content });
      await punishByScore(member, reason, message.channel?.name);
    }
  } catch {}
}

// ===== 新規: ランダム文字連投検知 =====
async function handleRandomStringSpam(message) {
  const { member, guild, content, channel } = message;
  if (!member || isWhitelisted(member)) return false;
  if (isRandomString(content)) {
    const c = currentCfg();
    const s = addScore(member.id, c.RANDOM_STRING);
    await safeDelete(message, 'ランダム文字列連投');
    await sendLogEmbed(guild, { title: '🚨 ランダム文字列検知', member, description: `意味のないランダム文字列\n+${c.RANDOM_STRING} / 現在 ${s}/${c.THRESHOLD}`, channelName: channel?.name, color: 0xff4757, content });
    await applyEmergencySlowmode(channel, 10, 'ランダム文字連投');
    await punishByScore(member, 'ランダム文字列連投', channel?.name);
    return true;
  }
  return false;
}

// ===== 新規: 変形リンク検知 =====
async function handleObfuscatedLink(message) {
  const { member, guild, content, channel } = message;
  if (!member || isWhitelisted(member)) return false;
  if (containsMaliciousLink(content)) {
    const c = currentCfg();
    const s = addScore(member.id, c.KEYWORD);
    await safeDelete(message, '変形リンク/荒らし文言');
    await sendLogEmbed(guild, { title: '🚨 変形・回避リンク検知', member, description: `正規化後に荒らしパターンを検出\n+${c.KEYWORD} / 現在 ${s}/${c.THRESHOLD}`, channelName: channel?.name, color: 0xff4757, content });
    await applyEmergencySlowmode(channel, 15, '変形リンク荒らし');
    await punishByScore(member, '変形リンク', channel?.name);
    return true;
  }
  return false;
}

// ===== 新規: 短縮リンク展開＋検査 =====
async function handleShortenedUrl(message) {
  const { member, guild, content, channel } = message;
  if (!member || isWhitelisted(member)) return false;
  const urlRegex = /https?:\/\/[^\s<>]+/g;
  const urls = content.match(urlRegex) || [];
  for (const url of urls) {
    const isShortened = SHORTENER_SERVICES.some(service => url.includes(service));
    if (isShortened) {
      try {
        const expandedUrl = await expandShortUrl(url);
        if (containsMaliciousLink(expandedUrl)) {
          const c = currentCfg();
          const s = addScore(member.id, c.KEYWORD);
          await safeDelete(message, '悪意ある短縮リンク');
          await sendLogEmbed(guild, { title: '🚨 悪意ある短縮リンク', member, description: `元のリンク: ${url}\n展開後: ${expandedUrl}\n+${c.KEYWORD} / 現在 ${s}/${c.THRESHOLD}`, channelName: channel?.name, color: 0xff4757, content });
          await punishByScore(member, '悪意ある短縮リンク', channel?.name);
          return true;
        }
      } catch (e) { console.error('URL展開エラー:', e.message); }
    } else if (containsMaliciousLink(url)) {
      const c = currentCfg();
      const s = addScore(member.id, c.KEYWORD);
      await safeDelete(message, '悪意あるリンク');
      await sendLogEmbed(guild, { title: '🚨 悪意あるリンク', member, description: `リンク: ${url}\n+${c.KEYWORD} / 現在 ${s}/${c.THRESHOLD}`, channelName: channel?.name, color: 0xff4757, content });
      await punishByScore(member, '悪意あるリンク', channel?.name);
      return true;
    }
  }
  return false;
}

// ===== 新規: 短文連投スパム（ノリ連投軽減）=====
async function handleShortMessageSpam(message) {
  const { member, guild, content, channel } = message;
  if (!member || isWhitelisted(member)) return;
  if (content.length >= SHORT_MESSAGE_THRESHOLD) return;
  const now = Date.now();
  const uid = member.id;
  if (!shortMsgHistory.has(uid)) shortMsgHistory.set(uid, []);
  const history = shortMsgHistory.get(uid);
  history.push({ timestamp: now, content });
  const recent = history.filter(h => now - h.timestamp < SHORT_MSG_WINDOW);
  shortMsgHistory.set(uid, recent);
  if (recent.length >= SHORT_MSG_SPAM_COUNT) {
    const unique = new Set(recent.map(h => h.content));
    const isRepetitive = unique.size === 1;
    const c = currentCfg();
    const isSameUserSpam = !isRepetitive;
    let added = c.MASS_SPAM;
    if (isSameUserSpam) added = Math.floor(added * 0.6);
    const s = addScore(uid, added, isSameUserSpam);
    await safeDelete(message, '短文連投');
    await sendLogEmbed(guild, { title: isSameUserSpam ? '⚠️ ノリ連投？ (軽減)' : '🚧 短文連投スパム', member, description: `${SHORT_MSG_WINDOW/1000}秒間に${recent.length}回\n+${added} / 現在 ${s}/${c.THRESHOLD}`, channelName: channel?.name, color: 0xffa200, content });
    if (!isSameUserSpam) await applyEmergencySlowmode(channel, 5, '連投検知（軽減）');
    await punishByScore(member, '短文連投', channel?.name);
  }
}

// ===== 新規: 複数アカウント協調コマンド攻撃検知 =====
async function handleMultiAccountCommandAttack(message) {
  const { member, guild, content, channel } = message;
  if (!member || isWhitelisted(member)) return false;
  const command = extractBotCommand(content);
  if (!command) return false;
  const now = Date.now();
  if (!commandAttackTracker.has(command)) {
    commandAttackTracker.set(command, { users: new Set(), timestamps: [] });
  }
  const tracker = commandAttackTracker.get(command);
  tracker.users.add(member.id);
  tracker.timestamps.push(now);
  tracker.timestamps = tracker.timestamps.filter(ts => now - ts < COMMAND_ATTACK_WINDOW_MS);
  const totalCount = tracker.timestamps.length;
  const uniqueUsers = tracker.users.size;
  if (uniqueUsers >= COMMAND_ATTACK_MIN_USERS && totalCount >= COMMAND_ATTACK_MIN_COUNT) {
    const isDangerous = isDangerousBotCommand(command);
    const scoreToAdd = isDangerous ? DANGEROUS_COMMAND_SCORE : SUSPICIOUS_COMMAND_SCORE;
    for (const userId of tracker.users) {
      const targetMember = guild.members.cache.get(userId);
      if (targetMember && !isWhitelisted(targetMember)) {
        const newScore = addScore(userId, scoreToAdd);
        await sendLogEmbed(guild, {
          title: isDangerous ? '🔴 協調botコマンド攻撃（危険）' : '⚠️ 協調botコマンド攻撃',
          member: targetMember,
          description: `**コマンド**: ${command}\n**参加アカウント数**: ${uniqueUsers}\n**実行回数**: ${totalCount}\n**加算スコア**: +${scoreToAdd}\n**現在スコア**: ${newScore}/${currentCfg().THRESHOLD}`,
          channelName: channel?.name,
          content,
          color: isDangerous ? 0xff0000 : 0xffa200,
        });
        await punishByScore(targetMember, `協調コマンド攻撃: ${command}`, channel?.name);
      }
    }
    await applyEmergencySlowmode(channel, 10, 'botコマンド協調攻撃');
    commandAttackTracker.delete(command);
    return true;
  }
  setTimeout(() => {
    const existing = commandAttackTracker.get(command);
    if (existing && existing.timestamps.length === 0) commandAttackTracker.delete(command);
  }, COMMAND_ATTACK_WINDOW_MS);
  return false;
}

// ===== 新規: 個人の同一コマンドリピート検知 =====
async function handlePersonalCommandSpam(message) {
  const { member, content, channel } = message;
  if (!member || isWhitelisted(member)) return;
  const command = extractBotCommand(content);
  if (!command) return;
  const now = Date.now();
  const lastCmd = userCmdTime.get(member.id) || 0;
  if (now - lastCmd < 1000) return; // 既存の連打検知に任せる
  userCmdTime.set(member.id, now);
  if (!userCommandDetails.has(member.id)) userCommandDetails.set(member.id, new Map());
  const cmdMap = userCommandDetails.get(member.id);
  const count = (cmdMap.get(command) || 0) + 1;
  cmdMap.set(command, count);
  setTimeout(() => {
    const m = userCommandDetails.get(member.id);
    if (m) {
      const newCount = (m.get(command) || 1) - 1;
      if (newCount <= 0) m.delete(command);
      if (m.size === 0) userCommandDetails.delete(member.id);
      else userCommandDetails.set(member.id, m);
    }
  }, 10000);
  if (count >= 3) {
    const c = currentCfg();
    const s = addScore(member.id, c.CMD_ABUSE);
    await sendLogEmbed(message.guild, { title: '🚧 同一コマンドリピート', member, description: `コマンド「${command}」を10秒以内に${count}回\n+${c.CMD_ABUSE} / 現在 ${s}/${c.THRESHOLD}`, channelName: channel?.name, color: 0xffa200, content });
    await punishByScore(member, '同一コマンド連打', channel?.name);
  }
}

// ===== 既存の類似メッセージ検知（改善済み）=====
async function handleSimilarityDetection(message) {
  const { member, guild, content, channel } = message;
  const uid = member.id;
  const gid = guild.id;
  const normalized = normalizeText(content);
  if (normalized.length < SIMILAR_MESSAGE_LENGTH || isCommonConversation(content)) return;
  if (!similarityTracker.has(gid)) similarityTracker.set(gid, new Map());
  const guildTracker = similarityTracker.get(gid);
  let similarMessageFound = false;
  let matchingHash = null;
  for (const [hash, data] of guildTracker.entries()) {
    const similarity = calculateSimilarity(normalized, hash);
    if (similarity >= SIMILARITY_PERCENT_THRESHOLD) {
      similarMessageFound = true;
      matchingHash = hash;
      if (!data.users.has(uid)) data.users.add(uid);
      data.count++;
      break;
    }
  }
  if (!similarMessageFound) {
    guildTracker.set(normalized, { firstSeen: Date.now(), users: new Set([uid]), count: 1 });
    return;
  }
  const matchingData = guildTracker.get(matchingHash);
  if (matchingData.users.size >= SIMILARITY_MIN_USERS) {
    if (matchingData.count >= SIMILARITY_TIMEOUT_THRESHOLD) {
      try {
        await member.timeout(SIMILARITY_TIMEOUT_DURATION, '類似メッセージ大量投稿');
        await safeDelete(message, '類似メッセージ大量投稿');
        await sendLogEmbed(guild, { title: '🚨 類似メッセージ大量投稿（タイムアウト）', member, description: `類似度: ${SIMILARITY_PERCENT_THRESHOLD}%以上\n投稿回数: ${matchingData.count}回\n参加ユーザー: ${matchingData.users.size}人\nタイムアウト: ${Math.floor(SIMILARITY_TIMEOUT_DURATION / 60000)}分`, channelName: channel?.name, color: 0xff0000, content });
        guildTracker.delete(matchingHash);
      } catch (e) { console.error('Failed to timeout user for similarity spam:', e); }
    } else if (matchingData.count >= SIMILARITY_DELETE_THRESHOLD) {
      await safeDelete(message, '類似メッセージ反復投稿');
      await sendLogEmbed(guild, { title: '⚠️ 類似メッセージ反復投稿（削除）', member, description: `類似度: ${SIMILARITY_PERCENT_THRESHOLD}%以上\n投稿回数: ${matchingData.count}回\n参加ユーザー: ${matchingData.users.size}人`, channelName: channel?.name, color: 0xffa200, content });
    }
  }
}

async function handlePersonalSimilarityDetection(message) {
  const { member, guild, content, channel } = message;
  const uid = member.id;
  const gid = guild.id;
  const normalized = normalizeText(content);
  if (isCommonConversation(content)) return;
  if (!messageHistory.has(gid)) messageHistory.set(gid, new Map());
  const gmap = messageHistory.get(gid);
  if (!gmap.has(normalized)) gmap.set(normalized, new Map());
  const senders = gmap.get(normalized);
  senders.set(uid, (senders.get(uid) || 0) + 1);
  if (senders.get(uid) >= SIMILAR_MESSAGE_THRESHOLD) {
    const s = addScore(uid, currentCfg().SIMILAR);
    await safeDelete(message, '類似メッセージ連投');
    await sendLogEmbed(guild, { title: '🚧 類似メッセージ（個人）', member, description: `+${currentCfg().SIMILAR} / 現在 ${s}/${currentCfg().THRESHOLD}\n内容（抜粋）: ${snippet(content)}`, channelName: channel?.name, color: 0xffa200, content });
    return punishByScore(member, '類似メッセージ連投', channel?.name);
  }
}

// ===== メッセージ監視（統合） =====
async function handleMessage(message) {
  if (!message?.guild || message.author?.bot) return;
  const member = message.member;
  if (!member || isWhitelisted(member) || member.permissions?.has(PermissionsBitField.Flags.Administrator)) return;

  await handleAiJudgement(message);
  if (await handleRandomStringSpam(message)) return;
  if (await handleObfuscatedLink(message)) return;
  if (await handleShortenedUrl(message)) return;
  await handleShortMessageSpam(message);
  if (await handleMultiAccountCommandAttack(message)) return;
  await handlePersonalCommandSpam(message);

  const c = currentCfg();
  const now = Date.now();
  const uid = member.id;
  const gid = message.guild.id;

  // 連投検知（通常）
  const list = userMsgTs.get(uid) || [];
  list.push(now);
  const recent = list.filter(t => now - t < MASS_SPAM_WINDOW);
  userMsgTs.set(uid, recent);
  if (recent.length >= MASS_SPAM_THRESHOLD) {
    const s = addScore(uid, c.MASS_SPAM, true);
    await safeDelete(message, 'メッセージ連投');
    await sendLogEmbed(message.guild, { title: '🚧 連投検知', member, description: `+${c.MASS_SPAM} / 現在 ${s}/${c.THRESHOLD}`, channelName: message.channel?.name, color: 0xffa200, content: message.content });
    await applyEmergencySlowmode(message.channel, 5, '連投検知');
    return punishByScore(member, 'メッセージ連投', message.channel?.name);
  }

  const content = (message.content || '').toLowerCase();

  // 既存のキーワード検知（正規化後もチェックするため拡張）
  if (RAID_KEYWORDS_BASE.some(k => content.includes(k)) || containsMaliciousLink(message.content)) {
    const s = addScore(uid, c.KEYWORD);
    await safeDelete(message, 'NGワード');
    await sendLogEmbed(message.guild, { title: '🚨 NGキーワード', member, description: `+${c.KEYWORD} / 現在 ${s}/${c.THRESHOLD}\n内容（抜粋）: ${snippet(message.content)}`, channelName: message.channel?.name, content: message.content });
    return punishByScore(member, 'NGワード', message.channel?.name);
  }

  // 改行・Zalgoチェック
  const newlineCount = (content.match(/\n/g) || []).length;
  if (newlineCount > 20) {
    const s = addScore(uid, c.NEWLINES);
    await safeDelete(message, '過度な改行');
    await sendLogEmbed(message.guild, { title: '🚧 過度な改行', member, description: `+${c.NEWLINES} / 現在 ${s}/${c.THRESHOLD}`, channelName: message.channel?.name, color: 0xffa200, content: message.content });
    return punishByScore(member, '過度な改行', message.channel?.name);
  }
  const zalgo = (message.content.match(/[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/g) || []).length;
  if (zalgo > 5) {
    const s = addScore(uid, c.ZALGO);
    await safeDelete(message, 'Zalgo 乱用');
    await sendLogEmbed(message.guild, { title: '🚧 Zalgo 乱用', member, description: `+${c.ZALGO} / 現在 ${s}/${c.THRESHOLD}`, channelName: message.channel?.name, color: 0xffa200, content: message.content });
    return punishByScore(member, 'Zalgo 乱用', message.channel?.name);
  }

  // 招待リンクスパム検知
  const rawContent = message.content || '';
  const inviteMatches = [...rawContent.matchAll(INVITE_REGEX)];
  if (inviteMatches.length > 0) {
    const isAllowed = inviteMatches.every(m => ALLOWED_INVITE_LINKS.some(allowed => allowed.toLowerCase().includes(m[1].toLowerCase())));
    if (!isAllowed) {
      const s = addScore(uid, c.KEYWORD);
      await safeDelete(message, '招待リンクスパム');
      await sendLogEmbed(message.guild, { title: '🚨 招待リンクスパム', member, description: `外部サーバーへの招待リンクを検知\n+${c.KEYWORD} / 現在 ${s}/${c.THRESHOLD}`, channelName: message.channel?.name, content: rawContent });
      return punishByScore(member, '招待リンクスパム', message.channel?.name);
    }
  }

  // メンションスパム検知
  const mentionCount = (message.mentions?.users?.size || 0) + (message.mentions?.roles?.size || 0) + (message.mentions?.everyone ? 1 : 0);
  if (mentionCount >= MENTION_SPAM_THRESHOLD) {
    const s = addScore(uid, c.KEYWORD);
    await safeDelete(message, 'メンションスパム');
    await sendLogEmbed(message.guild, { title: '🚨 メンションスパム', member, description: `1メッセージに ${mentionCount} 件のメンション\n+${c.KEYWORD} / 現在 ${s}/${c.THRESHOLD}`, channelName: message.channel?.name, content: message.content });
    return punishByScore(member, 'メンションスパム', message.channel?.name);
  }

  // 類似メッセージ検知
  await handleSimilarityDetection(message);
  await handlePersonalSimilarityDetection(message);

  // コマンド連打（従来の1秒制限）
  if (content.startsWith('!') || content.startsWith('/')) {
    const last = userCmdTime.get(uid) || 0;
    if (now - last < 1000) {
      const s = addScore(uid, c.CMD_ABUSE);
      await sendLogEmbed(message.guild, { title: '🚧 コマンド連打', member, description: `+${c.CMD_ABUSE} / 現在 ${s}/${c.THRESHOLD}`, channelName: message.channel?.name, color: 0xffa200, content: message.content });
      return punishByScore(member, 'コマンド連打', message.channel?.name);
    }
    userCmdTime.set(uid, now);
  }
}

// ===== メッセージ更新 =====
async function handleMessageUpdate(oldMessage, newMessage) {
  if (!newMessage || newMessage.author?.bot) return;
  if (oldMessage?.content === newMessage?.content) return;
  return handleMessage(newMessage);
}

// ===== リアクション連打 =====
async function handleReactionAdd(reaction, user) {
  if (!reaction?.message?.guild) return;
  if (user.bot) return;
  const member = reaction.message.guild.members.cache.get(user.id);
  if (!member || isWhitelisted(member) || member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
  const now = Date.now();
  const last = userReactTime.get(user.id) || 0;
  if (now - last < 1000) {
    const s = addScore(user.id, currentCfg().REACT_SPAM);
    await sendLogEmbed(reaction.message.guild, { title: '🚧 リアクション連打', member, description: `+${currentCfg().REACT_SPAM} / 現在 ${s}/${currentCfg().THRESHOLD}`, channelName: reaction.message.channel?.name, color: 0xffa200 });
    await punishByScore(member, 'リアクション連打', reaction.message.channel?.name);
  }
  userReactTime.set(user.id, now);
}

// ===== 監査ログ / 危険操作 =====
async function checkAndPunishMassAction(entry) {
  const { executor, action, guild, target } = entry;
  const executorMember = guild.members.cache.get(executor.id);
  if (!executorMember || executorMember.bot || isWhitelisted(executorMember) || isInProbation(executor.id)) return false;
  const now = Date.now();
  const executorId = executor.id;
  const logMap = (action === AuditLogEvent.MemberBanAdd) ? massBanLog : massNukeLog;
  if (!logMap.has(executorId)) logMap.set(executorId, []);
  const logArray = logMap.get(executorId);
  logArray.push({ timestamp: now, targetId: target?.id });
  const recentActions = logArray.filter(a => now - a.timestamp <= MASS_ACTION_WINDOW_MS);
  logMap.set(executorId, recentActions);
  if (recentActions.length >= MASS_ACTION_THRESHOLD) {
    let reason = '不審な大量操作';
    if (action === AuditLogEvent.MemberBanAdd) reason = '不審な大量BAN';
    else if (action === AuditLogEvent.ChannelDelete) reason = '不審なチャンネル削除';
    else if (action === AuditLogEvent.RoleDelete) reason = '不審なロール削除';
    try {
      const ok = await stripAllRoles(guild, executor.id, reason);
      await sendLogEmbed(guild, { title: `🚨 大量操作を検知・権限剥奪`, member: executorMember, description: `理由: ${reason}\n成功: ${ok}`, color: 0xff4757 });
      const auditLogs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 100 });
      const recentGrants = auditLogs.entries.filter(e => e.target.id === executor.id && e.changes.some(c => c.key === '$add'));
      for (const grant of recentGrants) {
        const giver = grant.executor;
        if (giver && !giver.bot && giver.id !== executor.id) {
          const giverMember = guild.members.cache.get(giver.id);
          if (giverMember && !isWhitelisted(giverMember)) {
            const ok2 = await stripAllRoles(guild, giver.id, '不審なユーザーに危険なロールを付与');
            await sendLogEmbed(guild, { title: `🚨 連鎖的処罰`, member: giverMember, description: `理由: 不審なユーザーに危険なロールを付与\n成功: ${ok2}`, color: 0xff4757 });
          }
        }
      }
    } catch { return false; }
    return true;
  }
  return false;
}

async function handleAuditLogEntry(entry) {
  const { guild, executor, action, target } = entry;
  if (!guild || !executor) return;
  const member = guild.members.cache.get(executor.id);
  if (!member || member.user.bot || isWhitelisted(member)) return;
  if (action === AuditLogEvent.MemberBanAdd || action === AuditLogEvent.ChannelDelete || action === AuditLogEvent.RoleDelete) {
    const punished = await checkAndPunishMassAction(entry);
    if (punished) return;
  }
  if (DANGER_ACTIONS.has(action) && !member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    if (pendingModActions.has(executor.id)) {
      const p = pendingModActions.get(executor.id);
      p.reasonAttempts++;
      try { await executor.createDM().then(dm => dm.send(`⚠️ 理由確認の再送（残り ${Math.max(0, 3 - p.reasonAttempts)} 回）`)); } catch {}
      return;
    }
    try {
      await saveAndStripRoles(member);
      const actionText = `アクション: ${AuditLogEvent[action]} / 対象: ${target?.tag || target?.name || target?.id}`;
      const dmText = `サーバーで重要な操作を行いました。\n${actionText}\nこのDMに **3分以内** に理由を返信してください。未回答なら権限剥奪を継続します。`;
      await executor.send(dmText).catch(() => {});
      pendingModActions.set(executor.id, { entry, timestamp: Date.now(), reasonAttempts: 0 });
      setTimeout(async () => {
        const p = pendingModActions.get(executor.id);
        if (!p) return;
        await sendLogEmbed(guild, { title: '⚠️ DM未応答につき権限剥奪継続', member, description: '重要操作の理由確認に未応答', color: 0xffa200 });
        pendingModActions.delete(executor.id);
      }, 3 * 60 * 1000);
    } catch {}
  }
}

// ===== Bot 追加監視 =====
async function handleBotAdd(member) {
  if (!member?.user?.bot) return false;
  const isVerified = !!member.user.flags?.has?.('VerifiedBot');
  if (!isVerified) {
    try {
      const logs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 1 });
      const entry = logs.entries.first();
      const executor = entry?.executor;
      await member.roles.set([], '未認証Botのため権限剥奪').catch(() => {});
      await sendLogEmbed(member.guild, { title: '🚨 怪しいBot検知', member, description: `招待者: ${executor?.tag || '不明'}`, color: 0xff4757 });
      return true;
    } catch {}
  }
  return false;
}

// ===== ロール更新 =====
async function handleRoleUpdate(oldRole, newRole) {
  const before = oldRole.permissions;
  const after = newRole.permissions;
  const added = DANGEROUS_PERMISSIONS.filter(p => after.has(p) && !before.has(p));
  if (added.length === 0) return;
  const isEveryone = oldRole.id === oldRole.guild.id;
  const addedNames = added.map(p => Object.keys(PermissionsBitField.Flags).find(k => PermissionsBitField.Flags[k] === p) || String(p));
  try {
    const logs = await oldRole.guild.fetchAuditLogs({ type: AuditLogEvent.RoleUpdate, limit: 3 });
    const entry = logs.entries.find(e => e.target?.id === oldRole.id);
    const executor = entry?.executor;
    if (!executor) return;
    const member = oldRole.guild.members.cache.get(executor.id);
    if (!member || isWhitelisted(member)) return;
    await newRole.setPermissions(before, '危険権限の自動差し戻し').catch(() => {});
    if (isEveryone) {
      await oldRole.guild.members.ban(executor.id, { reason: '@everyone に危険権限を付与' }).catch(() => {});
      await sendLogEmbed(oldRole.guild, { title: '🚨 @everyone 危険権限付与 → 即BAN・差し戻し', member, description: `付与された権限: ${addedNames.join(', ')}\n権限は自動差し戻し済み` });
    } else {
      const ok = await stripAllRoles(oldRole.guild, executor.id, `ロール「${oldRole.name}」に危険権限を付与`);
      await sendLogEmbed(oldRole.guild, { title: `⚠️ ロール「${oldRole.name}」に危険権限付与 → 権限剥奪`, member, description: `付与された権限: ${addedNames.join(', ')}\n権限は自動差し戻し済み\n実行者権限剥奪: ${ok}`, color: 0xff4757 });
    }
  } catch {}
}

// ===== ギルドメンバー更新 =====
async function onGuildMemberUpdate(oldMember, newMember) {
  if (newMember.user.bot || isWhitelisted(newMember)) return;
  const beforePerms = oldMember.permissions?.bitfield ?? 0n;
  const afterPerms = newMember.permissions?.bitfield ?? 0n;
  if (!hasDangerousPerms(beforePerms) && hasDangerousPerms(afterPerms)) {
    const executor = await findExecutorForTarget(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id);
    if (executor && !isWhitelisted(executor) && !isInProbation(executor.id)) {
      const newScore = addScore(executor.id, currentCfg().AUDIT_ABUSE);
      await sendLogEmbed(newMember.guild, { title: '⚠️ 危険権限付与を検知', member: newMember, description: `実行者: <@${executor.id}> が危険権限を付与しました。\n現在スコア: ${newScore}/${currentCfg().THRESHOLD}`, color: 0xffa200 });
      await punishByScore(executor, '不審な権限付与', newMember.guild.channels.cache.random()?.name);
    }
  }
}

// ===== BAN/Kick 救済 =====
async function onGuildBanAdd(ban) {
  const { guild, user } = ban;
  setTimeout(async () => {
    const executor = await findExecutorForTarget(guild, AuditLogEvent.MemberBanAdd, user.id);
    if (!executor) return;
    if (isWhitelisted(executor) || isInProbation(executor.id) || recordAndCheckMassAction(executor.id, user.id, 'BAN')) {
      try { await guild.members.unban(user.id, '荒らし検知: 誤BAN救済'); } catch {}
      const ok = await stripAllRoles(guild, executor.id, '荒らし検知: クールダウン中の処罰 or 大量処罰');
      await sendLogEmbed(guild, { title: '🚨 不審なBAN検知', description: `実行者 <@${executor.id}> を権限剥奪（成功:${ok}）。\n対象: **${user.tag}** はBAN解除しました。` });
      try {
        const url = await createOneTimeInvite(guild);
        const dm = await user.createDM();
        await dm.send(`すみません。サーバー側で不正なBANを検知し、解除しました。\n` + (url ? `再参加用の招待リンク: ${url}` : `再参加招待の作成に失敗しました。管理者へご連絡ください。`));
      } catch {}
    }
  }, 1500);
}

async function onGuildMemberRemove(member) {
  const { guild } = member;
  setTimeout(async () => {
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 5 }).catch(() => null);
    const entry = logs?.entries?.find(e => e.target?.id === member.id);
    if (!entry) return;
    const executor = entry.executor;
    if (!executor) return;
    const executorMember = guild.members.cache.get(executor.id);
    if (!executorMember || isWhitelisted(executorMember) || isInProbation(executor.id) || recordAndCheckMassAction(executor.id, member.id, 'KICK')) {
      const ok = await stripAllRoles(guild, executor.id, '荒らし検知: クールダウン中の処罰 or 大量処罰');
      await sendLogEmbed(guild, { title: '🚨 不審なKick検知', description: `実行者 <@${executor.id}> を権限剥奪（成功:${ok}）。\n対象: **${member.user?.tag || member.id}** にはお詫びDMを送ります。` });
      try {
        const url = await createOneTimeInvite(guild);
        const dm = await member.user.createDM();
        await dm.send(`すみません。サーバー側で不正なKickを検知しました。\n` + (url ? `再参加用の招待リンク: ${url}` : `再参加招待の作成に失敗しました。管理者へご連絡ください。`));
      } catch {}
    }
  }, 1500);
}

// ユーティリティ関数
function hasManageGuildPermission(member) {
  return member?.permissions?.has(PermissionsBitField.Flags.ManageGuild) || false;
}

function isInProbation(userId) {
  const p = probationAdmins.get(userId);
  return p && Date.now() - p < PROBATION_MS;
}

async function stripAllRoles(guild, userId, reason) {
  const member = guild.members.cache.get(userId);
  if (!member || !member.manageable) return false;
  try {
    await member.roles.set([], `荒らし対策: ${reason}`);
    probationAdmins.set(userId, Date.now());
    return true;
  } catch { return false; }
}

function recordAndCheckMassAction(executorId, targetId, actionType) {
  const now = Date.now();
  if (!executorActionLog.has(executorId)) executorActionLog.set(executorId, { KICK: [], BAN: [], TIMEOUT: [] });
  const log = executorActionLog.get(executorId)[actionType];
  log.push({ timestamp: now, target: targetId });
  const recentActions = log.filter(a => now - a.timestamp <= MASS_ACTION_WINDOW_MS);
  executorActionLog.get(executorId)[actionType] = recentActions;
  return recentActions.length > 2;
}

async function findExecutorForTarget(guild, actionType, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ type: actionType, limit: 5 });
    const entry = logs.entries.find(e => e.target?.id === targetId);
    return entry?.executor;
  } catch { return null; }
}

// DM応答処理
async function handleDirectMessage(message) {
  if (!message?.author || message.author.bot) return;
  const pending = pendingModActions.get(message.author.id);
  if (!pending) return;
  const reason = message.content?.trim();
  if (!reason || reason.length < 5) {
    try { await message.reply('理由が短すぎます。もう少し詳しく説明してください。'); } catch {}
    return;
  }
  const isAppropriate = await isReasonAppropriate(pending.entry, reason);
  if (isAppropriate) {
    try {
      const guild = pending.entry.guild;
      const member = guild.members.cache.get(message.author.id);
      if (member) {
        await restoreRoles(member);
        await sendLogEmbed(guild, { title: '✅ 理由確認完了・権限復元', member, description: `理由: ${reason}`, color: 0x00ff00 });
      }
      await message.reply('✅ 理由が確認できました。権限を復元しました。');
    } catch (e) {
      console.error('Failed to restore roles:', e);
      await message.reply('❌ 権限復元に失敗しました。管理者にお問い合わせください。').catch(() => {});
    }
  } else {
    try {
      await message.reply('❌ 理由が不適切と判断されました。権限剥奪を継続します。');
      await sendLogEmbed(pending.entry.guild, { title: '❌ 不適切な理由により権限剥奪継続', member: pending.entry.guild.members.cache.get(message.author.id), description: `提出された理由: ${reason}`, color: 0xff0000 });
    } catch {}
  }
  pendingModActions.delete(message.author.id);
}

// ===== サーバー設定変更監視 =====
async function handleGuildUpdate(oldGuild, newGuild) {
  const changes = [];
  if (oldGuild.name !== newGuild.name) changes.push(`名前: 「${oldGuild.name}」→「${newGuild.name}」`);
  if (oldGuild.icon !== newGuild.icon) changes.push('アイコンが変更されました');
  if (oldGuild.verificationLevel !== newGuild.verificationLevel) changes.push(`認証レベル: ${oldGuild.verificationLevel} → ${newGuild.verificationLevel}`);
  if (oldGuild.explicitContentFilter !== newGuild.explicitContentFilter) changes.push(`コンテンツフィルター変更`);
  if (changes.length === 0) return;
  try {
    const logs = await newGuild.fetchAuditLogs({ type: AuditLogEvent.GuildUpdate, limit: 1 });
    const entry = logs.entries.first();
    const executor = entry?.executor;
    const member = executor ? newGuild.members.cache.get(executor.id) : null;
    await sendLogEmbed(newGuild, { title: '📋 サーバー設定変更を検知', member, description: changes.join('\n'), color: 0x3498db });
    if (oldGuild.verificationLevel > newGuild.verificationLevel) {
      await newGuild.setVerificationLevel(oldGuild.verificationLevel, '荒らし対策: 認証レベル差し戻し').catch(() => {});
      if (member && !isWhitelisted(member)) {
        await stripAllRoles(newGuild, member.id, '認証レベルを不正に下げた');
        await sendLogEmbed(newGuild, { title: '🚨 認証レベル引き下げ → 差し戻し・権限剥奪', member, description: `${oldGuild.verificationLevel} → ${newGuild.verificationLevel} を差し戻しました` });
      }
    }
  } catch {}
}

// ===== チャンネル作成監視 =====
const CHANNEL_CREATE_THRESHOLD = 3;
const CHANNEL_CREATE_WINDOW = 60 * 1000;
async function handleChannelCreate(channel) {
  if (!channel.guild) return;
  try {
    const logs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelCreate, limit: 1 });
    const entry = logs.entries.first();
    const executor = entry?.executor;
    if (!executor) return;
    const member = channel.guild.members.cache.get(executor.id);
    if (!member || isWhitelisted(member)) return;
    const now = Date.now();
    if (!channelCreateLog.has(executor.id)) channelCreateLog.set(executor.id, []);
    const arr = channelCreateLog.get(executor.id);
    arr.push(now);
    const recent = arr.filter(t => now - t < CHANNEL_CREATE_WINDOW);
    channelCreateLog.set(executor.id, recent);
    await sendLogEmbed(channel.guild, { title: '📋 チャンネル作成', member, description: `#${channel.name} が作成されました（直近60秒: ${recent.length}回）`, color: 0x3498db });
    if (recent.length >= CHANNEL_CREATE_THRESHOLD) {
      await channel.delete('荒らし対策: 大量チャンネル作成').catch(() => {});
      const ok = await stripAllRoles(channel.guild, executor.id, '大量チャンネル作成');
      await sendLogEmbed(channel.guild, { title: '🚨 大量チャンネル作成 → 権限剥奪', member, description: `60秒以内に ${recent.length} 個作成\n権限剥奪: ${ok}` });
    }
  } catch {}
}

async function handleChannelUpdate(oldChannel, newChannel) {
  if (!newChannel.guild) return;
  const changes = [];
  if (oldChannel.name !== newChannel.name) changes.push(`名前: 「${oldChannel.name}」→「${newChannel.name}」`);
  const oldPerms = [...(oldChannel.permissionOverwrites?.cache?.values() || [])];
  const newPerms = [...(newChannel.permissionOverwrites?.cache?.values() || [])];
  if (oldPerms.length !== newPerms.length) changes.push(`権限設定が変更されました（${oldPerms.length}→${newPerms.length}件）`);
  if (changes.length === 0) return;
  try {
    const logs = await newChannel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelUpdate, limit: 1 });
    const entry = logs.entries.first();
    const executor = entry?.executor;
    const member = executor ? newChannel.guild.members.cache.get(executor.id) : null;
    await sendLogEmbed(newChannel.guild, { title: `📋 チャンネル変更: #${newChannel.name}`, member, description: changes.join('\n'), color: 0x3498db });
  } catch {}
}

// ===== ロール作成/削除監視 =====
const ROLE_DELETE_THRESHOLD = 3;
const ROLE_DELETE_WINDOW = 60 * 1000;
async function handleRoleCreate(role) {
  if (!role.guild) return;
  try {
    const logs = await role.guild.fetchAuditLogs({ type: AuditLogEvent.RoleCreate, limit: 1 });
    const entry = logs.entries.first();
    const executor = entry?.executor;
    const member = executor ? role.guild.members.cache.get(executor.id) : null;
    await sendLogEmbed(role.guild, { title: `📋 ロール作成: @${role.name}`, member, description: `権限: ${role.permissions.toArray().join(', ') || 'なし'}`, color: 0x2ecc71 });
  } catch {}
}
async function handleRoleDelete(role) {
  if (!role.guild) return;
  try {
    const logs = await role.guild.fetchAuditLogs({ type: AuditLogEvent.RoleDelete, limit: 1 });
    const entry = logs.entries.first();
    const executor = entry?.executor;
    if (!executor) return;
    const member = role.guild.members.cache.get(executor.id);
    if (!member || isWhitelisted(member)) return;
    const now = Date.now();
    if (!roleDeleteLog.has(executor.id)) roleDeleteLog.set(executor.id, []);
    const arr = roleDeleteLog.get(executor.id);
    arr.push(now);
    const recent = arr.filter(t => now - t < ROLE_DELETE_WINDOW);
    roleDeleteLog.set(executor.id, recent);
    await sendLogEmbed(role.guild, { title: `📋 ロール削除: @${role.name}（直近60秒: ${recent.length}回）`, member, description: `削除されたロール名: ${role.name}`, color: 0xe74c3c });
    if (recent.length >= ROLE_DELETE_THRESHOLD) {
      const ok = await stripAllRoles(role.guild, executor.id, '大量ロール削除');
      await sendLogEmbed(role.guild, { title: '🚨 大量ロール削除 → 権限剥奪', member, description: `60秒以内に ${recent.length} 個削除\n権限剥奪: ${ok}` });
    }
  } catch {}
}

function cleanupSimilarityTracker(guildTracker, expiryMs) {
  const now = Date.now();
  for (const [hash, data] of guildTracker.entries()) {
    if (data && data.firstSeen && now - data.firstSeen > expiryMs) guildTracker.delete(hash);
  }
}

// クリーンアップ間隔
setInterval(() => {
  const now = Date.now();
  for (const [guildId, tracker] of similarityTracker) cleanupSimilarityTracker(tracker, SIMILARITY_HASH_EXPIRY_MS);
  for (const [cmd, tracker] of commandAttackTracker) {
    tracker.timestamps = tracker.timestamps.filter(ts => now - ts < COMMAND_ATTACK_WINDOW_MS);
    if (tracker.timestamps.length === 0) commandAttackTracker.delete(cmd);
  }
}, CLEANUP_INTERVAL_MS);

module.exports = {
  handleMemberJoin,
  handleMessage,
  handleReactionAdd,
  handleRoleUpdate,
  handleRoleCreate,
  handleRoleDelete,
  handleAuditLogEntry,
  handleMessageUpdate,
  handleBotAdd,
  handleGuildUpdate,
  handleChannelCreate,
  handleChannelUpdate,
  onGuildMemberUpdate,
  onGuildBanAdd,
  onGuildMemberRemove,
  handleDirectMessage,
  pendingModActions,
  restoreRoles,
  hasManageGuildPermission,
  backupServerState,
  restoreServerState,
  isReasonAppropriate,
  addScore,
  getScore,
  setScore,
  markUser,
  isMarked,
  isWhitelisted,
  punishByScore,
  currentCfg,
  similarityTracker,
  SIMILARITY_HASH_EXPIRY_MS,
  CLEANUP_INTERVAL_MS,
  cleanupSimilarityTracker,
  applyEmergencySlowmode,
};
