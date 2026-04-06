// utils/quiz.js
const fs = require('fs');
const path = require('path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

let quizzes = {};
const activeUsers   = new Set(); // ユーザー単位のロック
const activeChannels = new Set(); // チャンネル単位のロック（二重出題防止）

const blockedChannelIds = [
  '1422418627704914002',
  '1422418631563803673',
  '1422418642078928916',
  '1422418645945946122',
];
const QUIZ_RESULT_DELETE_MS = 7000;

function scheduleDeleteMessage(message, delayMs = QUIZ_RESULT_DELETE_MS) {
  setTimeout(() => message.delete().catch(() => {}), delayMs);
}

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

function getRandomQuiz(category = null) {
  const categories = Object.keys(quizzes);
  if (categories.length === 0) return null;

  const cat = (category && quizzes[category]) ? category
    : categories[Math.floor(Math.random() * categories.length)];

  const questions = quizzes[cat];
  if (!questions || questions.length === 0) return null;

  const q = questions[Math.floor(Math.random() * questions.length)];
  return { category: cat, question: q.q, answer: q.a, choices: q.choices };
}

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

async function quizManager(target, user = null, category = null) {
  let channel, isSlash = false;

  if (target.channel && typeof target.isChatInputCommand === 'function') {
    isSlash = true;
    channel = target.channel;
    user = target.user;
  } else {
    channel = target;
  }

  // 禁止チャンネルチェック
  if (blockedChannelIds.includes(channel.id) || channel.name?.includes('雑談')) {
    const w = await channel.send('❌ このチャンネルではクイズは使えません');
    setTimeout(() => w.delete().catch(() => {}), 5000);
    return;
  }

  // チャンネル二重出題防止
  if (activeChannels.has(channel.id)) {
    const w = await channel.send('⏳ このチャンネルでは既にクイズ進行中です。');
    setTimeout(() => w.delete().catch(() => {}), 5000);
    return;
  }

  // ユーザー参加中チェック
  if (activeUsers.has(user.id)) {
    const w = await channel.send('❌ あなたは既にクイズに参加中です。');
    setTimeout(() => w.delete().catch(() => {}), 5000);
    return;
  }

  const quiz = getRandomQuiz(category);
  if (!quiz || !quiz.choices || quiz.choices.length === 0) {
    await channel.send('⚠️ クイズデータが不十分です。');
    return;
  }

  // ロック
  activeUsers.add(user.id);
  activeChannels.add(channel.id);

  async function runRound(currentQuiz) {
    const row = buildQuizButtons(currentQuiz);
    let msg;
    if (isSlash && !isSlash._replied) {
      msg = await channel.send({
        content: `📝 **${currentQuiz.category}クイズ**\n${currentQuiz.question}`,
        components: [row],
      });
    } else {
      msg = await channel.send({
        content: `📝 **${currentQuiz.category}クイズ**\n${currentQuiz.question}`,
        components: [row],
      });
    }

    return new Promise((resolve) => {
      const filter = (i) => i.user.id === user.id && i.customId.startsWith('quiz_');
      const collector = msg.createMessageComponentCollector({ filter, time: 30000 });

      collector.on('collect', async (i) => {
        const idx = parseInt(i.customId.split('_')[1], 10);
        const isCorrect = currentQuiz.choices[idx] === currentQuiz.answer;
        const resultText = isCorrect
          ? `✅ 正解！ (${currentQuiz.answer})`
          : `❌ 不正解... 正解は **${currentQuiz.answer}** でした。`;

        // 「もう一度」ボタン
        const nextRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('quiz_next')
            .setLabel('🔁 もう一度')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('quiz_end')
            .setLabel('⏹ 終了')
            .setStyle(ButtonStyle.Danger),
        );

        await i.update({ content: resultText, components: [nextRow] });
        collector.stop('answered');

        // 「もう一度」/「終了」の受付
        const endFilter = (j) => j.user.id === user.id && (j.customId === 'quiz_next' || j.customId === 'quiz_end');
        const endCollector = msg.createMessageComponentCollector({ filter: endFilter, time: 20000, max: 1 });

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
          await msg.edit({ content: `⌛ 時間切れ！ 正解は **${currentQuiz.answer}** でした。`, components: [] }).catch(() => {});
          scheduleDeleteMessage(msg);
          resolve('end');
        }
      });
    });
  }

  try {
    let action = 'next';
    while (action === 'next') {
      const next = getRandomQuiz(category);
      if (!next) break;
      action = await runRound(next);
    }
  } finally {
    // 必ずロック解除
    activeUsers.delete(user.id);
    activeChannels.delete(channel.id);
  }
}

module.exports = { preloadQuizzes, getRandomQuiz, quizManager, blockedChannelIds, activeUsers };
