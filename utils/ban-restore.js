// utils/ban-restore.js
// ================================================================
//  BAN時の自動復元モジュール
//  BANされたユーザーが過去3日以内に削除したチャンネル・ロールを
//  すべて復元する。
//
//  設計:
//    - handleChannelDelete / handleRoleDelete 時にデータを記録
//    - onGuildBanAdd 時に復元処理を呼ぶ
//    - 記録は JSON で永続化（再起動後も有効）
// ================================================================

'use strict';

const fs   = require('fs');
const path = require('path');
const { ChannelType } = require('discord.js');

// --- 定数 ---
const THREE_DAYS_MS   = 3 * 24 * 60 * 60 * 1000;
const DATA_DIR        = path.join(__dirname, '../data');
const STORE_PATH      = path.join(DATA_DIR, 'banRestoreStore.json');
const RESTORE_COLOR   = 0x2ecc71;
const LOG_CHANNEL_NAME = 'nuke-logs';

// ChannelType で作成可能な種別
const CREATABLE_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildCategory,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
]);

// --- ストア: { guildId: { userId: { channels: [...], roles: [...] } } } ---
let store = {};

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadStore() {
  try {
    store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    store = {};
  }
}

function saveStore() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error('[ban-restore] saveStore error:', e.message);
  }
}

// 起動時ロード
loadStore();

// 古いエントリの掃除（3日以上前のものは削除）
function pruneStore() {
  const cutoff = Date.now() - THREE_DAYS_MS;
  let dirty = false;
  for (const guildId of Object.keys(store)) {
    for (const userId of Object.keys(store[guildId])) {
      const entry = store[guildId][userId];
      entry.channels = (entry.channels || []).filter(c => c.deletedAt >= cutoff);
      entry.roles    = (entry.roles    || []).filter(r => r.deletedAt >= cutoff);
      if (entry.channels.length === 0 && entry.roles.length === 0) {
        delete store[guildId][userId];
        dirty = true;
      }
    }
    if (Object.keys(store[guildId]).length === 0) {
      delete store[guildId];
      dirty = true;
    }
  }
  if (dirty) saveStore();
}

// 6時間おきに掃除
setInterval(pruneStore, 6 * 60 * 60 * 1000);

// ================================================================
//  記録系 API
// ================================================================

/**
 * 削除されたチャンネルを記録する
 * handleChannelDelete から呼ぶ。Discord.js の channel オブジェクトは
 * 削除イベント時点ではまだキャッシュに残っている。
 *
 * @param {string} guildId
 * @param {string} executorId  - 削除を実行したユーザーID
 * @param {import('discord.js').GuildChannel} channel
 */
function recordDeletedChannel(guildId, executorId, channel) {
  if (!guildId || !executorId || !channel) return;

  // 権限オーバーライドを記録
  const overwrites = [];
  if (channel.permissionOverwrites) {
    for (const ow of channel.permissionOverwrites.cache.values()) {
      overwrites.push({
        id   : ow.id,
        type : ow.type,
        allow: ow.allow.bitfield.toString(),
        deny : ow.deny.bitfield.toString(),
      });
    }
  }

  const record = {
    deletedAt         : Date.now(),
    id                : channel.id,   // 復元時の参照用（元IDは再利用できないが照合に使う）
    name              : channel.name,
    type              : channel.type,
    parentId          : channel.parentId   || null,
    position          : channel.position   ?? 0,
    topic             : channel.topic      || null,
    nsfw              : channel.nsfw       || false,
    rateLimitPerUser  : channel.rateLimitPerUser || 0,
    userLimit         : channel.userLimit  || 0,
    bitrate           : channel.bitrate    || null,
    permissionOverwrites: overwrites,
  };

  if (!store[guildId])               store[guildId] = {};
  if (!store[guildId][executorId])   store[guildId][executorId] = { channels: [], roles: [] };
  store[guildId][executorId].channels.push(record);
  saveStore();
}

