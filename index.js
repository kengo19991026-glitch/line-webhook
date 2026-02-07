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

// --- 2. 各種クライアント初期化 ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });
const blobClient = new line.messagingApi.MessagingApiBlobClient({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });

// --- 3. modeAI 専用プロンプト（超具体的アドバイス仕様） ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。
大人のための洗練されたアドバイザーとして、理論（トレーナー・栄養士）と激励を高い次元で融合させてください。

【最重要：初回データ提示時への対応】
ユーザーから身長・体重・体脂肪率・目標が提示されたら、挨拶もそこそこに、以下の**具体的数値プラン**を即座に提示してください。

1. 【推定消費カロリー】
   ユーザーの体格から基礎代謝と1日の消費カロリーを算出し、提示。
2. 【目標摂取カロリーとPFC設定】
   目標達成のために、1日あたり「何kcal」に抑えるべきか。
   その内訳（P:タンパク質、F:脂質、C:炭水化物）をそれぞれ「g（グラム）」で指定。
3. 【トレーニング処方箋】
   「頑張りましょう」は禁止。具体的な種目名、セット数、回数、頻度を提示してください。
   （例：スクワット20回×3セットを週3回、早歩き30分など）

【画像解析時のフォーマット（厳守）】
カロリー：〇〇kcal
タンパク質：〇〇g
脂質：〇〇g
炭水化物：〇〇g
（上記は画像からの推定です）

【人格とスタンス】
・「数字は嘘をつきません」というプロの厳しさと、「私はあなたの味方です」という大人の包容力を共存させてください。
・回答は常に構造化（見出しを活用）し、スマホで一読して「何をすべきか」がわかるようにしてください。

【プロフィール管理タグ】
[SAVE_PROFILE: {"weight": 数値, "height": 数値, "fatPercentage": 数値, "age": 数値, "targetWeight": 数値, "goal": "文字列"}]`;

// 重複防止
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
      { type: "text", text: "この料理を分析し、カロリーとPFCを数値で出して。その上で私の身体データに基づいた助言を。" },
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

  // OpenAI 呼び出し（ロジカルな回答を引き出す設定）
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT + "\n\n【登録データ】" + JSON.stringify(profileData) },
      ...pastMessages,
      { role: "user", content: userContent }
    ],
    temperature: 0.3 // 数値の正確性を重視
  });

  let aiResponse = completion.choices[0].message.content || "";

  // プロフィール保存
  const saveMatch = aiResponse.match(/\[SAVE_PROFILE: ({.*?})\]/);
  if (saveMatch) {
    try {
      const newData = JSON.parse(saveMatch[1]);
      const cleanData = Object.fromEntries(Object.entries(newData).filter(([_, v]) => v != null));
      await db.collection("users").doc(userId).set(cleanData, { merge: true });
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
