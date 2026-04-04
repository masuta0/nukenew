// utils/music.js
// yt-dlp が存在しない場合は spawn を回避し、ytdl-core にフォールバックする安全実装

const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const { spawn, spawnSync } = require('child_process');
const stream = require('stream');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');

let ytdl;
try { ytdl = require('ytdl-core'); } catch (e) { ytdl = null; }

const connections = new Map();
const players = new Map();
const queues = new Map();

const delay = ms => new Promise(r => setTimeout(r, ms));

// --- yt-dlp の存在チェック ---
function isYtDlpAvailable() {
  try {
    // try which
    const which = spawnSync('which', ['yt-dlp'], { encoding: 'utf8' });
    if (which.status === 0 && which.stdout && which.stdout.trim()) return true;
  } catch (_) {}
  // check common install paths
  const candidates = ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', '/root/.local/bin/yt-dlp'];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return true;
    } catch (_) {}
  }
  return false;
}

const hasYtDlp = isYtDlpAvailable();

// safe spawn wrapper for yt-dlp: returns stdout stream or null
function spawnYtdlpStream(url) {
  if (!hasYtDlp) {
    console.warn('yt-dlp not available on PATH; skipping spawn');
    return null;
  }
  try {
    const cp = spawn('yt-dlp', ['-f', 'bestaudio', '-o', '-', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    // attach error handler so process 'error' doesn't bubble unhandled
    cp.on('error', err => {
      console.error('yt-dlp spawn error (handled):', err?.code || err?.message || err);
    });
    return cp.stdout;
  } catch (err) {
    console.error('spawnYtdlpStream failed:', err);
    return null;
  }
}

// ffmpeg helper: convert input stream to raw pcm for Discord
function spawnFfmpegForStream(inputStream) {
  try {
    const args = ['-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'];
    const ff = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    ff.on('error', e => console.error('ffmpeg spawn error:', e));
    if (inputStream && typeof inputStream.pipe === 'function') inputStream.pipe(ff.stdin);
    return ff.stdout;
  } catch (e) {
    console.error('spawnFfmpegForStream error:', e);
    return null;
  }
}

// joinVoice expects VoiceChannel
async function joinVoice(channel) {
  if (!channel || !channel.guild) throw new Error('Voice channel is required');
  const guildId = channel.guild.id;
  if (!connections.has(guildId)) {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });
    connections.set(guildId, connection);
  }
  return connections.get(guildId);
}

