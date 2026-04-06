const { ensureDropboxInit } = require('./storage');

const LOCK_PATH = '/app-data/bot-active-lock.json';
const LOCK_TTL_MS = Number(process.env.BOT_SINGLETON_TTL_MS || 90_000);
const HEARTBEAT_MS = Number(process.env.BOT_SINGLETON_HEARTBEAT_MS || 30_000);

function now() {
  return Date.now();
}

function isConflictError(err) {
  const summary = err?.error?.error_summary || err?.message || '';
  return typeof summary === 'string' && summary.includes('conflict');
}

async function readLockState(client) {
  try {
    const response = await client.filesDownload({ path: LOCK_PATH });
    const raw = Buffer.from(response.result.fileBinary).toString('utf-8');
    if (!raw) return null;
    return {
      rev: response.result.rev,
      lock: JSON.parse(raw),
    };
  } catch (err) {
    if (err?.status === 409) return null;
    console.error('❌ Singleton lock 読み込み失敗:', err?.error || err?.message || err);
    return null;
  }
}

async function writeLockCAS(client, ownerId, previousRev = null) {
  const payload = { ownerId, updatedAt: now() };
  return writeLockPayloadCAS(client, payload, previousRev);
}

async function writeLockPayloadCAS(client, payload, previousRev = null) {
  const mode = previousRev
    ? { '.tag': 'update', update: previousRev }
    : { '.tag': 'add' };

  try {
    await client.filesUpload({
      path: LOCK_PATH,
      contents: JSON.stringify(payload),
      mode,
      autorename: false,
      mute: true,
    });
    return true;
  } catch (err) {
    if (isConflictError(err)) return false;
    console.error('❌ Singleton lock 書き込み失敗:', err?.error || err?.message || err);
    return false;
  }
}

async function acquireSingletonLock(instanceId) {
  const dbx = await ensureDropboxInit();
  if (!dbx) {
    console.warn('⚠️ Singleton lock をスキップ: Dropboxが利用できません。');
    return { acquired: true, reason: 'dropbox-unavailable' };
  }

  for (let i = 0; i < 5; i += 1) {
    const state = await readLockState(dbx);
    const lock = state?.lock;
    const ts = now();
    const isStale = !lock?.updatedAt || ts - lock.updatedAt > LOCK_TTL_MS;

    if (lock && !isStale && lock.ownerId !== instanceId) {
      return { acquired: false, reason: `active-owner:${lock.ownerId}` };
    }

    const won = await writeLockCAS(dbx, instanceId, state?.rev || null);
    if (won) return { acquired: true, reason: 'acquired' };
  }

  return { acquired: false, reason: 'write-race' };
}

async function refreshSingletonLock(instanceId) {
  const dbx = await ensureDropboxInit();
  if (!dbx) return false;

  const state = await readLockState(dbx);
  if (!state?.lock || state.lock.ownerId !== instanceId) return false;
  return writeLockCAS(dbx, instanceId, state.rev);
}

async function relinquishSingletonLock(instanceId) {
  const dbx = await ensureDropboxInit();
  if (!dbx) return false;

  const state = await readLockState(dbx);
  if (!state?.lock || state.lock.ownerId !== instanceId) return false;

  const expiredPayload = { ownerId: instanceId, updatedAt: 0 };
  return writeLockPayloadCAS(dbx, expiredPayload, state.rev);
}

function startSingletonHeartbeat(instanceId) {
  return setInterval(async () => {
    const ok = await refreshSingletonLock(instanceId);
    if (!ok) {
      console.warn('⚠️ Singleton lock heartbeat 失敗');
    }
  }, HEARTBEAT_MS);
}

module.exports = {
  acquireSingletonLock,
  refreshSingletonLock,
  relinquishSingletonLock,
  startSingletonHeartbeat,
};
