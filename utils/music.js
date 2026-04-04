// utils/music.js  ── 修正版
// play-dl を使用（ytdl-core はYouTubeのbot検出で使用不可のため）

const {
joinVoiceChannel,
createAudioPlayer,
createAudioResource,
AudioPlayerStatus,
StreamType,
VoiceConnectionStatus,
entersState,
} = require(’@discordjs/voice’);
const { spawn, spawnSync } = require(‘child_process’);
const ffmpegPath = require(‘ffmpeg-static’);
const fs = require(‘fs’);

// play-dl（YouTube対応・bot検出回避）
let playdl;
try {
playdl = require(‘play-dl’);
} catch (e) {
console.warn(‘play-dl が見つかりません:’, e.message);
playdl = null;
}

const connections = new Map();
const players    = new Map();
const queues     = new Map();

// ── yt-dlp の存在チェック（Renderでは基本なし） ──
function isYtDlpAvailable() {
try {
const which = spawnSync(‘which’, [‘yt-dlp’], { encoding: ‘utf8’ });
if (which.status === 0 && which.stdout?.trim()) return true;
} catch (*) {}
for (const p of [’/usr/local/bin/yt-dlp’, ‘/usr/bin/yt-dlp’, ‘/root/.local/bin/yt-dlp’]) {
try { if (fs.existsSync(p)) return true; } catch (*) {}
}
return false;
}
const hasYtDlp = isYtDlpAvailable();

function spawnYtdlpStream(url) {
if (!hasYtDlp) return null;
try {
const cp = spawn(‘yt-dlp’, [’-f’, ‘bestaudio’, ‘-o’, ‘-’, url], {
stdio: [‘ignore’, ‘pipe’, ‘pipe’],
});
cp.on(‘error’, err => console.error(‘yt-dlp spawn error:’, err?.code || err?.message));
return cp.stdout;
} catch (err) {
console.error(‘spawnYtdlpStream failed:’, err);
return null;
}
}

async function joinVoice(channel) {
if (!channel?.guild) throw new Error(‘Voice channel is required’);
const guildId = channel.guild.id;
if (!connections.has(guildId)) {
const connection = joinVoiceChannel({
channelId:       channel.id,
guildId:         channel.guild.id,
adapterCreator:  channel.guild.voiceAdapterCreator,
});
// 接続失敗時のエラーハンドラ
connection.on(‘error’, err => console.error(‘Voice connection error:’, err));
connections.set(guildId, connection);
}
return connections.get(guildId);
}

async function leaveVoice(guildOrChannel) {
const guildId = typeof guildOrChannel === ‘string’
? guildOrChannel
: guildOrChannel?.guild?.id;
if (!guildId) return false;
const conn = connections.get(guildId);
if (conn) try { conn.destroy(); } catch {}
connections.delete(guildId);
const player = players.get(guildId);
if (player) try { player.stop(); } catch {}
players.delete(guildId);
queues.delete(guildId);
return true;
}

async function send(textChannel, text) {
if (!textChannel?.send) return null;
return textChannel.send(text).catch(() => null);
}

