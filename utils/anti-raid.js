// utils/anti-raid.js
// ================================================================
//  ★ 改良版 Anti-Raid  ★
//  設計思想:
//    1. 一般雑談・短文・日本語会話は絶対に処罰しない
//    2. 「荒らし確定フラグ（CONFIRMED_RAID）」が立った場合のみ即削除・即処罰
//    3. 確定は「複数の異常行動が短時間で重なった場合」のみ
//    4. 誤検知ゼロに近づける
//    5. 乗っ取り（Bot/Webhook）の自動防御と自動復旧（パージ）
// ================================================================

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const {
  AuditLogEvent,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

// ===== 固定ログチャンネル名 =====
const LOG_CHANNEL_NAME = 'nuke-logs';
const AUTH_CHANNEL_ID = process.env.ANTI_RAID_AUTH_CHANNEL_ID || '1425643775694340158';
const JOIN_LOG_CHANNEL_ID = process.env.JOIN_LOG_CHANNEL_ID || '1425643771206570117';
const ADMIN_APPROVER_ID = '1427240409007915028';

// ホワイトリスト
const WHITELIST_USERS = (process.env.ANTI_RAID_WHITELIST_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
const WHITELIST_ROLES = (process.env.ANTI_RAID_WHITELIST_ROLES || '').split(',').map(s => s.trim()).filter(Boolean);

// ===== JSON永続化 =====
const DATA_DIR = path.join(__dirname, '../data');
const SCORE_PATH = path.join(DATA_DIR, 'raidScores.json');
const MARK_PATH = path.join(DATA_DIR, 'raidMarks.json');
const BACKUP_PATH = path.join(DATA_DIR, 'serverBackup.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let scores = {};
let markedUsersStore = {};
let serverBackup = {};

function saveScores() { try { fs.writeFileSync(SCORE_PATH, JSON.stringify(scores, null, 2)); } catch {} }
function saveMarks() { try { fs.writeFileSync(MARK_PATH, JSON.stringify(markedUsersStore, null, 2)); } catch {} }
function saveBackup() { try { fs.writeFileSync(BACKUP_PATH, JSON.stringify(serverBackup, null, 2)); } catch {} }

try { scores = JSON.parse(fs.readFileSync(SCORE_PATH, 'utf8')); } catch {}
try { markedUsersStore = JSON.parse(fs.readFileSync(MARK_PATH, 'utf8')); } catch {}
try { serverBackup = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8')); } catch {}

// ===== 閾値（誤検知防止に緩和済み）=====
const NIGHT_START_HOUR = 35; // 無効化
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
    RANDOM_STRING: 12,
    ATTACHMENT_SPAM: 15,
    MASS_MENTION: 20,
    DANGEROUS_FILE: 30,
    BAD_NAME: 10,
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
    ATTACHMENT_SPAM: 15,
    MASS_MENTION: 20,
    DANGEROUS_FILE: 30,
    BAD_NAME: 10,
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
const MASS_SPAM_THRESHOLD = 7;
const MASS_SPAM_WINDOW = 5 * 1000;
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
const GHOST_PING_SCORE = 15;

// ===== ヌークBot対策定数 =====
const NUKE_DETECT_WINDOW_MS = 30 * 1000;
const CHANNEL_DELETE_NUKE_THRESHOLD = 3;
const ROLE_DELETE_NUKE_THRESHOLD = 3;
const MASS_BAN_NUKE_THRESHOLD = 5;
const CHANNEL_CREATE_NUKE_THRESHOLD = 5;
const FLOOD_MSG_THRESHOLD = 8;
const FLOOD_MSG_WINDOW_MS = 10 * 1000;

// ノリ連投減衰率
const SAME_USER_SPAM_DECAY = 0.5;

// ランダム文字検知パラメータ
const RANDOM_STRING_ENTROPY_THRESHOLD = 0.78;
const RANDOM_STRING_MIN_LENGTH = 15;

// ================================================================
//  ★ NEW: 荒らし確定フラグ（CONFIRMED_RAID）システム
// ================================================================
// 複数の異常行動が CONFIRMED_RAID_WINDOW_MS 以内に CONFIRMED_RAID_MIN_SIGNALS 種類以上重なると確定
const CONFIRMED_RAID_WINDOW_MS = 7 * 1000;   // 7秒以内
const CONFIRMED_RAID_MIN_SIGNALS = 2;         // 2種類以上の異常
const CONFIRMED_RAID_TIMEOUT_MS = 10 * 60 * 1000; // 確定時タイムアウト: 10分
const CONFIRMED_RAID_RESET_MS = 30 * 60 * 1000;   // 確定フラグリセット: 30分

// 確定対象となる「重大な異常種別」一覧
const CONFIRMED_RAID_TYPES = new Set([
  'RANDOM_STRING',     // ランダム文字列
  'MALICIOUS_LINK',    // 悪意あるリンク
  'MASS_MENTION',      // 大量メンション
  'ATTACHMENT_SPAM',   // 添付連投
  'DANGEROUS_FILE',    // 危険なファイル
  'NEW_USER_LINK',     // 新規ユーザー+リンク
  'NEW_USER_MENTION',  // 新規ユーザー+大量メンション
  'NEW_USER_ATTACH',   // 新規ユーザー+添付
  'CMD_ATTACK',        // 協調コマンド攻撃
  'REPETITIVE_SPAM',   // 完全同一文字の連投
  'SHORTENED_LINK',    // 悪意ある短縮リンク
]);

// ================================================================
//  ★ NEW: 信頼レイヤー（Trust System）定数
// ================================================================
const NEW_USER_WINDOW_MS = 10 * 60 * 1000;   // 10分以内に参加したユーザー
const NEW_USER_LINK_SCORE = 20;              // 新規ユーザーがリンク送信
const NEW_USER_ATTACHMENT_SCORE = 15;        // 新規ユーザーが添付ファイル
const NEW_USER_MENTION_SCORE = 25;           // 新規ユーザーが大量メンション
const NEW_USER_MENTION_THRESHOLD = 3;        // 新規ユーザーのメンション閾値（緩和）

// ================================================================
//  ★ NEW: チャンネル別ルール定数
// ================================================================
const LENIENT_CHANNEL_KEYWORDS = ['雑談', 'chat', 'general', 'talk', 'lobby', 'lounge', 'free', 'casual', 'off', 'random', '依頼'];
const STRICT_CHANNEL_KEYWORDS  = ['認証', 'verify', 'auth', 'captcha', '公開', 'public', 'announce', 'info', 'recruit'];

// ================================================================
//  ★ NEW: 権限悪用対策の拡張定数
// ================================================================
const INVITE_SPAM_THRESHOLD = 3;            // 1分内に招待リンク生成
const INVITE_SPAM_WINDOW_MS = 60 * 1000;
const THREAD_SPAM_THRESHOLD = 5;            // 30秒内にスレッド作成
const THREAD_SPAM_WINDOW_MS = 30 * 1000;
const EMOJI_ABUSE_THRESHOLD = 5;            // 30秒内に絵文字/スタンプ変更
const EMOJI_ABUSE_WINDOW_MS = 30 * 1000;
const CHANNEL_SETTING_ABUSE_THRESHOLD = 4; // 30秒内にチャンネル設定変更
const CHANNEL_SETTING_ABUSE_WINDOW_MS = 30 * 1000;

// ================================================================
//  通常会話ワード（誤検知防止）強化版
// ================================================================
const COMMON_WORDS = new Set([
  // 日本語基本挨拶
  'おはよう', 'こんにちは', 'こんばんは', 'お疲れ様', 'おつかれ', 'ありがとう',
  'おやすみ', 'よろしく', 'はい', 'いいえ', 'そうですね', 'わかりました',
  'すみません', 'ごめんなさい', 'ありがとうございます', 'おはようございます',
  // 日本語カジュアル
  '笑', 'w', 'www', 'wwww', 'わら', '草', '草草', '大草原', 'ｗ', 'ｗｗ',
  'ええ', 'うん', 'なるほど', 'マジ', 'まじ', 'やば', 'すご', 'やった',
  'そか', 'そっか', 'へえ', 'ほんと', 'ほんとに', 'まじか', 'えー',
  'そうだね', 'だよね', 'だよ', 'だよな', 'だね', 'わかる', 'わかんない',
  'それな', 'あー', 'うーん', 'んー', 'そうか', 'なるほどね', 'たしかに',
  'かもね', 'かも', 'かな', 'どうかな', 'だと思う', 'だと思う',
  'ね', 'よね', 'よ', 'な', 'か', 'ね〜', 'よ〜',
  'おー', 'おお', 'うおー', 'うわー', 'あれ', 'あれ？',
  'えっ', 'えっ！', 'あっ', 'あ！', 'おっ',
  'やばい', 'やばすぎ', 'すごい', 'すごすぎ', 'さすが', 'さすがです',
  'いいね', 'いいな', 'うらやま', 'うらやましい',
  'おつ', 'おつかれ', 'ごくろうさん',
  'ただいま', 'おかえり', 'おかえりなさい',
  'いってらっしゃい', 'いってきます',
  'んで', 'んー', 'まぁ', 'まあ', 'まーね', 'まあね',
  'あと', 'それと', 'ところで',
  'えへ', 'えへへ', 'あはは', 'ははは', 'ふふ', 'ふふふ',
  // 英語基本
  'hello', 'hi', 'hey', 'heyy', 'hiii',
  'thanks', 'thank you', 'thx', 'ty',
  'yes', 'no', 'ok', 'okay', 'sure', 'yep', 'nope',
  'good morning', 'good night', 'gn', 'gm',
  'welcome', 'welcome back', 'wb',
  'sorry', 'please', 'np', 'no problem',
  'lol', 'lmao', 'haha', 'hehe', 'xd', ':d',
  'omg', 'wtf', 'brb', 'afk', 'gg',
  'same', 'true', 'facts', 'fr', 'real',
  'nice', 'cool', 'awesome', 'great',
]);

// 基本のNGキーワード
const RAID_KEYWORDS_BASE = [
  'raid by', 'on top', '.ozeu', '.gg/oze', '.gg/dpko', 'ますまにの顔', 'ますまに顔',
  '#mute', 'molmol', '.gg/mol', 'aarr', 'aarr on top', 'arr on top', 'discord.gg'
];
const ALLOWED_INVITE_LINKS = ['discord.gg/9ScuqvxzD7'];
const SHORTENER_SERVICES = [
  'bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly',
  'adf.ly', 'shorte.st', 'bc.vc', 't.co', 'shorturl.at', 'rb.gy'
];

// 危険なファイル拡張子
const DANGEROUS_EXTENSIONS = ['.exe', '.bat', '.cmd', '.scr', '.vbs', '.pif', '.application', '.ps1', '.jar'];

// 大量メンション閾値
const MENTION_THRESHOLD = 5;

// 危険権限
const DANGEROUS_PERMISSIONS = [
  PermissionsBitField.Flags.Administrator, PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.ManageRoles, PermissionsBitField.Flags.KickMembers,
  PermissionsBitField.Flags.BanMembers, PermissionsBitField.Flags.ManageGuild,
];
const DANGEROUS_PERMS_BITFIELD = new PermissionsBitField().add(...DANGEROUS_PERMISSIONS);
const DANGER_ACTIONS = new Set([
  AuditLogEvent.MemberKick, AuditLogEvent.MemberBanAdd, AuditLogEvent.ChannelCreate,
  AuditLogEvent.ChannelDelete, AuditLogEvent.ChannelUpdate, AuditLogEvent.RoleCreate,
  AuditLogEvent.RoleDelete, AuditLogEvent.RoleUpdate,
]);

// ===== botコマンド対策用定数 =====
const COMMAND_PREFIXES = ['!', '?', '.', '/', '$', '+', '-', '>', '<'];
const DANGEROUS_BOT_COMMANDS = [
  'ban', 'kick', 'mute', 'warn', 'purge', 'clear',
  'lock', 'lockdown', 'exec', 'eval', 'shutdown', 'reboot', 'reset'
];
const COMMAND_ATTACK_WINDOW_MS = 10 * 1000;
const COMMAND_ATTACK_MIN_USERS = 3;
const COMMAND_ATTACK_MIN_COUNT = 3;
const SUSPICIOUS_COMMAND_SCORE = 10;
const DANGEROUS_COMMAND_SCORE = 20;

// ===== 内部状態（既存）=====
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
const shortMsgHistory = new Map();
const adminActionHistory = new Map();
const slowModeChannels = new Map();
const channelCreateLog = new Map();
const roleDeleteLog = new Map();
const commandAttackTracker = new Map();
const userCommandDetails = new Map();
const userAttachmentLog = new Map();
const dangerRoleDistLog = new Map();
const webhookCreateLog = new Map();
const channelDeleteLog = new Map();
const nukeBanLog = new Map();
const channelFloodLog = new Map();
const webhookFloodLog = new Map(); // ★ NEW: Webhookスパム用

// ================================================================
//  ★ NEW: 追加内部状態マップ
// ================================================================
// CONFIRMED_RAID: ユーザーごとの異常ログ（type, timestamp）
const anomalyLog = new Map();
// CONFIRMED_RAID: 確定済みユーザーセット（重複処罰防止）
const confirmedRaidUsers = new Set();
// Trust System: 参加時刻記録
const userJoinTimeMap = new Map();
// 権限悪用拡張: 招待リンク生成ログ
const inviteCreateLog = new Map();
// 権限悪用拡張: スレッド作成ログ
const threadCreateLog = new Map();
// 権限悪用拡張: 絵文字/スタンプ変更ログ
const emojiAbuseLog = new Map();
// 権限悪用拡張: チャンネル設定変更ログ
const channelSettingLog = new Map();

// ================================================================
//  ★ ユーティリティ関数
// ================================================================

function hasDangerousPerms(permBits) {
  return new PermissionsBitField(permBits).any(DANGEROUS_PERMS_BITFIELD);
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

function setScore(userId, value) { scores[userId] = value; saveScores(); }
function getScore(userId) { return scores[userId] || 0; }

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
    anomalyLog.delete(userId);
    confirmedRaidUsers.delete(userId);
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

// 文字列正規化（変形対策）
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

// ランダム文字列検出
function isRandomString(text) {
  if (text.length < RANDOM_STRING_MIN_LENGTH) return false;
  // 日本語が2文字以上含まれていれば通常会話
  const japaneseChars = (text.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF]/g) || []).length;
  if (japaneseChars >= 2) return false;
  const lower = text.toLowerCase();
  for (const word of COMMON_WORDS) if (lower.includes(word)) return false;
  const asciiOnly = text.replace(/[^\x20-\x7E]/g, '');
  if (asciiOnly.length < RANDOM_STRING_MIN_LENGTH) return false;
  const freq = {};
  for (const ch of asciiOnly) freq[ch] = (freq[ch] || 0) + 1;
  let entropy = 0;
  const len = asciiOnly.length;
  for (const ch in freq) {
    const p = freq[ch] / len;
    entropy -= p * Math.log2(p);
  }
  const maxEntropy = Math.log2(Math.min(len, 95));
  const normalizedEntropy = entropy / maxEntropy;
  if (normalizedEntropy > RANDOM_STRING_ENTROPY_THRESHOLD) return true;
  const onlyAlnum = /^[a-zA-Z0-9]+$/.test(asciiOnly);
  const vowelCount = (asciiOnly.match(/[aeiouAEIOU]/g) || []).length;
  if (onlyAlnum && vowelCount === 0 && asciiOnly.length > 8) return true;
  return false;
}

// 類似度計算
function calculateSimilarity(str1, str2) {
  if (str1 === str2) return 100;
  const len1 = str1.length, len2 = str2.length;
  if (len1 === 0) return len2 === 0 ? 100 : 0;
  if (len2 === 0) return 0;
  const matrix = Array(len2 + 1).fill().map(() => Array(len1 + 1).fill(0));
  for (let i = 0; i <= len1; i++) matrix[0][i] = i;
  for (let j = 0; j <= len2; j++) matrix[j][0] = j;
  for (let j = 1; j <= len2; j++) {
    for (let i = 1; i <= len1; i++) {
      const cost = str1[i-1] === str2[j-1] ? 0 : 1;
      matrix[j][i] = Math.min(matrix[j-1][i] + 1, matrix[j][i-1] + 1, matrix[j-1][i-1] + cost);
    }
  }
  const distance = matrix[len2][len1];
  const maxLen = Math.max(len1, len2);
  return Math.round((1 - distance / maxLen) * 100);
}

function isCommonConversation(content) {
  const normalized = content.toLowerCase().trim();
  // 5文字以下は絶対に雑談
  if (normalized.length <= 5) return true;
  // 日本語が含まれていれば基本的に雑談（リンクや明確な荒らし文言チェックは別途）
  if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(normalized)) {
    // 日本語テキストで長さが50文字以下なら雑談とみなす
    if (normalized.length <= 50) return true;
  }
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

// ログチャンネル（nuke-logs）を取得/作成
async function getOrCreateLogChannel(guild) {
  if (!guild) return null;
  let ch = guild.channels.cache.find(c => c.name === LOG_CHANNEL_NAME && c.type === ChannelType.GuildText);
  if (ch) return ch;
  try {
    ch = await guild.channels.create({ name: LOG_CHANNEL_NAME, type: ChannelType.GuildText, reason: '荒らし対策ログ専用' });
    return ch;
  } catch { return null; }
}

async function sendLogEmbed(guild, { title, member, description, fields = [], color = 0xff0000, channelName, content = null }) {
  const ch = await getOrCreateLogChannel(guild);
  if (!ch) return;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description || '')
    .addFields(
      ...(member ? [{ name: 'ユーザー', value: `${member.user?.tag || 'unknown'} (${member.id})`, inline: false }] : []),
      ...fields,
      ...(content ? [{ name: '問題のメッセージ', value: `\`\`\`\n${snippet(content, 1000)}\n\`\`\``, inline: false }] : [])
    )
    .setTimestamp();
  if (channelName) embed.setFooter({ text: `チャンネル: #${channelName}` });
  ch.send({ embeds: [embed] }).catch(() => {});
}

async function sendPlainLog(guild, content) {
  const ch = await getOrCreateLogChannel(guild);
  if (ch) await ch.send(content).catch(() => {});
}

// ================================================================
//  ★ NEW: ヘルパー関数
// ================================================================

/**
 * 日本語文字を含むかどうか
 */
function containsJapanese(text) {
  return /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF]/.test(text);
}

/**
 * 新規ユーザー（参加から10分以内）かどうか
 */
function isNewUser(member) {
  if (!member) return false;
  const joinedAt = member.joinedTimestamp || userJoinTimeMap.get(member.id);
  if (!joinedAt) return false;
  return Date.now() - joinedAt < NEW_USER_WINDOW_MS;
}

/**
 * チャンネルを分類する（lenient / strict / normal）
 */
function classifyChannel(channel) {
  if (!channel?.name) return 'normal';
  const name = channel.name.toLowerCase();
  if (LENIENT_CHANNEL_KEYWORDS.some(k => name.includes(k))) return 'lenient';
  if (STRICT_CHANNEL_KEYWORDS.some(k => name.includes(k))) return 'strict';
  return 'normal';
}

/**
 * ★★★ 荒らし異常ログに記録し、確定かどうかを返す
 */
function logAnomaly(userId, anomalyType) {
  if (!CONFIRMED_RAID_TYPES.has(anomalyType)) return false;

  const now = Date.now();
  if (!anomalyLog.has(userId)) anomalyLog.set(userId, []);
  const log = anomalyLog.get(userId);
  log.push({ type: anomalyType, timestamp: now });

  const recent = log.filter(e => now - e.timestamp < CONFIRMED_RAID_WINDOW_MS);
  anomalyLog.set(userId, recent);

  if (confirmedRaidUsers.has(userId)) return true;

  const types = new Set(recent.map(e => e.type));
  return types.size >= CONFIRMED_RAID_MIN_SIGNALS;
}

/**
 * ★★★ 荒らし確定時の即処罰および自動復旧（パージ）
 */
async function executeConfirmedPunishment(member, reason, triggerMessage = null) {
  if (!member || isWhitelisted(member)) return;
  if (confirmedRaidUsers.has(member.id)) return; // 重複防止
  confirmedRaidUsers.add(member.id);

  // 1. トリガーメッセージを即削除
  if (triggerMessage?.deletable) {
    await triggerMessage.delete().catch(() => {});
  }

  // 2. ★ 過去12時間のメッセージを一括削除（自動復旧）
  const deleted = await deleteRecentMessages(member.guild, member.id, 12);

  // 3. タイムアウト → 失敗したらBAN → それも失敗なら権限剥奪
  let action = 'unknown';
  try {
    if (member.moderatable) {
      await member.timeout(CONFIRMED_RAID_TIMEOUT_MS, `荒らし確定: ${reason}`);
      action = 'TIMEOUT (10分)';
    } else {
      throw new Error('not moderatable');
    }
  } catch {
    try {
      await member.guild.members.ban(member.id, {
        reason: `荒らし確定(Timeout失敗): ${reason}`,
        deleteMessageSeconds: 86400,
      });
      action = 'BAN';
    } catch {
      await saveAndStripRoles(member);
      action = '権限剥奪';
    }
  }

  // 4. ログ出力
  await sendLogEmbed(member.guild, {
    title: `🚨🚨【荒らし確定】即時処罰・自動復旧: ${action}`,
    member,
    description: [
      `**確定理由**: ${reason}`,
      `**処罰内容**: ${action}`,
      `**自動復旧パージ**: 過去12時間のメッセージ ${deleted} 件を一括削除しました。`,
      `**確定ロジック**: ${CONFIRMED_RAID_WINDOW_MS/1000}秒以内に複数の異常行動を検知`,
    ].join('\n'),
    color: 0xff0000,
  });

  markUser(member.id);

  // 30分後に確定フラグをリセット（再検知可能にする）
  setTimeout(() => confirmedRaidUsers.delete(member.id), CONFIRMED_RAID_RESET_MS);
}

// ================================================================
//  ★ NEW: 信頼レイヤー（Trust System）チェック
// ================================================================
async function checkTrustViolation(message) {
  const { member, guild, content, channel } = message;
  if (!member || isWhitelisted(member)) return false;
  if (!isNewUser(member)) return false;
  // 依頼チャンネルはリンク・添付制限をスキップ
  if (channel?.name && channel.name.includes('依頼')) return false;

  const hasExternalLink = /https?:\/\//.test(content) && !ALLOWED_INVITE_LINKS.some(a => content.includes(a));
  const hasInviteLink   = /discord\.gg\//i.test(content) && !ALLOWED_INVITE_LINKS.some(a => content.includes(a));
  const hasAttachment   = message.attachments?.size > 0;
  const mentionCount    = (message.mentions?.users?.size || 0) + (message.mentions?.roles?.size || 0);
  const hasMassMention  = mentionCount >= NEW_USER_MENTION_THRESHOLD;

  let violated = false;
  const violations = [];

  if (hasExternalLink || hasInviteLink) {
    addScore(member.id, NEW_USER_LINK_SCORE);
    violations.push('リンク送信');
    logAnomaly(member.id, 'NEW_USER_LINK');
    violated = true;
  }
  if (hasAttachment) {
    addScore(member.id, NEW_USER_ATTACHMENT_SCORE);
    violations.push('添付ファイル');
    logAnomaly(member.id, 'NEW_USER_ATTACH');
    violated = true;
  }
  if (hasMassMention) {
    addScore(member.id, NEW_USER_MENTION_SCORE);
    violations.push(`大量メンション(${mentionCount}件)`);
    logAnomaly(member.id, 'NEW_USER_MENTION');
    violated = true;
  }

  if (!violated) return false;

  const joinedSecsAgo = Math.floor((Date.now() - (member.joinedTimestamp || Date.now())) / 1000);
  await safeDelete(message, `新規ユーザー信頼違反: ${violations.join(', ')}`);
  await sendLogEmbed(guild, {
    title: '🔒 新規ユーザー信頼違反（参加直後）',
    member,
    description: [
      `**違反内容**: ${violations.join(', ')}`,
      `**参加からの経過**: ${joinedSecsAgo}秒`,
      `**スコア**: ${getScore(member.id)}/${currentCfg().THRESHOLD}`,
      `※ 参加${NEW_USER_WINDOW_MS/60000}分以内はリンク・添付・大量メンションを制限しています`,
    ].join('\n'),
    channelName: channel?.name,
    color: 0xff6600,
  });

  const isConfirmed = anomalyLog.has(member.id) &&
    new Set(anomalyLog.get(member.id).filter(e => Date.now() - e.timestamp < CONFIRMED_RAID_WINDOW_MS).map(e => e.type)).size >= CONFIRMED_RAID_MIN_SIGNALS;

  if (isConfirmed) {
    await executeConfirmedPunishment(member, `新規ユーザー複合違反: ${violations.join(', ')}`, null);
  } else {
    await punishByScore(member, `新規ユーザー制限違反: ${violations.join(', ')}`, channel?.name);
  }
  return true;
}

// ================================================================
//  権限操作
// ================================================================
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
  member.send('✅ 認証が完了しました。ロールを復元しました。').catch(() => {});
}
async function createOneTimeInvite(guild) {
  try {
    const channel = guild.systemChannel || guild.channels.cache.find(c =>
      c.type === ChannelType.GuildText &&
      c.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.CreateInstantInvite)
    );
    if (!channel) return null;
    const invite = await channel.createInvite({ maxAge: 30*60, maxUses: 1, unique: true });
    return invite?.url || null;
  } catch { return null; }
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
function isInProbation(userId) {
  const p = probationAdmins.get(userId);
  return p && Date.now() - p < PROBATION_MS;
}
function hasManageGuildPermission(member) {
  return member?.permissions?.has(PermissionsBitField.Flags.ManageGuild) || false;
}

