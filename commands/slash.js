// commands/slash.js
const {
  SlashCommandBuilder,
  Routes,
  REST,
  PermissionFlagsBits,
} = require("discord.js");

const { chat } = require("../utils/ai");
const { fetchWeather, loadUserWeatherPref } = require("../utils/weather");
const verifySetup = require("../utils/verify");
const { getLevelData, setLevelAndXp, calculateRequiredXp } = require("../utils/level");
const { quizManager } = require("../utils/quiz");
const music = require("../utils/music");
const { backupServer, restoreServer, nukeChannel, clearMessages, addRoleToAll, lockChannels } = require("../utils/guild");
const ticket = require("../utils/ticket");
const rolePanelCommands = require("./rolepanel");

// 新規： invite util
const { createInvite, fetchInviteCount } = require("../utils/invite");

// ---------------- コマンド定義 ----------------
const commands = [
  new SlashCommandBuilder()
    .setName("ai")
    .setDescription("AIと対話します")
    .addStringOption(opt => opt.setName("prompt").setDescription("AIへの質問").setRequired(true)),

  new SlashCommandBuilder()
    .setName("weather")
    .setDescription("天気を取得します")
    .addStringOption(opt => opt.setName("location").setDescription("場所").setRequired(false)),

  new SlashCommandBuilder()
    .setName("level")
    .setDescription("自分または指定ユーザーのレベルを確認します")
    .addUserOption(opt => opt.setName("user").setDescription("確認するユーザー").setRequired(false)),

  new SlashCommandBuilder()
    .setName("setlevel")
    .setDescription("ユーザーのレベルとXPを設定します（管理者専用）")
    .addUserOption(opt => opt.setName("user").setDescription("対象ユーザー").setRequired(true))
    .addIntegerOption(opt => opt.setName("level").setDescription("設定するレベル").setRequired(true))
    .addIntegerOption(opt => opt.setName("xp").setDescription("設定するXP").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName("quiz").setDescription("クイズを開始します"),

  // 音楽
  new SlashCommandBuilder().setName("mplay").setDescription("音楽を再生します")
    .addStringOption(opt => opt.setName("url").setDescription("YouTube URL").setRequired(true)),
  new SlashCommandBuilder().setName("mskip").setDescription("曲をスキップします"),
  new SlashCommandBuilder().setName("mstop").setDescription("音楽を停止します"),
  new SlashCommandBuilder().setName("mpause").setDescription("音楽を一時停止します"),
  new SlashCommandBuilder().setName("mresume").setDescription("音楽を再開します"),

  // サーバー管理
  new SlashCommandBuilder().setName("backup").setDescription("サーバーをバックアップします（管理者専用）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("restore").setDescription("サーバーをリストアします（管理者専用）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("nuke").setDescription("チャンネルを爆破します（管理者専用）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("clear").setDescription("メッセージを一括削除します（管理者専用）")
    .addIntegerOption(opt => opt.setName("amount").setDescription("削除する数").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder().setName("addroleall").setDescription("全員にロールを付与します（管理者専用）")
    .addRoleOption(opt => opt.setName("role").setDescription("付与するロール").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("lock").setDescription("全チャンネルをロックします（管理者専用）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // 認証パネル設置
  new SlashCommandBuilder()
    .setName("verifysetup")
    .setDescription("認証メッセージを設置します（管理者専用）")
    .addRoleOption(opt => opt.setName("role").setDescription("認証後に付与するロール").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  // ロールパネル
  ...rolePanelCommands.data,

  // チケットパネル設置
  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("チケット作成用パネルを設置します（管理者専用）")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  // 招待リンク作成
  new SlashCommandBuilder().setName("invite").setDescription("自分専用の招待リンクを作成します"),

  // 招待数確認
  new SlashCommandBuilder().setName("invitecount").setDescription("自分の招待数を確認します"),
];

// ---------------- コマンド登録 ----------------
async function registerSlashCommands(client) {
  if (!client.user) throw new Error("client.user がまだ存在しません。Botは ready ですか？");

  const rest = new REST({ version: "10" }).setToken(client.token);

  try {
    console.log("📌 スラッシュコマンド登録開始");
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands.map(c => c.toJSON()),
    });
    console.log("✅ スラッシュコマンド登録完了");
  } catch (err) {
    console.error("❌ スラッシュコマンド登録失敗:", err);
  }
}

// ---------------- サーバークールダウン ----------------
const SERVER_COOLDOWN_TIME = 2;
const serverCooldowns = new Map();

// ---------------- コマンド実行処理 ----------------
async function handleSlashCommand(interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  // サーバー全体クールダウン判定
  const lastServerUsed = serverCooldowns.get(interaction.guild.id) || 0;
  if (Date.now() - lastServerUsed < SERVER_COOLDOWN_TIME * 1000) {
    await interaction.reply({ content: "コマンドは少し待ってから実行してください。", ephemeral: true });
    return;
  }
  serverCooldowns.set(interaction.guild.id, Date.now());

  const { commandName, channel, user } = interaction;

  try {
    if (commandName === "ai") {
      const prompt = interaction.options.getString("prompt");
      await interaction.deferReply({ ephemeral: true });
      const res = await chat(prompt);
      await interaction.editReply(res);
    }

    else if (commandName === "weather") {
      let location = interaction.options.getString("location");
      if (!location) {
        const userPref = await loadUserWeatherPref(user.id);
        location = userPref || "Tokyo";
      }
      await interaction.deferReply({ ephemeral: true });
      const res = await fetchWeather(location);
      await interaction.editReply(res);
    }

    else if (commandName === "level") {
      const targetUser = interaction.options.getUser("user") || user;
      const data = getLevelData(channel.guild.id, targetUser.id);
      const nextXp = calculateRequiredXp(data.level + 1);
      const xpDisplay = nextXp ?? "MAX";
      await interaction.reply({
        content: `📊 ${targetUser.tag} のレベル: ${data.level}, XP: ${data.xp}/${xpDisplay}`,
        ephemeral: true,
      });
    }

    else if (commandName === "setlevel") {
      const targetUser = interaction.options.getUser("user");
      const level = interaction.options.getInteger("level");
      const xp = interaction.options.getInteger("xp");
      await setLevelAndXp(channel.guild.id, targetUser.id, level, xp);
      await interaction.reply({ content: `✅ ${targetUser.tag} のレベルを ${level}, XPを ${xp} に設定しました`, ephemeral: true });
    }

    else if (commandName === "quiz") {
      if (quizManager && typeof quizManager.getQuestion === 'function') {
        const q = await quizManager.getQuestion();
        await interaction.reply({ content: `クイズ: ${q.text}`, ephemeral: true });
      } else if (typeof quizManager === 'function') {
        await interaction.deferReply({ ephemeral: true });
        await quizManager(interaction, interaction.user);
      } else {
        await interaction.reply({ content: '⚠️ クイズ機能が未設定です。', ephemeral: true });
      }
    }

    else if (commandName === "mplay") {
      if (!interaction.member?.voice?.channel) {
        return interaction.reply({ content: "VCに参加してください。", ephemeral: true });
      }

      const url = interaction.options.getString("url");
      await interaction.deferReply({ ephemeral: true });

      try {
        await music.joinVoice(interaction.member.voice.channel);
        const title = await music.play(interaction.member.voice.channel, url, interaction.channel);
        await interaction.editReply({ content: `🎵 再生開始: **${title}**` });
      } catch (err) {
        console.error("mplay error:", err);
        await interaction.editReply({ content: `❌ 再生に失敗しました: ${err.message}` });
      }
    } 

    else if (commandName === "mskip") {
      if (!interaction.member?.voice?.channel) {
        return interaction.reply({ content: "VCに参加してください。", ephemeral: true });
      }

      const guildId = interaction.guild.id;
      const queue = music.queues?.get?.(guildId);

      if (!queue || queue.length === 0) {
        return interaction.reply({ content: "キューに曲がありません。", ephemeral: true });
      }

      const player = music.players?.get?.(guildId);
      if (player) {
        player.stop(); // これで次の曲に自動移行
        await interaction.reply({ content: "⏭️ スキップしました。", ephemeral: true });
      } else {
        await interaction.reply({ content: "再生中の曲がありません。", ephemeral: true });
      }
    } 

    else if (commandName === "mstop") {
      const stopped = music.stop(interaction.guild.id);
      if (stopped) {
        await interaction.reply({ content: "⏹️ 再生を停止しました。", ephemeral: true });
      } else {
        await interaction.reply({ content: "再生中の音楽がありません。", ephemeral: true });
      }
    } 

    else if (commandName === "mpause") {
      const guildId = interaction.guild.id;
      const player = music.players?.get?.(guildId);

      if (!player) {
        return interaction.reply({ content: "再生中の音楽がありません。", ephemeral: true });
      }

      player.pause();
      await interaction.reply({ content: "⏸️ 一時停止しました。", ephemeral: true });
    } 

    else if (commandName === "mresume") {
      const guildId = interaction.guild.id;
      const player = music.players?.get?.(guildId);

      if (!player) {
        return interaction.reply({ content: "再生中の音楽がありません。", ephemeral: true });
      }

      player.unpause();
      await interaction.reply({ content: "▶️ 再開しました。", ephemeral: true });
    }

    else if (commandName === "backup") {
      await interaction.deferReply({ ephemeral: true });
      await backupServer(interaction.guild);
      await interaction.editReply({ content: '✅ バックアップ処理を実行しました。', ephemeral: true });
    }
    else if (commandName === "restore") {
      await interaction.deferReply({ ephemeral: true });
      await restoreServer(interaction.guild, interaction.channel);
      await interaction.editReply({ content: '✅ リストア処理を実行しました。', ephemeral: true });
    }
    else if (commandName === "nuke") {
      await interaction.deferReply({ ephemeral: true });
      const newCh = await nukeChannel(interaction.channel);
      await interaction.editReply({ content: `✅ チャンネルをNukeしました: <#${newCh.id}>`, ephemeral: true });
    }
    else if (commandName === "clear") {
      const amount = interaction.options.getInteger("amount");
      await interaction.deferReply({ ephemeral: true });
      const deleted = await clearMessages(interaction.channel, amount, interaction.channel);
      await interaction.editReply({ content: `🧹 ${deleted}件のメッセージを削除しました。`, ephemeral: true });
    }
    else if (commandName === "addroleall") {
      const role = interaction.options.getRole("role");
      if (!role) {
        return interaction.reply({ content: '❌ ロールが指定されていません。', ephemeral: true });
      }
      const result = await addRoleToAll(interaction.guild, role);

      if (!result || !result.success) {
        return interaction.reply({ content: `❌ 付与に失敗しました: ${result?.error || '不明なエラー'}`, ephemeral: true });
      }

      return interaction.reply({ content: `✅ 全ユーザーにロール「${role.name}」を付与しました。（付与数: ${result.count}）`, ephemeral: true });
    }
    else if (commandName === "lock") await lockChannels(interaction);

    else if (commandName === "verifysetup") {
      await verifySetup.execute(interaction);
    }

    else if (commandName === "rolepanel" || commandName === "rolepaneladd") {
      await rolePanelCommands.execute(interaction);
    }

    else if (commandName === "ticket") {
      await ticket.sendTicketPanel(interaction);
    }

    // 招待リンク作成
    else if (commandName === "invite") {
      await interaction.deferReply({ ephemeral: true });
      const res = await createInvite(interaction.guild, interaction.channel, interaction.user);
      if (res.success) {
        await interaction.editReply({ content: `🔗 あなた専用の招待リンク: ${res.url}`, ephemeral: true });
      } else {
        await interaction.editReply({ content: `❌ 招待リンクの作成に失敗しました: ${res.error || '不明なエラー'}`, ephemeral: true });
      }
    }

    // 招待数確認
    else if (commandName === "invitecount") {
      await interaction.deferReply({ ephemeral: true });
      const res = await fetchInviteCount(interaction.guild, interaction.user);
      if (res.success) {
        await interaction.editReply({ content: `📊 あなたの招待数: **${res.count}**\n\n詳細: ${JSON.stringify(res.details || {}, null, 2)}`, ephemeral: true });
      } else {
        await interaction.editReply({ content: `❌ 招待数の取得に失敗しました: ${res.error || '不明なエラー'}`, ephemeral: true });
      }
    }

    else {
      // 未定義コマンドは無視
    }
  } catch (err) {
    console.error("❌ SlashCommand Error:", err);
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({ content: "❌ コマンド実行中にエラーが発生しました", ephemeral: true });
    } else {
      await interaction.reply({ content: "❌ コマンド実行中にエラーが発生しました", ephemeral: true });
    }
  }
}

// ---------------- ボタン実行処理 ----------------
async function handleButtonInteraction(interaction) {
  if (!interaction.isButton()) return;
  if (interaction.customId.startsWith("role_button_")) {
    await rolePanelCommands.buttonHandler(interaction);
  }
}

module.exports = {
  registerSlashCommands,
  handleSlashCommand,
  handleButtonInteraction,
  commands,
};
