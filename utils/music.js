// utils/music.js
var voice = require('@discordjs/voice');
var joinVoiceChannel = voice.joinVoiceChannel;
var createAudioPlayer = voice.createAudioPlayer;
var createAudioResource = voice.createAudioResource;
var AudioPlayerStatus = voice.AudioPlayerStatus;
var StreamType = voice.StreamType;

var childProcess = require('child_process');
var spawn = childProcess.spawn;
var spawnSync = childProcess.spawnSync;
var path = require('path');
var ffmpegPath = require('ffmpeg-static');
var fs = require('fs');

var playdl = null;
try { playdl = require('play-dl'); } catch (e) { console.warn('[music] play-dl not found'); }

var connections = new Map();
var players = new Map();
var queues = new Map();

function findYtDlp() {
  var candidates = [
    path.join(__dirname, '../yt-dlp'),
    path.join(__dirname, '../bin/yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    '/root/.local/bin/yt-dlp',
  ];
  for (var i = 0; i < candidates.length; i++) {
    try {
      if (fs.existsSync(candidates[i])) {
        console.log('[music] yt-dlp found:', candidates[i]);
        return candidates[i];
      }
    } catch (_) {}
  }
  try {
    var r = spawnSync('which', ['yt-dlp'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout.trim();
  } catch (_) {}
  return null;
}
var ytDlpPath = findYtDlp();
console.log('[music] yt-dlp:', ytDlpPath || 'NOT FOUND');

function spawnYtdlpStream(url) {
  if (!ytDlpPath) return null;
  try {
    var cp = spawn(ytDlpPath, ['-f', 'bestaudio', '-o', '-', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cp.on('error', function(e) { console.error('[yt-dlp] error:', e.message); });
    return cp.stdout;
  } catch (e) {
    console.error('[yt-dlp] spawn failed:', e);
    return null;
  }
}

async function joinVoice(channel) {
  if (!channel || !channel.guild) throw new Error('Voice channel required');
  var guildId = channel.guild.id;
  if (!connections.has(guildId)) {
    var conn = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });
    conn.on('error', function(e) { console.error('[voice] error:', e); });
    connections.set(guildId, conn);
  }
  return connections.get(guildId);
}

async function leaveVoice(guildOrChannel) {
  var guildId = typeof guildOrChannel === 'string' ? guildOrChannel
    : (guildOrChannel && guildOrChannel.guild ? guildOrChannel.guild.id : null);
  if (!guildId) return false;
  var conn = connections.get(guildId);
  if (conn) { try { conn.destroy(); } catch (_) {} }
  connections.delete(guildId);
  var player = players.get(guildId);
  if (player) { try { player.stop(); } catch (_) {} }
  players.delete(guildId);
  queues.delete(guildId);
  return true;
}

async function safeSend(ch, text) {
  if (!ch || typeof ch.send !== 'function') return null;
  return ch.send(text).catch(function() { return null; });
}

function autoDelete(msg, ms) {
  if (msg && msg.deletable) setTimeout(function() { msg.delete().catch(function(){}); }, ms);
}

async function playNext(guildId, textChannel, voiceChannel) {
  var queue = queues.get(guildId);
  if (!queue || queue.length === 0) return;
  var item = queue.shift();
  var url = item.url;
  var title = item.title;
  var isYouTube = item.isYouTube;
  var isAttachment = item.isAttachment;

  try {
    var resource = null;

    if (isYouTube) {
      var ytdlpOut = spawnYtdlpStream(url);
      if (ytdlpOut) {
        var ff1 = spawn(ffmpegPath, ['-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], {
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        ff1.on('error', function(e) { console.error('[ffmpeg] error:', e); });
        ytdlpOut.pipe(ff1.stdin);
        resource = createAudioResource(ff1.stdout, { inputType: StreamType.Raw });

      } else if (playdl) {
        try {
          var stream = await playdl.stream(url, { quality: 2 });
          resource = createAudioResource(stream.stream, { inputType: stream.type });
        } catch (pdErr) {
          console.error('[play-dl] error:', pdErr.message);
          var m1 = await safeSend(textChannel, 'Stream error: ' + (pdErr.message || pdErr));
          autoDelete(m1, 30000);
          setTimeout(function() { playNext(guildId, textChannel, voiceChannel); }, 500);
          return;
        }
      } else {
        var m2 = await safeSend(textChannel, 'No playback engine found.');
        autoDelete(m2, 30000);
        setTimeout(function() { playNext(guildId, textChannel, voiceChannel); }, 500);
        return;
      }

    } else if (isAttachment) {
      var ff2 = spawn(ffmpegPath, ['-i', url, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      ff2.on('error', function(e) { console.error('[ffmpeg] error:', e); });
      resource = createAudioResource(ff2.stdout, { inputType: StreamType.Raw });

    } else {
      resource = createAudioResource(url);
    }

    var player = createAudioPlayer();
    player.on('error', async function(err) {
      console.error('[player] error:', err);
      var m3 = await safeSend(textChannel, 'Player error: ' + err.message);
      autoDelete(m3, 30000);
      setTimeout(function() { playNext(guildId, textChannel, voiceChannel); }, 1000);
    });
    player.on(AudioPlayerStatus.Idle, function() {
      setTimeout(function() { playNext(guildId, textChannel, voiceChannel); }, 250);
    });

    if (!connections.has(guildId) && voiceChannel) await joinVoice(voiceChannel);
    var conn2 = connections.get(guildId);
    if (conn2) conn2.subscribe(player);
    players.set(guildId, player);
    player.play(resource);

    var startMsg = await safeSend(textChannel, '\uD83C\uDFB5 ' + (title || url));
    autoDelete(startMsg, 30000);

  } catch (err) {
    console.error('[music] playNext error:', err);
    var m4 = await safeSend(textChannel, 'Playback failed: ' + (err.message || err));
    autoDelete(m4, 30000);
    setTimeout(function() { playNext(guildId, textChannel, voiceChannel); }, 1000);
  }
}

async function playYouTube(channel, url, textChannel) {
  if (!channel) throw new Error('Voice channel required');
  var guildId = channel.guild.id;
  await joinVoice(channel);

  var title = url;
  try {
    if (ytDlpPath) {
      var p = spawnSync(ytDlpPath, ['--get-title', '--no-warnings', url], {
        encoding: 'utf8', timeout: 10000,
      });
      if (p.status === 0 && p.stdout) title = p.stdout.trim();
    } else if (playdl) {
      var info = await playdl.video_info(url).catch(function() { return null; });
      if (info && info.video_details && info.video_details.title) title = info.video_details.title;
    }
  } catch (e) { console.warn('[music] title fetch failed:', e.message); }

  if (!queues.has(guildId)) queues.set(guildId, []);
  queues.get(guildId).push({ url: url, title: title, isYouTube: true, isAttachment: false });

  var ps = players.get(guildId);
  var isPlaying = ps && ps.state && ps.state.status === AudioPlayerStatus.Playing;
  if (!isPlaying) {
    playNext(guildId, textChannel, channel);
  } else {
    var qMsg = await safeSend(textChannel, 'Queued: **' + title + '**');
    autoDelete(qMsg, 30000);
  }
  return title;
}

async function playAttachment(channel, attachmentUrl, filename, textChannel) {
  if (!channel) throw new Error('Voice channel required');
  var guildId = channel.guild.id;
  await joinVoice(channel);
  if (!queues.has(guildId)) queues.set(guildId, []);
  queues.get(guildId).push({ url: attachmentUrl, title: filename, isYouTube: false, isAttachment: true });

  var ps2 = players.get(guildId);
  var isPlaying2 = ps2 && ps2.state && ps2.state.status === AudioPlayerStatus.Playing;
  if (!isPlaying2) {
    playNext(guildId, textChannel, channel);
  } else {
    var aMsg = await safeSend(textChannel, 'Queued: **' + filename + '**');
    autoDelete(aMsg, 30000);
  }
  return filename;
}

async function play(channel, url, textChannel, attachmentFilename) {
  if (!channel || !channel.guild) throw new Error('Voice channel required');
  if (attachmentFilename) return playAttachment(channel, url, attachmentFilename, textChannel);
  if (typeof url === 'string' && (url.indexOf('youtube.com') !== -1 || url.indexOf('youtu.be') !== -1)) {
    return playYouTube(channel, url, textChannel);
  }
  return playAttachment(channel, url, url.split('/').pop(), textChannel);
}

function stop(guildOrChannel) {
  var guildId = typeof guildOrChannel === 'string' ? guildOrChannel
    : (guildOrChannel && guildOrChannel.guild ? guildOrChannel.guild.id : null);
  if (!guildId) return false;
  var player = players.get(guildId);
  if (!player) return false;
  queues.set(guildId, []);
  try { player.stop(); } catch (e) { console.error('[music] stop error:', e); }
  return true;
}

module.exports = {
  joinVoice: joinVoice,
  leaveVoice: leaveVoice,
  play: play,
  stop: stop,
  playUrl: play,
  stopMusic: stop,
  players: players,
  queues: queues,
  _hasYtDlp: !!ytDlpPath,
};
