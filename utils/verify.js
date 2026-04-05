const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} = require('discord.js');
const { uploadToDropbox, downloadFromDropbox } = require('../utils/storage');

const userCodes = new Map();
const DROPBOX_VERIFY_DATA_PATH = '/bot_data/verifyData.json';

// ===== 安全な応答ヘルパー =====
async function safeReply(interaction, options) {
  try {
    if (interaction.replied || interaction.deferred) {
      return await interaction.editReply(options).catch(() => {});
    }
    return await interaction.reply(options);
  } catch (err) {
    if (err.code === 10062 || err.code === 40060) return; // 期限切れ・二重応答は無視
    console.error('❌ safeReply error:', err.message);
  }
}

// ===== Dropbox 保存/読み込み =====
async function saveVerifyData(data) {
  try {
    const success = await uploadToDropbox(DROPBOX_VERIFY_DATA_PATH, JSON.stringify(data, null, 2));
    if (success) console.log('✅ 認証データをDropboxに保存しました');
    else console.error('❌ 認証データのDropbox保存に失敗');
  } catch (err) {
    console.error('❌ 認証データ保存エラー:', err);
  }
}

async function loadVerifyData() {
  try {
    const data = await downloadFromDropbox(DROPBOX_VERIFY_DATA_PATH);
    if (data) {
      const parsed = JSON.parse(data);
      console.log('✅ 認証データをDropboxから読み込みました');
      return parsed;
    }
    console.warn('⚠️ Dropboxに認証データが存在しません');
    return {};
  } catch (err) {
    console.error('❌ 認証データ読み込みエラー:', err);
    return {};
  }
}

// ===== コード生成 =====
function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

// ===== Embed/ボタン作成 =====
function createVerifyMessageEmbedAndComponents(roleName) {
  const embed = new EmbedBuilder()
    .setTitle('🛡️ サーバー認証')
    .setDescription(`サーバーに参加するには「認証する」ボタンを押してコードを入力してください。\n認証後は **${roleName}** ロールが付与されます。`)
    .setColor('Blue');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('verify_button')
      .setLabel('認証する')
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verifysetup')
    .setDescription('認証メッセージを設置します (管理者用)')
    .addRoleOption(option =>
      option.setName('role')
        .setDescription('認証後に付与するロール')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  async execute(interaction) {
    const role = interaction.options.getRole('role');
    await saveVerifyData({ guildId: interaction.guild.id, channelId: interaction.channel.id, roleId: role.id });
    const messagePayload = createVerifyMessageEmbedAndComponents(role.name);
    await safeReply(interaction, messagePayload);
  },

  async buttonHandler(interaction) {
    if (interaction.customId !== 'verify_button') return;
    // 既に応答済みなら何もしない
    if (interaction.replied || interaction.deferred) return;

    try {
      const code = generateCode();
      userCodes.set(interaction.user.id, code);

      const modal = new ModalBuilder()
        .setCustomId('verify_modal')
        .setTitle('認証コード入力');

      const codeInput = new TextInputBuilder()
        .setCustomId('verify_input')
        .setLabel('コード: ' + code)
        .setPlaceholder('上記のコードをそのまま入力してください')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(codeInput));
      await interaction.showModal(modal);
    } catch (err) {
      if (err.code === 10062 || err.code === 40060) return;
      console.error('❌ buttonHandler error:', err.message);
    }
  },

  async modalHandler(interaction) {
    if (interaction.customId !== 'verify_modal') return;
    if (interaction.replied || interaction.deferred) return;

    try {
      const inputCode = interaction.fields.getTextInputValue('verify_input');
      const correctCode = userCodes.get(interaction.user.id);

      if (inputCode !== correctCode) {
        return safeReply(interaction, { content: '❌ 認証コードが間違っています', flags: MessageFlags.Ephemeral });
      }

      const verifyData = await loadVerifyData();
      if (!verifyData.roleId) {
        return safeReply(interaction, { content: '❌ 認証ロールが設定されていません', flags: MessageFlags.Ephemeral });
      }

      const member = await interaction.guild.members.fetch(interaction.user.id);
      await member.roles.add(verifyData.roleId);
      userCodes.delete(interaction.user.id);
      await safeReply(interaction, { content: '✅ 認証完了！ロールが付与されました。', flags: MessageFlags.Ephemeral });
    } catch (err) {
      if (err.code === 10062 || err.code === 40060) return;
      console.error('❌ modalHandler error:', err.message);
      await safeReply(interaction, { content: '❌ 認証処理中にエラーが発生しました', flags: MessageFlags.Ephemeral });
    }
  },

  async restoreVerifyMessage(client) {
    const verifyData = await loadVerifyData();
    if (!verifyData.guildId || !verifyData.channelId || !verifyData.roleId) return;

    try {
      const guild   = await client.guilds.fetch(verifyData.guildId);
      const channel = await guild.channels.fetch(verifyData.channelId);
      const role    = await guild.roles.fetch(verifyData.roleId);
      if (!channel || !channel.isTextBased() || !role) return;

      const messages = await channel.messages.fetch({ limit: 100 });
      const oldBotMessage = messages.find(m =>
        m.author.id === client.user.id && m.embeds[0]?.title === '🛡️ サーバー認証'
      );
      if (oldBotMessage) await oldBotMessage.delete().catch(() => {});

      await channel.send(createVerifyMessageEmbedAndComponents(role.name));
      console.log('✅ 認証メッセージを自動再設置しました');
    } catch (err) {
      console.error('❌ restoreVerifyMessage エラー:', err);
    }
  },
};
