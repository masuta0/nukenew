// utils/monitor.js
const fs = require('fs').promises;
const path = require('path');
const LOG_PATH = path.join(__dirname, '../logs/anti_raid.log');
const CMD_PREFIX = "!";

/**
 * サーバー監視ログのコマンドハンドラを初期化します。
 * @param {Discord.Client} client - Discord.jsのクライアントインスタンス
 */
async function initializeMonitorCommand(client) {
    client.on('messageCreate', async (msg) => {
        if (msg.author.bot || !msg.content.startsWith(CMD_PREFIX)) {
            return;
        }

        const args = msg.content.slice(CMD_PREFIX.length).split(/\s+/);
        const cmd = args.shift()?.toLowerCase();

        if (cmd !== 'monitor') {
            return;
        }

        // 管理者権限のチェック（hasManageGuildPermission 関数がないため、簡易的なチェックを使用）
        if (!msg.member?.permissions.has('ManageGuild')) {
            return msg.reply("⚠️ このコマンドはサーバー管理者のみが使用できます。");
        }

        try {
            await fs.access(LOG_PATH);

            const logContent = await fs.readFile(LOG_PATH, 'utf-8');

            if (logContent.trim().length === 0) {
                await msg.channel.send("✅ 監視ログは空です。");
                await fs.unlink(LOG_PATH); // 空でも削除
                return;
            }

            await msg.channel.send({
                content: "**サーバー監視ログ**\n```\n" + logContent + "\n```",
                files: [{ attachment: Buffer.from(logContent), name: 'anti_raid.log' }]
            });

            await fs.unlink(LOG_PATH);
            await msg.channel.send("✅ 監視ログを正常に確認し、削除しました。");

        } catch (e) {
            if (e.code === 'ENOENT') {
                await msg.channel.send("⚠️ 監視ログファイルが見つかりませんでした。");
            } else {
                console.error("監視ログの処理中にエラーが発生しました:", e);
                await msg.channel.send("❌ 監視ログの処理中にエラーが発生しました。");
            }
        }
    });

    console.log("✅ 監視コマンドハンドラが初期化されました。");
}

module.exports = { initializeMonitorCommand };