async function leaveVoice(guildOrChannel) {
  const guildId = typeof guildOrChannel === 'string' ? guildOrChannel : (guildOrChannel?.guild?.id);
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

async function playNext(guildId, textChannel, voiceChannel) {
  const queue = queues.get(guildId);
  if (!queue || queue.length === 0) return;
  const item = queue.shift();
  const { url, title, isYouTube, isAttachment } = item;

  try {
    let resource = null;

    if (isYouTube) {
      // 1) try yt-dlp spawn + ffmpeg
      const ytdlpStdout = spawnYtdlpStream(url);
      if (ytdlpStdout) {
        const ffout = spawnFfmpegForStream(ytdlpStdout);
        if (!ffout) throw new Error('ffmpeg failed for yt-dlp stream');
        resource = createAudioResource(ffout, { inputType: StreamType.Raw });
      } else if (ytdl) {
        // 2) fallback to ytdl-core + ffmpeg
        try {
          let ytdlStream;
          let streamErrorOccurred = false;

          // 先にタイトルだけ取得を試みる（失敗したらスキップ）
          let videoInfo = null;
          try {
            videoInfo = await ytdl.getInfo(url);
          } catch (infoErr) {
            console.error('ytdl.getInfo failed:', infoErr);
            const statusCode = infoErr?.statusCode || infoErr?.status || null;

            if (statusCode === 410) {
              if (textChannel && typeof textChannel.send === 'function') {
                const msg = await textChannel.send('❌ この動画は利用できません（削除済みまたはアクセス不可）').catch(()=>null);
                if (msg && msg.deletable) {
                  setTimeout(() => msg.delete().catch(()=>{}), 30000);
                }
              }
            } else if (statusCode === 403) {
              if (textChannel && typeof textChannel.send === 'function') {
                const msg = await textChannel.send('❌ この動画へのアクセスが拒否されました').catch(()=>null);
                if (msg && msg.deletable) {
                  setTimeout(() => msg.delete().catch(()=>{}), 30000);
                }
              }
            } else {
              if (textChannel && typeof textChannel.send === 'function') {
                const msg = await textChannel.send(`❌ 動画情報の取得に失敗しました`).catch(()=>null);
                if (msg && msg.deletable) {
                  setTimeout(() => msg.delete().catch(()=>{}), 30000);
                }
              }
            }

            // 次の曲へ
            setTimeout(() => playNext(guildId, textChannel, voiceChannel), 500);
            return;
          }

          if (!videoInfo || !videoInfo.videoDetails) {
            if (textChannel && typeof textChannel.send === 'function') {
              const msg = await textChannel.send('❌ 動画情報が取得できませんでした').catch(()=>null);
              if (msg && msg.deletable) {
                setTimeout(() => msg.delete().catch(()=>{}), 30000);
              }
            }
            setTimeout(() => playNext(guildId, textChannel, voiceChannel), 500);
            return;
          }

          ytdlStream = ytdl(url, { 
            filter: 'audioonly', 
            highWaterMark: 1 << 25,
            quality: 'highestaudio'
          });

          ytdlStream.on('error', (err) => {
            if (streamErrorOccurred) return;
            streamErrorOccurred = true;

            console.error('ytdl stream error:', err);
            const statusCode = err?.statusCode || err?.status || null;

            if (textChannel && typeof textChannel.send === 'function') {
              let errorMsg = '❌ 再生エラーが発生しました';
              if (statusCode === 410) {
                errorMsg = '❌ この動画は利用できません';
              } else if (statusCode === 403) {
                errorMsg = '❌ この動画へのアクセスが拒否されました';
              }

              textChannel.send(errorMsg).then(msg => {
                if (msg && msg.deletable) {
                  setTimeout(() => msg.delete().catch(()=>{}), 30000);
                }
              }).catch(()=>{});
            }

            setTimeout(() => playNext(guildId, textChannel, voiceChannel), 500);
          });

          const ffout = spawnFfmpegForStream(ytdlStream);
          if (!ffout) throw new Error('ffmpeg failed for ytdl-core stream');
          resource = createAudioResource(ffout, { inputType: StreamType.Raw });

        } catch (yerr) {
          console.error('ytdl fallback failed:', yerr);
          if (textChannel && typeof textChannel.send === 'function') {
            const msg = await textChannel.send(`❌ 再生に失敗しました: ${yerr.message || String(yerr)}`).catch(()=>null);
            if (msg && msg.deletable) {
              setTimeout(() => msg.delete().catch(()=>{}), 30000);
            }
          }
          setTimeout(() => playNext(guildId, textChannel, voiceChannel), 500);
          return;
        }
      } else {
        throw new Error('再生に必要な yt-dlp または ytdl-core が見つかりません。');
      }
    } else if (isAttachment) {
      // attachment URL -> use ffmpeg directly (ffmpeg reads URL)
      const ff = spawn(ffmpegPath, ['-i', url, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
      ff.on('error', e => console.error('ffmpeg spawn error:', e));
      resource = createAudioResource(ff.stdout, { inputType: StreamType.Raw });
    } else {
      resource = createAudioResource(url);
    }

    const player = createAudioPlayer();
    player.play(resource);
    player.on('error', err => {
      console.error('Audio player error:', err);
      if (textChannel && typeof textChannel.send === 'function') {
        textChannel.send(`❌ プレイヤーエラーが発生しました`).then(msg => {
          if (msg && msg.deletable) {
            setTimeout(() => msg.delete().catch(()=>{}), 30000);
          }
        }).catch(()=>{});
      }
      setTimeout(() => playNext(guildId, textChannel, voiceChannel), 1000);
    });
    player.on(AudioPlayerStatus.Idle, () => {
      setTimeout(() => playNext(guildId, textChannel, voiceChannel), 250);
    });

    const conn = connections.get(guildId);
    if (!conn && voiceChannel) await joinVoice(voiceChannel);
    const connection = connections.get(guildId);
    if (connection) connection.subscribe(player);
    players.set(guildId, player);

    if (textChannel && typeof textChannel.send === 'function') {
      const msg = await textChannel.send(`🎵 再生開始: **${title || '不明なタイトル'}**`).catch(()=>null);
      if (msg && msg.deletable) {
        setTimeout(() => msg.delete().catch(()=>{}), 30000);
      }
    }
  } catch (err) {
    console.error('再生エラー:', err);
    if (textChannel && typeof textChannel.send === 'function') {
      const msg = await textChannel.send(`❌ 再生できませんでした: **${title || '不明なタイトル'}**\n理由: ${err.message || err}`).catch(()=>null);
      if (msg && msg.deletable) {
        setTimeout(() => msg.delete().catch(()=>{}), 30000);
      }
    }
    setTimeout(() => playNext(guildId, textChannel, voiceChannel), 1000);
  }
}

async function playYouTube(channel, url, textChannel) {
  if (!channel) throw new Error('Voice channel is required');
  const guildId = channel.guild.id;
  await joinVoice(channel);

  let title = '不明なタイトル';
  try {
    if (hasYtDlp) {
      const p = spawnSync('yt-dlp', ['--get-title', '--no-warnings', url], { encoding: 'utf8', timeout: 5000 });
      if (p.status === 0 && p.stdout) title = p.stdout.trim();
    } else if (ytdl) {
      try {
        const info = await ytdl.getInfo(url).catch(()=>null);
        if (info && info.videoDetails && info.videoDetails.title) {
          title = info.videoDetails.title;
        }
      } catch (e) {
        console.warn('タイトル取得失敗:', e.message);
      }
    }
  } catch (e) {
    console.warn('タイトル取得でエラー:', e);
  }

  if (!queues.has(guildId)) queues.set(guildId, []);
  queues.get(guildId).push({ url, title, isYouTube: true, isAttachment: false });
  const isPlaying = players.get(guildId)?.state?.status === AudioPlayerStatus.Playing;
  if (!isPlaying) playNext(guildId, textChannel, channel);
  else if (textChannel && typeof textChannel.send === 'function') {
    const msg = await textChannel.send(`▶️ キューに追加: **${title}**`).catch(()=>null);
    if (msg && msg.deletable) {
      setTimeout(() => msg.delete().catch(()=>{}), 30000);
    }
  }
  return title;
}

async function playAttachment(channel, attachmentUrl, filename, textChannel) {
  if (!channel) throw new Error('Voice channel is required');
  const guildId = channel.guild.id;
  await joinVoice(channel);
  if (!queues.has(guildId)) queues.set(guildId, []);
  queues.get(guildId).push({ url: attachmentUrl, title: filename, isYouTube: false, isAttachment: true });
  const isPlaying = players.get(guildId)?.state?.status === AudioPlayerStatus.Playing;
  if (!isPlaying) playNext(guildId, textChannel, channel);
  else if (textChannel && typeof textChannel.send === 'function') {
    const msg = await textChannel.send(`▶️ キューに追加: **${filename}**`).catch(()=>null);
    if (msg && msg.deletable) {
      setTimeout(() => msg.delete().catch(()=>{}), 30000);
    }
  }
  return filename;
}

// public play: accepts (VoiceChannel, url, textChannel)
async function play(channel, url, textChannel, attachmentFilename = null) {
  if (!channel || !channel.guild) throw new Error('Voice channel is required');
  if (attachmentFilename) return playAttachment(channel, url, attachmentFilename, textChannel);
  if (typeof url === 'string' && (url.includes('youtube.com') || url.includes('youtu.be'))) return playYouTube(channel, url, textChannel);
  return playAttachment(channel, url, url.split('/').pop(), textChannel);
}

function stop(guildOrChannel) {
  const guildId = typeof guildOrChannel === 'string' ? guildOrChannel : (guildOrChannel?.guild?.id);
  const player = players.get(guildId);
  if (!player) return false;
  queues.set(guildId, []);
  try { player.stop(); } catch (e) { console.error('stop error:', e); }
  return true;
}

module.exports = {
  joinVoice,
  leaveVoice,
  play,
  stop,
  // compatibility aliases
  playUrl: async (...args) => play(...args),
  stopMusic: stop,
  players,
  queues,
  // expose detection for debugging
  _hasYtDlp: hasYtDlp
};