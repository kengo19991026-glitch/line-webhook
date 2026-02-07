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

// --- 3. modeAI 専用プロンプト（データ受取最優先・即時反映ロジック） ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。
トレーナー・栄養士の専門知識を「深いメンタルケア」で包み込むプロのアドバイザーです。

【最優先：データ受取と保存のロジック】
1. ユーザーから「身長・体重・年齢・体脂肪率・目標」などの数値がメッセージ（userContent）に含まれている場合、**他のどのルールよりも優先してその数値を読み取り、回答の末尾に必ず [SAVE_PROFILE] タグを付与して保存してください。**
2. データを送ってくれた瞬間、拒否することなく「データをありがとうございます。内容を把握しました」と伝え、そのままプロとしての具体的な分析や激励を開始してください。
3. 過去のデータ（JSON）が空であっても、今回のメッセージでデータが提供されていれば、それは「データがある状態」として扱います。
4. 全くデータがなく、かつ今回も提示されていない場合のみ、具体的な助言を控え、データを要求してください。

【食事解析のフォーマット】
画像解析時は、必ず冒頭に以下を数値で出力：
カロリー：〇〇kcal
タンパク質：〇〇g
脂質：〇〇g
炭水化物：〇〇g
（上記は画像からの推定です）

【プロフィール管理タグ（絶対必須）】
数値を検知・更新した際は必ず末尾に付与（1つでも数値があれば付与）：
[SAVE_PROFILE: {"weight": 数値, "height": 数値, "fatPercentage": 数値, "age": 数値, "targetWeight": 数値, "goal": "文字列"}]

【口調】
洗練された敬語。大人の余裕と、目標達成への強い並走感。`;

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
    userContent = [
      { type: "text", text: "この料理の栄養素を分析し、指定のフォーマットで数値を出力してください。" },
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
    profileData = profileDoc.exists ? profileDoc.data() : { weight: null, height: null, goal: null };
    
    const snap = await db.collection("users").doc(userId).collection("history").orderBy("createdAt", "desc").limit(6).get();
    if (!snap.empty) {
      pastMessages = snap.docs.reverse().map(doc => ({ role: doc.data().role, content: doc.data().content }));
    }
  } catch (e) { console.error("DB Error:", e); }

  // OpenAI 呼び出し（指示の優先順位を明確化）
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT + "\n\n【DBに登録済みのユーザーデータ】" + JSON.stringify(profileData) },
      ...pastMessages,
      { role: "user", content: userContent }
    ],
    temperature: 0.2
  });

  let aiResponse = completion.choices[0].message.content || "";

  // [SAVE_PROFILE] タグの処理とFirestore保存
  const saveMatch = aiResponse.match(/\[SAVE_PROFILE: ({.*?})\]/);
  if (saveMatch) {
    try {
      const newData = JSON.parse(saveMatch[1]);
      // nullやundefinedを除外してクリーンなデータにする
      const cleanData = Object.fromEntries(Object.entries(newData).filter(([_, v]) => v != null));
      await db.collection("users").doc(userId).set(cleanData, { merge: true });
      aiResponse = aiResponse.replace(/\[SAVE_PROFILE: {.*?}\]/g, "").trim();
      console.log(`[SUCCESS] Profile updated for user: ${userId}`);
    } catch (e) {
      console.error("Save Match Error:", e);
    }
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
