// utils/anti-raid.js
const fs = require('fs');
const path = require('path');
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
    ({
      chat
    } = require('./ai'));
  } catch {}
}

// ===== 設定 =====
const LOG_CHANNEL_ID = process.env.ANTI_RAID_LOG_CHANNEL_ID || '1425643752982319227';
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

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, {
  recursive: true
});

let scores = {};
let markedUsersStore = {};
let serverBackup = {};

function saveScores() {
  try {
    fs.writeFileSync(SCORE_PATH, JSON.stringify(scores, null, 2));
  } catch {}
}

function saveMarks() {
  try {
    fs.writeFileSync(MARK_PATH, JSON.stringify(markedUsersStore, null, 2));
  } catch {}
}

function saveBackup() {
  try {
    fs.writeFileSync(BACKUP_PATH, JSON.stringify(serverBackup, null, 2));
  } catch {}
}

// 起動時にデータ読み込み
try {
  scores = JSON.parse(fs.readFileSync(SCORE_PATH, 'utf8'));
} catch {}
try {
  markedUsersStore = JSON.parse(fs.readFileSync(MARK_PATH, 'utf8'));
} catch {}
try {
  serverBackup = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
} catch {}

// ===== 閾値（昼/夜で可変）=====
const NIGHT_START_HOUR = 35; // 意図的に無効化
const NIGHT_END_HOUR = 35; // 意図的に無効化

