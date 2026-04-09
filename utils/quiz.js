// utils/quiz.js
const fs = require('fs');
const path = require('path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

let quizzes = {};
const activeUsers = new Set(); // ユーザー単位のロック
const activeChannels = new Set(); // チャンネル単位のロック（二重出題防止）

const blockedChannelIds = [
  '1422418627704914002',
  '1422418631563803673',
  '1422418642078928916',
  '1422418645945946122',
];
const QUIZ_RESULT_DELETE_MS = 7000;

/**
 * 指定時間後にメッセージを削除する（失敗時は無視）
 * @param {import('discord.js').Message} message
 * @param {number} delayMs
 */
function scheduleDeleteMessage(message, delayMs = QUIZ_RESULT_DELETE_MS) {
  setTimeout(() => message.delete().catch(() => {}), delayMs);
}

/**
 * クイズデータをファイルから読み込む
 * 起動時に一度だけ実行されることを想定
 */
function preloadQuizzes() {
  try {
    const data = fs.readFileSync(path.join(__dirname, '../quizzes.json'), 'utf-8');
    quizzes = JSON.parse(data);
    // 選択肢の重複を起動時に自動修正
    for (const cat of Object.keys(quizzes)) {
      for (const q of quizzes[cat]) {
        if (q.choices) {
          q.choices = [...new Set(q.choices)];
        }
      }
    }
    console.log('✅ Quiz data loaded successfully.');
  } catch (err) {
    console.error('❌ Failed to load quiz data:', err);
  }
}

/**
 * ランダムなクイズを取得する
 * @param {string|null} category カテゴリ名（省略可）
 * @returns {object|null} { category, question, answer, choices } または null
 */
function getRandomQuiz(category = null) {
  // 存在しないカテゴリが指定された場合は null を返す（呼び出し元でエラーハンドリング）
  if (category && !quizzes[category]) {
    return null;
  }

  const categories = category ? [category] : Object.keys(quizzes);
  if (categories.length === 0) return null;

  const cat = categories[Math.floor(Math.random() * categories.length)];
  const questions = quizzes[cat];
  if (!questions || questions.length === 0) return null;

  const q = questions[Math.floor(Math.random() * questions.length)];
  return { category: cat, question: q.q, answer: q.a, choices: q.choices };
}

/**
 * クイズの選択肢ボタンを含む ActionRow を生成する
 * @param {object} quiz
 * @returns {ActionRowBuilder}
 */
function buildQuizButtons(quiz) {
  const row = new ActionRowBuilder();
  quiz.choices.forEach((choice, idx) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`quiz_${idx}`)
        .setLabel(choice)
        .setStyle(ButtonStyle.Primary)
    );
  });
  return row;
}

/**
 * クイズを開始し、連続出題を管理する
 * @param {import('discord.js').CommandInteraction|import('discord.js').Message} target
 * @param {import('discord.js').User|null} user
 * @param {string|null} category
 */
