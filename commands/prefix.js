// commands/prefix.js
const {
  hasManageGuildPermission,
  backupServer,
  restoreServer,
  nukeChannel,
  clearMessages,
  addRoleToAll,
  resetServerChannels,
} = require("../utils/guild");
const { PermissionFlagsBits } = require('discord.js');
const {
  addMessage,
  getRanking,
  updateActiveRoles,
} = require("../utils/activity");
const { chat, checkAiCooldown, setAiCooldown } = require("../utils/ai");
const {
  saveUserWeatherPref,
  loadUserWeatherPref,
  fetchWeather,
} = require("../utils/weather");
const { quizManager, activeUsers } = require("../utils/quiz");
const translate = require('@iamtraction/google-translate');
const { autoDeleteMessage } = require('../utils/messaging');

const CMD_PREFIX = "!";
const cooldowns = new Map();
const COOLDOWN_TIME = 10;
const SERVER_COOLDOWN_TIME = 2;
const serverCooldowns = new Map();
const AUTO_DELETE_COMMANDS = ["help", "ping", "ai", "クイズ", "英語", "天気"];
const AUTO_DELETE_SECONDS = 30;
const processedPrefixMessages = new Map();
const PREFIX_DEDUP_TTL_MS = 5 * 60 * 1000;

const helpMessage = `
**このボットについて**
- 🎶 音楽再生 / 📝 AIチャット / 📚 クイズ / 🌤️ 天気情報 / 🔨 サーバー管理 / 🛡️ 荒らし対策
**コマンド一覧**
!help | !ping | !uptime | !天気 | !クイズ | !ai | !英語 | !nuke | !join | !play | !stop | !leave | !backup | !restore | !addrole | !clear | !ranking | !reset
`;