const cfg = {
  // ★ 修正: 閾値とスコアを大幅に緩和し、誤検知を減らす調整
  day: {
    THRESHOLD: 30,      // タイムアウトの閾値を10→30に引き上げ
    MASS_JOIN: 5,       // 大量参加: 10→5
    KEYWORD: 15,        // NGワード: 10→15（一発アウト回避）
    SIMILAR: 8,         // 類似メッセージ: 10→8
    CMD_ABUSE: 5,       // コマンド乱用: 10→5
    REACT_SPAM: 5,      // リアクションスパム: 10→5
    NEWLINES: 10,       // 過度な改行: 20→10
    ZALGO: 10,          // Zalgo文字: 20→10
    MASS_SPAM: 7,       // メッセージ連投: 7のまま（閾値30に対しては妥当）
    WEBHOOK: 20,        // Webhook作成: 25→20
    AUDIT_ABUSE: 15,    // 監査ログ悪用: 10→15
    ACCOUNT_AGE: 10,    // 新規アカウント: 15→10（一発アウト回避）
  },
  night: { // 夜間も昼間と同じ設定に緩和。必要であれば個別に調整してください。
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

// ★ 修正: 連投検知の閾値を現実的な値に修正・緩和
const MASS_SPAM_THRESHOLD = 4; // 3→4回に緩和 (5秒間に4回)
const MASS_SPAM_WINDOW = 5 * 1000; // 180ms(バグ)→5秒に修正

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

// 【追加】普通の会話を除外するフィルター
const COMMON_WORDS = new Set([
  'おはよう', 'こんにちは', 'こんばんは', 'お疲れ様', 'ありがとう', 'おやすみ',
  'よろしく', 'はい', 'いいえ', 'そうですね', 'わかりました', 'すみません',
  'hello', 'hi', 'thanks', 'thank you', 'yes', 'no', 'ok', 'okay',
  'good morning', 'good night', 'welcome', 'sorry', 'please'
]);

const RAID_KEYWORDS = [
  'raid by',
  'on top',
  '.ozeu',
  '.gg/oze',
  '.gg/dpko',
  'ますまにの顔',
  'ますまに顔',
  '#mute',
  'molmol',
  '.gg/mol'
];

// ===== 招待リンクスパム対策 =====
// discord.gg/ を含む怪しい招待リンク（ホワイトリストの既知リンクを除く）
const ALLOWED_INVITE_LINKS = [
  'discord.gg/9ScuqvxzD7', // ますまに共栄圏公式
];
const INVITE_REGEX = /discord(?:app)?\.(?:gg|com\/invite)\/([A-Za-z0-9-]+)/gi;

// ===== メンションスパム対策 =====
const MENTION_SPAM_THRESHOLD = 5; // 1メッセージ中のメンション数上限

const DANGEROUS_PERMISSIONS = [
  PermissionsBitField.Flags.Administrator, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.KickMembers, PermissionsBitField.Flags.BanMembers, PermissionsBitField.Flags.ManageGuild,
];
const DANGEROUS_PERMS_BITFIELD = new PermissionsBitField().add(...DANGEROUS_PERMISSIONS);

const DANGER_ACTIONS = new Set([
  AuditLogEvent.MemberKick, AuditLogEvent.MemberBanAdd, AuditLogEvent.ChannelCreate, AuditLogEvent.ChannelDelete,
  AuditLogEvent.ChannelUpdate, AuditLogEvent.RoleCreate, AuditLogEvent.RoleDelete, AuditLogEvent.RoleUpdate,
]);

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

function addScore(userId, amount) {
  scores[userId] = (scores[userId] || 0) + amount;
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

// ★ 新機能: 文字列類似度計算（簡単なレーベンシュタイン距離ベース）
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

// 普通の会話パターンを除外する関数
function isCommonConversation(content) {
  const normalized = content.toLowerCase().trim();

  // 短すぎるメッセージ（挨拶など）
  if (normalized.length < 5) return true;

  // 一般的な単語のみで構成
  const words = normalized.split(/\s+/);
  if (words.length <= 3 && words.every(word => COMMON_WORDS.has(word))) return true;

  // 感嘆符や疑問符のみ
  if (/^[!？?！。.]+$/.test(normalized)) return true;

  // 数字のみ、記号のみ
  if (/^[\d\s]+$/.test(normalized) || /^[^\w\s]+$/.test(normalized)) return true;

  return false;
}

// URL、メンション、絵文字を除外する正規化関数
function normalizeMessage(content) {
  return content
    .toLowerCase()
    // URLを除去
    .replace(/https?:\/\/[^\s]+/g, '')
    // メンションを除去
    .replace(/<@[!&]?\d+>/g, '')
    // チャンネルメンションを除去
    .replace(/<#\d+>/g, '')
    // カスタム絵文字を除去
    .replace(/<a?:\w+:\d+>/g, '')
    // Unicode絵文字を除去（基本的なもの）
    .replace(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]/gu, '')
    // 連続する空白を1つに
    .replace(/\s+/g, ' ')
    // 句読点を除去
    .replace(/[^\w\s]/g, '')
    .trim();
}

// 【新規追加】ハッシュトラッカーのクリーンアップ関数
function cleanupSimilarityTracker(guildTracker, expiryMs) {
  const now = Date.now();
  let cleanedCount = 0;

  // Mapに保存されているメッセージハッシュを全てチェック
  for (const hash of guildTracker.keys()) {
    const data = guildTracker.get(hash);

    // 最初の投稿時刻(firstSeen)から有効期限を過ぎているか判定
    if (data && data.firstSeen && now - data.firstSeen > expiryMs) {
      guildTracker.delete(hash);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    console.log(`[Anti-Raid Cleanup] Cleared ${cleanedCount} expired similarity hashes. (Total Guild Hashes: ${guildTracker.size})`);
  }
}


async function getOrCreateLogChannel(guild, channelId = LOG_CHANNEL_ID) {
  if (!guild) return null;
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
      ...(member ? [{
        name: 'ユーザー',
        value: `${member.user?.tag || 'unknown'} (${member.id})`,
        inline: false
      }] : []),
      ...fields,
      ...(content ? [{
        name: '問題となったメッセージ',
        value: `\`\`\`\n${snippet(content, 1000)}\n\`\`\``,
        inline: false
      }] : []),
    )
    .setTimestamp();

  if (channelName && channelName.length > 0) {
    embed.setFooter({
      text: `チャンネル: #${channelName}`
    });
  }

  ch.send({
    embeds: [embed]
  }).catch(() => {});
}

async function sendPlainLog(guild, channelId, content) {
  try {
    const ch = guild.channels.cache.get(channelId) || guild.systemChannel || guild.channels.cache.find(c => c.type === ChannelType.GuildText);
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
    const channel =
      guild.systemChannel ||
      guild.channels.cache.find(c =>
        c.type === ChannelType.GuildText &&
        c.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.CreateInstantInvite)
      );
    if (!channel) return null;
    const invite = await channel.createInvite({
      maxAge: 30 * 60,
      maxUses: 1,
      unique: true,
      reason: '救済用自動招待リンク',
    }).catch(() => null);
    return invite?.url || null;
  } catch (e) {
    console.error('[anti-raid] createOneTimeInvite error:', e);
    return null;
  }
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
      roles: guild.roles.cache.map(r => ({
        id: r.id,
        permissions: r.permissions.bitfield
      })),
      channels: guild.channels.cache.map(c => ({
        id: c.id,
        type: c.type,
        name: c.name
      })),
    };
    serverBackup[guild.id] = data;
    saveBackup();
  } catch (e) {
    console.error('[anti-raid] backupServerState error:', e);
  }
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
      if (channel && channel.name !== c.name) {
        await channel.setName(c.name, 'バックアップ復元');
      }
    }
    await sendPlainLog(guild, LOG_CHANNEL_ID, '✅ サーバーをバックアップ状態に復元しました。');
  } catch (e) {
    console.error('[anti-raid] restoreServerState error:', e);
  }
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
      await sendLogEmbed(member.guild, {
        title: '⚠️ 荒らし疑い（Mute）',
        member,
        description: `理由: ${reason}\nスコア: ${score}/${c.THRESHOLD}`,
        channelName,
        color: 0xffa200,
      });
      return;
    }
  }

  if (score >= c.THRESHOLD) {
    try {
      await member.timeout(TIMEOUT_MS, reason);
      await sendLogEmbed(member.guild, {
        title: '🚨 Timeout 適用',
        member,
        description: `理由: ${reason}\nスコア: ${score}（閾値 ${c.THRESHOLD} 到達）\nTimeout: ${Math.floor(TIMEOUT_MS / 60000)}分`,
        channelName,
      });
      setScore(member.id, Math.floor(c.THRESHOLD * 0.5));
      markUser(member.id);
    } catch {
      await saveAndStripRoles(member).catch(() => {});
      await sendLogEmbed(member.guild, {
        title: '🚨 権限剥奪（代替）',
        member,
        description: `Timeout に失敗したためロール剥奪。\n理由: ${reason}\nスコア: ${score}`,
        channelName,
      });
      markUser(member.id);
    }
  }
}