async function quizManager(target, user = null, category = null) {
  let channel, isSlash = false;

  if (target.channel && typeof target.isChatInputCommand === 'function') {
    // スラッシュコマンド経由
    isSlash = true;
    channel = target.channel;
    user = target.user;
  } else {
    // メッセージ経由
    channel = target;
  }

  // 禁止チャンネルチェック（IDまたは名前で判定）
  if (blockedChannelIds.includes(channel.id) || channel.name?.includes('雑談')) {
    const w = await channel.send('❌ このチャンネルではクイズは使えません');
    return setTimeout(() => w.delete().catch(() => {}), 5000);
  }

  // チャンネル二重出題防止
  if (activeChannels.has(channel.id)) {
    const w = await channel.send('⏳ このチャンネルでは既にクイズ進行中です。');
    return setTimeout(() => w.delete().catch(() => {}), 5000);
  }

  // ユーザー参加中チェック
  if (activeUsers.has(user.id)) {
    const w = await channel.send('❌ あなたは既にクイズに参加中です。');
    return setTimeout(() => w.delete().catch(() => {}), 5000);
  }

  // カテゴリ存在確認（指定があれば）
  if (category && !quizzes[category]) {
    const w = await channel.send(`❌ カテゴリ「${category}」は存在しません。`);
    return setTimeout(() => w.delete().catch(() => {}), 5000);
  }

  const firstQuiz = getRandomQuiz(category);
  if (!firstQuiz || !firstQuiz.choices || firstQuiz.choices.length === 0) {
    await channel.send('⚠️ クイズデータが不十分です。');
    return;
  }

  // ロック
  activeUsers.add(user.id);
  activeChannels.add(channel.id);

  /**
   * 1問分の出題と解答処理を行う
   * @param {object} quiz
   * @returns {Promise<'next'|'end'>}
   */
  async function runRound(quiz) {
    const row = buildQuizButtons(quiz);
    const msg = await channel.send({
      content: `📝 **${quiz.category}クイズ**\n${quiz.question}`,
      components: [row],
    });

    return new Promise((resolve) => {
      const filter = (i) => i.user.id === user.id && i.customId.startsWith('quiz_');
      const collector = msg.createMessageComponentCollector({ filter, time: 30000 });

      collector.on('collect', async (i) => {
        // 解答があった瞬間にコレクターを停止し、二重処理を防止
        collector.stop();

        const idx = parseInt(i.customId.split('_')[1], 10);
        const isCorrect = quiz.choices[idx] === quiz.answer;
        const resultText = isCorrect
          ? `✅ 正解！ (${quiz.answer})`
          : `❌ 不正解... 正解は **${quiz.answer}** でした。`;

        // 「もう一度」「終了」ボタン
        const nextRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('quiz_next')
            .setLabel('🔁 もう一度')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('quiz_end')
            .setLabel('⏹ 終了')
            .setStyle(ButtonStyle.Danger)
        );

        await i.update({ content: resultText, components: [nextRow] });

        // 継続選択用コレクター
        const endFilter = (j) =>
          j.user.id === user.id && (j.customId === 'quiz_next' || j.customId === 'quiz_end');
        const endCollector = msg.createMessageComponentCollector({
          filter: endFilter,
          time: 20000,
          max: 1,
        });

        endCollector.on('collect', async (j) => {
          if (j.customId === 'quiz_next') {
            await j.update({ content: resultText, components: [] });
            scheduleDeleteMessage(msg, 1200);
            resolve('next');
          } else {
            await j.update({ content: resultText + '\nクイズを終了しました！', components: [] });
            scheduleDeleteMessage(msg);
            resolve('end');
          }
        });

        endCollector.on('end', (_, reason) => {
          if (reason === 'time') {
            scheduleDeleteMessage(msg);
            resolve('end');
          }
        });
      });

      collector.on('end', async (_, reason) => {
        if (reason === 'time') {
          // 時間切れの場合は正解を表示
          await msg
            .edit({
              content: `⌛ 時間切れ！ 正解は **${quiz.answer}** でした。`,
              components: [],
            })
            .catch(() => {});
          scheduleDeleteMessage(msg);
          resolve('end');
        }
      });
    });
  }

  try {
    let currentQuiz = firstQuiz;
    let action = 'next';
    while (action === 'next') {
      action = await runRound(currentQuiz);
      if (action === 'next') {
        // 次の問題を取得（カテゴリ指定は初回のみ有効。継続時はランダムカテゴリから）
        currentQuiz = getRandomQuiz(category);
        if (!currentQuiz) {
          await channel.send('⚠️ クイズデータが見つかりませんでした。');
          break;
        }
      }
    }
  } finally {
    // 必ずロック解除
    activeUsers.delete(user.id);
    activeChannels.delete(channel.id);
  }
}

module.exports = {
  preloadQuizzes,
  getRandomQuiz,
  quizManager,
  blockedChannelIds,
  activeUsers,
};
