// utils/music.js
const voice = require('@discordjs/voice');
const { spawn, spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');

// play-dl
var playdl = null;
try {
  playdl = require('play-dl');
} catch (e) {
  console.warn('[music] play-dl not found:', e.message);
}

var connections = new Map();
var players = new Map();
var queues = new Map();

function isYtDlpAvailable() {
  try {
    var r = spawnSync('which', ['yt-dlp'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout && r.stdout.trim()) return true;
  } catch (e) { }
  var candidates = ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', '/root/.local/bin/yt-dlp'];
  for (var i = 0; i < candidates.length; i++) {
    try { if (fs.existsSync(candidates[i])) return true; } catch (e) { }
  }
  return false;
}

var hasYtDlp = isYtDlpAvailable();
console.log('[music] yt-dlp available:', hasYtDlp);

function spawnYtdlpStream(url) {
  if (!hasYtDlp) return null;
  try {
    var cp = spawn('yt-dlp', ['-f', 'bestaudio', '-o', '-', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return cp.stdout;
  } catch (err) {
    return null;
  }
}

async function joinVoice(channel) {
  if (!channel || !channel.guild) throw new Error('Voice channel required');
  var guildId = channel.guild.id;
  if (!connections.has(guildId)) {
    var conn = voice.joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });
    connections.set(guildId, conn);
  }
  return connections.get(guildId);
}

async function playNext(guildId, textChannel, voiceChannel) {
  var queue = queues.get(guildId);
  if (!queue || queue.length === 0) return;
  var item = queue.shift();
  
  try {
    var resource = null;
    if (item.isYouTube) {
      var ytdlpOut = spawnYtdlpStream(item.url);
      if (ytdlpOut) {
        var ff = spawn(ffmpegPath, ['-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
        ytdlpOut.pipe(ff.stdin);
        resource = voice.createAudioResource(ff.stdout, { inputType: voice.StreamType.Raw });
      } else if (playdl) {
        var stream = await playdl.stream(item.url, { quality: 2 });
        resource = voice.createAudioResource(stream.stream, { inputType: stream.type });
      }
    } else {
      resource = voice.createAudioResource(item.url);
    }

    var player = voice.createAudioPlayer();
    player.on(voice.AudioPlayerStatus.Idle, () => playNext(guildId, textChannel, voiceChannel));
    
    var conn = await joinVoice(voiceChannel);
    conn.subscribe(player);
    players.set(guildId, player);
    player.play(resource);
    textChannel.send('🎵 Playing: **' + item.title + '**').catch(() => {});
  } catch (e) {
    console.error(e);
    playNext(guildId, textChannel, voiceChannel);
  }
}

async function play(channel, url, textChannel) {
  var guildId = channel.guild.id;
  if (!queues.has(guildId)) queues.set(guildId, []);
  
  var title = url;
  var isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
  
  queues.get(guildId).push({ url, title, isYouTube });
  
  var currentPlayer = players.get(guildId);
  if (!currentPlayer || currentPlayer.state.status !== voice.AudioPlayerStatus.Playing) {
    playNext(guildId, textChannel, channel);
  } else {
    textChannel.send('✅ Added to queue').catch(() => {});
  }
}

function stop(guildId) {
  var player = players.get(guildId);
  if (player) player.stop();
  queues.set(guildId, []);
}

module.exports = { play, stop, leaveVoice: (id) => {
  var conn = connections.get(id);
  if (conn) conn.destroy();
  connections.delete(id);
} };