async function playNext(guildId, textChannel, voiceChannel) {
const queue = queues.get(guildId);
if (!queue || queue.length === 0) return;
const { url, title, isYouTube, isAttachment } = queue.shift();

try {
let resource = null;

```
if (isYouTube) {
  // ── 優先順: yt-dlp → play-dl ──
  const ytdlpStream = spawnYtdlpStream(url);
  if (ytdlpStream) {
    // yt-dlp が使える環境（Dockerビルドなど）
    const ff = spawn(ffmpegPath, [
      '-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'ignore'] });
    ff.on('error', e => console.error('ffmpeg error:', e));
    ytdlpStream.pipe(ff.stdin);
    resource = createAudioResource(ff.stdout, { inputType: StreamType.Raw });

  } else if (playdl) {
    // ── play-dl による再生（Renderなどyt-dlpなし環境） ──
    try {
      // play-dl はストリームを直接返せる
      const stream = await playdl.stream(url, { quality: 2 });
      resource = createAudioResource(stream.stream, {
        inputType: stream.type,
      });
    } catch (pdErr) {
      console.error('play-dl stream error:', pdErr);
      const msg = pdErr.message || String(pdErr);
      await send(textChannel, `❌ 再生に失敗しました: ${msg}`);
      setTimeout(() => playNext(guildId, textChannel, voiceChannel), 500);
      return;
    }

  } else {
    await send(textChannel, '❌ 再生エンジンが見つかりません（play-dl / yt-dlp が必要です）');
    setTimeout(() => playNext(guildId, textChannel, voiceChannel), 500);
    return;
  }

} else if (isAttachment) {
  // 添付ファイル → ffmpeg で直接読み込み
  const ff = spawn(ffmpegPath, [
    '-i', url, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  ff.on('error', e => console.error('ffmpeg error:', e));
  resource = createAudioResource(ff.stdout, { inputType: StreamType.Raw });

} else {
  resource = createAudioResource(url);
}

const player = createAudioPlayer();
player.on('error', async err => {
  console.error('Audio player error:', err);
  await send(textChannel, `❌ プレイヤーエラー: ${err.message}`);
  setTimeout(() => playNext(guildId, textChannel, voiceChannel), 1000);
});
player.on(AudioPlayerStatus.Idle, () => {
  setTimeout(() => playNext(guildId, textChannel, voiceChannel), 250);
});

// VC接続を確認してSubscribe
if (!connections.has(guildId) && voiceChannel) await joinVoice(voiceChannel);
const connection = connections.get(guildId);
if (connection) connection.subscribe(player);
players.set(guildId, player);
player.play(resource);

// 再生開始メッセージ（30秒後に自動削除）
const msg = await send(textChannel, `🎵 再生開始: **${title || '不明'}**`);
if (msg?.deletable) setTimeout(() => msg.delete().catch(() => {}), 30000);
```

} catch (err) {
console.error(‘playNext error:’, err);
const msg = await send(textChannel, `❌ 再生できませんでした: **${title || '不明'}**\n${err.message}`);
if (msg?.deletable) setTimeout(() => msg.delete().catch(() => {}), 30000);
setTimeout(() => playNext(guildId, textChannel, voiceChannel), 1000);
}
}

async function playYouTube(channel, url, textChannel) {
if (!channel) throw new Error(‘Voice channel is required’);
const guildId = channel.guild.id;
await joinVoice(channel);

// タイトル取得
let title = url; // フォールバックはURLそのまま
try {
if (hasYtDlp) {
const p = spawnSync(‘yt-dlp’, [’–get-title’, ‘–no-warnings’, url], {
encoding: ‘utf8’, timeout: 5000,
});
if (p.status === 0 && p.stdout) title = p.stdout.trim();
} else if (playdl) {
const info = await playdl.video_info(url).catch(() => null);
if (info?.video_details?.title) title = info.video_details.title;
}
} catch (e) {
console.warn(‘タイトル取得失敗:’, e.message);
}

if (!queues.has(guildId)) queues.set(guildId, []);
queues.get(guildId).push({ url, title, isYouTube: true, isAttachment: false });

const isPlaying = players.get(guildId)?.state?.status === AudioPlayerStatus.Playing;
if (!isPlaying) {
playNext(guildId, textChannel, channel);
} else {
const msg = await send(textChannel, `▶️ キューに追加: **${title}**`);
if (msg?.deletable) setTimeout(() => msg.delete().catch(() => {}), 30000);
}
return title;
}

async function playAttachment(channel, attachmentUrl, filename, textChannel) {
if (!channel) throw new Error(‘Voice channel is required’);
const guildId = channel.guild.id;
await joinVoice(channel);
if (!queues.has(guildId)) queues.set(guildId, []);
queues.get(guildId).push({ url: attachmentUrl, title: filename, isYouTube: false, isAttachment: true });

const isPlaying = players.get(guildId)?.state?.status === AudioPlayerStatus.Playing;
if (!isPlaying) {
playNext(guildId, textChannel, channel);
} else {
const msg = await send(textChannel, `▶️ キューに追加: **${filename}**`);
if (msg?.deletable) setTimeout(() => msg.delete().catch(() => {}), 30000);
}
return filename;
}

async function play(channel, url, textChannel, attachmentFilename = null) {
if (!channel?.guild) throw new Error(‘Voice channel is required’);
if (attachmentFilename) return playAttachment(channel, url, attachmentFilename, textChannel);
if (typeof url === ‘string’ && (url.includes(‘youtube.com’) || url.includes(‘youtu.be’))) {
return playYouTube(channel, url, textChannel);
}
return playAttachment(channel, url, url.split(’/’).pop(), textChannel);
}

function stop(guildOrChannel) {
const guildId = typeof guildOrChannel === ‘string’
? guildOrChannel
: guildOrChannel?.guild?.id;
const player = players.get(guildId);
if (!player) return false;
queues.set(guildId, []);
try { player.stop(); } catch (e) { console.error(‘stop error:’, e); }
return true;
}

module.exports = {
joinVoice,
leaveVoice,
play,
stop,
playUrl: async (…args) => play(…args),
stopMusic: stop,
players,
queues,
_hasYtDlp: hasYtDlp,
};
