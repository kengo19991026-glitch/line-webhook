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

// --- 3. modeAI 専用プロンプト（画像解析・絶対優先版） ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。
あなたは**「世界最高峰の画像認識能力を持つAI栄養士」**です。

【最重要司令：画像解析の強制】
ユーザーから写真が送られた場合、**「分析できない」「詳しくは分からない」という発言は固く禁じます。**
たとえ写真が不鮮明でも、一部しか写っていなくても、必ずあなたの**「推測（目視）」**で以下の数値を断定して出力してください。
※システム上の過去データに頼らず、**今見ている画像**を最優先で分析してください。

【タスク1：食事データの保存（必須）】
分析結果の数値は、以下の形式の隠しタグとして**必ず**出力してください。
[SAVE_NUTRITION: {"food": "料理名", "kcal": 数値, "p": 数値, "f": 数値, "c": 数値}]
※数値は整数（例: 550）。

【タスク2：集計データの統合】
プロンプト末尾に「システム算出データ（過去の履歴）」が渡されます。
質問に答える際は、このシステムデータと、**今まさに画像から読み取った数値**を足し合わせて回答してください。

【禁止事項】
・Markdown記法（#や*）の使用。
・「推測ですが」「正確ではありませんが」といった自信のない前置き。

【回答構成】
■今回の分析結果
・料理名：〇〇（見た目から具体的に特定）
・カロリー：約〇〇kcal
・PFC：P:〇〇g / F:〇〇g / C:〇〇g

■本日の合計（今回分を含む）
・合計：約〇〇kcal（システム記録 + 今回の分析値）

■アドバイス
（短く簡潔に、プロとしての次の一手）

【プロフィール管理タグ】
[SAVE_PROFILE: {"weight": 数値, "height": 数値, "fatPercentage": 数値, "age": 数値, "targetWeight": 数値, "goal": "文字列"}]`;

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

  if (event.type === "message" && event.message.type === "text") {
    userContent = [{ type: "text", text: event.message.text }];
  } else if (event.type === "message" && event.message.type === "image") {
    const blob = await blobClient.getMessageContent(event.message.id);
    const buffer = await streamToBuffer(blob);
    const base64Image = buffer.toString("base64");
    
    // 画像送信時の指示を「推測許可」に変更
    userContent = [
      { type: "text", text: "この料理の写真を分析してください。「分析できない」は禁止です。見た目から大胆に推測し、具体的なカロリーとPFCを数値で断定してください。必ず末尾に [SAVE_NUTRITION] タグを出力すること。" },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
    ];
  } else {
    return;
  }

  // --- データ取得 & 集計ロジック ---
  let profileData = {};
  let pastMessages = [];
  let summary = { today: { k: 0, p: 0, f: 0, c: 0 }, week: { k: 0 }, month: { k: 0 } };

  try {
    const profileDoc = await db.collection("users").doc(userId).get();
    profileData = profileDoc.exists ? profileDoc.data() : { weight: null };

    const snap = await db.collection("users").doc(userId).collection("history").orderBy("createdAt", "desc").limit(4).get();
    if (!snap.empty) {
      pastMessages = snap.docs.reverse().map(doc => ({ role: doc.data().role, content: doc.data().content }));
    }

    // ログ集計
    const now = new Date();
    const jstOffset = 9 * 60 * 60 * 1000;
    const jstNow = new Date(now.getTime() + jstOffset);
    const todayStart = new Date(jstNow); todayStart.setUTCHours(0, 0, 0, 0); 
    const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - 6);
    const monthStart = new Date(todayStart); monthStart.setDate(monthStart.getDate() - 29);
    const queryStartUtc = new Date(monthStart.getTime() - jstOffset);

    let logSnap = { empty: true, forEach: () => {} };
    try {
      logSnap = await db.collection("users").doc(userId).collection("nutrition_logs")
        .where("createdAt", ">=", queryStartUtc).get();
    } catch (e) {}

    if (!logSnap.empty) {
      logSnap.forEach(doc => {
        const d = doc.data();
        const logDateJst = new Date(d.createdAt.toDate().getTime() + jstOffset);
        const vals = { k: Number(d.kcal)||0, p: Number(d.p)||0, f: Number(d.f)||0, c: Number(d.c)||0 };
        
        summary.month.k += vals.k;
        if (logDateJst >= new Date(weekStart.getTime() - jstOffset)) summary.week.k += vals.k;
        if (logDateJst >= new Date(todayStart.getTime() - jstOffset)) {
            summary.today.k += vals.k; summary.today.p += vals.p; summary.today.f += vals.f; summary.today.c += vals.c;
        }
      });
    }
  } catch (e) { console.error("DB Error:", e); }

  const getAvg = (sum, days) => Math.round(sum / days);

  // システムメッセージ作成（画像解析を邪魔しない文言に修正）
  const dynamicSystemMessage = `
${SYSTEM_PROMPT}

【システム算出データ（参考情報）】
※以下は過去の記録です。**今送られてきた画像の分析には使用しないでください。**
今、画像が送られている場合は、このデータに「画像から読み取った数値」を足して、今日の合計を回答してください。

・本日記録済み: ${summary.today.k} kcal
・直近7日平均: ${getAvg(summary.week.k, 7)} kcal/日

【ユーザー情報】
${JSON.stringify(profileData)}
`;

  // OpenAI 呼び出し（画像解析の自由度を高めるためTemperatureを調整）
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: dynamicSystemMessage },
      ...pastMessages,
      { role: "user", content: userContent }
    ],
    temperature: 0.5, // 0.2だと保守的になりすぎて「分からない」と言うため、少し上げる
    max_tokens: 1000
  });

  let aiResponse = completion.choices[0].message.content || "";

  // --- 保存処理 ---
  const saveNutritionMatch = aiResponse.match(/\[SAVE_NUTRITION: (\{[\s\S]*?\})\]/);
  if (saveNutritionMatch) {
    try {
      const jsonStr = saveNutritionMatch[1];
      const nutritionData = JSON.parse(jsonStr);
      await db.collection("users").doc(userId).collection("nutrition_logs").add({
        ...nutritionData,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) {}
  }

  const saveProfileMatch = aiResponse.match(/\[SAVE_PROFILE: (\{[\s\S]*?\})\]/);
  if (saveProfileMatch) {
    try {
      const newData = JSON.parse(saveProfileMatch[1]);
      await db.collection("users").doc(userId).set(newData, { merge: true });
    } catch (e) {}
  }

  // --- クリーニング ---
  aiResponse = cleanMarkdown(aiResponse);

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

// --- マークダウン除去専用関数 ---
function cleanMarkdown(text) {
  let cleaned = text;
  cleaned = cleaned.replace(/\[SAVE_PROFILE: \{[\s\S]*?\}\]/g, "");
  cleaned = cleaned.replace(/\[SAVE_NUTRITION: \{[\s\S]*?\}\]/g, "");
  cleaned = cleaned.replace(/\*\*(.*?)\*\*/g, "$1");
  cleaned = cleaned.replace(/^#{1,6}\s+/gm, "■ ");
  cleaned = cleaned.replace(/^[\*\-]\s+/gm, "・");
  cleaned = cleaned.replace(/`/g, "");
  return cleaned.trim();
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
