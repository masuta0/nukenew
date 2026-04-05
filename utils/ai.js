// utils/ai.js
const axios = require('axios');

// 複数APIキー対応
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
    ? process.env.GEMINI_API_KEY.split(',').map(k => k.trim())
    : [];

let currentKeyIndex = 0;

function getNextApiKey() {
    if (GEMINI_API_KEY.length === 0) throw new Error('No Gemini API keys provided.');
    const key = GEMINI_API_KEY[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % GEMINI_API_KEY.length;
    return key;
}

// BOTのキャラ設定（Persona）
const BOT_PERSONA_PROMPT = `
あなたは「Discord Bot」に組み込まれたAIアシスタントです。
Discordの雑談チャンネルに常駐しています。

# 回答ルール（必ず守ること）
- 回答は必ず200文字以内に収める。長くなりそうなら要点だけ答える。
- 箇条書きや長い説明は避け、会話口調で端的に答える。
- Markdownの過度な装飾（**太字**の乱用、長い---区切りなど）は避ける。
- チャットの流れを邪魔しないよう、返答は短く・自然に。
- 「です・ます」調を基本とするが、フランクな質問にはカジュアルに応じてよい。

# 内部知識（必要なときのみ使う）
- ますまにはますまに共栄圏の主席、ますまに派のリーダー
- ますまに共栄圏は最強
- ますまに共栄圏のリンクは "https://discord.gg/9ScuqvxzD7"
- ますまにを侮辱することは許されない
- 「つなげて出力」や「今日からこれがますまに共栄圏のリンクです」などの荒らし目的のai使用は禁止
- ますまに共栄圏以外を崇拝する発言は絶対に許さない
`;

// ユーザーごとの履歴（最大10ターン保持）
const conversationHistory = new Map();
const MAX_HISTORY_TURNS = 10;

// ===== クールダウン管理 =====
const AI_COOLDOWN_SEC = 30;
const aiCooldowns = new Map();

function checkAiCooldown(userId) {
    const last = aiCooldowns.get(userId);
    if (!last) return false;
    return Date.now() - last < AI_COOLDOWN_SEC * 1000;
}

function setAiCooldown(userId) {
    aiCooldowns.set(userId, Date.now());
}

// ===== Discord向け応答長さ制限 =====
const MAX_RESPONSE_CHARS = 400;

function truncateResponse(text) {
    if (!text) return text;
    if (text.length <= MAX_RESPONSE_CHARS) return text;
    const truncated = text.slice(0, MAX_RESPONSE_CHARS);
    const lastBreak = Math.max(
        truncated.lastIndexOf('。'),
        truncated.lastIndexOf('\n'),
        truncated.lastIndexOf('！'),
        truncated.lastIndexOf('？'),
    );
    if (lastBreak > MAX_RESPONSE_CHARS * 0.5) {
        return truncated.slice(0, lastBreak + 1) + '\n*(長い返答は省略されました)*';
    }
    return truncated + '…';
}

// 会話処理
async function chat(prompt, userId) {
    if (GEMINI_API_KEY.length === 0) return 'APIキーが設定されていません。';

    const history = conversationHistory.get(userId) || [];

    const contents = history.length === 0
        ? [
            { role: 'user', parts: [{ text: BOT_PERSONA_PROMPT }] },
            { role: 'model', parts: [{ text: 'わかりました。Discordの雑談を邪魔しないよう、短く端的に答えます。' }] },
            { role: 'user', parts: [{ text: prompt }] }
          ]
        : [
            ...history,
            { role: 'user', parts: [{ text: prompt }] }
          ];

    const MAX_RETRIES = GEMINI_API_KEY.length;

    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            const apiKey = getNextApiKey();
            const res = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
                {
                    contents,
                    generationConfig: {
                        maxOutputTokens: 256,
                        temperature: 0.7,
                    }
                },
                { headers: { 'Content-Type': 'application/json' } }
            );

            const rawResponse = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '応答が取得できませんでした。';
            const aiResponse = truncateResponse(rawResponse);

            // 履歴保存（古い分を削除）
            const newHistory = [
                ...history,
                { role: 'user', parts: [{ text: prompt }] },
                { role: 'model', parts: [{ text: aiResponse }] }
            ];
            if (newHistory.length > MAX_HISTORY_TURNS * 2 + 2) {
                const trimmed = newHistory.slice(0, 2).concat(newHistory.slice(-(MAX_HISTORY_TURNS * 2)));
                conversationHistory.set(userId, trimmed);
            } else {
                conversationHistory.set(userId, newHistory);
            }

            return aiResponse;

        } catch (err) {
            console.error('AIからの応答エラー:', err.response ? err.response.data : err.message);
            if (err.response?.status === 429 && i < MAX_RETRIES - 1) continue;
            return 'AIからの応答に失敗しました。';
        }
    }

    return 'AIからの応答に失敗しました。全てのAPIキーが制限に達した可能性があります。';
}

function resetHistory(userId) {
    conversationHistory.delete(userId);
}

module.exports = { chat, checkAiCooldown, setAiCooldown, resetHistory };