// ====== AI 補助（任意）=====
const AI_ANTI_RAID_PROMPT = `
- 以下の行為のみ「不審」と判定:

1. サーバー破壊（権限乱用/チャンネル大量作成/ロール削除など）
1. Raid 予告や勧誘、荒らし用リンク（https 無しでも .gg を含むなど）
1. 不適切画像の乱用
1. メッセージの大量連投

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
      // ★ 修正: AI判定のスコアを15→10に引き下げ、即タイムアウトを防止
      const added = addScore(member.id, 10);
      await sendLogEmbed(message.guild, {
        title: '🤖 AI 不審判定',
        member,
        description: `理由: ${reason}\n付与: +10\n現在: ${added}/${currentCfg().THRESHOLD}`,
        channelName: message.channel?.name,
        color: 0x6c5ce7,
        content: message.content,
      });
      await punishByScore(member, reason, message.channel?.name);
    }
  } catch {}
}

// ====== Join 監視 ======
async function handleMemberJoin(member) {
  if (!member || member.user.bot) return;
  if (isWhitelisted(member)) return;

  const now = Date.now();
  const gid = member.guild.id;
  if (!memberJoinLog.has(gid)) memberJoinLog.set(gid, []);
  const arr = memberJoinLog.get(gid);
  arr.push({
    id: member.id,
    timestamp: now
  });
  const recent = arr.filter(j => now - j.timestamp < RAID_TIME_WINDOW);
  memberJoinLog.set(gid, recent);

  const c = currentCfg();

  if (recent.length >= RAID_MEMBER_THRESHOLD) {
    await sendLogEmbed(member.guild, {
      title: '🚨 Raid 警告（大量参加）',
      member,
      description: `過去1分で ${recent.length} 人が参加`,
      color: 0xff4757,
    });
    for (const j of recent) {
      const m = await member.guild.members.fetch(j.id).catch(() => null);
      if (!m) continue;
      await saveAndStripRoles(m).catch(() => {});
      m.send(`サーバーが一時的に警戒モードです。\n<#${AUTH_CHANNEL_ID}> で認証をお願いします。`).catch(() => {});
      addScore(m.id, c.MASS_JOIN);
    }
  }

  const age = now - member.user.createdAt.getTime();
  if (age < 7 * 24 * 60 * 60 * 1000) {
    // 7日未満のアカウント。1日未満はスコア増加
    const ageBonus = age < 24 * 60 * 60 * 1000 ? c.ACCOUNT_AGE : Math.floor(c.ACCOUNT_AGE * 0.5);
    const newScore = addScore(member.id, ageBonus);
    await sendLogEmbed(member.guild, {
      title: '⚠️ 新規アカウント参加',
      member,
      description: `年齢 ${Math.floor(age / 3600000)}h → +${ageBonus}\n現在: ${newScore}/${c.THRESHOLD}`,
      color: 0xffa200,
    });
    await punishByScore(member, '新規アカウント', 'system');
  }

  if (JOIN_LOG_CHANNEL_ID) {
    await sendPlainLog(member.guild, JOIN_LOG_CHANNEL_ID,
      `👋 **参加**: ${member.user.bot ? '[BOT] ' : ''}<@${member.id}> (${member.user.tag})`);
  }
}

