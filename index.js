require('dotenv').config();

const express = require('express');
const { middleware, messagingApi } = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');

// ─── 設定チェック ────────────────────────────────────────────────
const REQUIRED_ENV = ['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'ANTHROPIC_API_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`ERROR: 環境変数 ${key} が設定されていません`);
    process.exit(1);
  }
}

// ─── クライアント初期化 ──────────────────────────────────────────
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const lineClient = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const anthropic = new Anthropic();

// ─── 定数 ────────────────────────────────────────────────────────
const MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS = 1024;
const MAX_HISTORY_PAIRS = 8; // ユーザー・アシスタントのペア数上限

const SYSTEM_PROMPT = `あなたはMeguriの健康アドバイザーです。陰陽五行・中医学の観点から、ユーザーの体質・季節に合わせた食事・養生アドバイスを提供します。親しみやすく簡潔に、LINEチャット向けの返答をしてください。

【ガイドライン】
- 回答は200〜400文字程度を目安に、LINEで読みやすい長さにする
- 体質タイプ（気虚・陰虚・血虚・陽虚・痰湿）に触れる場合は分かりやすく説明する
- 具体的な食材名・生活習慣のアドバイスを含める
- 医療診断・薬の処方は行わず、必要な場合は医師への相談を促す
- 絵文字を適度に使って親しみやすさを演出する`;

const RESET_KEYWORDS = ['リセット', 'クリア', 'はじめから', 'reset', 'clear'];

// ─── 会話履歴管理（ユーザーごとにインメモリで保持）───────────────
const histories = new Map();

function getHistory(userId) {
  if (!histories.has(userId)) histories.set(userId, []);
  return histories.get(userId);
}

function pushHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });
  // 上限を超えたら古いペアを削除
  while (history.length > MAX_HISTORY_PAIRS * 2) {
    history.splice(0, 2);
  }
}

function clearHistory(userId) {
  histories.set(userId, []);
}

// ─── Claudeへのリクエスト ────────────────────────────────────────
async function askClaude(userId, userText) {
  pushHistory(userId, 'user', userText);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: getHistory(userId),
  });

  const replyText = response.content[0].text;
  pushHistory(userId, 'assistant', replyText);
  return replyText;
}

// ─── LINEイベント処理 ────────────────────────────────────────────
async function handleEvent(event) {
  if (event.type === 'follow') {
    // 友だち追加時のウェルカムメッセージ
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: 'Meguriへようこそ！🌿\n\n陰陽五行・中医学の観点から、あなたの体質や季節に合わせた食事・養生アドバイスをお届けします。\n\n気になることは何でもお気軽にどうぞ。「体が疲れやすい」「冷え性がひどい」など、お悩みをそのまま教えてください😊',
      }],
    });
    return;
  }

  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId = event.source.userId;
  const userText = event.message.text.trim();

  // リセットコマンド
  if (RESET_KEYWORDS.includes(userText)) {
    clearHistory(userId);
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: '会話をリセットしました🔄\nまた新たにご相談ください！',
      }],
    });
    return;
  }

  try {
    const reply = await askClaude(userId, userText);
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: reply }],
    });
  } catch (err) {
    console.error(`Claude APIエラー [userId: ${userId}]:`, err.message);
    // エラー時はユーザーに通知して履歴をロールバック
    const history = getHistory(userId);
    if (history.length > 0 && history[history.length - 1].role === 'user') {
      history.pop();
    }
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: '申し訳ありません、一時的にエラーが発生しました🙏\nしばらくしてからもう一度お試しください。',
      }],
    });
  }
}

// ─── Expressサーバー ─────────────────────────────────────────────
const app = express();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', model: MODEL });
});

app.post('/webhook', middleware(lineConfig), (req, res) => {
  // LINEには即座に200を返す（タイムアウト防止）
  res.sendStatus(200);
  Promise.all(req.body.events.map(handleEvent)).catch(console.error);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Meguri LINE Bot 起動中 — port ${PORT}`);
  console.log(`   モデル: ${MODEL}`);
  console.log(`   ヘルスチェック: http://localhost:${PORT}/health`);
  console.log(`   Webhook URL: http://localhost:${PORT}/webhook`);
});
