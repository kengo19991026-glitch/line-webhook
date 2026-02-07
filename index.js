import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import admin from "firebase-admin";

const app = express();
const PORT = Number(process.env.PORT || 8080);

// --- 1. Firestore の初期化 ---
admin.initializeApp({
  projectId: "project-d3eb52a5-cef2-40c7-bfc" 
});
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

// --- 2. 各種クライアントの初期化 ---
const openai = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY
});

const client = new line.messagingApi.MessagingApiClient({ 
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN 
});

// --- 3. modeAI 専用プロンプト（体脂肪率の項目を追加） ---
const SYSTEM_PROMPT = `
あなたの名前は「modeAI（モードアイ）」です。
一流のトレーナー、栄養士、カウンセラーを統合した、大人向けの洗練されたAIアドバイザーです。

【重要な任務】
・ユーザーの「身長・体重・体脂肪率・目標」を把握し、それに基づいた専門的な数値を提示してください。
・体脂肪率の変化は、筋肉量の増減や食事の質を判断する重要な指標として扱ってください。

【新規ユーザーへの対応】
・相手が初めて、またはデータが不足している場合は、丁寧に自己紹介をし、「身長、体重、体脂肪率、目標体重」を教えてもらうよう促してください。

【プロフィール更新ルール】
会話で新しい身体データ（体重、体脂肪率等）を検知した場合は、必ず回答の末尾に以下を付与してください。
[SAVE_PROFILE: {"weight": 数値, "height": 数値, "fatPercentage": 数値, "targetWeight": 数値, "goal": "文字列"}]
`;

const eventCache = new Set();

app.post("/webhook", line.middleware({ 
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN, 
  channelSecret: process.env.LINE_CHANNEL_SECRET 
}), (req, res) => {
  res.status(200).send("OK");

  const events = req.body.events;
  events.forEach(async (event) => {
    if (event.type !== "message" || event.message.type !== "text") return;
    
    if (eventCache.has(event.eventId)) return;
    eventCache.add(event.eventId);
    setTimeout(() => eventCache.delete(event.eventId), 3600000);

    handleModeAI(event).catch(err => console.error("[CRITICAL ERROR]", err));
  });
});

async function handleModeAI(event) {
  const userId = event.source.userId;
  const userText = event.message.text;

  // --- 4. データの取得（安全な読み込み） ---
  let profileData = {};
  let pastMessages = [];

  try {
    const profileDoc = await db.collection("users").doc(userId).get();
    if (profileDoc.exists) {
      profileData = profileDoc.data();
    }

    const historySnapshot = await db.collection("users").doc(userId)
      .collection("history").orderBy("createdAt", "desc").limit(6).get();
    
    if (!historySnapshot.empty) {
      pastMessages = historySnapshot.docs.reverse().map(doc => ({
        role: doc.data().role,
        content: doc.data().content
      }));
    }
  } catch (dbError) {
    console.error("Database Read Error:", dbError);
  }

  // --- 5. OpenAI 呼び出し ---
  const completion = await openai.chat.completions.create({
    model: "gpt-4o", 
    messages: [
      { role: "system", content: SYSTEM_PROMPT + "\n【現在のユーザーデータ】 " + JSON.stringify(profileData) },
      ...pastMessages,
      { role: "user", content: userText }
    ],
    temperature: 0.7,
  });

  let aiResponse = completion.choices[0].message.content || "";

  // --- 6. プロフィール更新（fatPercentageに対応） ---
  const saveMatch = aiResponse.match(/\[SAVE_PROFILE: ({.*?})\]/);
  if (saveMatch) {
    try {
      const newData = JSON.parse(saveMatch[1]);
      await db.collection("users").doc(userId).set(newData, { merge: true });
      aiResponse = aiResponse.replace(/\[SAVE_PROFILE: {.*?}\]/g, "").trim();
      console.log("[LOG] Profile Updated with Fat Percentage");
    } catch (e) {
      console.error("Profile Save Error:", e);
    }
  }

  // --- 7. 返信と履歴保存（独立実行） ---
  client.pushMessage({
    to: userId,
    messages: [{ type: "text", text: aiResponse }]
  }).catch(e => console.error("Push Error:", e));

  db.collection("users").doc(userId).collection("history").add({
    role: "user", content: userText, createdAt: admin.firestore.FieldValue.serverTimestamp()
  }).catch(e => console.error("History Save Error (User)"));

  db.collection("users").doc(userId).collection("history").add({
    role: "assistant", content: aiResponse, createdAt: admin.firestore.FieldValue.serverTimestamp()
  }).catch(e => console.error("History Save Error (AI)"));
}

app.listen(PORT, "0.0.0.0");
