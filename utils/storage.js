// utils/storage.js
const fs   = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { Dropbox, DropboxAuth } = require('dropbox');

// ===== 認証情報の取得（env優先 → dropbox_token.json フォールバック） =====
function loadDropboxCredentials() {
  if (process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET && process.env.DROPBOX_REFRESH_TOKEN) {
    return {
      appKey:       process.env.DROPBOX_APP_KEY,
      appSecret:    process.env.DROPBOX_APP_SECRET,
      refreshToken: process.env.DROPBOX_REFRESH_TOKEN,
    };
  }
  try {
    const tokenPath = path.join(__dirname, '../dropbox_token.json');
    if (fs.existsSync(tokenPath)) {
      const raw = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      if (raw.refresh_token) {
        return {
          appKey:       process.env.DROPBOX_APP_KEY    || '',
          appSecret:    process.env.DROPBOX_APP_SECRET || '',
          refreshToken: raw.refresh_token,
        };
      }
    }
  } catch (e) {
    console.warn('⚠️ dropbox_token.json の読み込みに失敗しました:', e.message);
  }
  return null;
}

let dbx = null;
let initPromise = null;

async function ensureDropboxInit() {
  if (dbx) return dbx;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const creds = loadDropboxCredentials();
    if (!creds || !creds.refreshToken) {
      console.warn('⚠️ Dropbox認証情報が見つかりません。Dropbox機能はスキップされます。');
      return null;
    }

    try {
      const dbxAuth = new DropboxAuth({
        clientId:     creds.appKey,
        clientSecret: creds.appSecret,
        refreshToken: creds.refreshToken,
        fetch,
      });

      await dbxAuth.refreshAccessToken();

      dbx = new Dropbox({ auth: dbxAuth, fetch });
      return dbx;
    } catch (e) {
      console.error('❌ Dropbox初期化に失敗しました:', e?.error || e?.message || e);
      return null;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

async function ensureFolder(folderPath) {
  const client = await ensureDropboxInit();
  if (!client) return false;
  try {
    await client.filesCreateFolderV2({ path: folderPath, autorename: false });
    return true;
  } catch (e) {
    if (e?.error?.error?.path?.['.tag'] === 'conflict') return true;
    console.error('❌ Dropbox ensureFolder失敗:', e?.error || e?.message || e);
    return false;
  }
}

async function uploadToDropbox(dropboxPath, contents) {
  const client = await ensureDropboxInit();
  if (!client) {
    console.error('❌ Dropboxクライアント未初期化のためアップロードをスキップします。');
    return false;
  }
  try {
    await client.filesUpload({
      path: dropboxPath,
      contents,
      mode: { '.tag': 'overwrite' },
    });
    return true;
  } catch (err) {
    console.error('❌ Dropboxアップロード失敗:', err?.error || err?.message || err);
    return false;
  }
}

async function downloadFromDropbox(dropboxPath) {
  const client = await ensureDropboxInit();
  if (!client) return null;
  try {
    const response = await client.filesDownload({ path: dropboxPath });
    const buffer = response.result.fileBinary;
    if (buffer) {
      return Buffer.from(buffer).toString('utf-8');
    }
    return null;
  } catch (err) {
    if (err?.status === 409) {
      console.warn('⚠️ Dropboxファイルが見つかりません: ' + dropboxPath);
      return null;
    }
    console.error('❌ Dropboxダウンロード失敗:', err?.error || err?.message || err);
    return null;
  }
}

module.exports = { ensureDropboxInit, ensureFolder, uploadToDropbox, downloadFromDropbox };
