// utils/invite.js
const fs = require('fs');
const path = require('path');
const { uploadToDropbox, downloadFromDropbox, ensureFolder } = require('./storage');

const LOCAL_BACKUP_DIR = process.env.BACKUP_PATH || path.join(process.cwd(), 'backups');
fs.mkdirSync(LOCAL_BACKUP_DIR, { recursive: true });

/**
 * Dropbox/ローカル両対応で guild ごとの invites マッピングを読み込む
 * 形式: { [userId]: [{ code, url, channelId, createdAt }] }
 */
async function loadInviteMapping(guildId) {
  const dropPath = `/bot_backups/invites_${guildId}.json`;
  try {
    const txt = await downloadFromDropbox(dropPath);
    if (txt) return JSON.parse(txt);
  } catch (e) {
    // ignore, fallback to local
  }

  // ローカル fallback
  try {
    const p = path.join(LOCAL_BACKUP_DIR, `invites_${guildId}.json`);
    if (fs.existsSync(p)) {
      const txt = fs.readFileSync(p, 'utf8');
      return JSON.parse(txt);
    }
  } catch (e) {
    console.error('loadInviteMapping local read error:', e);
  }
  return {}; // 空マップ
}

async function saveInviteMapping(guildId, mapping) {
  const dropPath = `/bot_backups/invites_${guildId}.json`;
  const body = JSON.stringify(mapping, null, 2);

  // try ensure folder (no-op if dropbox not configured)
  try { await ensureFolder('/bot_backups'); } catch (e) {}

  // try upload to dropbox
  try {
    const ok = await uploadToDropbox(dropPath, body);
    if (ok) return true;
  } catch (e) {
    console.error('saveInviteMapping dropbox upload error:', e);
  }

  // fallback to local
  try {
    const p = path.join(LOCAL_BACKUP_DIR, `invites_${guildId}.json`);
    fs.writeFileSync(p, body, 'utf8');
    return true;
  } catch (e) {
    console.error('saveInviteMapping local write error:', e);
    return false;
  }
}

/**
 * 指定チャンネルで招待を作成し、guild mapping に保存する
 * @param {Guild} guild
 * @param {TextChannel} channel
 * @param {User} inviter
 * @returns {Promise<{success: boolean, url?: string, error?: string}>}
 */
async function createInvite(guild, channel, inviter) {
  if (!guild || !channel || !inviter) return { success: false, error: 'invalid args' };

  try {
    // 一度作成（無期限、ユニーク）
    const invite = await channel.createInvite({ maxAge: 0, unique: true, reason: `Invite created by ${inviter.tag}` });
    const mapping = await loadInviteMapping(guild.id);

    const entry = {
      code: invite.code,
      url: invite.url || `https://discord.gg/${invite.code}`,
      channelId: channel.id,
      createdAt: new Date().toISOString(),
    };
    mapping[inviter.id] = mapping[inviter.id] || [];
    // 重複を避ける（同じ code があれば追加しない）
    if (!mapping[inviter.id].some(e => e.code === entry.code)) {
      mapping[inviter.id].push(entry);
      await saveInviteMapping(guild.id, mapping);
    }

    return { success: true, url: entry.url };
  } catch (e) {
    console.error('createInvite error:', e);
    return { success: false, error: e?.message || String(e) };
  }
}

/**
 * 保存している招待コードを元に、当該ユーザーの招待利用数を集計する
 * - まず Dropbox/local に保存したコードを基に集計
 * - 保存がない/取得できない場合は guild.invites.fetch() の inviter を代替集計
 * @param {Guild} guild
 * @param {User} user
 * @returns {Promise<{success: boolean, count?: number, details?: object, error?: string}>}
 */
async function fetchInviteCount(guild, user) {
  if (!guild || !user) return { success: false, error: 'invalid args' };

  try {
    const mapping = await loadInviteMapping(guild.id);
    // 取得可能な invites（Discord API）を先に取る（必要に応じて参照）
    let fetchedInvites = null;
    try {
      fetchedInvites = await guild.invites.fetch();
    } catch (e) {
      // 権限不足等で取れないことがある。後で fallback ロジックを使う
      console.warn('fetchInviteCount: guild.invites.fetch failed:', e?.message || e);
      fetchedInvites = null;
    }

    // 1) 保存されているコードがあればそれらの uses を足す
    const userEntries = mapping[user.id] || [];
    let count = 0;
    const details = { byStoredCodes: [], fallbackByInviter: 0 };

    if (userEntries.length && fetchedInvites) {
      for (const e of userEntries) {
        const found = fetchedInvites.find(inv => inv.code === e.code);
        const uses = found ? (found.uses || 0) : 0;
        details.byStoredCodes.push({ code: e.code, channelId: e.channelId, uses, url: e.url });
        count += uses;
      }
      return { success: true, count, details };
    }

    // 2) 保存が無い or fetchedInvites が取れない場合の代替
    if (fetchedInvites) {
      // invites の inviter フィールドでカウント（invite を作ったアカウントと一致するか）
      for (const inv of fetchedInvites.values()) {
        if (inv.inviter && inv.inviter.id === user.id) {
          count += (inv.uses || 0);
        }
      }
      details.fallbackByInviter = count;
      return { success: true, count, details };
    }

    // 3) ここまで来たら何もできない（fetch できず保存も無い）
    return { success: true, count: 0, details: {}, error: 'No data available (cannot fetch invites and no stored mapping)' };
  } catch (e) {
    console.error('fetchInviteCount error:', e);
    return { success: false, error: e?.message || String(e) };
  }
}

module.exports = {
  createInvite,
  fetchInviteCount,
  loadInviteMapping,
  saveInviteMapping,
};