// 改善された類似メッセージ検知システム（複数ユーザー）
async function handleSimilarityDetection(message) {
  const {
    member,
    guild,
    content,
    channel
  } = message;
  const uid = member.id;
  const gid = guild.id;

  const normalized = normalizeMessage(content);

  // 普通の会話や短いメッセージはスキップ
  if (normalized.length < SIMILAR_MESSAGE_LENGTH || isCommonConversation(content)) {
    return;
  }

  if (!similarityTracker.has(gid)) {
    similarityTracker.set(gid, new Map());
  }

  const guildTracker = similarityTracker.get(gid);
  let similarMessageFound = false;
  let matchingHash = null;

  // 既存のメッセージと類似度をチェック
  for (const [hash, data] of guildTracker.entries()) {
    const similarity = calculateSimilarity(normalized, hash);
    if (similarity >= SIMILARITY_PERCENT_THRESHOLD) {
      similarMessageFound = true;
      matchingHash = hash;

      // データが存在する場合：更新
      if (!data.users.has(uid)) {
        data.users.add(uid);
      }
      data.count++;
      break;
    }
  }

  // 類似メッセージが見つからない場合、新しく登録
  if (!similarMessageFound) {
    guildTracker.set(normalized, {
      firstSeen: Date.now(),
      users: new Set([uid]),
      count: 1
    });
    return;
  }

  const matchingData = guildTracker.get(matchingHash);

  // ★ 重要な変更: 最低ユーザー数の確認を追加
  if (matchingData.users.size >= SIMILARITY_MIN_USERS) {
    if (matchingData.count >= SIMILARITY_TIMEOUT_THRESHOLD) {
      // 15回以上: タイムアウト（3分）
      try {
        await member.timeout(SIMILARITY_TIMEOUT_DURATION, '類似メッセージ大量投稿');
        await safeDelete(message, '類似メッセージ大量投稿');
        await sendLogEmbed(guild, {
          title: '🚨 類似メッセージ大量投稿（タイムアウト）',
          member,
          description: `類似度: ${SIMILARITY_PERCENT_THRESHOLD}%以上\n投稿回数: ${matchingData.count}回\n参加ユーザー: ${matchingData.users.size}人\nタイムアウト: ${Math.floor(SIMILARITY_TIMEOUT_DURATION / 60000)}分`,
          channelName: channel?.name,
          color: 0xff0000,
          content: content,
        });

        // カウントをリセット
        guildTracker.delete(matchingHash);
      } catch (e) {
        console.error('Failed to timeout user for similarity spam:', e);
      }
    } else if (matchingData.count >= SIMILARITY_DELETE_THRESHOLD) {
      // 8回以上: メッセージ削除
      await safeDelete(message, '類似メッセージ反復投稿');
      await sendLogEmbed(guild, {
        title: '⚠️ 類似メッセージ反復投稿（削除）',
        member,
        description: `類似度: ${SIMILARITY_PERCENT_THRESHOLD}%以上\n投稿回数: ${matchingData.count}回\n参加ユーザー: ${matchingData.users.size}人`,
        channelName: channel?.name,
        color: 0xffa200,
        content: content,
      });
    }
  }
}

// 従来の個人単位の類似メッセージ検知（緩和済み）
async function handlePersonalSimilarityDetection(message) {
  const {
    member,
    guild,
    content,
    channel
  } = message;
  const uid = member.id;
  const gid = guild.id;

  const normalized = normalizeMessage(content);

  // 普通の会話はスキップ
  if (isCommonConversation(content)) {
    return;
  }

  if (!messageHistory.has(gid)) messageHistory.set(gid, new Map());
  const gmap = messageHistory.get(gid);
  if (!gmap.has(normalized)) gmap.set(normalized, new Map());
  const senders = gmap.get(normalized);
  senders.set(uid, (senders.get(uid) || 0) + 1);

  if (senders.get(uid) >= SIMILAR_MESSAGE_THRESHOLD) {
    const s = addScore(uid, currentCfg().SIMILAR);
    await safeDelete(message, '類似メッセージ連投');
    await sendLogEmbed(guild, {
      title: '🚧 類似メッセージ（個人）',
      member,
      description: `+${currentCfg().SIMILAR} / 現在 ${s}/${currentCfg().THRESHOLD}\n内容（抜粋）: ${snippet(content)}`,
      channelName: channel?.name,
      color: 0xffa200,
      content: content,
    });
    return punishByScore(member, '類似メッセージ連投', channel?.name);
  }
}