// ================================================================
//  ★ バックアップ強化版
// ================================================================
function backupServerState(guild) {
  try {
    const data = {
      timestamp: Date.now(),
      guildName: guild.name,
      verificationLevel: guild.verificationLevel,

      roles: guild.roles.cache.map(r => ({
        id: r.id,
        name: r.name,
        color: r.color,
        hoist: r.hoist,
        mentionable: r.mentionable,
        position: r.position,
        permissions: r.permissions.bitfield.toString(),
      })),

      channels: guild.channels.cache.map(c => ({
        id: c.id,
        name: c.name,
        type: c.type,
        parentId: c.parentId || null,
        position: c.position || 0,
        topic: c.topic || null,
        nsfw: c.nsfw || false,
        rateLimitPerUser: c.rateLimitPerUser || 0,
        userLimit: c.userLimit || 0,
        bitrate: c.bitrate || null,
      })),

      permissionOverwrites: (() => {
        const result = {};
        for (const [id, channel] of guild.channels.cache) {
          if (!channel.permissionOverwrites) continue;
          result[id] = channel.permissionOverwrites.cache.map(ow => ({
            id: ow.id,
            type: ow.type,
            allow: ow.allow.bitfield.toString(),
            deny: ow.deny.bitfield.toString(),
          }));
        }
        return result;
      })(),
    };

    serverBackup[guild.id] = data;
    saveBackup();
    return data;
  } catch (e) {
    console.error('[anti-raid] backupServerState error:', e);
    return null;
  }
}

