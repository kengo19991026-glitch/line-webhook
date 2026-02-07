import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import admin from "firebase-admin";

const app = express();
const PORT = Number(process.env.PORT || 8080);

// --- 1. Firestore 初期化 ---
if (!admin.apps.length) {
  admin.initializeApp({ projectId: "project-d3eb52a5-cef2-40c7-bfc" });
}
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

// --- 2. クライアント初期化 ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });
const blobClient = new line.messagingApi.MessagingApiBlobClient({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });

// --- 3. modeAI 専用プロンプト（LINE表示最適化版） ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。
「数字は嘘をつかない」を信条とする、超ロジカルかつユーザーに寄り添うパーソナルトレーナー兼栄養士です。

【重要：LINE表示用のフォーマットルール】
LINEのトーク画面で表示されるため、以下のルールを絶対に守ってください。
1. **Markdown記法（#, *, -）は禁止**です。「###」や「**」は絶対に使わないでください。
2. 見出しには「■」や「【 】」を使用してください。
3. 箇条書きには「・」を使用してください。
4. 強調したい箇所は「」や（）を使って表現し、アスタリスク(*)は使わないでください。

【思考プロセス（内部処理）】
回答前に必ずユーザーデータ（身長・体重・年齢・体脂肪率）から以下を計算してください。
1. BMR（基礎代謝）
2. TDEE（総消費カロリー）
3. 目標達成のためのPFCバランス（P:高め設定）

【回答構成】
挨拶は手短にし、すぐに以下の形式で数値を出してください。

■現状の数値分析
・推定消費(TDEE)：約〇〇kcal
・目標摂取：約〇〇kcal
・目標PFC：P:〇〇g / F:〇〇g / C:〇〇g

■具体的なアクション
（ここから、数値に基づいた食事やトレーニングの具体的種目・回数を「・」を使って箇条書きで提示）

■アドバイス
（メンタルケアを含めた、プロとしての温かい一言）

【プロフィール管理タグ】
ユーザーの身体データが更新された場合のみ、回答の最後に以下を付与：
[SAVE_PROFILE: {"weight": 数値, "height": 数値, "fatPercentage": 数値, "age": 数値, "targetWeight": 数値, "goal": "文字列"}]`;

// 重複防止キャッシュ
const eventCache = new Set();

app.post("/webhook", line.middleware({ 
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN, 
  channelSecret: process.env.LINE_CHANNEL_SECRET 
}), (req, res) => {
  res.status(200).send("OK");
  const events = req.body.events || [];

  events.forEach(async (event) => {
    if (eventCache.has(event.eventId)) return;
    eventCache.add(event.eventId);
    setTimeout(() => eventCache.delete(event.eventId), 60000);

    try {
      await handleModeAI(event);
    } catch (err) {
      console.error("Fatal Event Error:", err);
    }
  });
});

async function handleModeAI(event) {
  const userId = event.source.userId;
  let userContent;

  if (event.type === "message" && event.message.type === "text") {
    userContent = [{ type: "text", text: event.message.text }];
  } else if (event.type === "message" && event.message.type === "image") {
    const blob = await blobClient.getMessageContent(event.message.id);
    const buffer = await streamToBuffer(blob);
    const base64Image = buffer.toString("base64");
    
    // 画像送信時の指示にもフォーマット遵守を追加
    userContent = [
      { type: "text", text: "この写真を栄養士として分析してください。Markdown記法（#や*）は使わず、■や・を使って見やすく数値を提示してください。" },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
    ];
  } else {
    return;
  }

  // データ取得
  let profileData = {};
  let pastMessages = [];
  try {
    const profileDoc = await db.collection("users").doc(userId).get();
    profileData = profileDoc.exists ? profileDoc.data() : { weight: null };
    
    const snap = await db.collection("users").doc(userId).collection("history").orderBy("createdAt", "desc").limit(4).get();
    if (!snap.empty) {
      pastMessages = snap.docs.reverse().map(doc => ({ role: doc.data().role, content: doc.data().content }));
    }
  } catch (e) { console.error("DB Error:", e); }

  // OpenAI 呼び出し
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT + "\n\n【最新ユーザーデータ】" + JSON.stringify(profileData) },
      ...pastMessages,
      { role: "user", content: userContent }
    ],
    temperature: 0.2 // フォーマット崩れを防ぐため低めに設定
  });

  let aiResponse = completion.choices[0].message.content || "";

  // --- クリーニング処理（万が一Markdownが混ざった場合の保険） ---
  // ### や ** を削除または置換して、LINEで見やすくする
  aiResponse = aiResponse
    .replace(/^### /gm, "■")   // ### 見出し -> ■見出し
    .replace(/^## /gm, "■")    // ## 見出し -> ■見出し
    .replace(/\*\*/g, "")      // **強調** -> 強調（単に削除）
    .replace(/^\* /gm, "・")   // * 箇条書き -> ・箇条書き
    .replace(/^- /gm, "・");   // - 箇条書き -> ・箇条書き

  // プロフィール更新処理
  const saveMatch = aiResponse.match(/\[SAVE_PROFILE: ({.*?})\]/);
  if (saveMatch) {
    try {
      const newData = JSON.parse(saveMatch[1]);
      await db.collection("users").doc(userId).set(newData, { merge: true });
      aiResponse = aiResponse.replace(/\[SAVE_PROFILE: {.*?}\]/g, "").trim();
    } catch (e) {}
  }

  await client.pushMessage({ to: userId, messages: [{ type: "text", text: aiResponse }] });

  // 履歴保存
  const historyText = event.message.type === "text" ? event.message.text : "[画像送信]";
  db.collection("users").doc(userId).collection("history").add({
    role: "user", content: historyText, createdAt: admin.firestore.FieldValue.serverTimestamp()
  }).catch(() => {});
  db.collection("users").doc(userId).collection("history").add({
    role: "assistant", content: aiResponse, createdAt: admin.firestore.FieldValue.serverTimestamp()
  }).catch(() => {});
}

async function streamToBuffer(stream) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

app.listen(PORT, "0.0.0.0");
