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

// --- 3. modeAI 専用プロンプト（ログ保存・強制強化版） ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。
「数字は嘘をつかない」を信条とする、超ロジカルかつユーザーに寄り添うパーソナルトレーナー兼栄養士です。

【重要：LINE表示用のフォーマットルール】
1. 見出しには「■」や「【 】」を使用してください。
2. 箇条書きには「・」を使用してください。
3. **Markdown記法（#や*）は禁止**です。絶対に使わないでください。

【最重要タスク：食事データの保存】
ユーザーが「食事の写真」や「食べたものの報告」を送ってきた場合、アドバイスの最後に**必ず**以下の形式で隠しタグを出力してください。
これがないとデータベースに記録されません。

出力タグ形式：
[SAVE_NUTRITION: {"food": "料理名", "kcal": 数値, "p": 数値, "f": 数値, "c": 数値}]

※注意点：
・数値には「kcal」や「g」などの単位をつけず、純粋な数字だけにしてください。（例: "kcal": 550）
・前後に余計な文字を入れないでください。

【回答構成】
挨拶は手短にし、すぐに以下の形式で数値を出してください。

■現状の数値分析
・推定消費(TDEE)：約〇〇kcal
・目標摂取：約〇〇kcal
・目標PFC：P:〇〇g / F:〇〇g / C:〇〇g

■分析結果（食事の場合）
・料理名：〇〇
・カロリー：〇〇kcal
・PFC：P:〇〇g / F:〇〇g / C:〇〇g

■アドバイス
（メンタルケアを含めた、プロとしての温かい一言）

【プロフィール管理タグ】
ユーザーの身体データが更新された場合のみ付与：
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
    
    // 画像送信時、ログ保存タグを出すよう強く指示
    userContent = [
      { type: "text", text: "この写真を栄養士として分析してください。Markdown記法は禁止です。また、分析結果のカロリーとPFCをデータベースに保存するため、必ず末尾に [SAVE_NUTRITION] タグを正しいJSON形式で出力してください。" },
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
    profileData = profileDoc.exists ? profileDoc.data() : { weight: null };
    
    const snap = await db.collection("users").doc(userId).collection("history").orderBy("createdAt", "desc").limit(4).get();
    if (!snap.empty) {
      pastMessages = snap.docs.reverse().map(doc => ({ role: doc.data().role, content: doc.data().content }));
    }
  } catch (e) { console.error("DB Error:", e); }

  // OpenAI 呼び出し
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT + "\n\n【最新ユーザーデータ】" + JSON.stringify(profileData) },
      ...pastMessages,
      { role: "user", content: userContent }
    ],
    temperature: 0.2
  });

  let aiResponse = completion.choices[0].message.content || "";

  // --- 1. 食事ログ保存処理（正規表現を強化） ---
  // 改行が含まれていてもマッチするように [\s\S]*? を使用
  const saveNutritionMatch = aiResponse.match(/\[SAVE_NUTRITION: (\{[\s\S]*?\})\]/);
  if (saveNutritionMatch) {
    try {
      const jsonStr = saveNutritionMatch[1];
      const nutritionData = JSON.parse(jsonStr);
      
      // 数値型への変換（AIが文字列で返した場合の保険）
      const safeData = {
        food: nutritionData.food || "不明な食事",
        kcal: Number(nutritionData.kcal) || 0,
        p: Number(nutritionData.p) || 0,
        f: Number(nutritionData.f) || 0,
        c: Number(nutritionData.c) || 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };

      await db.collection("users").doc(userId).collection("nutrition_logs").add(safeData);
      console.log(`[SUCCESS] Nutrition log saved for user: ${userId}`);
    } catch (e) {
      console.error("[ERROR] Nutrition JSON parse failed:", e);
      // ここでエラーが出てもユーザーへの返信は止めない
    }
  }

  // --- 2. プロフィール保存処理 ---
  const saveProfileMatch = aiResponse.match(/\[SAVE_PROFILE: (\{[\s\S]*?\})\]/);
  if (saveProfileMatch) {
    try {
      const newData = JSON.parse(saveProfileMatch[1]);
      await db.collection("users").doc(userId).set(newData, { merge: true });
    } catch (e) {}
  }

  // --- クリーニング処理 ---
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
  
  // 保存用タグを削除（改行対応）
  cleaned = cleaned.replace(/\[SAVE_PROFILE: \{[\s\S]*?\}\]/g, "");
  cleaned = cleaned.replace(/\[SAVE_NUTRITION: \{[\s\S]*?\}\]/g, "");

  // マークダウン記号の削除・置換
  cleaned = cleaned.replace(/\*\*(.*?)\*\*/g, "$1"); // 太字
  cleaned = cleaned.replace(/^#{1,6}\s+/gm, "■ "); // 見出し
  cleaned = cleaned.replace(/^[\*\-]\s+/gm, "・"); // リスト
  cleaned = cleaned.replace(/`/g, ""); // バッククォート

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
