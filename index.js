import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import admin from "firebase-admin";

const app = express();
const PORT = Number(process.env.PORT || 8080);

// --- 1. Firestore 初期化 (プロジェクトID確認済み) ---
if (!admin.apps.length) {
  admin.initializeApp({ projectId: "project-d3eb52a5-cef2-40c7-bfc" });
}
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

// --- 2. クライアント初期化 ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });

// --- 3. modeAI 専用プロンプト ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。
一流のトレーナー、栄養士、カウンセラーを統合したアドバイザーとして振る舞ってください。

【ミッション】
・ユーザーの身長、体重、体脂肪率、目標を把握し、パーソナライズされた助言をすること。
・体脂肪率は健康管理の要です。数値の変化をプロ視点で分析してください。

【新規ユーザーへの対応】
・データがない場合は丁寧に自己紹介し、身体データ（体重、体脂肪率など）を教えてもらうよう促してください。

【保存ルール】
数値が変わった時は、必ず末尾に以下を付与してください。
[SAVE_PROFILE: {"weight": 数値, "height": 数値, "fatPercentage": 数値, "targetWeight": 数値, "goal": "文字列"}]`;

// 重複防止
const eventCache = new Set();

app.post("/webhook", line.middleware({ 
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN, 
  channelSecret: process.env.LINE_CHANNEL_SECRET 
}), (req, res) => {
  res.status(200).send("OK");
  const events = req.body.events || [];

  events.forEach(async (event) => {
    if (event.type !== "message" || event.message.type !== "text") return;
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
  const userText = event.message.text;

  // 1. データ取得 (個別に try-catch してエラーでも続行させる)
  let profileData = {};
  let pastMessages = [];

  try {
    const profileDoc = await db.collection("users").doc(userId).get();
    if (profileDoc.exists) profileData = profileDoc.data();
  } catch (e) { console.error("Profile Read Error:", e); }

  try {
    const snap = await db.collection("users").doc(userId).collection("history")
      .orderBy("createdAt", "desc").limit(6).get();
    if (!snap.empty) {
      pastMessages = snap.docs.reverse().map(doc => ({
        role: doc.data().role, content: doc.data().content
      }));
    }
  } catch (e) { console.error("History Read Error:", e); }

  // 2. AI 呼び出し
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT + "\n【現状】" + JSON.stringify(profileData) },
      ...pastMessages,
      { role: "user", content: userText }
    ]
  });

  let aiResponse = completion.choices[0].message.content || "";

  // 3. プロフィール更新
  const saveMatch = aiResponse.match(/\[SAVE_PROFILE: ({.*?})\]/);
  if (saveMatch) {
    try {
      const newData = JSON.parse(saveMatch[1]);
      await db.collection("users").doc(userId).set(newData, { merge: true });
      aiResponse = aiResponse.replace(/\[SAVE_PROFILE: {.*?}\]/g, "").trim();
    } catch (e) { console.error("Save Match Error:", e); }
  }

  // 4. 返信 (失敗してもログに残す)
  try {
    await client.pushMessage({
      to: userId,
      messages: [{ type: "text", text: aiResponse }]
    });
  } catch (e) { console.error("Push Message Error:", e); }

  // 5. 履歴保存 (バックグラウンドで実行)
  db.collection("users").doc(userId).collection("history").add({
    role: "user", content: userText, createdAt: admin.firestore.FieldValue.serverTimestamp()
  }).catch(() => {});
  db.collection("users").doc(userId).collection("history").add({
    role: "assistant", content: aiResponse, createdAt: admin.firestore.FieldValue.serverTimestamp()
  }).catch(() => {});
}

app.listen(PORT, "0.0.0.0");