async function restoreServerState(guild) {
  const data = serverBackup[guild.id];
  if (!data) {
    await sendPlainLog(guild, '❌ バックアップデータが見つかりません。先に `/backup` を実行してください。');
    return;
  }
  let restoredRoles = 0, restoredChannels = 0, restoredOverwrites = 0;
  try {
    for (const r of data.roles || []) {
      const role = guild.roles.cache.get(r.id);
      if (role && role.editable) {
        try {
          await role.setPermissions(BigInt(r.permissions), 'バックアップ復元');
          restoredRoles++;
        } catch {}
      }
    }
    for (const c of data.channels || []) {
      const channel = guild.channels.cache.get(c.id);
      if (!channel) continue;
      try {
        const updates = {};
        if (channel.name !== c.name) updates.name = c.name;
        if (c.topic !== undefined && channel.topic !== c.topic) updates.topic = c.topic;
        if (c.nsfw !== undefined && channel.nsfw !== c.nsfw) updates.nsfw = c.nsfw;
        if (c.rateLimitPerUser !== undefined && channel.rateLimitPerUser !== c.rateLimitPerUser) updates.rateLimitPerUser = c.rateLimitPerUser;
        if (Object.keys(updates).length > 0) {
          await channel.edit(updates, 'バックアップ復元');
          restoredChannels++;
        }
      } catch {}
    }
    for (const [channelId, overwrites] of Object.entries(data.permissionOverwrites || {})) {
      const channel = guild.channels.cache.get(channelId);
      if (!channel?.permissionOverwrites) continue;
      for (const ow of overwrites) {
        try {
          await channel.permissionOverwrites.edit(ow.id, {
            allow: BigInt(ow.allow),
            deny: BigInt(ow.deny),
          }, { reason: 'バックアップ復元' });
          restoredOverwrites++;
        } catch {}
      }
    }
    if (data.verificationLevel !== undefined) {
      await guild.setVerificationLevel(data.verificationLevel, 'バックアップ復元').catch(() => {});
    }
    await sendPlainLog(guild, [
      `✅ **サーバーをバックアップ状態に復元しました。**`,
      `📅 バックアップ日時: ${new Date(data.timestamp).toLocaleString('ja-JP')}`,
      `🔧 ロール復元: ${restoredRoles} / チャンネル復元: ${restoredChannels} / 権限オーバーライド復元: ${restoredOverwrites}`,
    ].join('\n'));
  } catch (e) {
    await sendPlainLog(guild, `❌ 復元中にエラーが発生しました: ${e.message}`);
  }
}

// ===== 荒らし確定時: 過去12時間のメッセージを一括削除 =====
async function deleteRecentMessages(guild, userId, hoursBack = 12) {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  let totalDeleted = 0;
  const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText);
  for (const [, channel] of textChannels) {
    try {
      const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      if (!messages) continue;
      const targets = messages.filter(m => m.author.id === userId && m.createdTimestamp >= cutoff);
      if (targets.size === 0) continue;
      if (targets.size === 1) {
        await targets.first().delete().catch(() => {});
        totalDeleted++;
      } else {
        await channel.bulkDelete(targets, true).catch(async () => {
          for (const [, msg] of targets) {
            await msg.delete().catch(() => {});
            totalDeleted++;
          }
        });
        totalDeleted += targets.size;
      }
    } catch {}
  }
  return totalDeleted;
}

// スコアによる処罰
async function punishByScore(member, reason, channelName) {
  if (!member || isWhitelisted(member) || probationAdmins.has(member.id)) return;
  const c = currentCfg();
  const score = getScore(member.id);
  if (score >= Math.floor(c.THRESHOLD * 0.5) && score < c.THRESHOLD) {
    const muteRole = member.guild.roles.cache.find(r => r.name.toLowerCase() === 'muted');
    if (muteRole && !member.roles.cache.has(muteRole.id)) {
      await member.roles.add(muteRole, '荒らし疑い').catch(() => {});
      await sendLogEmbed(member.guild, { title: '⚠️ 荒らし疑い（Mute）', member, description: `理由: ${reason}\nスコア: ${score}/${c.THRESHOLD}`, channelName, color: 0xffa200 });
      return;
    }
  }
  if (score >= c.THRESHOLD) {
    try {
      await member.timeout(TIMEOUT_MS, reason);
      const deleted = await deleteRecentMessages(member.guild, member.id, 12);
      await sendLogEmbed(member.guild, { title: '🚨 Timeout 適用', member, description: `理由: ${reason}\nスコア: ${score}\n🗑️ 過去12時間のメッセージ ${deleted} 件を削除しました`, channelName });
      setScore(member.id, Math.floor(c.THRESHOLD * 0.5));
      markUser(member.id);
    } catch {
      await saveAndStripRoles(member);
      const deleted = await deleteRecentMessages(member.guild, member.id, 12);
      await sendLogEmbed(member.guild, { title: '🚨 権限剥奪（代替）', member, description: `Timeout失敗: ${reason}\n🗑️ 過去12時間のメッセージ ${deleted} 件を削除しました`, channelName });
      markUser(member.id);
    }
  }
}

