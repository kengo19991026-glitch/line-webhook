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

// --- 3. modeAI 専用プロンプト（フォーマット強制版） ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。

【画像が送られてきた場合の絶対ルール】
あなたは「栄養成分分析システム」として機能します。
「美味しそうですね」などの感想や挨拶から始めず、**必ず以下のフォーマット通りに数値を出力してください。**

出力フォーマット：
-----------------------------------
【分析結果】
料理名：〇〇
カロリー：〇〇kcal
タンパク質：〇〇g
脂質：〇〇g
炭水化物：〇〇g
（上記は画像からの推定です）

【アドバイス】
（ここからトレーナー・栄養士として、メンタルケアを含めた温かいアドバイスや、次回の食事への提案を記述してください）
-----------------------------------

【テキスト会話時のルール】
通常時は、トレーナー・栄養士・カウンセラーを統合した、大人な雰囲気の洗練されたアドバイザーとして、ユーザーに寄り添った対話をしてください。

【プロフィール管理】
会話から新しい身体データ（体重、体脂肪率など）を得た場合のみ、回答の最後に以下を付与：
[SAVE_PROFILE: {"weight": 数値, "height": 数値, "fatPercentage": 数値, "targetWeight": 数値, "goal": "文字列"}]
`;

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

  // メッセージ判別
  if (event.type === "message" && event.message.type === "text") {
    userContent = [{ type: "text", text: event.message.text }];
  } else if (event.type === "message" && event.message.type === "image") {
    const blob = await blobClient.getMessageContent(event.message.id);
    const buffer = await streamToBuffer(blob);
    const base64Image = buffer.toString("base64");
    
    // 画像送信時のプロンプトも「数値を出すこと」にフォーカスさせる
    userContent = [
      { type: "text", text: "この料理の栄養素を分析し、指定されたフォーマット（カロリー、PFC）で数値を出力してください。" },
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
    if (profileDoc.exists) profileData = profileDoc.data();
    
    // 画像解析の際は、過去の文脈に引っ張られすぎないよう履歴を少し減らすか、あるいはそのまま使う
    const snap = await db.collection("users").doc(userId).collection("history").orderBy("createdAt", "desc").limit(6).get();
    if (!snap.empty) {
      pastMessages = snap.docs.reverse().map(doc => ({ role: doc.data().role, content: doc.data().content }));
    }
  } catch (e) { console.error("DB Error:", e); }

  // OpenAI 呼び出し
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT + "\n【ユーザー情報】" + JSON.stringify(profileData) },
      ...pastMessages,
      { role: "user", content: userContent }
    ],
    // Temperatureを下げて、フォーマット遵守率を高める
    temperature: 0.2, 
    max_tokens: 800
  });

  let aiResponse = completion.choices[0].message.content || "";

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
