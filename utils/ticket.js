// utils/ticket.js
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} = require("discord.js");
const fs = require("fs").promises;
const path = require("path");

// --- 自身の環境に合わせてIDを設定 ---
const TICKET_CATEGORY_ID = "1422418557635133522";
const LOG_CHANNEL_ID = "1422418581995651082";
const STAFF_ROLE_ID = "1422418421978501152";
// ------------------------------------

module.exports = {
  // チケット作成パネルを送信する
  async sendTicketPanel(interaction) {
    const button = new ButtonBuilder()
      .setCustomId("ticket_create")
      .setLabel("査定チケットを作成")
      .setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder().addComponents(button);

    // パネル自体はチャンネルの全員に見えるように送信
    await interaction.channel.send({
      content: "査定したい場合は下のボタンからチケットを作成してください。",
      components: [row],
    });

    // コマンドを実行した管理者には、完了したことを伝える非公開メッセージを送信
    await interaction.reply({
      content: "✅ チケットパネルを設置しました。",
      ephemeral: true,
    });
  },

  // ボタンが押されたときの処理
  async buttonHandler(interaction) {
    if (interaction.customId === "ticket_create") {
      const modal = new ModalBuilder()
        .setCustomId("ticket_modal")
        .setTitle("査定チケット");

      const reasonInput = new TextInputBuilder()
        .setCustomId("ticket_reason")
        .setLabel("査定内容を詳しく入力してください")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      return interaction.showModal(modal);
    }

    if (interaction.customId === "ticket_close") {
      const channel = interaction.channel;

      await interaction.reply(`🗑️ このチケットは5秒後にクローズされます...`);

      const logChannel = interaction.guild.channels.cache.get(LOG_CHANNEL_ID);
      if (logChannel) {
        // メッセージを取得してログファイルを作成
        const messages = await channel.messages.fetch({ limit: 100 });
        const content = messages
          .map(m => `[${m.createdAt.toLocaleString("ja-JP")}] ${m.author.tag}: ${m.content}`)
          .reverse()
          .join("\n");

        // ファイルに書き込み
        const filePath = path.join(__dirname, `${channel.name}-log.txt`);
        await fs.writeFile(filePath, content || "メッセージはありませんでした。");

        // ログチャンネルにファイルを送信
        await logChannel.send({
          content: `🗑️ チケット **${channel.name}** を ${interaction.user} が閉じました。`,
          files: [filePath],
        });

        // 一時ファイルを削除
        await fs.unlink(filePath).catch(err => console.error("一時ログファイルの削除に失敗:", err));
      }

      // 5秒待ってからチャンネルを削除
      setTimeout(() => channel.delete("Ticket closed"), 5000);
    }
  },

  // モーダルが送信されたときの処理
  async modalHandler(interaction) {
    if (interaction.customId !== "ticket_modal") return;

    await interaction.deferReply({ ephemeral: true });

    const reason = interaction.fields.getTextInputValue("ticket_reason");
    const category = interaction.guild.channels.cache.get(TICKET_CATEGORY_ID);

    if (!category || category.type !== ChannelType.GuildCategory) {
      return interaction.editReply({
        content: "❌ チケットカテゴリが見つかりません。管理者に連絡してください。",
      });
    }

    try {
      const channel = await interaction.guild.channels.create({
        name: `ticket-${interaction.user.username}`,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: [
          { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          { id: STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        ],
      });

      const closeButton = new ButtonBuilder()
        .setCustomId("ticket_close")
        .setLabel("❌ チケットを閉じる")
        .setStyle(ButtonStyle.Danger);

      await channel.send({
        content: `🎫 ${interaction.user} がチケットを作成しました。\n**内容:**\n\`\`\`${reason}\`\`\``,
        components: [new ActionRowBuilder().addComponents(closeButton)],
      });

      await interaction.editReply({
        content: `✅ チケットを作成しました: ${channel}`,
      });
    } catch (error) {
        console.error("チケットチャンネルの作成に失敗:", error);
        await interaction.editReply({
            content: "❌ チャンネルの作成に失敗しました。BOTの権限を確認してください。",
        });
    }
  },
};