// 緊急スローモード
async function applyEmergencySlowmode(channel, durationSeconds = 10, reason = '荒らし検知') {
  if (!channel || channel.type !== ChannelType.GuildText) return;
  if (slowModeChannels.has(channel.id)) return;
  try {
    const originalRateLimit = channel.rateLimitPerUser;
    await channel.setRateLimitPerUser(durationSeconds, reason);
    slowModeChannels.set(channel.id, { originalRateLimit, timeout: Date.now() });
    await sendLogEmbed(channel.guild, {
      title: '⏱️ 緊急スローモード適用',
      description: `#${channel.name}\nスローモード: ${durationSeconds}秒\n理由: ${reason}\n⏰ 5分後に自動解除します。`,
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
  } catch {}
}

// ================================================================
//  ★ ランダム文字連投検知（確定フラグ統合）
// ================================================================
async function handleRandomStringSpam(message) {
  const { member, guild, content, channel } = message;
  if (!member || isWhitelisted(member)) return false;
  if (isRandomString(content)) {
    const c = currentCfg();
    const s = addScore(member.id, c.RANDOM_STRING);
    await sendLogEmbed(guild, {
      title: '⚠️ ランダム文字列検知',
      member,
      description: `+${c.RANDOM_STRING} / 現在 ${s}/${c.THRESHOLD}`,
      channelName: channel?.name,
      content,
    });
    await applyEmergencySlowmode(channel, 10, 'ランダム文字連投');

    const isConfirmed = logAnomaly(member.id, 'RANDOM_STRING');
    if (isConfirmed) {
      await executeConfirmedPunishment(member, 'ランダム文字列 + 複合異常', message);
    } else {
      await punishByScore(member, 'ランダム文字列連投', channel?.name);
    }
    return true;
  }
  return false;
}

// ===== 変形リンク検知 =====
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

async function handleObfuscatedLink(message) {
  const { member, guild, content, channel } = message;
  if (!member || isWhitelisted(member)) return false;
  // 依頼チャンネルはどのサーバーリンクも許可
  if (channel?.name && channel.name.includes('依頼')) return false;
  if (containsMaliciousLink(content)) {
    // --- 自サーバー招待リンク判定 ---
    // メッセージ内の discord.gg/XXXX を全て抽出し、
    // 全て自サーバーの招待コードであれば招待ログのみ記録して処罰しない
    const inviteCodes = [...content.matchAll(/discord(?:app)?\.(?:gg|com\/invite)\/([a-z0-9-]+)/gi)]
      .map(m => m[1]);
    if (inviteCodes.length > 0) {
      try {
        const guildInvites = await guild.invites.fetch();
        const allOwnGuild = inviteCodes.every(code =>
          guildInvites.has(code) || ALLOWED_INVITE_LINKS.some(a => a.includes(code))
        );
        if (allOwnGuild) {
          // 自サーバーの正規招待リンク → ログだけ記録して終了
          await sendLogEmbed(guild, {
            title: '📨 招待リンク送信ログ',
            member,
            description: `自サーバーの招待リンクをチャンネルに送信しました\nコード: ${inviteCodes.map(c => `\`${c}\``).join(', ')}\nURL: ${inviteCodes.map(c => `https://discord.gg/${c}`).join(', ')}`,
            channelName: channel?.name,
            color: 0x5865f2,
          });
          return false;
        }
      } catch (e) {
        // 招待取得失敗時は通常の悪意リンク処理を続行
        console.warn('handleObfuscatedLink: guild.invites.fetch failed:', e?.message || e);
      }
    }
    // --- 悪意リンク・変形リンク処理（既存） ---
    const c = currentCfg();
    const s = addScore(member.id, c.KEYWORD);
    await safeDelete(message, '変形リンク/荒らし文言');
    await sendLogEmbed(guild, {
      title: '🚨 変形・回避リンク検知',
      member,
      description: `正規化後に荒らしパターンを検出\n+${c.KEYWORD} / 現在 ${s}/${c.THRESHOLD}`,
      channelName: channel?.name,
      content,
    });
    await applyEmergencySlowmode(channel, 15, '変形リンク荒らし');

    const isConfirmed = logAnomaly(member.id, 'MALICIOUS_LINK');
    if (isConfirmed) {
      await executeConfirmedPunishment(member, '変形リンク + 複合異常', null);
    } else {
      await punishByScore(member, '変形リンク', channel?.name);
    }
    return true;
  }
  return false;
}

// ===== 短縮リンク展開 =====
async function expandShortUrl(url) {
  try {
    const response = await axios.head(url, { maxRedirects: 5, timeout: 5000, validateStatus: status => status >= 200 && status < 400 });
    return response.request.res.responseUrl || url;
  } catch { return url; }
}

async function handleShortenedUrl(message) {
  const { member, guild, content, channel } = message;
  if (!member || isWhitelisted(member)) return false;
  const urlRegex = /https?:\/\/[^\s<>]+/g;
  const urls = content.match(urlRegex) || [];
  for (const url of urls) {
    const isShortened = SHORTENER_SERVICES.some(s => url.includes(s));
    if (isShortened) {
      const expanded = await expandShortUrl(url);
      if (containsMaliciousLink(expanded)) {
        const c = currentCfg();
        const s = addScore(member.id, c.KEYWORD);
        await safeDelete(message, '悪意ある短縮リンク');
        await sendLogEmbed(guild, {
          title: '🚨 悪意ある短縮リンク',
          member,
          description: `元: ${url}\n展開後: ${expanded}\n+${c.KEYWORD} / ${s}`,
          channelName: channel?.name,
          content,
        });
        const isConfirmed = logAnomaly(member.id, 'SHORTENED_LINK');
        if (isConfirmed) {
          await executeConfirmedPunishment(member, '悪意ある短縮リンク + 複合異常', null);
        } else {
          await punishByScore(member, '悪意ある短縮リンク', channel?.name);
        }
        return true;
      }
    } else if (containsMaliciousLink(url)) {
      const c = currentCfg();
      const s = addScore(member.id, c.KEYWORD);
      await safeDelete(message, '悪意あるリンク');
      await sendLogEmbed(guild, {
        title: '🚨 悪意あるリンク',
        member,
        description: `リンク: ${url}\n+${c.KEYWORD} / ${s}`,
        channelName: channel?.name,
        content,
      });
      const isConfirmed = logAnomaly(member.id, 'MALICIOUS_LINK');
      if (isConfirmed) {
        await executeConfirmedPunishment(member, '悪意あるリンク + 複合異常', null);
      } else {
        await punishByScore(member, '悪意あるリンク', channel?.name);
      }
      return true;
    }
  }
  return false;
}

// ===== 添付ファイル連投スパム検知（確定フラグ統合）=====
async function handleAttachmentSpam(message) {
  const { member, guild, channel } = message;
  if (!member || isWhitelisted(member)) return false;
  if (!message.attachments || message.attachments.size === 0) return false;

  const now = Date.now();
  const uid = member.id;
  if (!userAttachmentLog.has(uid)) userAttachmentLog.set(uid, []);
  const history = userAttachmentLog.get(uid);
  for (let i = 0; i < message.attachments.size; i++) history.push(now);
  const recent = history.filter(t => now - t < 5000);
  userAttachmentLog.set(uid, recent);

  if (recent.length >= 3) {
    const c = currentCfg();
    const s = addScore(uid, c.ATTACHMENT_SPAM);
    await sendLogEmbed(guild, {
      title: '🚨 添付ファイル連投検知',
      member,
      description: `5秒以内に ${recent.length} 個のファイルを送信\n+${c.ATTACHMENT_SPAM} / 現在 ${s}/${c.THRESHOLD}`,
      channelName: channel?.name,
    });

    const isConfirmed = logAnomaly(uid, 'ATTACHMENT_SPAM');
    if (isConfirmed) {
      await executeConfirmedPunishment(member, '添付ファイル連投 + 複合異常', message);
    } else {
      await punishByScore(member, '添付ファイル連投', channel?.name);
    }
    return true;
  }
  return false;
}

// ===== 大量メンションスパム検知（確定フラグ統合）=====
async function handleMassMention(message) {
  const { member, guild, channel, mentions } = message;
  if (!member || isWhitelisted(member)) return false;

  const mentionCount = (mentions.users?.size || 0) + (mentions.roles?.size || 0);
  if (!mentions.everyone && mentionCount >= MENTION_THRESHOLD) {
    const scoreToAdd = mentionCount * 7;
    const s = addScore(member.id, scoreToAdd);
    await safeDelete(message, '大量メンションスパム');
    await sendLogEmbed(guild, {
      title: '🚨 大量メンションスパム検知',
      member,
      description: `1メッセージ内に ${mentionCount} 件のメンション\n+${scoreToAdd} (${mentionCount}×7) / 現在 ${s}/${currentCfg().THRESHOLD}`,
      channelName: channel?.name,
      content: message.content,
    });
    await applyEmergencySlowmode(channel, 15, 'メンションスパム');

    const isConfirmed = logAnomaly(member.id, 'MASS_MENTION');
    if (isConfirmed) {
      await executeConfirmedPunishment(member, '大量メンション + 複合異常', null);
    } else {
      await punishByScore(member, '大量メンションスパム', channel?.name);
    }
    return true;
  }
  return false;
}

// ===== 危険なファイル（マルウェア・Token Grabber）検知（確定フラグ統合）=====
async function handleDangerousFiles(message) {
  const { member, guild, channel, attachments } = message;
  if (!member || isWhitelisted(member) || attachments.size === 0) return false;

  for (const [, attachment] of attachments) {
    const fileName = attachment.name?.toLowerCase() || '';
    if (DANGEROUS_EXTENSIONS.some(ext => fileName.endsWith(ext))) {
      const c = currentCfg();
      const s = addScore(member.id, c.DANGEROUS_FILE);
      await safeDelete(message, '危険なファイルの送信');
      await sendLogEmbed(guild, {
        title: '🚨 危険なファイル（マルウェア疑い）を遮断',
        member,
        description: `送信されたファイル: \`${fileName}\`\nToken Grabberなどを防ぐため削除しました。\n+${c.DANGEROUS_FILE} / 現在 ${s}/${c.THRESHOLD}`,
        channelName: channel?.name,
      });

      // 危険ファイルは単発でも即確定扱い（スコアが危険なため）
      const isConfirmed = logAnomaly(member.id, 'DANGEROUS_FILE');
      if (isConfirmed || s >= c.THRESHOLD) {
        await executeConfirmedPunishment(member, `危険なファイル送信: ${fileName}`, null);
      } else {
        await punishByScore(member, '危険なファイルの送信', channel?.name);
      }
      return true;
    }
  }
  return false;
}

// ===== 悪意のある名前・Hoisting 対策 =====
async function handleBadNickname(member) {
  if (!member || member.user.bot || isWhitelisted(member)) return;
  const username = member.user.username.toLowerCase();
  const displayName = member.displayName.toLowerCase();

  const hasInvite = username.includes('discord.gg') || username.includes('.gg/') ||
                    displayName.includes('discord.gg') || displayName.includes('.gg/');
  const isHoisting = /^[^a-zA-Z0-9ぁ-んァ-ヶ一-龠]/.test(member.displayName);

  if (hasInvite) {
    const c = currentCfg();
    const s = addScore(member.id, c.BAD_NAME);
    await sendLogEmbed(member.guild, {
      title: '⚠️ 悪意のあるユーザー名検知（招待リンク）',
      member,
      description: `名前に招待リンクが含まれています。\n+${c.BAD_NAME} / 現在 ${s}/${c.THRESHOLD}`,
      color: 0xffa200,
    });
    if (member.manageable) {
      await member.setNickname('Unverified User', '招待リンクを含む名前の強制変更').catch(() => {});
    }
    await punishByScore(member, '名前に招待リンクが含まれている', 'system');
  } else if (isHoisting && member.manageable) {
    const stripped = member.displayName.replace(/^[^a-zA-Z0-9ぁ-んァ-ヶ一-龠]+/, '').trim();
    const newName = stripped.length >= 1 ? stripped : 'Moderated Name';
    await member.setNickname(newName, 'Hoisting（記号始まり）対策').catch(() => {});
    await sendLogEmbed(member.guild, {
      title: '🔧 Hoisting対策: 先頭記号を除去しました',
      member,
      description: `\`${member.displayName}\` → \`${newName}\``,
      color: 0x3498db,
    });
  }
}

// ================================================================
//  短文連投スパム検知
//  ★ 改良点: 日本語が含まれる場合はほぼスキップ、雑談ノリは処罰しない
// ================================================================
const SHORT_MESSAGE_THRESHOLD = 20;
const SHORT_MSG_SPAM_COUNT = 10;   // 8→10 誤検知防止
const SHORT_MSG_WINDOW = 10000;

async function handleShortMessageSpam(message) {
  const { member, guild, content, channel } = message;
  if (!member || isWhitelisted(member)) return;
  if (content.length >= SHORT_MESSAGE_THRESHOLD) return;

  // ★ 日本語が含まれる短文は絶対にスキップ（雑談保護）
  if (containsJapanese(content)) return;

  // ★ COMMON_WORDSに含まれる単語のみの場合はスキップ
  const normalized = content.toLowerCase().trim();
  if (COMMON_WORDS.has(normalized)) return;

  const now = Date.now();
  const uid = member.id;
  if (!shortMsgHistory.has(uid)) shortMsgHistory.set(uid, []);
  const history = shortMsgHistory.get(uid);
  history.push({ timestamp: now, content });
  const recent = history.filter(h => now - h.timestamp < SHORT_MSG_WINDOW);
  shortMsgHistory.set(uid, recent);

  if (recent.length >= SHORT_MSG_SPAM_COUNT) {
    const unique = new Set(recent.map(h => h.content));
    const isRepetitive = unique.size === 1; // 完全同一文字の連投

    // ★ 内容が全て違う場合（普通の会話）はほぼ無視
    if (!isRepetitive) {
      // 雑談ノリとみなし、スコアを加算しない
      return;
    }

    // 完全同一メッセージの連投のみ処罰
    const c = currentCfg();
    const s = addScore(uid, c.MASS_SPAM);
    await sendLogEmbed(guild, {
      title: '🚧 同一短文連投スパム',
      member,
      description: `${SHORT_MSG_WINDOW/1000}秒間に${recent.length}回の完全同一メッセージ\n+${c.MASS_SPAM} / 現在 ${s}/${c.THRESHOLD}`,
      channelName: channel?.name,
      content,
    });

    const isConfirmed = logAnomaly(uid, 'REPETITIVE_SPAM');
    if (isConfirmed) {
      await executeConfirmedPunishment(member, '同一短文連投 + 複合異常', message);
    } else {
      await punishByScore(member, '短文連投（完全同一）', channel?.name);
    }
  }
}

// ===== botコマンド抽出 =====
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
        const isConfirmed = logAnomaly(userId, 'CMD_ATTACK');
        if (isConfirmed) {
          await executeConfirmedPunishment(targetMember, `協調コマンド攻撃: ${command}`, null);
        } else {
          await punishByScore(targetMember, `協調コマンド攻撃: ${command}`, channel?.name);
        }
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

async function handlePersonalCommandSpam(message) {
  const { member, content, channel } = message;
  if (!member || isWhitelisted(member)) return;
  const command = extractBotCommand(content);
  if (!command) return;
  const now = Date.now();
  const lastCmd = userCmdTime.get(member.id) || 0;
  if (now - lastCmd < 1000) return;
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
    await sendLogEmbed(message.guild, {
      title: '🚧 同一コマンドリピート',
      member,
      description: `コマンド「${command}」を10秒以内に${count}回\n+${c.CMD_ABUSE} / 現在 ${s}/${c.THRESHOLD}`,
      channelName: channel?.name,
      content,
    });
    await punishByScore(member, '同一コマンド連打', channel?.name);
  }
}

// ===== 類似メッセージ検知 =====
async function handleSimilarityDetection(message) {
  const { member, guild, content, channel } = message;
  const uid = member.id;
  const normalized = content.toLowerCase().trim();
  if (normalized.length < 10 || isCommonConversation(content)) return;
  if (!similarityTracker.has(guild.id)) similarityTracker.set(guild.id, new Map());
  const guildTracker = similarityTracker.get(guild.id);
  let similarFound = false, matchingHash = null;
  for (const [hash, data] of guildTracker.entries()) {
    if (calculateSimilarity(normalized, hash) >= SIMILARITY_PERCENT_THRESHOLD) {
      similarFound = true;
      matchingHash = hash;
      if (!data.users.has(uid)) data.users.add(uid);
      data.count++;
      break;
    }
  }
  if (!similarFound) {
    guildTracker.set(normalized, { firstSeen: Date.now(), users: new Set([uid]), count: 1 });
    return;
  }
  const matchingData = guildTracker.get(matchingHash);
  if (matchingData.users.size >= SIMILARITY_MIN_USERS) {
    if (matchingData.count >= SIMILARITY_TIMEOUT_THRESHOLD) {
      await member.timeout(SIMILARITY_TIMEOUT_DURATION, '類似メッセージ大量投稿');
      await safeDelete(message, '類似メッセージ大量投稿');
      await sendLogEmbed(guild, {
        title: '🚨 類似メッセージ大量投稿（タイムアウト）',
        member,
        description: `類似度: ${SIMILARITY_PERCENT_THRESHOLD}%以上\n投稿回数: ${matchingData.count}\n参加ユーザー: ${matchingData.users.size}人`,
        channelName: channel?.name,
        color: 0xff0000,
        content,
      });
      guildTracker.delete(matchingHash);
    } else if (matchingData.count >= SIMILARITY_DELETE_THRESHOLD) {
      await sendLogEmbed(guild, {
        title: '⚠️ 類似メッセージ反復投稿（警告）',
        member,
        description: `類似度: ${SIMILARITY_PERCENT_THRESHOLD}%以上\n投稿回数: ${matchingData.count}\n参加ユーザー: ${matchingData.users.size}人`,
        channelName: channel?.name,
        color: 0xffa200,
        content,
      });
    }
  }
}

async function handlePersonalSimilarityDetection(message) {
  const { member, guild, content, channel } = message;
  const uid = member.id;
  const normalized = content.toLowerCase().trim();
  if (isCommonConversation(content)) return;
  if (!messageHistory.has(guild.id)) messageHistory.set(guild.id, new Map());
  const gmap = messageHistory.get(guild.id);
  if (!gmap.has(normalized)) gmap.set(normalized, new Map());
  const senders = gmap.get(normalized);
  senders.set(uid, (senders.get(uid) || 0) + 1);
  if (senders.get(uid) >= 5) {
    const s = addScore(uid, currentCfg().SIMILAR);
    await sendLogEmbed(guild, {
      title: '🚧 類似メッセージ（個人）',
      member,
      description: `+${currentCfg().SIMILAR} / 現在 ${s}/${currentCfg().THRESHOLD}`,
      channelName: channel?.name,
      content,
    });
    await punishByScore(member, '類似メッセージ連投', channel?.name);
  }
}

// ===== ヌークBot: Botメッセージスパム検知 =====
async function handleBotSpam(message) {
  if (!message.author.bot || !message.guild) return false;
  const content = message.content || '';
  if ((content.includes('@everyone') || content.includes('@here')) &&
      /discord\.gg\//i.test(content)) {
    await safeDelete(message, 'ヌークBotによる@everyoneスパム');
    
    // ★ Botスパムの自動復旧 (パージ)
    const deleted = await deleteRecentMessages(message.guild, message.author.id, 1);

    await message.guild.members.ban(message.author.id, {
      reason: 'ヌークBot: @everyone+招待リンクスパム',
      deleteMessageSeconds: 86400,
    }).catch(() => {});

    await sendLogEmbed(message.guild, {
      title: '🚨 ヌークBotのスパムを検知 → 即時BAN & パージ',
      description: `Bot <@${message.author.id}> が @everyone+招待リンクを連投しました。即BANし、スパムメッセージ ${deleted} 件をパージしました。`,
      color: 0xff0000,
      content,
    });
    return true;
  }
  const key = `${message.guild.id}:${message.channel.id}:${message.author.id}`;
  if (!channelFloodLog.has(key)) channelFloodLog.set(key, []);
  const arr = channelFloodLog.get(key);
  const now = Date.now();
  arr.push(now);
  const recent = arr.filter(t => now - t < FLOOD_MSG_WINDOW_MS);
  channelFloodLog.set(key, recent);
  if (recent.length >= FLOOD_MSG_THRESHOLD) {
    const deleted = await deleteRecentMessages(message.guild, message.author.id, 1);
    await message.guild.members.ban(message.author.id, {
      reason: `ヌークBot: ${FLOOD_MSG_WINDOW_MS / 1000}秒以内に${recent.length}件フラッド`,
      deleteMessageSeconds: 86400,
    }).catch(() => {});
    await sendLogEmbed(message.guild, {
      title: '🚨 BotによるフラッドMSG → 即時BAN & パージ',
      description: `Bot <@${message.author.id}> が ${FLOOD_MSG_WINDOW_MS / 1000}秒以内に ${recent.length} 件のメッセージをフラッド。即BANし、メッセージ ${deleted} 件をパージしました。`,
      color: 0xff0000,
    });
    return true;
  }
  return false;
}

// ===== ★ NEW: Webhook 乗っ取り対策 =====
async function handleWebhookSpam(message) {
  if (!message.webhookId || !message.guild) return false;
  const key = message.webhookId;
  const now = Date.now();
  if (!webhookFloodLog.has(key)) webhookFloodLog.set(key, []);
  const arr = webhookFloodLog.get(key);
  arr.push(now);
  const recent = arr.filter(t => now - t < 10000); // 10秒間に監視
  webhookFloodLog.set(key, recent);

  if (recent.length >= 5) { // 10秒に5回以上でスパム判定
    await message.channel.bulkDelete(recent.length).catch(() => {});
    try {
      const webhooks = await message.guild.fetchWebhooks();
      const targetWh = webhooks.get(key);
      if (targetWh) {
        await targetWh.delete('Webhook乗っ取りスパム自動防御');
        await sendLogEmbed(message.guild, {
          title: '🚨 Webhook乗っ取り防御・自動復旧',
          description: `Webhook(\`${targetWh.name}\`) から短時間に大量のスパムを検知しました。\n対象Webhookを自動削除し、直近のスパムメッセージを消去しました。`,
          color: 0xff0000,
        });
      }
    } catch (e) {
      console.error('Webhook削除失敗', e);
    }
    return true;
  }
  return false;
}

// ================================================================
//  ★ メインのメッセージハンドラ（優先順位と構成を最適化）
// ================================================================
async function handleMessage(message) {
  if (!message?.guild || !message.author) return;

  // Webhookによるスパム対応
  if (message.webhookId) {
    await handleWebhookSpam(message);
    return;
  }

  // Botメッセージはヌークスパム検知のみ
  if (message.author.bot) {
    await handleBotSpam(message);
    return;
  }

  const member = message.member;
  if (!member || isWhitelisted(member) || member.permissions?.has(PermissionsBitField.Flags.Administrator)) return;

  const channelType = classifyChannel(message.channel);

  // ★ 1. 危険なファイル・リンクを【最優先】でチェック
  if (await handleDangerousFiles(message)) return;
  if (await handleObfuscatedLink(message)) return;
  if (await handleShortenedUrl(message)) return;

  // ★ 2. 信頼レイヤー（新規ユーザーチェック）
  if (await checkTrustViolation(message)) return;

  // ★ 3. 大量メンションチェック
  if (await handleMassMention(message)) return;

  // ★ 雑談チャンネル（lenient）では添付スパム・ランダム文字・短文スパムを緩和
  if (channelType !== 'lenient') {
    if (await handleRandomStringSpam(message)) return;
    if (await handleAttachmentSpam(message)) return;
    await handleShortMessageSpam(message);
  } else {
    // 雑談チャンネルでも明らかなランダム文字は検知（ただしスコア半減）
    const content = message.content || '';
    if (isRandomString(content)) {
      const c = currentCfg();
      const reduced = Math.floor(c.RANDOM_STRING * 0.5);
      const s = addScore(member.id, reduced);
      await sendLogEmbed(message.guild, {
        title: '⚠️ ランダム文字列検知（雑談チャンネル・軽減）',
        member,
        description: `+${reduced}（雑談チャンネルのため軽減） / 現在 ${s}/${c.THRESHOLD}`,
        channelName: message.channel?.name,
        content,
        color: 0xffa200,
      });
      await punishByScore(member, 'ランダム文字列連投（雑談）', message.channel?.name);
      return;
    }
  }

  if (await handleMultiAccountCommandAttack(message)) return;
  await handlePersonalCommandSpam(message);

  const c = currentCfg();
  const now = Date.now();
  const uid = member.id;

  // 通常連投検知（厳格チャンネルはより短い時間窓を使用）
  const spamWindow = channelType === 'strict' ? Math.floor(MASS_SPAM_WINDOW * 0.7) : MASS_SPAM_WINDOW;
  const spamThreshold = channelType === 'strict' ? Math.floor(MASS_SPAM_THRESHOLD * 0.7) : MASS_SPAM_THRESHOLD;

  const list = userMsgTs.get(uid) || [];
  list.push(now);
  const recent = list.filter(t => now - t < spamWindow);
  userMsgTs.set(uid, recent);
  if (recent.length >= spamThreshold) {
    const s = addScore(uid, c.MASS_SPAM, true);
    await sendLogEmbed(message.guild, {
      title: '🚧 連投検知',
      member,
      description: `+${c.MASS_SPAM} / 現在 ${s}/${c.THRESHOLD}`,
      channelName: message.channel?.name,
      content: message.content,
    });
    await applyEmergencySlowmode(message.channel, 5, '連投検知');
    return punishByScore(member, '連投', message.channel?.name);
  }

  // Zalgo/改行チェック（雑談チャンネルでは閾値緩和）
  const content = message.content || '';
  const newlineCount = (content.match(/\n/g) || []).length;
  const newlineLimit = channelType === 'lenient' ? 30 : 20;
  if (newlineCount > newlineLimit) {
    const s = addScore(uid, c.NEWLINES);
    await safeDelete(message, '過度な改行');
    await sendLogEmbed(message.guild, {
      title: '🚧 過度な改行',
      member,
      description: `+${c.NEWLINES} / ${s}`,
      channelName: message.channel?.name,
      content,
    });
    return punishByScore(member, '過度な改行', message.channel?.name);
  }

  const zalgo = (message.content.match(/[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/g) || []).length;
  if (zalgo > 15) {
    const s = addScore(uid, c.ZALGO);
    await safeDelete(message, 'Zalgo');
    await sendLogEmbed(message.guild, {
      title: '🚧 Zalgo乱用',
      member,
      description: `+${c.ZALGO} / ${s}`,
      channelName: message.channel?.name,
      content,
    });
    return punishByScore(member, 'Zalgo', message.channel?.name);
  }

  // コマンド連打
  if (content.startsWith('!') || content.startsWith('/')) {
    const last = userCmdTime.get(uid) || 0;
    if (now - last < 1000) {
      const s = addScore(uid, c.CMD_ABUSE);
      await sendLogEmbed(message.guild, {
        title: '🚧 コマンド連打',
        member,
        description: `+${c.CMD_ABUSE} / ${s}`,
        channelName: message.channel?.name,
        content,
      });
      return punishByScore(member, 'コマンド連打', message.channel?.name);
    }
    userCmdTime.set(uid, now);
  }

  // 類似メッセージ検知（雑談チャンネルでは短文スキップ）
  if (channelType !== 'lenient' || content.length >= 20) {
    await handleSimilarityDetection(message);
    await handlePersonalSimilarityDetection(message);
  }
}

// ===== メンバージョイン監視 =====
async function handleMemberJoin(member) {
  if (!member || member.user.bot) return;
  if (isWhitelisted(member)) return;
  const now = Date.now();

  // ★ 信頼レイヤー: 参加時刻を記録
  userJoinTimeMap.set(member.id, now);
  // 24時間後に自動削除
  setTimeout(() => userJoinTimeMap.delete(member.id), 24 * 60 * 60 * 1000);

  const gid = member.guild.id;
  if (!memberJoinLog.has(gid)) memberJoinLog.set(gid, []);
  const arr = memberJoinLog.get(gid);
  arr.push({ id: member.id, timestamp: now });
  const recent = arr.filter(j => now - j.timestamp < RAID_TIME_WINDOW);
  memberJoinLog.set(gid, recent);

  if (recent.length >= RAID_MEMBER_THRESHOLD) {
    await sendLogEmbed(member.guild, { title: '🚨 Raid 警告（大量参加）', member, description: `過去1分で ${recent.length} 人が参加`, color: 0xff4757 });
    const prevLevel = member.guild.verificationLevel;
    await member.guild.setVerificationLevel(4, 'Raid対策: 一時ロックダウン').catch(() => {});
    await sendPlainLog(member.guild, `🔒 **ロックダウン開始**: 認証レベルを最高(4)に引き上げました。10分後に自動解除します。`);
    setTimeout(async () => {
      await member.guild.setVerificationLevel(prevLevel, 'Raid対策: ロックダウン解除').catch(() => {});
      await sendPlainLog(member.guild, `🔓 **ロックダウン解除**: 認証レベルを元に戻しました。`);
    }, 10 * 60 * 1000);
    for (const j of recent) {
      const m = await member.guild.members.fetch(j.id).catch(() => null);
      if (m) { await saveAndStripRoles(m); m.send(`サーバーが一時的に警戒モードです。\n<#${AUTH_CHANNEL_ID}> で認証をお願いします。`).catch(() => {}); }
    }
  }

  await handleBadNickname(member);

  // ★ 新規参加時の初期スコア加算を廃止。懸念ログの通知のみ行う。
  let suspicionFlags = [];
  const age = now - member.user.createdAt.getTime();
  if (age < 1 * 24 * 60 * 60 * 1000) suspicionFlags.push('作成から1日未満の新規アカウント');
  else if (age < 7 * 24 * 60 * 60 * 1000) suspicionFlags.push('作成から7日未満のアカウント');
  if (!member.user.avatar) suspicionFlags.push('初期アイコン');

  if (suspicionFlags.length > 0) {
    await sendLogEmbed(member.guild, {
      title: 'ℹ️ 新規参加者アラート (監視対象)',
      member,
      description: `懸念事項: ${suspicionFlags.join(', ')}\n※誤検知防止のためスコア加算は行わず、監視のみ行います。`,
      color: 0x3498db,
    });
  }

  if (JOIN_LOG_CHANNEL_ID) {
    await sendPlainLog(member.guild, `👋 **参加**: ${member.user.bot ? '[BOT] ' : ''}<@${member.id}> (${member.user.tag})`);
  }
}

// ===== リアクション連打検知 =====
async function handleReactionAdd(reaction, user) {
  if (!reaction?.message?.guild) return;
  if (user.bot) return;
  const member = reaction.message.guild.members.cache.get(user.id);
  if (!member || isWhitelisted(member) || member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
  const now = Date.now();
  const last = userReactTime.get(user.id) || 0;
  if (now - last < 1000) {
    const s = addScore(user.id, currentCfg().REACT_SPAM);
    await sendLogEmbed(reaction.message.guild, {
      title: '🚧 リアクション連打',
      member,
      description: `+${currentCfg().REACT_SPAM} / 現在 ${s}/${currentCfg().THRESHOLD}`,
      channelName: reaction.message.channel?.name,
      color: 0xffa200,
    });
    await punishByScore(member, 'リアクション連打', reaction.message.channel?.name);
  }
  userReactTime.set(user.id, now);
}

// ===== 監査ログ処理 =====
async function checkAndPunishMassAction(entry) {
  const { executor, action, guild, target } = entry;
  const executorMember = guild.members.cache.get(executor.id);
  if (!executorMember || isWhitelisted(executorMember) || isInProbation(executor.id)) return false;
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
      if (executorMember.user.bot) {
        await guild.members.ban(executor.id, { reason: `ヌークBot検知: ${reason}` }).catch(() => {});
        await sendLogEmbed(guild, { title: `🚨 ヌークBot検知 → 即時BAN`, member: executorMember, description: `理由: ${reason}`, color: 0xff0000 });
      } else {
        const ok = await stripAllRoles(guild, executor.id, reason);
        await sendLogEmbed(guild, { title: `🚨 大量操作を検知・権限剥奪`, member: executorMember, description: `理由: ${reason}\n成功: ${ok}`, color: 0xff4757 });
      }
    } catch { return false; }
    return true;
  }
  return false;
}

// ================================================================
//  ★ NEW: 権限悪用対策の拡張
// ================================================================

/**
 * 招待リンクの大量生成を検知
 */
async function handleInviteCreateSpam(entry) {
  const { guild, executor, target } = entry;
  if (!executor) return;
  const member = guild.members.cache.get(executor.id);
  if (!member || isWhitelisted(member)) return;

  // ✅ 招待作成ログ（常時記録）
  const inviteCode = target?.code || '不明';
  const inviteUrl  = inviteCode !== '不明' ? `https://discord.gg/${inviteCode}` : '不明';
  const maxAge     = target?.maxAge  != null ? (target.maxAge === 0 ? '無期限' : `${target.maxAge / 60}分`) : '不明';
  const maxUses    = target?.maxUses != null ? (target.maxUses === 0 ? '無制限' : `${target.maxUses}回`) : '不明';
  const channel    = target?.channel ? `<#${target.channel.id}>` : '不明';
  await sendLogEmbed(guild, {
    title: '📨 招待リンク作成ログ',
    member,
    description: `招待リンクを作成しました
コード: \`${inviteCode}\`
URL: ${inviteUrl}
対象チャンネル: ${channel}
有効期限: ${maxAge} / 最大使用: ${maxUses}`,
    color: 0x5865f2,
  });

  // スパム検知（既存）
  const now = Date.now();
  if (!inviteCreateLog.has(executor.id)) inviteCreateLog.set(executor.id, []);
  const log = inviteCreateLog.get(executor.id);
  log.push(now);
  const recent = log.filter(t => now - t < INVITE_SPAM_WINDOW_MS);
  inviteCreateLog.set(executor.id, recent);
  if (recent.length >= INVITE_SPAM_THRESHOLD) {
    await stripAllRoles(guild, executor.id, '招待リンク大量生成');
    await sendLogEmbed(guild, {
      title: '🚨 招待リンクの大量生成を検知',
      member,
      description: `${INVITE_SPAM_WINDOW_MS/1000}秒以内に ${recent.length} 個の招待リンクを生成したため権限を剥奪しました。`,
      color: 0xff4757,
    });
    inviteCreateLog.delete(executor.id);
  }
}

/**
 * Thread（スレッド）の大量作成を検知
 */
async function handleThreadCreateSpam(entry) {
  const { guild, executor } = entry;
  if (!executor) return;
  const member = guild.members.cache.get(executor.id);
  if (!member || isWhitelisted(member)) return;
  const now = Date.now();
  if (!threadCreateLog.has(executor.id)) threadCreateLog.set(executor.id, []);
  const log = threadCreateLog.get(executor.id);
  log.push(now);
  const recent = log.filter(t => now - t < THREAD_SPAM_WINDOW_MS);
  threadCreateLog.set(executor.id, recent);
  if (recent.length >= THREAD_SPAM_THRESHOLD) {
    await stripAllRoles(guild, executor.id, 'スレッド大量作成');
    await sendLogEmbed(guild, {
      title: '🚨 Threadの大量作成を検知',
      member,
      description: `${THREAD_SPAM_WINDOW_MS/1000}秒以内に ${recent.length} 個のスレッドを作成したため権限を剥奪しました。`,
      color: 0xff4757,
    });
    threadCreateLog.delete(executor.id);
  }
}

/**
 * 絵文字/スタンプの連続変更を検知
 */
async function handleEmojiStickerAbuse(entry) {
  const { guild, executor, action } = entry;
  if (!executor) return;
  const emojiActions = new Set([
    AuditLogEvent.EmojiCreate, AuditLogEvent.EmojiDelete, AuditLogEvent.EmojiUpdate,
    AuditLogEvent.StickerCreate, AuditLogEvent.StickerDelete, AuditLogEvent.StickerUpdate,
  ]);
  if (!emojiActions.has(action)) return;
  const member = guild.members.cache.get(executor.id);
  if (!member || isWhitelisted(member)) return;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
  const now = Date.now();
  if (!emojiAbuseLog.has(executor.id)) emojiAbuseLog.set(executor.id, []);
  const log = emojiAbuseLog.get(executor.id);
  log.push({ action, timestamp: now });
  const recent = log.filter(e => now - e.timestamp < EMOJI_ABUSE_WINDOW_MS);
  emojiAbuseLog.set(executor.id, recent);
  if (recent.length >= EMOJI_ABUSE_THRESHOLD) {
    await stripAllRoles(guild, executor.id, '絵文字/スタンプの連続変更');
    await sendLogEmbed(guild, {
      title: '🚨 絵文字/スタンプの連続変更を検知',
      member,
      description: `${EMOJI_ABUSE_WINDOW_MS/1000}秒以内に ${recent.length} 回の絵文字/スタンプ変更を検出したため権限を剥奪しました。`,
      color: 0xff4757,
    });
    emojiAbuseLog.delete(executor.id);
  }
}

/**
 * チャンネル設定変更の連打を検知（★ 改良点：安全な変更を除外）
 */
async function handleChannelSettingAbuse(entry) {
  const { guild, executor, action, changes } = entry;
  if (!executor || action !== AuditLogEvent.ChannelUpdate) return;
  
  // 安全な変更(トピックやNSFW設定等)は無視して、危険な変更のみ対象にする
  const isDangerousChange = changes && changes.some(c => ['permission_overwrites', 'name', 'type'].includes(c.key));
  if (!isDangerousChange) return;

  const member = guild.members.cache.get(executor.id);
  if (!member || isWhitelisted(member) || member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

  const now = Date.now();
  if (!channelSettingLog.has(executor.id)) channelSettingLog.set(executor.id, []);
  const log = channelSettingLog.get(executor.id);
  log.push(now);
  const recent = log.filter(t => now - t < CHANNEL_SETTING_ABUSE_WINDOW_MS);
  channelSettingLog.set(executor.id, recent);

  if (recent.length >= CHANNEL_SETTING_ABUSE_THRESHOLD) {
    await stripAllRoles(guild, executor.id, 'チャンネル設定の連続変更(権限/名前)');
    await sendLogEmbed(guild, {
      title: '🚨 危険なチャンネル設定変更の連打を検知',
      member,
      description: `${CHANNEL_SETTING_ABUSE_WINDOW_MS/1000}秒以内に ${recent.length} 回のチャンネル設定（権限・名前等）の変更を検出したため権限を剥奪しました。`,
      color: 0xff4757,
    });
    channelSettingLog.delete(executor.id);
  }
}

// ================================================================
//  監査ログエントリーハンドラ
// ================================================================
async function handleAuditLogEntry(entry) {
  const { guild, executor, action, target } = entry;
  if (!guild || !executor) return;
  const member = guild.members.cache.get(executor.id);
  if (!member || isWhitelisted(member)) return;

  // 招待リンク大量生成
  if (action === AuditLogEvent.InviteCreate) {
    await handleInviteCreateSpam(entry);
    return;
  }

  // Thread大量作成
  if (action === AuditLogEvent.ThreadCreate) {
    await handleThreadCreateSpam(entry);
    return;
  }

  // 絵文字/スタンプ変更連打
  const emojiActions = new Set([
    AuditLogEvent.EmojiCreate, AuditLogEvent.EmojiDelete, AuditLogEvent.EmojiUpdate,
    AuditLogEvent.StickerCreate, AuditLogEvent.StickerDelete, AuditLogEvent.StickerUpdate,
  ]);
  if (emojiActions.has(action)) {
    await handleEmojiStickerAbuse(entry);
    return;
  }

  // チャンネル設定変更連打
  if (action === AuditLogEvent.ChannelUpdate) {
    await handleChannelSettingAbuse(entry);
  }

  // Webhook作成スパム
  if (action === AuditLogEvent.WebhookCreate) {
    const now = Date.now();
    if (!webhookCreateLog.has(executor.id)) webhookCreateLog.set(executor.id, []);
    const logs = webhookCreateLog.get(executor.id);
    logs.push(now);
    const recent = logs.filter(t => now - t < 60000);
    webhookCreateLog.set(executor.id, recent);
    if (recent.length >= 2) {
      await stripAllRoles(guild, executor.id, 'Webhook大量作成スパム');
      await sendLogEmbed(guild, { title: '🚨 Webhookスパム検知', member, description: `1分間に ${recent.length} 個のWebhookを作成したため権限を剥奪しました。`, color: 0xff4757 });
      try {
        const webhooks = await guild.fetchWebhooks();
        const targetWebhook = webhooks.find(w => w.id === target?.id);
        if (targetWebhook) await targetWebhook.delete('荒らし対策: 自動削除');
      } catch {}
      return;
    }
  }

  if (action === AuditLogEvent.MemberBanAdd || action === AuditLogEvent.ChannelDelete || action === AuditLogEvent.RoleDelete) {
    const punished = await checkAndPunishMassAction(entry);
    if (punished) return;
  }

  if (DANGER_ACTIONS.has(action) && !member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    if (pendingModActions.has(executor.id)) {
      const p = pendingModActions.get(executor.id);
      p.reasonAttempts++;
      try { await executor.send(`⚠️ 理由確認の再送（残り ${Math.max(0, 3 - p.reasonAttempts)} 回）`); } catch {}
      return;
    }
    try {
      await saveAndStripRoles(member);
      const actionText = `アクション: ${AuditLogEvent[action]} / 対象: ${target?.tag || target?.name || target?.id}`;
      await executor.send(`サーバーで重要な操作を行いました。\n${actionText}\nこのDMに **3分以内** に理由を返信してください。未回答なら権限剥奪を継続します。`).catch(() => {});
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

// ===== ゴーストピン（Mention & Delete）検知 =====
async function handleMessageDelete(message) {
  if (!message || !message.guild || !message.author) return;
  const content = message.content || '';
  const hasMassMention = content.includes('@everyone') || content.includes('@here') || (message.mentions?.users.size >= 3);
  if (hasMassMention) {
    const member = message.guild.members.cache.get(message.author.id);
    if (isWhitelisted(member)) return;
    const s = addScore(message.author.id, GHOST_PING_SCORE);
    await sendLogEmbed(message.guild, {
      title: '👻 ゴーストピン検知',
      member,
      description: `メンション付きメッセージを削除しました。\n加算スコア: +${GHOST_PING_SCORE} / 現在 ${s}`,
      color: 0xff4757,
      content,
    });
    await punishByScore(member, 'ゴーストピン', message.channel?.name);
  }
}

// ===== その他のイベントハンドラ =====
async function handleMessageUpdate(oldMessage, newMessage) {
  if (!newMessage || newMessage.author?.bot) return;
  if (oldMessage?.content === newMessage?.content) return;
  return handleMessage(newMessage);
}

async function handleBotAdd(member) {
  if (!member?.user?.bot) return false;
  const isVerified = !!member.user.flags?.has?.('VerifiedBot');
  if (!isVerified) {
    try {
      const logs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 1 });
      const entry = logs.entries.first();
      const executor = entry?.executor;
      await member.guild.members.ban(member.id, { reason: 'ヌーク対策: 未認証Botの自動BAN' }).catch(async () => {
        await member.kick('ヌーク対策: 未認証Bot').catch(() => {});
      });
      await sendLogEmbed(member.guild, {
        title: '🚨 未認証Bot → 即時BAN',
        member,
        description: `招待者: ${executor?.tag || '不明'}\n未認証のBotをBANしました。正規のBotを追加する場合は管理者が手動でホワイトリストに追加してください。`,
        color: 0xff0000,
      });
      return true;
    } catch {}
  }
  return false;
}

// 危険権限配布の連鎖停止
async function handleRoleUpdate(oldRole, newRole) {
  const before = oldRole.permissions;
  const after = newRole.permissions;
  const added = DANGEROUS_PERMISSIONS.filter(p => after.has(p) && !before.has(p));
  if (added.length === 0) return;
  try {
    const logs = await oldRole.guild.fetchAuditLogs({ type: AuditLogEvent.RoleUpdate, limit: 3 });
    const entry = logs.entries.find(e => e.target?.id === oldRole.id);
    const executor = entry?.executor;
    if (!executor) return;
    const member = oldRole.guild.members.cache.get(executor.id);
    if (!member || isWhitelisted(member)) return;
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      const now = Date.now();
      if (!dangerRoleDistLog.has(executor.id)) dangerRoleDistLog.set(executor.id, []);
      const dists = dangerRoleDistLog.get(executor.id);
      dists.push(now);
      const recent = dists.filter(t => now - t < 60000);
      dangerRoleDistLog.set(executor.id, recent);
      if (recent.length >= 2) {
        await stripAllRoles(oldRole.guild, executor.id, '危険権限の連鎖配布');
        await sendLogEmbed(oldRole.guild, {
          title: '🚨 危険権限配布の連鎖を検知',
          member,
          description: `管理者権限を持たないユーザーが短時間に複数回危険権限を付与したため、全ロールを剥奪しました。`,
          color: 0xff4757,
        });
        await newRole.setPermissions(before, '連鎖停止による差し戻し').catch(() => {});
        return;
      }
    }
    const isEveryone = oldRole.id === oldRole.guild.id;
    const addedNames = added.map(p => {
      const key = Object.keys(PermissionsBitField.Flags).find(k => PermissionsBitField.Flags[k] === p);
      return key || String(p);
    });
    if (isEveryone || member.user.bot) {
      await newRole.setPermissions(before, 'セキュリティ: 危険権限の付与を差し戻し').catch(() => {});
      if (member.user.bot) {
        await oldRole.guild.members.ban(executor.id, { reason: `ヌークBot: ロールへの危険権限付与` }).catch(() => {});
        await sendLogEmbed(oldRole.guild, { title: `🚨 ヌークBot: ロール危険権限付与 → 即BAN`, member, description: `付与された権限: ${addedNames.join(', ')}`, color: 0xff0000 });
      } else {
        const ok = await stripAllRoles(oldRole.guild, executor.id, `ロール「${oldRole.name}」に危険権限を付与`);
        await sendLogEmbed(oldRole.guild, { title: `⚠️ ロール「${oldRole.name}」に危険権限付与 → 権限剥奪`, member, description: `付与された権限: ${addedNames.join(', ')}\n実行者権限剥奪: ${ok}`, color: 0xff4757 });
      }
    }
  } catch {}
}

async function onGuildMemberUpdate(oldMember, newMember) {
  if (newMember.user.bot || isWhitelisted(newMember)) return;
  const beforePerms = oldMember.permissions?.bitfield ?? 0n;
  const afterPerms = newMember.permissions?.bitfield ?? 0n;
  if (!hasDangerousPerms(beforePerms) && hasDangerousPerms(afterPerms)) {
    const executor = await findExecutorForTarget(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id);
    if (executor && !isWhitelisted(executor) && !isInProbation(executor.id)) {
      const newScore = addScore(executor.id, currentCfg().AUDIT_ABUSE);
      await sendLogEmbed(newMember.guild, {
        title: '⚠️ 危険権限付与を検知',
        member: newMember,
        description: `実行者: <@${executor.id}> が危険権限を付与しました。\n現在スコア: ${newScore}/${currentCfg().THRESHOLD}`,
        color: 0xffa200,
      });
      await punishByScore(executor, '不審な権限付与', newMember.guild.channels.cache.random()?.name);
    }
  }
}

async function onGuildBanAdd(ban) {
  const { guild, user } = ban;
  setTimeout(async () => {
    const executor = await findExecutorForTarget(guild, AuditLogEvent.MemberBanAdd, user.id);
    if (!executor) return;
    const now = Date.now();
    if (!nukeBanLog.has(executor.id)) nukeBanLog.set(executor.id, []);
    const banArr = nukeBanLog.get(executor.id);
    banArr.push(now);
    const recentBans = banArr.filter(t => now - t < NUKE_DETECT_WINDOW_MS);
    nukeBanLog.set(executor.id, recentBans);
    const executorMember = guild.members.cache.get(executor.id);
    if (!isWhitelisted(executorMember) && recentBans.length >= MASS_BAN_NUKE_THRESHOLD) {
      await guild.members.ban(executor.id, { reason: `ヌーク対策: ${NUKE_DETECT_WINDOW_MS/1000}秒以内に${recentBans.length}件の大量BAN` }).catch(() => {});
      await sendLogEmbed(guild, {
        title: '🚨 大量BAN → 実行者を即時BAN',
        description: `実行者 <@${executor.id}> が ${NUKE_DETECT_WINDOW_MS/1000}秒以内に ${recentBans.length} 件のBANを実行。即BANしました。`,
        color: 0xff0000,
      });
      return;
    }
    if (isWhitelisted(executor) || isInProbation(executor.id) || recordAndCheckMassAction(executor.id, user.id, 'BAN')) {
      try { await guild.members.unban(user.id, '荒らし検知: 誤BAN救済'); } catch {}
      const ok = await stripAllRoles(guild, executor.id, '荒らし検知: クールダウン中の処罰 or 大量処罰');
      await sendLogEmbed(guild, { title: '🚨 不審なBAN検知', description: `実行者 <@${executor.id}> を権限剥奪（成功:${ok}）。\n対象: **${user.tag}** はBAN解除しました。` });
      try {
        const url = await createOneTimeInvite(guild);
        const dm = await user.createDM();
        await dm.send(`すみません。サーバー側で不正なBANを検知し、解除しました。\n${url ? `再参加用の招待リンク: ${url}` : `再参加招待の作成に失敗しました。管理者へご連絡ください。`}`);
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
        await dm.send(`すみません。サーバー側で不正なKickを検知しました。\n${url ? `再参加用の招待リンク: ${url}` : `再参加招待の作成に失敗しました。管理者へご連絡ください。`}`);
      } catch {}
    }
  }, 1500);
}

async function findExecutorForTarget(guild, actionType, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ type: actionType, limit: 5 });
    const entry = logs.entries.find(e => e.target?.id === targetId);
    return entry?.executor;
  } catch { return null; }
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

