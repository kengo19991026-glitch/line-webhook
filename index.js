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

// --- 3. modeAI 専用プロンプト ---
const SYSTEM_PROMPT = `
あなたの名前は「modeAI（モードアイ）」です。
一流のパーソナルトレーナー、管理栄養士、心理カウンセラーを統合した、大人向けの洗練されたAIアドバイザーです。

【新規ユーザーへの対応】
・相手が初めての利用者の場合は、丁寧に自己紹介をし、これから一緒に目標を目指すパートナーであることを伝えてください。
・まずは「身長、体重、目標」を教えてもらうよう促してください。

【基本ルール】
・落ち着いた、知的な口調（です・ます調）を維持。
・「私たちは最高のチームです」という姿勢。
・回答は簡潔に構造化し、適度な改行と絵文字を使用。

【専門モード】
キーワード（トレーナー/筋トレ、栄養士/食事、カウンセラー/相談）に応じて専門性を高めてください。
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

  // --- 4. データの取得（エラーハンドリング強化） ---
  let profileData = {};
  let pastMessages = [];

  try {
    const profileDoc = await db.collection("users").doc(userId).get();
    if (profileDoc.exists) {
      profileData = profileDoc.data();
    }

    // 履歴取得（空でもエラーにならないようにする）
    const historySnapshot = await db.collection("users").doc(userId)
      .collection("history").orderBy("createdAt", "desc").limit(6).get();
    
    if (!historySnapshot.empty) {
      pastMessages = historySnapshot.docs.reverse().map(doc => ({
        role: doc.data().role,
        content: doc.data().content
      }));
    }
  } catch (dbError) {
    console.error("Firestore Read Error:", dbError);
    // DBエラーでも会話を続行させるため、空のまま進む
  }

  // --- 5. OpenAI 呼び出し ---
  const completion = await openai.chat.completions.create({
    model: "gpt-4o", 
    messages: [
      { role: "system", content: SYSTEM_PROMPT + "\n【ユーザー情報】 " + JSON.stringify(profileData) },
      ...pastMessages,
      { role: "user", content: userText }
    ],
    temperature: 0.7,
  });

  let aiResponse = completion.choices[0].message.content || "";

  // --- 6. プロフィール更新 ---
  const saveMatch = aiResponse.match(/\[SAVE_PROFILE: ({.*?})\]/);
  if (saveMatch) {
    try {
      const newData = JSON.parse(saveMatch[1]);
      await db.collection("users").doc(userId).set(newData, { merge: true });
      aiResponse = aiResponse.replace(/\[SAVE_PROFILE: {.*?}\]/g, "").trim();
    } catch (e) {
      console.error("Profile Save Error:", e);
    }
  }

  // --- 7. 送答と保存 ---
  // 履歴保存に失敗しても返信だけは届くように個別に実行
  client.pushMessage({
    to: userId,
    messages: [{ type: "text", text: aiResponse }]
  }).catch(e => console.error("Push Error:", e));

  db.collection("users").doc(userId).collection("history").add({
    role: "user", content: userText, createdAt: admin.firestore.FieldValue.serverTimestamp()
  }).catch(e => console.error("History Save Error (User):", e));

  db.collection("users").doc(userId).collection("history").add({
    role: "assistant", content: aiResponse, createdAt: admin.firestore.FieldValue.serverTimestamp()
  }).catch(e => console.error("History Save Error (AI):", e));
}

app.listen(PORT, "0.0.0.0");
