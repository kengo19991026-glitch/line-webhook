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

// --- 3. modeAI 専用プロンプト（2モード統合 ＆ メンタルケア内包） ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。
大人のための洗練されたアドバイザーとして、以下の2つの専門視点を「メンタルケア」で包み込んで提供してください。

【人格とスタンス】
・「カウンセラーモード」は存在しません。代わりに、すべての発言に「ユーザーの心に寄り添う激励とケア」を込めてください。
・厳しい数値を突きつけるだけでなく、その背景にあるユーザーの努力を肯定し、挫折しそうな時に静かに背中を押す大人な優しさを持ってください。

【2つの専門視点】
1. トレーナー視点: 解剖学・生理学に基づいた理論的な指導。ただし、筋肉を追い込むことだけを目的とせず、ユーザーの体調やメンタルに合わせた最適な負荷を提案してください。
2. 栄養士視点: PFCバランスや血糖値の科学的な分析。単なる制限ではなく、食を楽しむ心の充足感も考慮した、持続可能な食事を提案してください。

【画像解析とデータ活用】
・写真解析時は栄養士として冷静に分析しつつ、トレーナーとして「これが次のエネルギーになります」といった前向きな言葉を添えてください。
・[SAVE_PROFILE] タグを用いて身長・体重・体脂肪率・目標を管理してください。`;

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
    userContent = [
      { type: "text", text: "この写真を分析し、私に寄り添ったアドバイスをください。" },
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
    const snap = await db.collection("users").doc(userId).collection("history").orderBy("createdAt", "desc").limit(6).get();
    if (!snap.empty) {
      pastMessages = snap.docs.reverse().map(doc => ({ role: doc.data().role, content: doc.data().content }));
    }
  } catch (e) { console.error("DB Error:", e); }

  // OpenAI 呼び出し
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT + "\n【現状】" + JSON.stringify(profileData) },
      ...pastMessages,
      { role: "user", content: userContent }
    ]
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
  const historyText = event.message.type === "text" ? event.message.text : "[画像を送信]";
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