// ===== 手動承認フロー: DM理由受付 =====
async function handleDirectMessage(message) {
  if (!message?.author || message.author.bot) return;
  const pending = pendingModActions.get(message.author.id);
  if (!pending) return;
  const reason = message.content?.trim();
  if (!reason || reason.length < 5) {
    try { await message.reply('理由が短すぎます。もう少し詳しく説明してください。'); } catch {}
    return;
  }
  const guild = pending.entry.guild;
  const logChannel = await getOrCreateLogChannel(guild);
  if (!logChannel) return;
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('🛡️ 権限復元リクエスト')
    .setDescription(`ユーザーが権限剥奪に対する理由を送信しました。`)
    .addFields(
      { name: 'ユーザー', value: `<@${message.author.id}> (${message.author.tag})`, inline: true },
      { name: '実行した操作', value: `\`${AuditLogEvent[pending.entry.action]}\``, inline: true },
      { name: '提出された理由', value: `\`\`\`\n${reason}\n\`\`\``, inline: false }
    )
    .setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`approve_raid_${message.author.id}`).setLabel('承認 (Approve)').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`reject_raid_${message.author.id}`).setLabel('拒否 (Reject)').setStyle(ButtonStyle.Danger)
  );
  await logChannel.send({ content: `<@${ADMIN_APPROVER_ID}> 承認してください。`, embeds: [embed], components: [row] }).catch(() => {});
  await message.reply('✅ 理由を送信しました。管理者の承認をお待ちください。');
}

