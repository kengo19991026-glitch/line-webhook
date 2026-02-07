import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import admin from "firebase-admin";

const app = express();
const PORT = Number(process.env.PORT || 8080);

// --- 1. Firestore の初期化 ---
admin.initializeApp({
  projectId: "project-d3eb52a5-cef2-40c7-bfc" // あなたのプロジェクトID
});
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

// --- 2. 各種クライアントの初期化 ---
const openai = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 30000 // 30秒でタイムアウト設定
});

const client = new line.messagingApi.MessagingApiClient({ 
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN 
});

// --- 3. modeAI 専用プロンプト ---
const SYSTEM_PROMPT = `
あなたの名前は「modeAI（モードアイ）」です。
一流のパーソナルトレーナー、管理栄養士、心理カウンセラーの知識を統合した、大人向けの洗練されたAIアドバイザーとして振る舞ってください。

【基本スタンス】
・落ち着いた、シックで知的な口調を維持してください。
・「私たちは最高のチームです」という姿勢で、ユーザーを支えるパートナーとして接してください。
・回答は簡潔かつ構造化し、適度に改行と絵文字を使用して読みやすくしてください。

【3つの専門モード】
キーワードに応じて専門性を切り替えてください。
1. 「トレーナー」/「筋トレ」: 解剖学的・生理学的根拠に基づいた、熱血で理論的な指導。
2. 「栄養士」/「食事」: PFCバランスや血糖値を意識した、具体的で冷静な食事改善案。
3. 「カウンセラー」/「相談」: 傾聴と共感をベースに、自己肯定感を整える温かい対話。
※指定がない場合は、これらを統合してバランスよく回答してください。

【身体データの活用】
ユーザーデータ（身長・体重・目標）に基づき、「今の体重ならこの負荷が最適です」といったパーソナライズされた数値を必ず盛り込んでください。

【プロフィール更新ルール】
会話で新しい身体データ（現在の体重、目標等）を検知した場合は、必ず回答の末尾に以下を付与してください。
[SAVE_PROFILE: {"weight": 数値, "height": 数値, "targetWeight": 数値, "goal": "文字列"}]
`;

// 重複実行防止用のキャッシュ（1時間保持）
const eventCache = new Set();

app.post("/webhook", line.middleware({ 
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN, 
  channelSecret: process.env.LINE_CHANNEL_SECRET 
}), (req, res) => {
  // ⚡ LINEに即座に200を返し、再送を物理的に防ぐ
  res.status(200).send("OK");

  const events = req.body.events;
  events.forEach(async (event) => {
    if (event.type !== "message" || event.message.type !== "text") return;
    
    // 重複チェック
    if (eventCache.has(event.eventId)) return;
    eventCache.add(event.eventId);
    setTimeout(() => eventCache.delete(event.eventId), 3600000);

    // 非同期でメイン処理を実行
    handleModeAI(event).catch(err => console.error("[ERROR]", err));
  });
});

async function handleModeAI(event) {
  const userId = event.source.userId;
  const userText = event.message.text;

  // 1. プロフィールと履歴を並列取得（時短）
  const [profileDoc, historySnapshot] = await Promise.all([
    db.collection("users").doc(userId).get(),
    db.collection("users").doc(userId).collection("history").orderBy("createdAt", "desc").limit(8).get()
  ]);

  const profileData = profileDoc.exists ? profileDoc.data() : {};
  const pastMessages = historySnapshot.docs.reverse().map(doc => ({
    role: doc.data().role,
    content: doc.data().content
  }));

  // 2. OpenAI 呼び出し（第2世代環境で高速実行）
  const completion = await openai.chat.completions.create({
    model: "gpt-4o", 
    messages: [
      { role: "system", content: SYSTEM_PROMPT + "\n【ユーザーデータ】 " + JSON.stringify(profileData) },
      ...pastMessages,
      { role: "user", content: userText }
    ],
    temperature: 0.7,
  });

  let aiResponse = completion.choices[0].message.content || "";

  // 3. プロフィール更新タグの解析
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

  // 4. LINEへの返信と履歴保存を並列実行
  await Promise.all([
    client.pushMessage({
      to: userId,
      messages: [{ type: "text", text: aiResponse }]
    }),
    db.collection("users").doc(userId).collection("history").add({
      role: "user", content: userText, createdAt: admin.firestore.FieldValue.serverTimestamp()
    }),
    db.collection("users").doc(userId).collection("history").add({
      role: "assistant", content: aiResponse, createdAt: admin.firestore.FieldValue.serverTimestamp()
    })
  ]);
}

app.listen(PORT, "0.0.0.0", () => console.log(`modeAI is running on port ${PORT}`));
