// utils/quiz.js
const fs = require("fs");
const path = require("path");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

let quizzes = {};
const activeUsers = new Set(); // 参加中ユーザー管理
const blockedChannelIds = [
  "1422418627704914002",
  "1422418631563804673",
  "1422418642078928916",
  "1422418645945946122"
]; // クイズ禁止チャンネル

// クイズデータロード
function preloadQuizzes() {
  try {
    const data = fs.readFileSync(path.join(__dirname, "../quizzes.json"), "utf-8");
    quizzes = JSON.parse(data);
    console.log("✅ Quiz data loaded successfully.");
  } catch (err) {
    console.error("❌ Failed to load quiz data:", err);
  }
}

function getRandomQuiz(category = null) {
  const categories = Object.keys(quizzes);
  if (categories.length === 0) return null;

  if (category && quizzes[category]) {
    const questions = quizzes[category];
    if (!questions || questions.length === 0) return null;
    const q = questions[Math.floor(Math.random() * questions.length)];
    return { category, question: q.q, answer: q.a, choices: q.choices };
  }

  // ランダム
  const randomCategory = categories[Math.floor(Math.random() * categories.length)];
  const questions = quizzes[randomCategory];
  if (!questions || questions.length === 0) return null;
  const q = questions[Math.floor(Math.random() * questions.length)];
  return { category: randomCategory, question: q.q, answer: q.a, choices: q.choices };
}

// target: prefix の場合は TextChannel、slash の場合は Interaction
async function quizManager(target, user = null, category = null) {
  let channel, isSlash = false;

  if (target.channel && target.isChatInputCommand) {
    // Slash
    isSlash = true;
    channel = target.channel;
    user = target.user;
  } else {
    // Prefix
    channel = target;
  }

  // 禁止チャンネルチェック
  if (blockedChannelIds.includes(channel.id) || channel.name?.includes("雑談")) {
    const warningMsg = await channel.send(`❌ このチャンネルではクイズは使えません`);
    setTimeout(() => warningMsg.delete().catch(() => {}), 5000);
    return;
  }

  // 参加中ユーザー制御
  if (activeUsers.has(user.id)) {
    const warn = await channel.send("❌ あなたは既にクイズに参加中です。");
    setTimeout(() => warn.delete().catch(() => {}), 5000);
    return;
  }
  activeUsers.add(user.id);

  const quiz = getRandomQuiz(category);
  if (!quiz || !quiz.choices || quiz.choices.length === 0) {
    await channel.send("⚠️ クイズデータが不十分です。");
    activeUsers.delete(user.id);
    return;
  }

  // ボタン作成
  const buttons = new ActionRowBuilder();
  quiz.choices.forEach((choice, idx) => {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId(`quiz_${idx}`)
        .setLabel(choice)
        .setStyle(ButtonStyle.Primary)
    );
  });

  // 出題
  let msg;
  if (isSlash) {
    msg = await target.reply({
      content: `📝 **${quiz.category}クイズ**\n${quiz.question}`,
      components: [buttons],
      fetchReply: true,
    });
  } else {
    msg = await channel.send({
      content: `📝 **${quiz.category}クイズ**\n${quiz.question}`,
      components: [buttons],
    });
  }

  // 回答待ち (30秒)
  const filter = (i) => i.user.id === user.id;
  const collector = msg.createMessageComponentCollector({ filter, time: 30000 });

  collector.on("collect", async (i) => {
    if (!i.isButton()) return;
    const selectedIndex = parseInt(i.customId.split("_")[1], 10);
    const isCorrect = quiz.choices[selectedIndex] === quiz.answer;

    const content = isCorrect
      ? `✅ 正解！ (${quiz.answer})`
      : `❌ 不正解... 正解は **${quiz.answer}** でした。`;

    await i.update({ content, components: [] });
    collector.stop("answered");
  });

  collector.on("end", async (_, reason) => {
    if (reason === "time") {
      await channel.send(`⌛ 時間切れ！ 正解は **${quiz.answer}** でした。`);
    }
    // クイズ終了 → 参加解除
    activeUsers.delete(user.id);
  });
}

module.exports = { preloadQuizzes, getRandomQuiz, quizManager, blockedChannelIds, activeUsers };