// ===== 手動承認フロー: インタラクション処理 =====
async function handleInteraction(interaction) {
  if (!interaction.isButton()) return;
  const customId = interaction.customId;
  if (!customId.startsWith('approve_raid_') && !customId.startsWith('reject_raid_')) return;
  if (interaction.user.id !== ADMIN_APPROVER_ID) {
    return interaction.reply({ content: '❌ この操作を行う権限がありません。', ephemeral: true });
  }
  const [action, , userId] = customId.split('_');
  const guild = interaction.guild;
  const member = guild.members.cache.get(userId);
  if (action === 'approve') {
    if (member) {
      await restoreRoles(member);
      await member.send('✅ 管理者によって承認されました。権限を復元しました。').catch(() => {});
    }
    await interaction.update({
      content: `✅ <@${userId}> のリクエストを**承認**しました。`,
      components: [],
      embeds: [interaction.message.embeds[0].setColor(0x00ff00).setTitle('🛡️ 権限復元リクエスト [承認済み]')],
    });
    await sendLogEmbed(guild, { title: '✅ 理由確認完了・権限復元', member, description: `管理者 <@${interaction.user.id}> が承認しました。`, color: 0x00ff00 });
  } else {
    if (member) {
      await member.send('❌ 管理者によってリクエストが拒否されました。権限剥奪状態を維持します。').catch(() => {});
    }
    await interaction.update({
      content: `❌ <@${userId}> のリクエストを**拒否**しました。`,
      components: [],
      embeds: [interaction.message.embeds[0].setColor(0xff0000).setTitle('🛡️ 権限復元リクエスト [拒否済み]')],
    });
    await sendLogEmbed(guild, { title: '❌ 理由不適切による権限剥奪継続', member, description: `管理者 <@${interaction.user.id}> が拒否しました。`, color: 0xff0000 });
  }
  pendingModActions.delete(userId);
}

