// commands/play.js
// 依頼事項2：yt-dlp → ffmpeg パイプ方式による音声再生
// yt-dlp の stdout を直接 ffmpeg stdin にパイプし、Opus に変換して Discord へ送る
'use strict';

const { SlashCommandBuilder }  = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');
const { spawnSync } = require('child_process');

// ─── yt-dlp / ffmpeg パス解決 ────────────────────────────
function findYtDlp() {
  const candidates = [
    path.join(__dirname, '../yt-dlp'),        // プロジェクトルートに同梱
    path.join(__dirname, '../bin/yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    '/root/.local/bin/yt-dlp',
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  try {
    const r = spawnSync('which', ['yt-dlp'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch (_) {}
  return null;
}

function findFfmpeg() {
  // ffmpeg-static がインストールされていれば優先使用
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch (_) {}
  // Dockerfile で直接インストールされている場合
  for (const p of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  try {
    const r = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch (_) {}
  return 'ffmpeg'; // PATH に任せる
}

const YT_DLP_PATH = findYtDlp();
const FFMPEG_PATH = findFfmpeg();
console.log('[play] yt-dlp:', YT_DLP_PATH || 'NOT FOUND');
console.log('[play] ffmpeg:', FFMPEG_PATH);

// ─── ギルドごとの状態管理 ────────────────────────────────
const connections = new Map(); // guildId → VoiceConnection
const players     = new Map(); // guildId → AudioPlayer
const queues      = new Map(); // guildId → [{url, title}]

// ─── 依頼事項2 コア：yt-dlp → ffmpeg パイプでストリーム生成 ─
/**
 * yt-dlp の stdout を ffmpeg stdin にパイプし、
 * Discord 用 Opus ストリーム（48000Hz 2ch）の AudioResource を返す。
 *
 * @param {string} videoUrl  YouTube などの動画 URL
 * @returns {{ resource: AudioResource, ytDlpProc: ChildProcess, ffmpegProc: ChildProcess }}
 */
function createYtDlpFfmpegResource(videoUrl) {
  if (!YT_DLP_PATH) throw new Error('yt-dlp が見つかりません。PATH を確認してください。');

  // ── Step 1: yt-dlp を起動し、最高音質の音声を stdout に流す ──
  const ytDlpProc = spawn(YT_DLP_PATH, [
    '--format', 'bestaudio/best',   // 最高音質の音声トラックを選択
    '--no-playlist',                 // プレイリストは無視
    '--no-warnings',
    '-o', '-',                       // 標準出力へ出力（パイプ用）
    videoUrl,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'], // stdout をパイプとして受け取る
  });

  ytDlpProc.stderr.on('data', d => {
    const msg = d.toString();
    // 通常のダウンロード進捗は debug レベルのみ記録
    if (!/^\[download\]/.test(msg)) console.warn('[yt-dlp]', msg.trim());
  });
  ytDlpProc.on('error', err => console.error('[yt-dlp] spawn error:', err.message));

  // ── Step 2: ffmpeg で Discord 用 Opus（48000Hz, 2ch）に変換 ──
  const ffmpegProc = spawn(FFMPEG_PATH, [
    '-i',    'pipe:0',  // stdin からの入力（yt-dlp の stdout が来る）
    '-vn',              // 映像ストリームを無効化
    '-f',    's16le',   // PCM signed 16-bit little-endian（@discordjs/voice の Raw 入力形式）
    '-ar',   '48000',   // サンプリングレート 48000Hz（Discord 標準）
    '-ac',   '2',       // ステレオ 2ch
    '-loglevel', 'error',
    'pipe:1',           // stdout へ出力
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  ffmpegProc.stderr.on('data', d => console.error('[ffmpeg]', d.toString().trim()));
  ffmpegProc.on('error', err => console.error('[ffmpeg] spawn error:', err.message));

  // ── Step 3: yt-dlp の stdout → ffmpeg の stdin にパイプ接続 ──
  ytDlpProc.stdout.pipe(ffmpegProc.stdin);

  // yt-dlp が終了したら ffmpeg の stdin も閉じる（EOF を伝える）
  ytDlpProc.stdout.on('end', () => {
    try { ffmpegProc.stdin.end(); } catch (_) {}
  });
  ytDlpProc.on('close', code => {
    if (code !== 0) console.warn(`[yt-dlp] exited with code ${code}`);
    try { ffmpegProc.stdin.end(); } catch (_) {}
  });
  ffmpegProc.on('close', code => {
    if (code !== 0) console.warn(`[ffmpeg] exited with code ${code}`);
  });

  // ── Step 4: ffmpeg の stdout を AudioResource に変換 ──
  // StreamType.Raw = PCM s16le 生データ（@discordjs/voice が Opus へエンコード）
  const resource = createAudioResource(ffmpegProc.stdout, {
    inputType:     StreamType.Raw,
    inlineVolume:  false, // 必要なら true に変更してボリューム制御可能
  });

  return { resource, ytDlpProc, ffmpegProc };
}

// ─── タイトル取得（同期 spawnSync） ─────────────────────
function fetchTitle(videoUrl) {
  if (!YT_DLP_PATH) return videoUrl;
  try {
    const r = spawnSync(YT_DLP_PATH, [
      '--print', 'title',
      '--no-warnings',
      '--no-playlist',
      videoUrl,
    ], { encoding: 'utf8', timeout: 10000 });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch (_) {}
  return videoUrl;
}

// ─── 再生キュー処理 ──────────────────────────────────────
async function playNext(guildId, textChannel, voiceChannel) {
  const queue = queues.get(guildId);
  if (!queue || queue.length === 0) return;
  const { url, title } = queue.shift();

  console.log('[play] playNext:', title);

  let ytDlpProc, ffmpegProc;
  try {
    ({ resource: resource, ytDlpProc, ffmpegProc } = createYtDlpFfmpegResource(url));
  } catch (err) {
    console.error('[play] stream creation error:', err.message);
    if (textChannel) textChannel.send(`❌ ストリーム作成失敗: ${err.message}`).catch(() => {});
    setTimeout(() => playNext(guildId, textChannel, voiceChannel), 1000);
    return;
  }

  var resource; // ESLint 対策（上記 destructuring 前の宣言）
  // ↑ 実際には createYtDlpFfmpegResource の戻り値を受けているので問題なし

  const player = createAudioPlayer();

  player.on('error', err => {
    console.error('[player] error:', err.message);
    // プロセスをクリーンアップ
    try { ytDlpProc.kill('SIGTERM'); } catch (_) {}
    try { ffmpegProc.kill('SIGTERM'); } catch (_) {}
    if (textChannel) textChannel.send(`❌ 再生エラー: ${err.message}`).catch(() => {});
    setTimeout(() => playNext(guildId, textChannel, voiceChannel), 1000);
  });

  player.on(AudioPlayerStatus.Idle, () => {
    console.log('[play] track ended');
    try { ytDlpProc.kill('SIGTERM'); } catch (_) {}
    try { ffmpegProc.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => playNext(guildId, textChannel, voiceChannel), 250);
  });

  // ボイス接続が無ければ作成
  if (!connections.has(guildId) && voiceChannel) {
    const conn = joinVoiceChannel({
      channelId:      voiceChannel.id,
      guildId:        voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });
    conn.on('error', e => console.error('[voice] connection error:', e));
    connections.set(guildId, conn);
    // 接続確立まで待機
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
    } catch (_) {
      conn.destroy();
      connections.delete(guildId);
      if (textChannel) textChannel.send('❌ ボイスチャンネルへの接続に失敗しました。').catch(() => {});
      return;
    }
  }

  const conn = connections.get(guildId);
  if (conn) conn.subscribe(player);
  players.set(guildId, player);

  // ── ここで実際に再生開始 ──
  player.play(resource);
  console.log('[play] player.play() called for:', title);

  if (textChannel) textChannel.send(`🎵 再生中: **${title}**`).catch(() => {});
}

// ─── スラッシュコマンド定義 ──────────────────────────────
const command = new SlashCommandBuilder()
  .setName('play')
  .setDescription('YouTubeの音楽を再生します（yt-dlp + ffmpeg パイプ方式）')
  .addStringOption(opt =>
    opt.setName('url')
       .setDescription('YouTube の URL')
       .setRequired(true)
  );

// ─── スラッシュコマンドハンドラ ─────────────────────────
async function execute(interaction) {
  const url         = interaction.options.getString('url');
  const voiceChannel = interaction.member?.voice?.channel;

  if (!voiceChannel) {
    return interaction.reply({ content: '❌ ボイスチャンネルに参加してから実行してください。', ephemeral: true });
  }

  await interaction.deferReply();

  const guildId = interaction.guild.id;
  const title   = fetchTitle(url); // タイトルを事前に取得

  if (!queues.has(guildId)) queues.set(guildId, []);
  queues.get(guildId).push({ url, title });

  const currentPlayer = players.get(guildId);
  const isPlaying     = currentPlayer?.state?.status === AudioPlayerStatus.Playing;

  if (!isPlaying) {
    await interaction.editReply(`🎵 再生を開始します: **${title}**`);
    playNext(guildId, interaction.channel, voiceChannel);
  } else {
    await interaction.editReply(`📋 キューに追加しました: **${title}**`);
  }
}

module.exports = {
  command,
  execute,
  // ユーティリティのエクスポート（他モジュールからも利用可能）
  createYtDlpFfmpegResource,
  connections,
  players,
  queues,
};
