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

// --- 3. modeAI 専用プロンプト（画像解析優先ロジック） ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。
あなたは「高度な画像認識能力を持つ」プロのAI栄養士です。

【最優先ルール：画像の扱い】
ユーザーから写真が送られた場合、**システムデータ（過去の記録）に頼らず、必ずあなたの「目（画像認識）」を使って料理内容とカロリー・PFCを推定してください。**
「分析できません」「一般的な例」といった逃げ口上は禁止です。多少の誤差があっても、自信を持って具体的な数値を断言してください。

【タスク1：食事データの保存（必須）】
食事の画像や報告があった場合、回答の最後に**必ず**以下のタグを出力してください。
[SAVE_NUTRITION: {"food": "料理名", "kcal": 数値, "p": 数値, "f": 数値, "c": 数値}]
※数値は単位なしの数字（例: 550）。

【タスク2：集計データの活用】
プロンプトの最後に**「システム算出データ（過去の履歴）」**が渡されます。
・「今日の合計は？」と聞かれたら：システム算出データ + **今まさに分析した食事の数値** を合計して答えてください。
・「今週の平均は？」と聞かれたら：システム算出データをそのまま答えてください。

【禁止事項（Markdown）】
LINEで見やすくするため、Markdown記法（#や*）は禁止です。
・見出しは「■」または「【 】」
・箇条書きは「・」
を使用してください。

【回答構成】
■今回の分析結果（写真がある場合）
・料理名：〇〇
・推定カロリー：〇〇kcal
・PFC：P:〇〇g / F:〇〇g / C:〇〇g

■本日の摂取状況（今回の食事を含む）
・本日の合計：約〇〇kcal（システム記録＋今回分）
・目標まで：あと約〇〇kcal

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
    
    // 画像送信時の指示を強化：「あなたは画像が見えている」と認識させる
    userContent = [
      { type: "text", text: "【重要指令】この写真を栄養士の目で見て、具体的に分析してください。「分析できない」という回答は許可しません。見たままの食材から数値を推定し、必ず末尾に [SAVE_NUTRITION] タグを出力してください。Markdown禁止。" },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
    ];
  } else {
    return;
  }

  // --- データ取得 & 集計ロジック ---
  let profileData = {};
  let pastMessages = [];
  
  // 集計用オブジェクト
  let summary = {
    today: { k: 0, p: 0, f: 0, c: 0 },
    week:  { k: 0, p: 0, f: 0, c: 0 },
    month: { k: 0, p: 0, f: 0, c: 0 }
  };

  try {
    const profileDoc = await db.collection("users").doc(userId).get();
    profileData = profileDoc.exists ? profileDoc.data() : { weight: null };

    const snap = await db.collection("users").doc(userId).collection("history").orderBy("createdAt", "desc").limit(4).get();
    if (!snap.empty) {
      pastMessages = snap.docs.reverse().map(doc => ({ role: doc.data().role, content: doc.data().content }));
    }

    // 過去30日分のログ集計
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
        .where("createdAt", ">=", queryStartUtc)
        .get();
    } catch (e) {}

    if (!logSnap.empty) {
      logSnap.forEach(doc => {
        const d = doc.data();
        const logDateUtc = d.createdAt.toDate();
        const logDateJst = new Date(logDateUtc.getTime() + jstOffset);

        const vals = {
          k: Number(d.kcal) || 0, p: Number(d.p) || 0, f: Number(d.f) || 0, c: Number(d.c) || 0
        };
        addValues(summary.month, vals);
        if (logDateJst >= new Date(weekStart.getTime() - jstOffset)) addValues(summary.week, vals);
        if (logDateJst >= new Date(todayStart.getTime() - jstOffset)) addValues(summary.today, vals);
      });
    }

  } catch (e) { console.error("DB Error:", e); }

  function addValues(target, vals) {
    target.k += vals.k; target.p += vals.p; target.f += vals.f; target.c += vals.c;
  }
  const getAvg = (sum, days) => Math.round(sum / days);

  // システムメッセージ作成（画像の扱いを優先するよう指示）
  const dynamicSystemMessage = `
${SYSTEM_PROMPT}

【システム算出データ（過去〜直前までの記録）】
※注意：以下は「過去のデータ」です。**今送られてきた画像の数値は含まれていません。**
今送られてきた写真がある場合は、以下の数値に、あなたが解析した数値を**足して**回答してください。

1. **本日** の合計 (記録済み分のみ)
   - カロリー: ${summary.today.k} kcal
   - P: ${summary.today.p}g / F: ${summary.today.f}g / C: ${summary.today.c}g

2. **直近7日間** (記録済み分のみ)
   - 平均: ${getAvg(summary.week.k, 7)} kcal/日

【最新ユーザーデータ】
${JSON.stringify(profileData)}
`;

  // OpenAI 呼び出し (max_tokensを追加し、回答切れを防ぐ)
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: dynamicSystemMessage },
      ...pastMessages,
      { role: "user", content: userContent }
    ],
    temperature: 0.3, // 少し自由度を戻して画像解析の柔軟性を上げる
    max_tokens: 1000
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
