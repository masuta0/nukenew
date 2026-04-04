// commands/rolepanel.js
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');

// ロール検索処理（メンション・ID・名前対応）
function parseRole(query, guild) {
  let role = null;

  // メンション <@&123456789>
  const mentionMatch = query.match(/^<@&(\d+)>$/);
  if (mentionMatch) role = guild.roles.cache.get(mentionMatch[1]);

  // ID
  if (!role && /^\d+$/.test(query)) role = guild.roles.cache.get(query);

  // 名前
  if (!role) {
    role =
      guild.roles.cache.find(r => r.name.toLowerCase() === query.toLowerCase()) ||
      guild.roles.cache.find(r => r.name.toLowerCase().includes(query.toLowerCase()));
  }

  return role;
}

// ボタンを行ごとに分割する（1行5個まで）
function chunkButtons(buttons) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }
  return rows;
}

module.exports = {
  // スラッシュコマンド定義
  data: [
    new SlashCommandBuilder()
      .setName('rolepanel')
      .setDescription('ロール付与パネルを設置します。')
      .addStringOption(option =>
        option
          .setName('message')
          .setDescription('パネルに表示するメッセージ')
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('roles')
          .setDescription('ロール（ID / メンション / 名前）をカンマ区切りで指定')
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    new SlashCommandBuilder()
      .setName('rolepaneladd')
      .setDescription('既存のロールパネルにロールを追加します。')
      .addStringOption(option =>
        option
          .setName('message_id')
          .setDescription('編集するロールパネルのメッセージID')
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('roles')
          .setDescription('追加するロール（ID / メンション / 名前）をカンマ区切りで指定')
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  ],

  // スラッシュコマンド実行処理
  async execute(interaction) {
    const name = interaction.commandName;

    // === /rolepanel ===
    if (name === 'rolepanel') {
      const message = interaction.options.getString('message');
      const rolesInput = interaction.options.getString('roles');
      const roleQueries = rolesInput.split(',').map(r => r.trim());

      const roles = roleQueries
        .map(query => parseRole(query, interaction.guild))
        .filter(r => r);

      if (!roles.length) {
        return interaction.reply({ content: '❌ 有効なロールが見つかりませんでした。', ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setColor('Purple')
        .setTitle('ロール選択パネル')
        .setDescription(message)
        .addFields(roles.map(role => ({ name: role.name, value: 'ボタンを押すと付与/解除できます。', inline: true }))); // inline: true を追加して見やすく

      const buttons = roles.map(role =>
        new ButtonBuilder()
          .setCustomId(`role_button_${role.id}`)
          .setLabel(role.name)
          .setStyle(ButtonStyle.Primary)
      );

      const rows = chunkButtons(buttons);

      const panelMessage = await interaction.channel.send({ embeds: [embed], components: rows });

      return interaction.reply({
        content: `✅ ロールパネルを作成しました！（メッセージID: \`${panelMessage.id}\`）`,
        ephemeral: true,
      });
    }

    // === /rolepaneladd ===
    if (name === 'rolepaneladd') {
      await interaction.deferReply({ ephemeral: true });

      const messageId = interaction.options.getString('message_id');
      const rolesInput = interaction.options.getString('roles');
      const roleQueries = rolesInput.split(',').map(r => r.trim());

      // メッセージを取得
      let panelMessage;
      try {
        panelMessage = await interaction.channel.messages.fetch(messageId);
      } catch {
        return interaction.editReply({ content: '❌ メッセージが見つかりませんでした。' });
      }

      // 既存のEmbedを取得
      const embed = panelMessage.embeds[0];
      if (!embed || embed.title !== 'ロール選択パネル') {
        return interaction.editReply({ content: '❌ これはロールパネルのメッセージではありません。' });
      }

      const oldRows = panelMessage.components;
      const existingButtons = oldRows.flatMap(row => row.components);

      const newRoles = roleQueries
        .map(query => parseRole(query, interaction.guild))
        .filter(r => r && !existingButtons.some(b => b.customId === `role_button_${r.id}`));

      if (!newRoles.length) {
        return interaction.editReply({ content: '⚠️ 新しく追加できる有効なロールが見つかりませんでした。（既存のロールはスキップされます）' });
      }

      // 新しいEmbedフィールドを生成
      const newFields = newRoles.map(role => ({
        name: role.name,
        value: 'ボタンを押すと付与/解除できます。',
        inline: true
      }));

      // 既存のフィールドと新しいフィールドを結合してEmbedを更新
      const updatedEmbed = EmbedBuilder.from(embed).addFields(newFields);

      const newButtons = newRoles.map(role =>
        new ButtonBuilder().setCustomId(`role_button_${role.id}`).setLabel(role.name).setStyle(ButtonStyle.Primary)
      );

      const rows = chunkButtons([...existingButtons, ...newButtons]);

      try {
        await panelMessage.edit({ embeds: [updatedEmbed], components: rows });
        await interaction.editReply({ content: `✅ ${newRoles.length}個のロールを追加しました！` });
      } catch (err) {
        console.error(err);
        await interaction.editReply({ content: '❌ メッセージの編集に失敗しました。ボタンやロールが多すぎる可能性があります。' });
      }
    }
  },

  // === ボタン処理 ===
  async buttonHandler(interaction) {
    if (!interaction.isButton()) return;

    await interaction.deferReply({ ephemeral: true });

    const [_, __, roleId] = interaction.customId.split('_');
    const member = interaction.member;
    const role = interaction.guild.roles.cache.get(roleId);

    if (!role) {
      return interaction.editReply({ content: '❌ 指定されたロールが見つかりません。' });
    }

    // Botのロールが対象ロールより上にあるか確認
    if (interaction.guild.members.me.roles.highest.position <= role.position) {
        return interaction.editReply({ content: `❌ ロール **${role.name}** の付与/解除に失敗しました。Botのロールがこのロールより下にあります。` });
    }

    try {
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId);
        return interaction.editReply({ content: `✅ ロール **${role.name}** を外しました。` });
      } else {
        await member.roles.add(roleId);
        return interaction.editReply({ content: `✅ ロール **${role.name}** を付与しました。` });
      }
    } catch (error) {
        console.error(`ロール処理エラー: ${error.message}`);
        return interaction.editReply({ content: '❌ ロールの付与/解除中に予期せぬエラーが発生しました。' });
    }
  },
};
