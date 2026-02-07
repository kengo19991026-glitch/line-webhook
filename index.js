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

// --- 3. modeAI 専用プロンプト（数値化の強制と人格の統合） ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。
大人のための洗練されたアドバイザーとして、トレーナー・栄養士の専門知識を「深いメンタルケア」で包み込んで提供してください。

【食事画像解析の絶対ルール】
画像が送られてきた場合、必ず冒頭に以下の「推定数値データ」を構造化して提示してください。
1. 料理名
2. 推定総カロリー (kcal)
3. PFCバランスの推定値 (P:タンパク質, F:脂質, C:炭水化物) を「g（グラム）」で。

回答の開始例：
「お疲れ様です。お食事の写真を拝見しました。分析結果をご報告しますね。
■分析データ
・料理：〇〇
・熱量：約000kcal
・PFC：P:00g / F:00g / C:00g」

【人格とスタンス】
・カウンセラーモードは廃止しましたが、すべての回答に「激励と共感」を込めてください。
・数値はプロとして正確に出しつつ、その後のアドバイスでは「この一食があなたの明日の力になります」といった、大人の余裕と優しさを持って接してください。
・否定はせず、改善点を伝える際も「こうするとさらに効率的です」とポジティブに導いてください。

【プロフィール管理】
[SAVE_PROFILE: {"weight": 数値, "height": 数値, "fatPercentage": 数値, "targetWeight": 数値, "goal": "文字列"}]
の形式を末尾に付与して、ユーザーデータを更新してください。`;

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

  // メッセージ判別（テキストか画像か）
  if (event.type === "message" && event.message.type === "text") {
    userContent = [{ type: "text", text: event.message.text }];
  } else if (event.type === "message" && event.message.type === "image") {
    const blob = await blobClient.getMessageContent(event.message.id);
    const buffer = await streamToBuffer(blob);
    const base64Image = buffer.toString("base64");
    userContent = [
      { type: "text", text: "この写真を分析し、カロリーとPFCバランスを数値で教えてください。その上で私に寄り添ったアドバイスを。" },
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

  // OpenAI 呼び出し（数値の安定性を高める設定）
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT + "\n【現状】" + JSON.stringify(profileData) },
      ...pastMessages,
      { role: "user", content: userContent }
    ],
    temperature: 0.3, // 数値の推測をより堅実にするため低めに設定
    max_tokens: 1000
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
  const historyText = event.message.type === "text" ? event.message.text : "[食事画像を送信]";
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