/**
 * 削除されたロールを記録する
 * handleRoleDelete から呼ぶ。
 *
 * @param {string} guildId
 * @param {string} executorId
 * @param {import('discord.js').Role} role
 */
function recordDeletedRole(guildId, executorId, role) {
  if (!guildId || !executorId || !role) return;

  const record = {
    deletedAt    : Date.now(),
    id           : role.id,
    name         : role.name,
    color        : role.color,
    hoist        : role.hoist,
    mentionable  : role.mentionable,
    permissions  : role.permissions.bitfield.toString(),
    position     : role.position,
    unicodeEmoji : role.unicodeEmoji || null,
  };

  if (!store[guildId])               store[guildId] = {};
  if (!store[guildId][executorId])   store[guildId][executorId] = { channels: [], roles: [] };
  store[guildId][executorId].roles.push(record);
  saveStore();
}

// ================================================================
//  復元系 API
// ================================================================

/**
 * ログチャンネルを取得（または nuke-logs を作成）
 */
async function getLogChannel(guild) {
  let ch = guild.channels.cache.find(
    c => c.name === LOG_CHANNEL_NAME && c.type === ChannelType.GuildText
  );
  if (!ch) {
    try {
      ch = await guild.channels.create({
        name  : LOG_CHANNEL_NAME,
        type  : ChannelType.GuildText,
        reason: '復元ログ出力用',
      });
    } catch { return null; }
  }
  return ch;
}

/**
 * BANされたユーザーが過去3日以内に削除したチャンネル・ロールを復元する
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} bannedUserId
 */