async function handleGuildUpdate(oldGuild, newGuild) {
  const changes = [];
  if (oldGuild.name !== newGuild.name) changes.push(`名前: 「${oldGuild.name}」→「${newGuild.name}」`);
  if (oldGuild.icon !== newGuild.icon) changes.push('アイコンが変更されました');
  if (oldGuild.verificationLevel !== newGuild.verificationLevel) changes.push(`認証レベル: ${oldGuild.verificationLevel} → ${newGuild.verificationLevel}`);
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

// ===== ヌークBot対策: チャンネル削除検知 =====
async function handleChannelDelete(channel) {
  if (!channel.guild) return;
  try {
    const logs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 1 });
    const entry = logs.entries.first();
    const executor = entry?.executor;
    if (!executor) return;
    const member = channel.guild.members.cache.get(executor.id);
    if (member && isWhitelisted(member)) return;
    const now = Date.now();
    if (!channelDeleteLog.has(executor.id)) channelDeleteLog.set(executor.id, []);
    const arr = channelDeleteLog.get(executor.id);
    arr.push(now);
    const recent = arr.filter(t => now - t < NUKE_DETECT_WINDOW_MS);
    channelDeleteLog.set(executor.id, recent);
    if (recent.length >= CHANNEL_DELETE_NUKE_THRESHOLD) {
      await channel.guild.members.ban(executor.id, {
        reason: `ヌーク対策: ${NUKE_DETECT_WINDOW_MS/1000}秒以内に${recent.length}個のチャンネルを削除`,
      }).catch(() => {});
      await sendLogEmbed(channel.guild, {
        title: '🚨 大量チャンネル削除 → 即時BAN',
        member,
        description: `${NUKE_DETECT_WINDOW_MS/1000}秒以内に ${recent.length} 個のチャンネルを削除\n実行者を即時BANしました。`,
        color: 0xff0000,
      });
    }
  } catch {}
}

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
    const recent = arr.filter(t => now - t < NUKE_DETECT_WINDOW_MS);
    channelCreateLog.set(executor.id, recent);
    if (recent.length >= CHANNEL_CREATE_NUKE_THRESHOLD) {
      await channel.delete('荒らし対策: 大量チャンネル作成').catch(() => {});
      if (member.user.bot) {
        await channel.guild.members.ban(executor.id, { reason: `ヌークBot: ${NUKE_DETECT_WINDOW_MS/1000}秒以内に${recent.length}個チャンネル作成` }).catch(() => {});
        await sendLogEmbed(channel.guild, { title: '🚨 ヌークBot: 大量チャンネル作成 → 即時BAN', member, description: `${NUKE_DETECT_WINDOW_MS/1000}秒以内に ${recent.length} 個作成`, color: 0xff0000 });
      } else {
        const ok = await stripAllRoles(channel.guild, executor.id, '大量チャンネル作成');
        await sendLogEmbed(channel.guild, { title: '🚨 大量チャンネル作成 → 権限剥奪', member, description: `${NUKE_DETECT_WINDOW_MS/1000}秒以内に ${recent.length} 個作成\n権限剥奪: ${ok}` });
      }
    }
  } catch {}
}

