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
  PermissionFlagsBits 
} = require('discord.js');
const { uploadToDropbox, downloadFromDropbox, ensureDropboxInit } = require('../utils/storage');

const userCodes = new Map();
const DROPBOX_VERIFY_DATA_PATH = '/bot_data/verifyData.json';

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
async function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

// ===== Embed/ボタン作成 =====
async function createVerifyMessageEmbedAndComponents(roleName) {
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

// ===== モジュールエクスポート =====
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
    const roleId = role.id;
    const channelId = interaction.channel.id;
    const guildId = interaction.guild.id;

    await saveVerifyData({ guildId, channelId, roleId });
    console.log(`✅ サーバー ${interaction.guild.name} の認証設定を保存`);

    const messagePayload = await createVerifyMessageEmbedAndComponents(role.name);
    await interaction.reply(messagePayload);
  },

  async buttonHandler(interaction) {
    if (interaction.customId !== 'verify_button') return;

    const code = await generateCode();
    userCodes.set(interaction.user.id, code);

    const modal = new ModalBuilder()
      .setCustomId('verify_modal')
      .setTitle('認証コード入力');

    const codeInput = new TextInputBuilder()
      .setCustomId('verify_input')
      .setLabel('表示されたコード: ' + code)
      .setPlaceholder('コードを入力してください')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(codeInput));
    await interaction.showModal(modal);
  },

  async modalHandler(interaction) {
    if (interaction.customId !== 'verify_modal') return;

    const inputCode = interaction.fields.getTextInputValue('verify_input');
    const correctCode = userCodes.get(interaction.user.id);

    if (inputCode !== correctCode) {
      return interaction.reply({ content: '❌ 認証コードが間違っています', flags: MessageFlags.Ephemeral });
    }

    const verifyData = await loadVerifyData();
    if (!verifyData.roleId) {
      return interaction.reply({ content: '❌ 認証ロールが設定されていません', flags: MessageFlags.Ephemeral });
    }

    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      await member.roles.add(verifyData.roleId);
      userCodes.delete(interaction.user.id);
      await interaction.reply({ content: '✅ 認証完了', flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.error('❌ ロール付与失敗:', err);
      await interaction.reply({ content: '❌ ロール付与に失敗しました', flags: MessageFlags.Ephemeral });
    }
  },

  async restoreVerifyMessage(client) {
    const verifyData = await loadVerifyData();
    if (!verifyData.guildId || !verifyData.channelId || !verifyData.roleId) return;

    try {
      const guild = await client.guilds.fetch(verifyData.guildId);
      const channel = await guild.channels.fetch(verifyData.channelId);
      const role = await guild.roles.fetch(verifyData.roleId);
      if (!channel || !channel.isTextBased() || !role) return;

      // 過去ボットメッセージ削除
      const messages = await channel.messages.fetch({ limit: 100 });
      const oldBotMessage = messages.find(m => m.author.id === client.user.id && m.embeds[0]?.title === '🛡️ サーバー認証');
      if (oldBotMessage) await oldBotMessage.delete().catch(() => {});

      // 新規メッセージ送信
      const messagePayload = await createVerifyMessageEmbedAndComponents(role.name);
      await channel.send(messagePayload);
      console.log('✅ 認証メッセージを自動再設置しました');
    } catch (err) {
      console.error('❌ restoreVerifyMessage エラー:', err);
    }
  }
};