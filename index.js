import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import admin from "firebase-admin";

const app = express();
const PORT = Number(process.env.PORT || 8080);

admin.initializeApp({ projectId: "project-d3eb52a5-cef2-40c7-bfc" });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });

const SYSTEM_PROMPT = `あなたは超一流のパーソナルトレーナー、管理栄養士、心理カウンセラーを統合したアドバイザーです。
【使命】
・ユーザーの身体データに基づき、プロとして「踏み込んだ」分析を行ってください。
・「素晴らしい」だけでなく「〜なので〇〇kgまでは増やせます」「PFCバランス的には脂質が〇g多いです」など数値や根拠を交えてください。
・回答は構造化し、読みやすく、かつ情熱的に！
・新情報があれば末尾に必ず [SAVE_PROFILE: {...}] タグを付与してください。`;

app.post("/webhook", line.middleware({ 
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN, 
  channelSecret: process.env.LINE_CHANNEL_SECRET 
}), async (req, res) => {
  // 💡 ポイント1: LINEに即座に200を返し、タイムアウト再送を防ぐ
  res.sendStatus(200);

  const events = req.body.events;
  for (const event of events) {
    if (event.type !== "message" || event.message.type !== "text") continue;
    
    // 💡 ポイント2: 重い処理は async でバックグラウンド実行
    handleEvent(event).catch(err => console.error("Event Error:", err));
  }
});

async function handleEvent(event) {
  const userId = event.source.userId;
  const userText = event.message.text;

  // 1. 並列取得で時短
  const [profileDoc, historySnapshot] = await Promise.all([
    db.collection("users").doc(userId).get(),
    db.collection("users").doc(userId).collection("history").orderBy("createdAt", "desc").limit(8).get()
  ]);

  const profileData = profileDoc.exists ? profileDoc.data() : {};
  const pastMessages = historySnapshot.docs.reverse().map(doc => ({
    role: doc.data().role,
    content: doc.data().content
  }));

  // 2. GPT-4o で濃い内容を生成（非同期なので多少時間がかかってもOK）
  const completion = await openai.chat.completions.create({
    model: "gpt-4o", 
    messages: [
      { role: "system", content: SYSTEM_PROMPT + "\n【重要：ユーザーデータ】 " + JSON.stringify(profileData) },
      ...pastMessages,
      { role: "user", content: userText }
    ],
    temperature: 0.7,
  });

  let aiResponse = completion.choices[0].message.content || "";

  // 3. プロフィール自動更新
  const saveMatch = aiResponse.match(/\[SAVE_PROFILE: ({.*?})\]/);
  if (saveMatch) {
    try {
      await db.collection("users").doc(userId).set(JSON.parse(saveMatch[1]), { merge: true });
      aiResponse = aiResponse.replace(/\[SAVE_PROFILE: {.*?}\]/g, "").trim();
    } catch (e) { console.error("Save Error", e); }
  }

  // 4. 保存と返信
  await Promise.all([
    db.collection("users").doc(userId).collection("history").add({
      role: "user", content: userText, createdAt: admin.firestore.FieldValue.serverTimestamp()
    }),
    db.collection("users").doc(userId).collection("history").add({
      role: "assistant", content: aiResponse, createdAt: admin.firestore.FieldValue.serverTimestamp()
    }),
    client.replyMessage({ replyToken: event.replyToken, messages: [{ type: "text", text: aiResponse }] })
  ]);
}

app.listen(PORT, "0.0.0.0");
