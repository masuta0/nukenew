const {
  hasManageGuildPermission,
  backupServer,
  restoreServer,
  nukeChannel,
  clearMessages,
  addRoleToAll,
  resetServerChannels,
} = require("../utils/guild");
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

const AUTO_DELETE_COMMANDS = [
  "help", "ping", "ai", "クイズ", "英語", "天気"
];

const AUTO_DELETE_SECONDS = 30;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const helpMessage = `
**このボットについて**

- 🎶 音楽再生
- 📝 AIチャット
- 📚 クイズ
- 🌤️ 天気情報
- 🔨 サーバー管理
- 🛡️ 荒らし対策

**コマンド一覧**
| コマンド | 説明 |
|---|---|
| !help | ヘルプをDMで送信 |
| !ping | 応答確認 |
| !uptime | 稼働時間表示 |
| !天気 [場所] | 天気取得 |
| !クイズ | クイズ出題 |
| !ai [内容] | AIチャット |
| !英語(他言語) | 翻訳 |
| !nuke | チャンネルNuke |
| !join | VC参加 |
| !play [URL/検索] | 音楽再生 |
| !stop | 再生停止 |
| !leave | VC退出 |
| !backup | サーバーバックアップ |
| !restore [ファイル名] | サーバー復元（ファイル名省略時はサーバーID） |
| !addrole [ロール名] | 全ユーザーロール付与 |
| !clear [数] [@ユーザー] | メッセージ削除 |
| !ranking | 月間アクティブユーザーランキング |
| !reset | サーバーのチャンネルをリセット（管理者限定） |
`;

const RANKING_BANNED_CHANNELS = [
  '雑談',
];

