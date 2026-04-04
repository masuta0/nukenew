// commands/register.js
const { REST, Routes } = require("discord.js");
const { commands } = require("./slash"); // 統合した slash.js で commands をエクスポートしている場合
require("dotenv").config(); // TOKEN, GUILD_ID を .env で管理している場合

async function registerGuildCommands(clientId, guildId, token) {
  const rest = new REST({ version: "10" }).setToken(token);

  try {
    console.log(`📌 ギルド(${guildId})用スラッシュコマンド登録開始`);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands.map(cmd => cmd.toJSON()),
    });
    console.log("✅ ギルド用スラッシュコマンド登録完了");
  } catch (err) {
    console.error("❌ スラッシュコマンド登録失敗:", err);
  }
}

// 実行用
registerGuildCommands(process.env.BOT_CLIENT_ID, process.env.GUILD_ID, process.env.BOT_TOKEN);