module.exports = async function handlePrefixMessage(client, msg) {
  if (msg.author.bot) return;
  if (!msg.guild) return;

  const content = (msg.content || "").trim();
  if (!content.startsWith(CMD_PREFIX)) return;
  const now = Date.now();
  const processedAt = processedPrefixMessages.get(msg.id);
  if (processedAt && now - processedAt < PREFIX_DEDUP_TTL_MS) return;
  processedPrefixMessages.set(msg.id, now);
  for (const [id, ts] of processedPrefixMessages.entries()) {
    if (now - ts > PREFIX_DEDUP_TTL_MS) processedPrefixMessages.delete(id);
  }

  autoDeleteMessage(msg, AUTO_DELETE_SECONDS);
  const args = content.slice(CMD_PREFIX.length).split(/\s+/);
  let cmd = args.shift()?.toLowerCase();

  const numSuffixMatch = cmd?.match(/^([a-z\u3040-\u30ff\u4e00-\u9fff]+)(\d+)$/);
  if (numSuffixMatch) {
    cmd = numSuffixMatch[1];
    args.unshift(numSuffixMatch[2]);
  }

  const lastServerUsed = serverCooldowns.get(msg.guild.id) || 0;
  if (Date.now() - lastServerUsed < SERVER_COOLDOWN_TIME * 1000) return;
  serverCooldowns.set(msg.guild.id, Date.now());

  if (cooldowns.has(msg.author.id)) {
    const lastUsed = cooldowns.get(msg.author.id);
    if (Date.now() - lastUsed < COOLDOWN_TIME * 1000) return;
  }
  cooldowns.set(msg.author.id, Date.now());

  async function safeReplyAndDelete(text) {
    const r = await msg.reply(text).catch(() => null);
    if (r) autoDeleteMessage(r, AUTO_DELETE_SECONDS);
    return r;
  }

  async function safeReplyErrorAndDelete(text) {
    const r = await msg.reply(text).catch(() => null);
    if (r) autoDeleteMessage(r, AUTO_DELETE_SECONDS);
    return r;
  }

  switch (cmd) {
    case "help":
      await msg.author.send(helpMessage).catch(() => {});
      await safeReplyAndDelete("ヘルプをDMに送信しました。");
      break;
    case "ping":
      await safeReplyAndDelete("Pong!");
      break;
    case "uptime":
      const uptime = process.uptime();
      await safeReplyAndDelete(`稼働時間: ${Math.floor(uptime/3600)}時間${Math.floor((uptime%3600)/60)}分${Math.floor(uptime%60)}秒`);
      break;
    case "天気": {
      const place = args[0] || "東京";
      const weather = await fetchWeather(place);
      if (!weather) {
        await safeReplyErrorAndDelete(`「${place}」の天気情報を取得できませんでした。地名を確認してください。`);
      } else {
        await safeReplyAndDelete(weather);
      }
      break;
    }
case "クイズ":
  await quizManager(msg, msg.author);  // msg.channel → msg
      break;
    case "ai": {
      const input = args.join(" ");
      if (!input) {
        await safeReplyErrorAndDelete("AIに聞きたいことを入力してください。");
        return;
      }
      const cooldown = checkAiCooldown(msg.author.id);
      if (cooldown) {
        const msgText = cooldown.type === 'global' 
          ? "AIが混み合っています。少し時間を置いてから試してね！" 
          : `AIはクールダウン中です。あと ${cooldown.remaining} 秒待ってね！`;
        await safeReplyErrorAndDelete(msgText);
        return;
      }
      const aiReply = await chat(input, msg.author.id);
      const reply = await msg.reply(aiReply).catch(() => null);
      if (reply) autoDeleteMessage(reply, AUTO_DELETE_SECONDS);
      break;
    }
    case "英語": {
      const input = args.join(" ");
      if (!input) {
        await safeReplyErrorAndDelete("翻訳する内容を入力してください。");
        return;
      }
      const result = await translate(input, { to: "en" });
      const reply = await msg.reply(result.text).catch(() => null);
      if (reply) autoDeleteMessage(reply, AUTO_DELETE_SECONDS);
      break;
    }
    case "nuke":
      if (!hasManageGuildPermission(msg.member)) return safeReplyErrorAndDelete("権限がありません。");
      await nukeChannel(msg.channel);
      break;
    case "join":
      if (!msg.member?.voice?.channel) return safeReplyErrorAndDelete("VCに参加してください。");
      try {
        const musicUtil = require("../utils/music");
        await musicUtil.joinVoice(msg.member.voice.channel);
        await safeReplyAndDelete(`✅ **${msg.member.voice.channel.name}** に参加しました！`);
      } catch (err) { await safeReplyErrorAndDelete(`失敗: ${err.message}`); }
      break;
    case "play":
      if (!msg.member?.voice?.channel) return safeReplyErrorAndDelete("VCに参加してください。");
      const query = args.join(" ");
      if (!query) return safeReplyErrorAndDelete("検索ワードを指定してください。");
      try {
        const musicUtil = require("../utils/music");
        await musicUtil.joinVoice(msg.member.voice.channel);
        await musicUtil.play(msg.member.voice.channel, query, msg.channel);
      } catch (err) { await safeReplyErrorAndDelete(`失敗: ${err.message}`); }
      break;
    case "stop":
      try {
        const musicUtil = require("../utils/music");
        if (musicUtil.stop(msg.guild.id)) await safeReplyAndDelete("⏹️ 再生を停止しました。");
        else await safeReplyErrorAndDelete("再生中の音楽がありません。");
      } catch (e) { await safeReplyErrorAndDelete("停止エラー"); }
      break;
    case "leave":
      try {
        const musicUtil = require("../utils/music");
        if (await musicUtil.leaveVoice(msg.guild.id)) await safeReplyAndDelete("👋 VCから退出しました。");
        else await safeReplyErrorAndDelete("VCに参加していません。");
      } catch (e) { await safeReplyErrorAndDelete("退出エラー"); }
      break;
    case "backup":
      if (!hasManageGuildPermission(msg.member)) return safeReplyErrorAndDelete("権限がありません。");
      await backupServer(msg.guild);
      await safeReplyAndDelete("サーバーバックアップが完了しました。");
      break;
    case "restore":
      if (!hasManageGuildPermission(msg.member)) return safeReplyErrorAndDelete("権限がありません。");
      if (!args[0]) return safeReplyErrorAndDelete("復元ファイル名を指定してください。");
      await restoreServer(msg.guild, msg.channel, args[0]);
      await safeReplyAndDelete("サーバー復元が完了しました。");
      break;
    case "addrole":
      if (!hasManageGuildPermission(msg.member)) return safeReplyErrorAndDelete("権限がありません。");
      const roleName = args.join(" ");
      if (!roleName) return safeReplyErrorAndDelete("ロール名を指定してください。");
      await addRoleToAll(msg.guild, roleName);
      await safeReplyAndDelete(`全ユーザーにロール「${roleName}」を付与しました。`);
      break;
    case "clear":
      if (!msg.member.permissions.has(PermissionFlagsBits.ManageMessages)) return safeReplyErrorAndDelete("権限がありません。");
      const amount = parseInt(args[0]);
      if (isNaN(amount) || amount < 1) return safeReplyErrorAndDelete("削除数を指定してください。");
      const targetMember = msg.mentions.members.first() || null;
      await msg.delete().catch(() => {});
      await clearMessages(msg.channel, amount, msg.channel, targetMember);
      break;
    case "ranking":
      const ranking = getRanking(msg.guild.id);
      if (!ranking.length) return safeReplyErrorAndDelete("ランキングデータはありません。");
      const rankingStr = ranking.map((u, i) => `${i + 1}位 <@${u.userId}>: ${u.count}回`).join("\n");
      await safeReplyAndDelete(`**月間アクティブユーザーランキング**\n${rankingStr}`);
      break;
    case "reset":
      if (!hasManageGuildPermission(msg.member)) return safeReplyErrorAndDelete("権限がありません。");
      await resetServerChannels(msg.guild, msg.channel);
      await safeReplyAndDelete("サーバーのチャンネルをリセットしました。");
      break;
    default:
      break;
  }
};
