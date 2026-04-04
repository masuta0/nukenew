// index.js  ── 修正版（主な変更点のみ抜粋・差し替え用）
// 元の index.js から以下の部分を変更してください。

// ============================================================
// [修正1] ハードコードされていたIDを環境変数から読むように変更
// ============================================================

// 変更前:
//   const ACTIVE_ROLE_ID = '1425643672900472964';
//   ...
//   const logChannel = await client.channels.fetch('1422418574730989638');

// 変更後:
const ACTIVE_ROLE_ID   = process.env.ACTIVE_ROLE_ID   || '';  // .envに追加
const FACE_LOG_CHANNEL = process.env.FACE_LOG_CHANNEL || '';  // .envに追加

// ============================================================
// [修正2] weeklyManager の handleMessage を messageCreate 内で呼ぶ
// ============================================================
// weeklyManager.js で setupWeekly 内の messageCreate リスナーを削除したため
// index.js の messageCreate の中で呼び出す必要があります。

// 旧: setupWeekly がリスナーを内部登録 → 二重登録
// 新: 以下のように index.js から明示的に呼ぶ

// ============================================================
// [修正3] handleFaceMatch で FACE_LOG_CHANNEL を使う
// ============================================================

// 上記の変更が適用された handleFaceMatch:
async function handleFaceMatch_fixed(message, client) {
    try { await message.delete(); } catch {}

    const member = message.member;
    let timeoutResult = '❌ タイムアウト失敗';
    let timeoutTag = '不明';

    if (member?.manageable) {
        try {
            await member.timeout(7 * 24 * 60 * 60 * 1000, 'Face image auto timeout');
            timeoutResult = '✅ タイムアウト成功';
            timeoutTag = member.user.tag;
        } catch (err) {
            console.error('タイムアウトエラー:', err);
        }
    }

    // ── 環境変数からチャンネルIDを取得 ──
    if (!FACE_LOG_CHANNEL) {
        console.warn('FACE_LOG_CHANNEL が未設定です');
        return;
    }

    try {
        const logChannel = await client.channels.fetch(FACE_LOG_CHANNEL);
        if (logChannel?.isTextBased()) {
            await logChannel.send({
                content:
                    `🧹 類似顔画像を削除しました\n` +
                    `👤 投稿者: ${timeoutTag} (<@${message.author.id}>)\n` +
                    `📨 メッセージID: ${message.id}\n` +
                    `⏱️ タイムアウト結果: ${timeoutResult}\n` +
                    `📍 チャンネル: <#${message.channel.id}>`,
                allowedMentions: { users: [], roles: [] },
            });
        }
    } catch (logErr) {
        console.error('ログ送信エラー:', logErr);
    }
}

// ============================================================
// [修正4] messageCreate ハンドラ内に weeklyManager を統合
// ============================================================

// 以下を client.on('messageCreate', ...) の中に追加:
// （既存の処理の最後、handlePrefixMessage の前に挿入）
//
//   // 週間メッセージカウント
//   const { handleMessage: handleWeeklyMessage } = require('./utils/weeklyManager');
//   await handleWeeklyMessage(message, WEEKLY_CHANNEL_ID);

// ============================================================
// [修正5] .env に追加すべき変数一覧（コメント）
// ============================================================
/*
TOKEN=                    # Discord Bot Token
GEMINI_API_KEY=           # Gemini APIキー (カンマ区切りで複数可)
DROPBOX_APP_KEY=          # Dropbox App Key
DROPBOX_APP_SECRET=       # Dropbox App Secret
DROPBOX_REFRESH_TOKEN=    # Dropbox Refresh Token
WEEKLY_CHANNEL_ID=        # 週間宣伝チャンネルのID
ACTIVE_ROLE_ID=           # アクティブロールのID  ← 新規追加
FACE_LOG_CHANNEL=         # 顔認識ログチャンネルのID  ← 新規追加
PORT=3000
*/

module.exports = { handleFaceMatch_fixed, ACTIVE_ROLE_ID, FACE_LOG_CHANNEL };