// ====== メッセージ監視 ======
async function handleMessage(message) {
  if (!message?.guild || message.author?.bot) return;
  const member = message.member;
  if (!member || isWhitelisted(member) || member.permissions?.has(PermissionsBitField.Flags.Administrator)) return;

  await handleAiJudgement(message);

  const c = currentCfg();
  const now = Date.now();
  const uid = member.id;
  const gid = message.guild.id;

  const list = userMsgTs.get(uid) || [];
  list.push(now);
  const recent = list.filter(t => now - t < MASS_SPAM_WINDOW);
  userMsgTs.set(uid, recent);
  if (recent.length >= MASS_SPAM_THRESHOLD) {
    const s = addScore(uid, c.MASS_SPAM);
    await safeDelete(message, 'メッセージ連投');
    await sendLogEmbed(message.guild, {
      title: '🚧 連投検知',
      member,
      description: `+${c.MASS_SPAM} / 現在 ${s}/${c.THRESHOLD}`,
      channelName: message.channel?.name,
      color: 0xffa200,
      content: message.content,
    });
    return punishByScore(member, 'メッセージ連投', message.channel?.name);
  }

  const content = (message.content || '').toLowerCase();

  if (RAID_KEYWORDS.some(k => content.includes(k))) {
    const s = addScore(uid, c.KEYWORD);
    await safeDelete(message, 'NGワード');
    await sendLogEmbed(message.guild, {
      title: '🚨 NGキーワード',
      member,
      description: `+${c.KEYWORD} / 現在 ${s}/${c.THRESHOLD}\n内容（抜粋）: ${snippet(message.content)}`,
      channelName: message.channel?.name,
      content: message.content,
    });
    return punishByScore(member, 'NGワード', message.channel?.name);
  }

  const newlineCount = (content.match(/\n/g) || []).length;
  if (newlineCount > 20) {
    const s = addScore(uid, c.NEWLINES);
    await safeDelete(message, '過度な改行');
    await sendLogEmbed(message.guild, {
      title: '🚧 過度な改行',
      member,
      description: `+${c.NEWLINES} / 現在 ${s}/${c.THRESHOLD}`,
      channelName: message.channel?.name,
      color: 0xffa200,
      content: message.content,
    });
    return punishByScore(member, '過度な改行', message.channel?.name);
  }

  const zalgo = (message.content.match(/[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/g) || []).length;
  if (zalgo > 5) {
    const s = addScore(uid, c.ZALGO);
    await safeDelete(message, 'Zalgo 乱用');
    await sendLogEmbed(message.guild, {
      title: '🚧 Zalgo 乱用',
      member,
      description: `+${c.ZALGO} / 現在 ${s}/${c.THRESHOLD}`,
      channelName: message.channel?.name,
      color: 0xffa200,
      content: message.content,
    });
    return punishByScore(member, 'Zalgo 乱用', message.channel?.name);
  }

  // ===== 招待リンクスパム検知 =====
  {
    const rawContent = message.content || '';
    const inviteMatches = [...rawContent.matchAll(INVITE_REGEX)];
    if (inviteMatches.length > 0) {
      const isAllowed = inviteMatches.every(m =>
        ALLOWED_INVITE_LINKS.some(allowed => allowed.toLowerCase().includes(m[1].toLowerCase()))
      );
      if (!isAllowed) {
        const s = addScore(uid, currentCfg().KEYWORD);
        await safeDelete(message, '招待リンクスパム');
        await sendLogEmbed(message.guild, {
          title: '🚨 招待リンクスパム',
          member,
          description: `外部サーバーへの招待リンクを検知\n+${currentCfg().KEYWORD} / 現在 ${s}/${currentCfg().THRESHOLD}`,
          channelName: message.channel?.name,
          content: rawContent,
        });
        return punishByScore(member, '招待リンクスパム', message.channel?.name);
      }
    }
  }

  // ===== メンションスパム検知 =====
  {
    const mentionCount =
      (message.mentions?.users?.size || 0) +
      (message.mentions?.roles?.size || 0) +
      (message.mentions?.everyone ? 1 : 0);
    if (mentionCount >= MENTION_SPAM_THRESHOLD) {
      const s = addScore(uid, currentCfg().KEYWORD);
      await safeDelete(message, 'メンションスパム');
      await sendLogEmbed(message.guild, {
        title: '🚨 メンションスパム',
        member,
        description: `1メッセージに ${mentionCount} 件のメンション\n+${currentCfg().KEYWORD} / 現在 ${s}/${currentCfg().THRESHOLD}`,
        channelName: message.channel?.name,
        content: message.content,
      });
      return punishByScore(member, 'メンションスパム', message.channel?.name);
    }
  }

  // ★ 修正済み: 類似メッセージ検知システムを新しい関数で呼び出し
  await handleSimilarityDetection(message);
  await handlePersonalSimilarityDetection(message);

  if (content.startsWith('!') || content.startsWith('/')) {
    const last = userCmdTime.get(uid) || 0;
    if (now - last < 1000) {
      const s = addScore(uid, c.CMD_ABUSE);
      await sendLogEmbed(message.guild, {
        title: '🚧 コマンド連打',
        member,
        description: `+${c.CMD_ABUSE} / 現在 ${s}/${c.THRESHOLD}`,
        channelName: message.channel?.name,
        color: 0xffa200,
        content: message.content,
      });
      return punishByScore(member, 'コマンド連打', message.channel?.name);
    }
    userCmdTime.set(uid, now);
  }
}

async function handleMessageUpdate(oldMessage, newMessage) {
  if (!newMessage || newMessage.author?.bot) return;
  if (oldMessage?.content === newMessage?.content) return;
  return handleMessage(newMessage);
}

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

// ====== 監査ログ / 危険操作 ======

// — 新機能：大量操作検知と連鎖的処罰 —
async function checkAndPunishMassAction(entry) {
  const {
    executor,
    action,
    guild,
    target
  } = entry;
  const executorMember = guild.members.cache.get(executor.id);
  if (!executorMember || executorMember.bot || isWhitelisted(executorMember) || isInProbation(executor.id)) return false;

  const now = Date.now();
  const executorId = executor.id;
  const logMap = (action === AuditLogEvent.MemberBanAdd) ? massBanLog : massNukeLog;

  if (!logMap.has(executorId)) logMap.set(executorId, []);
  const logArray = logMap.get(executorId);
  logArray.push({
    timestamp: now,
    targetId: target?.id
  });
  const recentActions = logArray.filter(a => now - a.timestamp <= MASS_ACTION_WINDOW_MS);
  logMap.set(executorId, recentActions);

  if (recentActions.length >= MASS_ACTION_THRESHOLD) {
    let reason = '不審な大量操作';
    if (action === AuditLogEvent.MemberBanAdd) {
      reason = '不審な大量BAN';
    } else if (action === AuditLogEvent.ChannelDelete) {
      reason = '不審なチャンネル削除';
    } else if (action === AuditLogEvent.RoleDelete) {
      reason = '不審なロール削除';
    }

    try {
      // 処罰実行
      const ok = await stripAllRoles(guild, executor.id, reason);
      await sendLogEmbed(guild, {
        title: `🚨 大量操作を検知・権限剥奪`,
        member: executorMember,
        description: `理由: ${reason}\n成功: ${ok}`,
        color: 0xff4757,
      });

      // 連鎖的処罰: ロールを渡した人間を追跡
      const auditLogs = await guild.fetchAuditLogs({
        type: AuditLogEvent.MemberRoleUpdate,
        limit: 100
      });
      const recentGrants = auditLogs.entries.filter(e => e.target.id === executor.id && e.changes.some(c => c.key === '$add'));
      for (const grant of recentGrants) {
        const giver = grant.executor;
        if (giver && !giver.bot && giver.id !== executor.id) {
          const giverMember = guild.members.cache.get(giver.id);
          if (giverMember && !isWhitelisted(giverMember)) {
            const ok2 = await stripAllRoles(guild, giver.id, '不審なユーザーに危険なロールを付与');
            await sendLogEmbed(guild, {
              title: `🚨 連鎖的処罰`,
              member: giverMember,
              description: `理由: 不審なユーザーに危険なロールを付与\n成功: ${ok2}`,
              color: 0xff4757,
            });
          }
        }
      }
    } catch {
      return false;
    }
    return true;

  }
  return false;
}

async function handleAuditLogEntry(entry) {
  const {
    guild,
    executor,
    action,
    target
  } = entry;

  // ギルドと実行者が存在するか最初にチェック
  if (!guild || !executor) {
    console.warn('監査ログエントリにギルドまたは実行者の情報がありません。');
    return;
  }

  const member = guild.members.cache.get(executor.id);

  // メンバーが見つからない、またはボット、ホワイトリストの場合は処理を中断
  if (!member || member.user.bot || isWhitelisted(member)) return;

  // 大量操作検知 (BAN / 削除)
  if (
    action === AuditLogEvent.MemberBanAdd ||
    action === AuditLogEvent.ChannelDelete ||
    action === AuditLogEvent.RoleDelete
  ) {
    const punished = await checkAndPunishMassAction(entry);
    if (punished) return;
  }

  // DM で理由確認
  if (DANGER_ACTIONS.has(action) && !member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    if (pendingModActions.has(executor.id)) {
      const p = pendingModActions.get(executor.id);
      p.reasonAttempts++;
      try {
        const dm = await executor.createDM();
        await dm.send(`⚠️ 理由確認の再送（残り ${Math.max(0, 3 - p.reasonAttempts)} 回）`);
      } catch {}
      return;
    }

    try {
      await saveAndStripRoles(member);
      const actionText = `アクション: ${AuditLogEvent[action]} / 対象: ${target?.tag || target?.name || target?.id}`;
      const dmText = `サーバーで重要な操作を行いました。\n${actionText}\nこのDMに **3分以内** に理由を返信してください。未回答なら権限剥奪を継続します。`;
      await executor.send(dmText).catch(() => {});
      pendingModActions.set(executor.id, {
        entry,
        timestamp: Date.now(),
        reasonAttempts: 0
      });

      setTimeout(async () => {
        const p = pendingModActions.get(executor.id);
        if (!p) return;
        await sendLogEmbed(guild, {
          title: '⚠️ DM未応答につき権限剥奪継続',
          member,
          description: '重要操作の理由確認に未応答',
          color: 0xffa200,
        });
        pendingModActions.delete(executor.id);
      }, 3 * 60 * 1000);
    } catch {}

  }
}

// ====== Bot 追加監視 ======
async function handleBotAdd(member) {
  if (!member?.user?.bot) return false;
  const isVerified = !!member.user.flags?.has?.('VerifiedBot');
  if (!isVerified) {
    try {
      const logs = await member.guild.fetchAuditLogs({
        type: AuditLogEvent.BotAdd,
        limit: 1
      });
      const entry = logs.entries.first();
      const executor = entry?.executor;
      await member.roles.set([], '未認証Botのため権限剥奪').catch(() => {});
      await sendLogEmbed(member.guild, {
        title: '🚨 怪しいBot検知',
        member,
        description: `招待者: ${executor?.tag || '不明'}`,
        color: 0xff4757,
      });
      return true;
    } catch {}
  }
  return false;
}

// ====== ロール更新 (@everyone 危険権限検知) ======
async function handleRoleUpdate(oldRole, newRole) {
  if (oldRole.id !== oldRole.guild.id) return;
  const before = oldRole.permissions;
  const after = newRole.permissions;
  const added = DANGEROUS_PERMISSIONS.filter(p => after.has(p) && !before.has(p));
  if (added.length === 0) return;

  try {
    const logs = await oldRole.guild.fetchAuditLogs({
      type: AuditLogEvent.RoleUpdate,
      limit: 1
    });
    const entry = logs.entries.first();
    const executor = entry?.executor;
    if (!executor) return;

    const member = oldRole.guild.members.cache.get(executor.id);
    if (!member || isWhitelisted(member)) return;

    await newRole.setPermissions(before, '危険権限の自動削除');
    await oldRole.guild.members.ban(executor.id, {
      reason: '@everyone に危険権限を付与'
    }).catch(() => {});
    await sendLogEmbed(oldRole.guild, {
      title: '🚨 危険権限を検知し差し戻し',
      member,
      description: `追加された権限: ${added.map(p => PermissionsBitField.Flags[p]).join(', ')}`,
    });

  } catch {}
}

// ★ 修正: 不審なタイムアウト検知機能を削除
async function onGuildMemberUpdate(oldMember, newMember) {
  if (newMember.user.bot || isWhitelisted(newMember)) return;

  const beforePerms = oldMember.permissions?.bitfield ?? 0n;
  const afterPerms = newMember.permissions?.bitfield ?? 0n;

  // 危険権限の付与を監視
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
  const {
    guild,
    user
  } = ban;
  setTimeout(async () => {
    const executor = await findExecutorForTarget(guild, AuditLogEvent.MemberBanAdd, user.id);
    if (!executor) return;
    if (isWhitelisted(executor) || isInProbation(executor.id) || recordAndCheckMassAction(executor.id, user.id, 'BAN')) {
      try {
        await guild.members.unban(user.id, '荒らし検知: 誤BAN救済');
      } catch {}
      const ok = await stripAllRoles(guild, executor.id, '荒らし検知: クールダウン中の処罰 or 大量処罰');
      await sendLogEmbed(guild, {
        title: '🚨 不審なBAN検知',
        description: `実行者 <@${executor.id}> を権限剥奪（成功:${ok}）。\n対象: **${user.tag}** はBAN解除しました。`,
      });
      try {
        const url = await createOneTimeInvite(guild);
        const dm = await user.createDM();
        await dm.send(`すみません。サーバー側で不正なBANを検知し、解除しました。\n` +
          (url ? `再参加用の招待リンク: ${url}` : `再参加招待の作成に失敗しました。管理者へご連絡ください。`));
      } catch {}
    }
  }, 1500);
}

async function onGuildMemberRemove(member) {
  const {
    guild
  } = member;
  setTimeout(async () => {
    const logs = await guild.fetchAuditLogs({
      type: AuditLogEvent.MemberKick,
      limit: 5
    }).catch(() => null);
    const entry = logs?.entries?.find(e => e.target?.id === member.id);
    if (!entry) return;
    const executor = entry.executor;
    if (!executor) return;
    const executorMember = guild.members.cache.get(executor.id);
    if (!executorMember || isWhitelisted(executorMember) || isInProbation(executor.id) || recordAndCheckMassAction(executor.id, member.id, 'KICK')) {
      const ok = await stripAllRoles(guild, executor.id, '荒らし検知: クールダウン中の処罰 or 大量処罰');
      await sendLogEmbed(guild, {
        title: '🚨 不審なKick検知',
        description: `実行者 <@${executor.id}> を権限剥奪（成功:${ok}）。\n対象: **${member.user?.tag || member.id}** にはお詫びDMを送ります。`,
      });
      try {
        const url = await createOneTimeInvite(guild);
        const dm = await member.user.createDM();
        await dm.send(`すみません。サーバー側で不正なKickを検知しました。\n` +
          (url ? `再参加用の招待リンク: ${url}` : `再参加招待の作成に失敗しました。管理者へご連絡ください。`));
      } catch {}
    }
  }, 1500);
}

// ユーティリティ関数
function snippet(text, maxLength = 30) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

async function safeDelete(message, reason) {
  try {
    if (message?.deletable) await message.delete();
  } catch (e) {
    console.error(`Failed to delete message: ${e.message}`);
  }
}

// 権限チェック関数 (index.js から移動)
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
  } catch {
    return false;
  }
}

