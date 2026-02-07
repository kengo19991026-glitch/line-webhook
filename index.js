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

// --- 3. modeAI 専用プロンプト（集計機能・完全版） ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。
数字に基づくロジカルな指導を行うパーソナルトレーナーです。

【重要：禁止事項】
**「集計する機能はありません」「手動で計算してください」という発言はシステムエラーとみなされるため、絶対に禁止します。**
あなたはシステムから渡される「計算済みの数値」を持っています。必ずそれを使って回答してください。

【フォーマットルール（LINE用）】
Markdown記法（#や*）は禁止です。
・見出しは「■」または「【 】」
・箇条書きは「・」
を使用してください。

【タスク：食事データの保存】
ユーザーから食事報告があった場合、回答の最後に**必ず**以下のタグを出力してください。
[SAVE_NUTRITION: {"food": "料理名", "kcal": 数値, "p": 数値, "f": 数値, "c": 数値}]
※数値は単位なしの数字のみ（例: "kcal": 550）。

【タスク：集計データの回答】
プロンプトの最後に**「システム算出データ」**が渡されます。
ユーザーから「今日の合計は？」「今週どう？」と聞かれたら、その数値をそのまま答えてください。
※もしシステム数値が「0」で、直前の会話に食事報告がある場合は、その分を脳内で足して答えてください。

【回答構成】
■現状の数値（システム集計）
・本日の合計：約〇〇kcal
・（週間平均があれば）：直近7日平均 〇〇kcal
・目標PFC達成度：(P/F/Cのバランスについて言及)

■分析結果（食事報告時のみ）
・料理名：〇〇
・カロリー：〇〇kcal
・PFC：P:〇〇g / F:〇〇g / C:〇〇g

■アドバイス
（メンタルケアを含めた、プロとしての温かい一言）

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
    
    userContent = [
      { type: "text", text: "この写真を栄養士として分析してください。Markdown禁止。必ず末尾に [SAVE_NUTRITION] タグを出力してください。" },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
    ];
  } else {
    return;
  }

  // --- データ取得 & 集計ロジック（本日・週間・月間） ---
  let profileData = {};
  let pastMessages = [];
  
  // 集計用オブジェクト
  let summary = {
    today: { k: 0, p: 0, f: 0, c: 0 },
    week:  { k: 0, p: 0, f: 0, c: 0 },
    month: { k: 0, p: 0, f: 0, c: 0 }
  };

  try {
    // 1. プロフィール取得
    const profileDoc = await db.collection("users").doc(userId).get();
    profileData = profileDoc.exists ? profileDoc.data() : { weight: null };

    // 2. 履歴取得
    const snap = await db.collection("users").doc(userId).collection("history").orderBy("createdAt", "desc").limit(4).get();
    if (!snap.empty) {
      pastMessages = snap.docs.reverse().map(doc => ({ role: doc.data().role, content: doc.data().content }));
    }

    // 3. 過去30日分のログを一括取得して振り分け集計
    const now = new Date();
    const jstOffset = 9 * 60 * 60 * 1000;
    const jstNow = new Date(now.getTime() + jstOffset);
    
    // 日付境界の計算（JST）
    const todayStart = new Date(jstNow); todayStart.setUTCHours(0, 0, 0, 0); 
    const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - 6);
    const monthStart = new Date(todayStart); monthStart.setDate(monthStart.getDate() - 29);

    // クエリ用UTC変換
    const queryStartUtc = new Date(monthStart.getTime() - jstOffset);

    // コレクションが存在しなくてもエラーにならないよう空配列で対処
    let logSnap = { empty: true, forEach: () => {} };
    try {
      logSnap = await db.collection("users").doc(userId).collection("nutrition_logs")
        .where("createdAt", ">=", queryStartUtc)
        .get();
    } catch (e) {
      console.log("No nutrition_logs collection yet.");
    }

    if (!logSnap.empty) {
      logSnap.forEach(doc => {
        const d = doc.data();
        const logDateUtc = d.createdAt.toDate();
        const logDateJst = new Date(logDateUtc.getTime() + jstOffset);

        const vals = {
          k: Number(d.kcal) || 0,
          p: Number(d.p) || 0,
          f: Number(d.f) || 0,
          c: Number(d.c) || 0
        };

        // 30日集計
        addValues(summary.month, vals);

        // 7日集計
        if (logDateJst >= new Date(weekStart.getTime() - jstOffset)) {
          addValues(summary.week, vals);
        }

        // 本日集計
        if (logDateJst >= new Date(todayStart.getTime() - jstOffset)) {
          addValues(summary.today, vals);
        }
      });
    }

  } catch (e) { console.error("DB Error:", e); }

  function addValues(target, vals) {
    target.k += vals.k; target.p += vals.p; target.f += vals.f; target.c += vals.c;
  }
  const getAvg = (sum, days) => Math.round(sum / days);

  // AIへの指示書（System Promptへの注入）
  const dynamicSystemMessage = `
${SYSTEM_PROMPT}

【システム算出データ（DB記録済み）】
AIはこの数値を「正」として回答してください。
※「0」の場合は「本日の記録はまだありません」と伝えてください。

1. **本日** の合計 (Today)
   - カロリー: ${summary.today.k} kcal
   - PFC: P:${summary.today.p}g / F:${summary.today.f}g / C:${summary.today.c}g

2. **直近7日間** 合計 (Week)
   - 平均: ${getAvg(summary.week.k, 7)} kcal/日

3. **直近30日間** 合計 (Month)
   - 平均: ${getAvg(summary.month.k, 30)} kcal/日

【最新ユーザーデータ】
${JSON.stringify(profileData)}
`;

  // OpenAI 呼び出し
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: dynamicSystemMessage },
      ...pastMessages,
      { role: "user", content: userContent }
    ],
    temperature: 0.2
  });

  let aiResponse = completion.choices[0].message.content || "";

  // --- 保存処理 (食事ログ) ---
  const saveNutritionMatch = aiResponse.match(/\[SAVE_NUTRITION: (\{[\s\S]*?\})\]/);
  if (saveNutritionMatch) {
    try {
      const jsonStr = saveNutritionMatch[1];
      const nutritionData = JSON.parse(jsonStr);
      const safeData = {
        food: nutritionData.food || "不明な食事",
        kcal: Number(nutritionData.kcal) || 0,
        p: Number(nutritionData.p) || 0,
        f: Number(nutritionData.f) || 0,
        c: Number(nutritionData.c) || 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      await db.collection("users").doc(userId).collection("nutrition_logs").add(safeData);
    } catch (e) { console.error("Nutrition Save Error:", e); }
  }

  // --- 保存処理 (プロフィール) ---
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
