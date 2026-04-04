// utils/messaging.js
// メッセージ自動削除ユーティリティ

/**
 * 指定秒数後にメッセージを自動削除する
 * @param {Message} message - 削除するメッセージ
 * @param {number} seconds - 削除までの秒数（デフォルト: 30秒）
 */
async function autoDeleteMessage(message, seconds = 30) {
  if (!message || !message.deletable) return;

  setTimeout(async () => {
    try {
      if (message.deletable) {
        await message.delete();
        console.log(`🗑️ メッセージを自動削除しました (${seconds}秒後)`);
      }
    } catch (err) {
      // メッセージが既に削除されている場合などはエラーを無視
      if (err.code !== 10008) { // Unknown Message
        console.error('メッセージ自動削除エラー:', err.message || err);
      }
    }
  }, seconds * 1000);
}

module.exports = {
  autoDeleteMessage
};