const { uploadToDropbox, downloadFromDropbox, ensureDropboxInit } = require(’./storage’);

const LOCK_PATH = ‘/app-data/bot-active-lock.json’;
const LOCK_TTL_MS = Number(process.env.BOT_SINGLETON_TTL_MS || 90_000);
const HEARTBEAT_MS = Number(process.env.BOT_SINGLETON_HEARTBEAT_MS || 30_000);

function now() {
return Date.now();
}

async function readLock() {
const raw = await downloadFromDropbox(LOCK_PATH);
if (!raw) return null;
try {
return JSON.parse(raw);
} catch {
return null;
}
}

async function writeLock(ownerId) {
const payload = { ownerId, updatedAt: now() };
const ok = await uploadToDropbox(LOCK_PATH, JSON.stringify(payload));
if (!ok) return false;
const verify = await readLock();
return verify?.ownerId === ownerId;
}

async function acquireSingletonLock(instanceId) {
const dbx = await ensureDropboxInit();
if (!dbx) {

```
return { acquired: true, reason: 'dropbox-unavailable' };
```

}

const lock = await readLock();
const ts = now();
const isStale = !lock?.updatedAt || ts - lock.updatedAt > LOCK_TTL_MS;

if (lock && !isStale && lock.ownerId !== instanceId) {
return { acquired: false, reason: `active-owner:${lock.ownerId}` };
}

const won = await writeLock(instanceId);
return { acquired: won, reason: won ? ‘acquired’ : ‘write-race’ };
}

async function refreshSingletonLock(instanceId) {
return writeLock(instanceId);
}

function startSingletonHeartbeat(instanceId) {
return setInterval(async () => {
const ok = await refreshSingletonLock(instanceId);
if (!ok) {

```
}
```

}, HEARTBEAT_MS);
}

module.exports = {
acquireSingletonLock,
refreshSingletonLock,
startSingletonHeartbeat,
};