async function handleChannelUpdate(oldChannel, newChannel) {
  if (!newChannel.guild) return;
  const changes = [];
  if (oldChannel.name !== newChannel.name) changes.push(`名前: 「${oldChannel.name}」→「${newChannel.name}」`);
  if (changes.length === 0) return;
  try {
    const logs = await newChannel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelUpdate, limit: 1 });
    const entry = logs.entries.first();
    const executor = entry?.executor;
    const member = executor ? newChannel.guild.members.cache.get(executor.id) : null;
    await sendLogEmbed(newChannel.guild, { title: `📋 チャンネル変更: #${newChannel.name}`, member, description: changes.join('\n'), color: 0x3498db });
  } catch {}
}

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
    const recent = arr.filter(t => now - t < NUKE_DETECT_WINDOW_MS);
    roleDeleteLog.set(executor.id, recent);
    if (recent.length >= ROLE_DELETE_NUKE_THRESHOLD) {
      if (member.user.bot) {
        await role.guild.members.ban(executor.id, { reason: `ヌークBot: ${NUKE_DETECT_WINDOW_MS/1000}秒以内に${recent.length}個ロール削除` }).catch(() => {});
        await sendLogEmbed(role.guild, { title: '🚨 ヌークBot: 大量ロール削除 → 即時BAN', member, description: `${NUKE_DETECT_WINDOW_MS/1000}秒以内に ${recent.length} 個削除`, color: 0xff0000 });
      } else {
        const ok = await stripAllRoles(role.guild, executor.id, '大量ロール削除');
        await sendLogEmbed(role.guild, { title: '🚨 大量ロール削除 → 権限剥奪', member, description: `${NUKE_DETECT_WINDOW_MS/1000}秒以内に ${recent.length} 個削除\n権限剥奪: ${ok}` });
      }
    }
  } catch {}
}

function cleanupSimilarityTracker(guildTracker, expiryMs) {
  const now = Date.now();
  for (const [hash, data] of guildTracker.entries()) {
    if (data && data.firstSeen && now - data.firstSeen > expiryMs) guildTracker.delete(hash);
  }
}

// ================================================================
//  定期クリーンアップ
// ================================================================
setInterval(() => {
  const now = Date.now();
  for (const [cmd, tracker] of commandAttackTracker) {
    tracker.timestamps = tracker.timestamps.filter(ts => now - ts < COMMAND_ATTACK_WINDOW_MS);
    if (tracker.timestamps.length === 0) commandAttackTracker.delete(cmd);
  }
  for (const [guildId, tracker] of similarityTracker) cleanupSimilarityTracker(tracker, SIMILARITY_HASH_EXPIRY_MS);
  for (const [userId, history] of adminActionHistory) {
    const filtered = history.filter(h => now - h.timestamp < 7 * 24 * 60 * 60 * 1000);
    if (filtered.length === 0) adminActionHistory.delete(userId);
    else adminActionHistory.set(userId, filtered);
  }
  // anomalyLog の古いエントリをクリーンアップ
  for (const [userId, log] of anomalyLog) {
    const recent = log.filter(e => now - e.timestamp < CONFIRMED_RAID_WINDOW_MS * 10);
    if (recent.length === 0) anomalyLog.delete(userId);
    else anomalyLog.set(userId, recent);
  }
  // 参加時刻マップのクリーンアップ
  for (const [userId, joinTime] of userJoinTimeMap) {
    if (now - joinTime > 24 * 60 * 60 * 1000) userJoinTimeMap.delete(userId);
  }
  // Webhookログのクリーンアップ追加
  for (const [webhookId, log] of webhookFloodLog) {
    const recent = log.filter(t => now - t < 10000);
    if (recent.length === 0) webhookFloodLog.delete(webhookId);
    else webhookFloodLog.set(webhookId, recent);
  }
}, CLEANUP_INTERVAL_MS);

// ================================================================
//  エクスポート
// ================================================================
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
  handleInteraction,
  handleMessageDelete,
  handleChannelDelete,
  handleBotSpam,
  handleWebhookSpam, // NEW エクスポート
  pendingModActions,
  restoreRoles,
  hasManageGuildPermission,
  backupServerState,
  restoreServerState,
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
  handleMassMention,
  handleDangerousFiles,
  handleBadNickname,
  deleteRecentMessages,

  logAnomaly,
  executeConfirmedPunishment,
  checkTrustViolation,
  classifyChannel,
  containsJapanese,
  isNewUser,
  handleInviteCreateSpam,
  handleThreadCreateSpam,
  handleEmojiStickerAbuse,
  handleChannelSettingAbuse,
  confirmedRaidUsers,
  anomalyLog,
};