function recordAndCheckMassAction(executorId, targetId, actionType) {
  const now = Date.now();
  if (!executorActionLog.has(executorId)) {
    executorActionLog.set(executorId, {
      KICK: [],
      BAN: [],
      TIMEOUT: []
    });
  }
  const log = executorActionLog.get(executorId)[actionType];
  log.push({
    timestamp: now,
    target: targetId
  });
  const recentActions = log.filter(a => now - a.timestamp <= MASS_ACTION_WINDOW_MS);
  executorActionLog.get(executorId)[actionType] = recentActions;
  return recentActions.length > 2; // 閾値は2
}

async function findExecutorForTarget(guild, actionType, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({
      type: actionType,
      limit: 5
    });
    const entry = logs.entries.find(e => e.target?.id === targetId);
    return entry?.executor;
  } catch {
    return null;
  }
}

// DM応答処理
async function handleDirectMessage(message) {
  if (!message?.author || message.author.bot) return;

  const pending = pendingModActions.get(message.author.id);
  if (!pending) return;

  const reason = message.content?.trim();
  if (!reason || reason.length < 5) {
    try {
      await message.reply('理由が短すぎます。もう少し詳しく説明してください。');
    } catch {}
    return;
  }

  const isAppropriate = await isReasonAppropriate(pending.entry, reason);
  if (isAppropriate) {
    try {
      const guild = pending.entry.guild;
      const member = guild.members.cache.get(message.author.id);
      if (member) {
        await restoreRoles(member);
        await sendLogEmbed(guild, {
          title: '✅ 理由確認完了・権限復元',
          member,
          description: `理由: ${reason}`,
          color: 0x00ff00,
        });
      }
      await message.reply('✅ 理由が確認できました。権限を復元しました。');
    } catch (e) {
      console.error('Failed to restore roles:', e);
      await message.reply('❌ 権限復元に失敗しました。管理者にお問い合わせください。').catch(() => {});
    }
  } else {
    try {
      await message.reply('❌ 理由が不適切と判断されました。権限剥奪を継続します。');
      await sendLogEmbed(pending.entry.guild, {
        title: '❌ 不適切な理由により権限剥奪継続',
        member: pending.entry.guild.members.cache.get(message.author.id),
        description: `提出された理由: ${reason}`,
        color: 0xff0000,
      });
    } catch {}
  }

  pendingModActions.delete(message.author.id);
}

// utils/anti-raid.js の最後に追加
module.exports = {
  // 外部から呼び出したい関数や変数をここに列挙
  handleMemberJoin,
  handleMessage,
  handleReactionAdd,
  handleRoleUpdate,
  handleAuditLogEntry,
  handleMessageUpdate,
  handleBotAdd,
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
  // 【追加】クリーンアップ機能の公開
  similarityTracker,
  SIMILARITY_HASH_EXPIRY_MS,
  CLEANUP_INTERVAL_MS,
  cleanupSimilarityTracker,
};
