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

// --- 3. modeAI 専用プロンプト（長期集計対応版） ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。
「数字は嘘をつかない」を信条とする、超ロジカルかつユーザーに寄り添うパーソナルトレーナー兼栄養士です。

【重要：LINE表示用のフォーマットルール】
1. 見出しには「■」や「【 】」を使用してください。
2. 箇条書きには「・」を使用してください。
3. **Markdown記法（#や*）は禁止**です。絶対に使わないでください。

【最重要タスク：食事データの保存】
ユーザーが「食事の写真」や「食べたものの報告」を送ってきた場合、アドバイスの最後に**必ず**以下の形式で隠しタグを出力してください。
出力タグ形式：
[SAVE_NUTRITION: {"food": "料理名", "kcal": 数値, "p": 数値, "f": 数値, "c": 数値}]
※数値は単位なしの数字のみ（例: "kcal": 550）。

【データに基づくアドバイス】
プロンプトの最後に、システムが計算した**「本日」「直近7日間」「直近30日間」**の摂取データが渡されます。
ユーザーから「今週の調子は？」「最近どう？」と聞かれたら、これらの数値（特に平均値）を引用して、傾向と対策をアドバイスしてください。

回答例：
「直近1週間の平均摂取カロリーは約2,100kcalで、目標を少し上回っています。特に脂質(F)が高めなので、来週は揚げ物を控えましょう。」

【回答構成】
■現状の数値分析
・推定消費(TDEE)：約〇〇kcal
・本日の摂取合計：約〇〇kcal
・（質問があれば）週間の平均摂取：約〇〇kcal
・目標PFC達成度：(P/F/Cのバランスについて言及)

■分析結果（食事報告時のみ）
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
    
    userContent = [
      { type: "text", text: "この写真を栄養士として分析してください。Markdown記法は禁止です。必ず末尾に [SAVE_NUTRITION] タグを出力してください。" },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
    ];
  } else {
    return;
  }

  // --- データ取得 & 長期集計ロジック ---
  let profileData = {};
  let pastMessages = [];
  
  // 集計用オブジェクト
  let summary = {
    today: { k: 0, p: 0, f: 0, c: 0, days: 1 }, // daysは割り算用（今日は1日）
    week:  { k: 0, p: 0, f: 0, c: 0, days: 7 },
    month: { k: 0, p: 0, f: 0, c: 0, days: 30 }
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

    // 3. 【重要】過去30日分のログを一括取得して振り分け集計
    const now = new Date();
    // 日本時間(JST)計算
    const jstOffset = 9 * 60 * 60 * 1000;
    const jstNow = new Date(now.getTime() + jstOffset);
    
    // それぞれの開始日時の計算（JST基準）
    const todayStart = new Date(jstNow); 
    todayStart.setUTCHours(0, 0, 0, 0); // 今日の0時

    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 6); // 過去7日間（今日含む）

    const monthStart = new Date(todayStart);
    monthStart.setDate(monthStart.getDate() - 29); // 過去30日間（今日含む）

    // UTCに戻してクエリ作成（一番古い30日前から取得）
    const queryStartUtc = new Date(monthStart.getTime() - jstOffset);

    const logSnap = await db.collection("users").doc(userId).collection("nutrition_logs")
      .where("createdAt", ">=", queryStartUtc)
      .get();

    logSnap.forEach(doc => {
      const d = doc.data();
      const logDateUtc = d.createdAt.toDate();
      const logDateJst = new Date(logDateUtc.getTime() + jstOffset); // ログの日時をJSTに変換

      const vals = {
        k: Number(d.kcal) || 0,
        p: Number(d.p) || 0,
        f: Number(d.f) || 0,
        c: Number(d.c) || 0
      };

      // 30日集計（クエリで絞ってるので全件対象）
      addValues(summary.month, vals);

      // 7日集計
      if (logDateJst >= new Date(weekStart.getTime() - jstOffset)) { // JST同士で比較
        addValues(summary.week, vals);
      }

      // 本日集計
      if (logDateJst >= new Date(todayStart.getTime() - jstOffset)) {
        addValues(summary.today, vals);
      }
    });

  } catch (e) { console.error("DB Error:", e); }

  // 集計関数
  function addValues(target, vals) {
    target.k += vals.k;
    target.p += vals.p;
    target.f += vals.f;
    target.c += vals.c;
  }

  // 平均値の算出（表示用）
  const getAvg = (sum, days) => Math.round(sum / days);

  // AIへの指示書生成
  const dynamicSystemMessage = `
${SYSTEM_PROMPT}

【システム算出データ（ユーザーの食事履歴）】
AIはこのデータを参照して、ユーザーの質問（「今週どう？」「今日どれくらい食べた？」）に答えてください。

1. **本日** の摂取合計
   - カロリー: ${summary.today.k} kcal
   - P: ${summary.today.p}g / F: ${summary.today.f}g / C: ${summary.today.c}g

2. **直近7日間** の合計と平均（1日あたり）
   - 7日間の合計: ${summary.week.k} kcal
   - **平均**: ${getAvg(summary.week.k, 7)} kcal/日
   - PFC平均: P:${getAvg(summary.week.p, 7)}g / F:${getAvg(summary.week.f, 7)}g / C:${getAvg(summary.week.c, 7)}g

3. **直近30日間** の合計と平均（1日あたり）
   - 30日間の合計: ${summary.month.k} kcal
   - **平均**: ${getAvg(summary.month.k, 30)} kcal/日

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