async function restoreForBannedUser(guild, bannedUserId) {
  const cutoff = Date.now() - THREE_DAYS_MS;
  const entry  = store[guild.id]?.[bannedUserId];
  if (!entry) return; // 記録なし → スキップ

  const channels = (entry.channels || []).filter(c => c.deletedAt >= cutoff);
  const roles    = (entry.roles    || []).filter(r => r.deletedAt >= cutoff);

  if (channels.length === 0 && roles.length === 0) return;

  const logCh = await getLogChannel(guild);
  const lines  = [
    `🔄 **BAN検知に伴う自動復元** <@${bannedUserId}>`,
    `過去3日以内の削除物: チャンネル **${channels.length}件** / ロール **${roles.length}件**`,
  ];

  // -------------------------------------------------------
  //  ロール復元（チャンネルの権限参照に先立って行う）
  // -------------------------------------------------------
  let restoredRoles = 0;
  const roleIdMap = {};  // old id → new Role

  // ボット自身のロールより上には置けないので上限を取得
  const botMember    = guild.members.me;
  const botHighest   = botMember?.roles.highest.position ?? 0;

  // 位置が低い順に作成（依存関係を考慮）
  const sortedRoles = [...roles].sort((a, b) => a.position - b.position);

  for (const r of sortedRoles) {
    // @everyone は復元不要
    if (r.name === '@everyone') continue;
    // 既に同名ロールがあれば skip（重複防止）
    if (guild.roles.cache.some(gr => gr.name === r.name)) {
      const existing = guild.roles.cache.find(gr => gr.name === r.name);
      if (existing) roleIdMap[r.id] = existing;
      lines.push(`⏭️ ロール「@${r.name}」は既に存在するためスキップ`);
      continue;
    }

    try {
      const targetPosition = Math.min(r.position, Math.max(1, botHighest - 1));
      const newRole = await guild.roles.create({
        name        : r.name,
        color       : r.color,
        hoist       : r.hoist,
        mentionable : r.mentionable,
        permissions : BigInt(r.permissions),
        position    : targetPosition,
        reason      : `BAN後自動復元（元削除者: ${bannedUserId}）`,
      });
      roleIdMap[r.id] = newRole;
      restoredRoles++;
      lines.push(`✅ ロール「@${r.name}」を復元`);
    } catch (e) {
      lines.push(`❌ ロール「@${r.name}」の復元失敗: ${e.message}`);
    }
  }

  // -------------------------------------------------------
  //  チャンネル復元
  //  カテゴリ → 通常チャンネル の順で作成
  // -------------------------------------------------------
  let restoredChannels = 0;
  const channelIdMap   = {};  // old id → new Channel

  // カテゴリを先に作成
  const categories = channels.filter(c => c.type === ChannelType.GuildCategory);
  const others     = channels.filter(c => c.type !== ChannelType.GuildCategory);

  async function createChannel(c) {
    if (!CREATABLE_CHANNEL_TYPES.has(c.type)) {
      lines.push(`⏭️ チャンネル「#${c.name}」は作成不可な種別(${c.type})のためスキップ`);
      return;
    }
    // 既に同名かつ同種別があれば skip
    if (guild.channels.cache.some(gc => gc.name === c.name && gc.type === c.type)) {
      const existing = guild.channels.cache.find(gc => gc.name === c.name && gc.type === c.type);
      if (existing) channelIdMap[c.id] = existing;
      lines.push(`⏭️ チャンネル「#${c.name}」は既に存在するためスキップ`);
      return;
    }

    try {
      // 親カテゴリを新IDでマッピング
      let parentId = null;
      if (c.parentId) {
        parentId = channelIdMap[c.parentId]?.id || null;
      }

      // 権限オーバーライドをロールIDマッピングで変換
      const permissionOverwrites = (c.permissionOverwrites || []).map(ow => {
        const newTarget = roleIdMap[ow.id]?.id || ow.id;
        return {
          id  : newTarget,
          type: ow.type,
          allow: BigInt(ow.allow),
          deny : BigInt(ow.deny),
        };
      });

      const opts = {
        name    : c.name,
        type    : c.type,
        position: c.position,
        reason  : `BAN後自動復元（元削除者: ${bannedUserId}）`,
        permissionOverwrites,
      };
      if (parentId)           opts.parent           = parentId;
      if (c.topic)            opts.topic            = c.topic;
      if (c.nsfw)             opts.nsfw             = c.nsfw;
      if (c.rateLimitPerUser) opts.rateLimitPerUser = c.rateLimitPerUser;
      if (c.userLimit)        opts.userLimit        = c.userLimit;
      if (c.bitrate && (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice)) {
        opts.bitrate = c.bitrate;
      }

      const newCh = await guild.channels.create(opts);
      channelIdMap[c.id] = newCh;
      restoredChannels++;
      lines.push(`✅ チャンネル「#${c.name}」を復元`);
    } catch (e) {
      lines.push(`❌ チャンネル「#${c.name}」の復元失敗: ${e.message}`);
    }
  }

  for (const c of categories) await createChannel(c);
  for (const c of others)     await createChannel(c);

  // -------------------------------------------------------
  //  ログ送信
  // -------------------------------------------------------
  lines.push(
    ``,
    `📊 **復元結果**: チャンネル ${restoredChannels}/${channels.length}件 / ロール ${restoredRoles}/${roles.length}件`,
  );

  if (logCh) {
    // 2000文字超えたら分割
    const text   = lines.join('\n');
    const chunks = [];
    let   cur    = '';
    for (const line of lines) {
      if ((cur + '\n' + line).length > 1900) {
        chunks.push(cur);
        cur = line;
      } else {
        cur = cur ? cur + '\n' + line : line;
      }
    }
    if (cur) chunks.push(cur);
    for (const chunk of chunks) {
      await logCh.send({ content: chunk }).catch(() => {});
    }
  }

  // 復元済みデータは削除（重複復元防止）
  delete store[guild.id][bannedUserId];
  if (Object.keys(store[guild.id]).length === 0) delete store[guild.id];
  saveStore();
}

module.exports = {
  recordDeletedChannel,
  recordDeletedRole,
  restoreForBannedUser,
};