module.exports = async function handlePrefixMessage(client, msg) {
  if (msg.author.bot) return;
  if (!msg.guild) return;

  const content = (msg.content || "").trim();
  if (!content.startsWith(CMD_PREFIX)) return;

  autoDeleteMessage(msg, AUTO_DELETE_SECONDS);

  const args = content.slice(CMD_PREFIX.length).split(/\s+/);
  let cmd = args.shift()?.toLowerCase();

  // !clear4 や !clear 4 など数字がコマンド名に直結している場合に対応
  // 例: cmd="clear4" → cmd="clear", args=["4", ...]
  const numSuffixMatch = cmd?.match(/^([a-z\u3040-\u30ff\u4e00-\u9fff]+)(\d+)$/);
  if (numSuffixMatch) {
    cmd = numSuffixMatch[1];
    args.unshift(numSuffixMatch[2]);
  }

  // サーバー全体クールダウン
  const lastServerUsed = serverCooldowns.get(msg.guild.id) || 0;
  if (Date.now() - lastServerUsed < SERVER_COOLDOWN_TIME * 1000) {
    return;
  }
  serverCooldowns.set(msg.guild.id, Date.now());

  // ユーザー個別クールダウン
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
    case "help": {
      await msg.author.send(helpMessage).catch(() => {});
      const reply = await msg.reply("ヘルプをDMに送信しました。");
      if (reply) autoDeleteMessage(reply, AUTO_DELETE_SECONDS);
      break;
    }

    case "ping": {
      await safeReplyAndDelete("Pong!");
      break;
    }

    case "uptime": {
      const uptime = process.uptime();
      const h = Math.floor(uptime / 3600);
      const m = Math.floor((uptime % 3600) / 60);
      const s = Math.floor(uptime % 60);
      await safeReplyAndDelete(`稼働時間: ${h}時間${m}分${s}秒`);
      break;
    }

    case "天気": {
      const place = args[0] || "東京";
      const weather = await fetchWeather(place);
      await safeReplyAndDelete(`${place}の天気: ${weather}`);
      break;
    }

    case "クイズ": {
      await quizManager(msg.channel, msg.author);
      break;
    }

    case "ai": {
      const input = args.join(" ");
      if (!input) {
        await safeReplyErrorAndDelete("AIに聞きたいことを入力してください。");
        return;
      }

      // AI専用のクールダウンチェックを呼び出す
      const cooldown = checkAiCooldown(msg.author.id);
      if (cooldown) {
        // 全体制限(global)か個人制限(user)かで返信を変える
        const msgText = cooldown.type === 'global' 
          ? "AIが混み合っています。少し時間を置いてから試してね！" 
          : `AIはクールダウン中です。あと ${cooldown.remaining} 秒待ってね！`;
        
        await safeReplyErrorAndDelete(msgText);
        return;
      }

      // 注意：setAiCooldown は ai.js の chat 関数内で成功時に自動実行されるため、ここでは呼びません。
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

    case "nuke": {
      if (!hasManageGuildPermission(msg.member)) {
        await safeReplyErrorAndDelete("権限がありません。");
        return;
      }
      await nukeChannel(msg.channel);
      break;
    }

    case "join": {
      if (!msg.member?.voice?.channel) {
        await safeReplyErrorAndDelete("VCに参加してください。");
        return;
      }
      try {
        const music = require("../utils/music");
        await music.joinVoice(msg.member.voice.channel);
        const reply = await msg.reply(`✅ **${msg.member.voice.channel.name}** に参加しました！`);
        if (reply) autoDeleteMessage(reply, AUTO_DELETE_SECONDS);
      } catch (err) {
        console.error("join command error:", err);
        await safeReplyErrorAndDelete(`VC参加に失敗しました: ${err.message || String(err)}`);
      }
      break;
    }

    case "play": {
      if (!msg.member?.voice?.channel) {
        await safeReplyErrorAndDelete("VCに参加してください。");
        return;
      }
      const query = args.join(" ");
      if (!query) {
        await safeReplyErrorAndDelete("再生するURLまたは検索ワードを指定してください。");
        return;
      }
      try {
        const music = require("../utils/music");
        await music.joinVoice(msg.member.voice.channel);
        const title = await music.play(msg.member.voice.channel, query, msg.channel);
        if (title) {
          console.log(`✅ 再生/キュー追加: ${title}`);
        }
      } catch (err) {
        console.error("play command error:", err);
        await safeReplyErrorAndDelete(`再生に失敗しました: ${err.message || String(err)}`);
      }
      break;
    }

    case "stop": {
      try {
        const music = require("../utils/music");
        const stopped = music.stop(msg.guild.id);
        if (stopped) {
          const reply = await msg.reply("⏹️ 再生を停止しました。");
          if (reply) autoDeleteMessage(reply, AUTO_DELETE_SECONDS);
        } else {
          await safeReplyErrorAndDelete("再生中の音楽がありません。");
        }
      } catch (e) {
        console.error("stop error:", e);
        await safeReplyErrorAndDelete("停止処理でエラーが発生しました。");
      }
      break;
    }

    case "leave": {
      try {
        const music = require("../utils/music");
        const left = await music.leaveVoice(msg.guild.id);
        if (left) {
          const reply = await msg.reply("👋 VCから退出しました。");
          if (reply) autoDeleteMessage(reply, AUTO_DELETE_SECONDS);
        } else {
          await safeReplyErrorAndDelete("VCに参加していません。");
        }
      } catch (e) {
        console.error("leave error:", e);
        await safeReplyErrorAndDelete("VC退出処理でエラーが発生しました。");
      }
      break;
    }

    case "backup": {
      if (!hasManageGuildPermission(msg.member)) {
        await safeReplyErrorAndDelete("権限がありません。");
        return;
      }
      await backupServer(msg.guild);
      const reply = await msg.reply("サーバーバックアップが完了しました。");
      if (reply) autoDeleteMessage(reply, AUTO_DELETE_SECONDS);
      break;
    }

    case "restore": {
      if (!hasManageGuildPermission(msg.member)) {
        await safeReplyErrorAndDelete("権限がありません。");
        return;
      }
      const filename = args[0];
      await restoreServer(msg.guild, msg.channel, filename);
      const reply = await msg.reply("サーバー復元が完了しました。");
      if (reply) autoDeleteMessage(reply, AUTO_DELETE_SECONDS);
      break;
    }

    case "addrole": {
      if (!hasManageGuildPermission(msg.member)) {
        await safeReplyErrorAndDelete("権限がありません。");
        return;
      }
      const roleName = args.join(" ");
      if (!roleName) {
        await safeReplyErrorAndDelete("ロール名を指定してください。");
        return;
      }
      await addRoleToAll(msg.guild, roleName);
      const reply = await msg.reply(`全ユーザーにロール「${roleName}」を付与しました。`);
      if (reply) autoDeleteMessage(reply, AUTO_DELETE_SECONDS);
      break;
    }

    case "clear": {
      if (!msg.member.permissions.has("MANAGE_MESSAGES")) {
        await safeReplyErrorAndDelete("権限がありません。");
        return;
      }
      const amount = parseInt(args[0]);
      if (isNaN(amount) || amount < 1) {
        await safeReplyErrorAndDelete("削除数を指定してください。");
        return;
      }
      const targetMember = msg.mentions.members.first() || null;
      await msg.delete().catch(() => {});
      await clearMessages(msg.channel, amount, msg.channel, targetMember);
      break;
    }

    case "ranking": {
      const ranking = await getRanking(msg.guild);
      if (!ranking.length) {
        await safeReplyErrorAndDelete("今月のランキングデータはありません。");
        return;
      }
      const rankingStr = ranking.map((u, i) => `${i + 1}位 <@${u.userId}>: ${u.count}回`).join("\n");
      const reply = await msg.reply(`**月間アクティブユーザーランキング**\n${rankingStr}`);
      if (reply) autoDeleteMessage(reply, AUTO_DELETE_SECONDS);
      break;
    }

    case "reset": {
      if (!hasManageGuildPermission(msg.member)) {
        await safeReplyErrorAndDelete("権限がありません。");
        return;
      }
      await resetServerChannels(msg.guild, msg.channel);
      const reply = await msg.reply("サーバーのチャンネルをリセットしました。");
      if (reply) autoDeleteMessage(reply, AUTO_DELETE_SECONDS);
      break;
    }

    default:
      break;
  }
};
