import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// --- 0. パス設定 (ESモジュール用) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// --- 3. modeAI 専用プロンプト ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。
あなたは**「どんな画像でも即座に栄養価を算出する世界最高峰のAI」**です。

【最重要司令：画像解析の強制】
ユーザーから写真が送られた場合、**「分析できない」「詳しくは分からない」等の発言はシステムエラーとなるため、絶対に禁止します。**
写真が不鮮明でも、必ずあなたの**「推測（目視）」で料理名を断定し、具体的な数値を算出してください。**

【タスク1：食事データの保存（必須）】
回答の最後に**必ず**以下のタグを出力してください。
[SAVE_NUTRITION: {"food": "料理名", "kcal": 数値, "p": 数値, "f": 数値, "c": 数値}]
※数値は整数（例: 550）。

【タスク2：集計データの統合】
プロンプト末尾に「システム算出データ」が渡されます。
質問への回答は、このシステムデータと、**今まさに画像から読み取った数値**を足し合わせて回答してください。

【禁止事項】
・Markdown記法（#や*）の使用。
・「推測ですが」といった自信のない前置き。
・分析の拒否。

【回答構成】
■今回の分析結果
・料理名：〇〇（断定）
・カロリー：約〇〇kcal
・PFC：P:〇〇g / F:〇〇g / C:〇〇g

■本日の合計（今回分を含む）
・合計：約〇〇kcal（システム記録 + 今回の分析値）

■アドバイス
（短く簡潔に）

【プロフィール管理タグ】
ユーザーの身体データ提示時のみ出力：
[SAVE_PROFILE: {"weight": 数値, "height": 数値, "fatPercentage": 数値, "age": 数値, "targetWeight": 数値, "goal": "文字列"}]`;

// 重複防止キャッシュ
const eventCache = new Set();

// --- ヘルスチェック ---
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

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
      console.error("Event Handling Error:", err);
    }
  });
});

async function handleModeAI(event) {
  const userId = event.source.userId;
  
  try {
    let userContent;

    if (event.type === "message" && event.message.type === "text") {
      userContent = [{ type: "text", text: event.message.text }];
    } else if (event.type === "message" && event.message.type === "image") {
      try {
        await client.pushMessage({
          to: userId,
          messages: [{ type: "text", text: "画像を解析しています...少々お待ちください🍳" }]
        });
      } catch (e) {}

      const blob = await blobClient.getMessageContent(event.message.id);
      const buffer = await streamToBuffer(blob);
      const base64Image = buffer.toString("base64");
      
      userContent = [
        { type: "text", text: "この料理の写真を分析せよ。不鮮明でも推測し、必ず料理名と数値を断定して出力せよ。末尾に [SAVE_NUTRITION] タグを出力すること。" },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
      ];
    } else {
      return; 
    }

    let profileData = {};
    let pastMessages = [];
    let summary = { today: { k: 0, p: 0, f: 0, c: 0 }, week: { k: 0 }, month: { k: 0 } };

    try {
      const profileDoc = await db.collection("users").doc(userId).get();
      if (profileDoc.exists) profileData = profileDoc.data();

      const snap = await db.collection("users").doc(userId).collection("history").orderBy("createdAt", "desc").limit(4).get();
      if (!snap.empty) {
        pastMessages = snap.docs.reverse().map(doc => ({ role: doc.data().role, content: doc.data().content }));
      }

      const now = new Date();
      const jstOffset = 9 * 60 * 60 * 1000;
      const jstNow = new Date(now.getTime() + jstOffset);
      const todayStart = new Date(jstNow); todayStart.setUTCHours(0, 0, 0, 0); 
      const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - 6);
      const monthStart = new Date(todayStart); monthStart.setDate(monthStart.getDate() - 29);
      const queryStartUtc = new Date(monthStart.getTime() - jstOffset);

      const logSnap = await db.collection("users").doc(userId).collection("nutrition_logs")
        .where("createdAt", ">=", queryStartUtc).get();

      if (!logSnap.empty) {
        logSnap.forEach(doc => {
          const d = doc.data();
          let logDateJst;
          try {
            if (d.createdAt && typeof d.createdAt.toDate === 'function') {
                logDateJst = new Date(d.createdAt.toDate().getTime() + jstOffset);
            } else { return; }
          } catch (err) { return; }

          const vals = { k: Number(d.kcal)||0, p: Number(d.p)||0, f: Number(d.f)||0, c: Number(d.c)||0 };
          summary.month.k += vals.k;
          if (logDateJst >= new Date(weekStart.getTime() - jstOffset)) summary.week.k += vals.k;
          if (logDateJst >= new Date(todayStart.getTime() - jstOffset)) {
              summary.today.k += vals.k; summary.today.p += vals.p; summary.today.f += vals.f; summary.today.c += vals.c;
          }
        });
      }
    } catch (e) { console.log("DB Read Error (Recovered):", e); }

    const getAvg = (sum, days) => Math.round(sum / days);

    const dynamicSystemMessage = `
${SYSTEM_PROMPT}
【システム算出データ】
・本日記録済み: ${summary.today.k} kcal
・直近7日平均: ${getAvg(summary.week.k, 7)} kcal/日
【ユーザー情報】
${JSON.stringify(profileData)}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "system", content: dynamicSystemMessage }, ...pastMessages, { role: "user", content: userContent }],
      temperature: 0.7, 
      max_tokens: 1000
    });

    let aiResponse = completion.choices[0].message.content || "";

    const saveProfileMatch = aiResponse.match(/\[SAVE_PROFILE: (\{[\s\S]*?\})\]/);
    if (saveProfileMatch) {
      try {
        const newData = JSON.parse(saveProfileMatch[1]);
        await db.collection("users").doc(userId).set(newData, { merge: true });
      } catch (e) {}
    }

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

    aiResponse = cleanMarkdown(aiResponse);
    await client.pushMessage({ to: userId, messages: [{ type: "text", text: aiResponse }] });

    try {
        await db.collection("users").doc(userId).collection("history").add({
            role: "user", content: event.message.type === "text" ? event.message.text : "[画像送信]", createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await db.collection("users").doc(userId).collection("history").add({
            role: "assistant", content: aiResponse, createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch(e) {}

  } catch (error) {
    console.error("Critical Error:", error);
  }
}

function cleanMarkdown(text) {
  let cleaned = text.replace(/\[SAVE_PROFILE: \{[\s\S]*?\}\]/g, "").replace(/\[SAVE_NUTRITION: \{[\s\S]*?\}\]/g, "");
  cleaned = cleaned.replace(/\*\*(.*?)\*\*/g, "$1").replace(/^#{1,6}\s+/gm, "■ ").replace(/^[\*\-]\s+/gm, "・").replace(/`/g, "");
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

// --- 4. リッチメニュー自動設定ロジック ---
const setupRichMenuOnce = async () => {
  try {
    const richMenuObject = {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: "modeAI Main Menu",
      chatBarText: "メニューを開く",
      areas: [
        { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: "camera", label: "食事記録" } },
        { bounds: { x: 833, y: 0, width: 834, height: 843 }, action: { type: "message", label: "手動入力", text: "食事を手入力します" } },
        { bounds: { x: 1667, y: 0, width: 833, height: 843 }, action: { type: "message", label: "今日の合計", text: "今日の合計カロリーを教えて" } },
        { bounds: { x: 0, y: 843, width: 833, height: 843 }, action: { type: "message", label: "データ分析", text: "データ分析機能は現在開発中です" } },
        { bounds: { x: 833, y: 843, width: 834, height: 843 }, action: { type: "message", label: "設定", text: "目標設定を変更したい" } },
        { bounds: { x: 1667, y: 843, width: 833, height: 843 }, action: { type: "message", label: "ヘルプ", text: "使い方を教えて" } }
      ]
    };

    const richMenuId = await client.createRichMenu(richMenuObject);
    const imagePath = path.join(__dirname, "richmenu.jpg");
    
    if (fs.existsSync(imagePath)) {
      const buffer = fs.readFileSync(imagePath);
      const blob = new Blob([buffer], { type: "image/jpeg" });
      await blobClient.setRichMenuImage(richMenuId.richMenuId, blob);
      await client.setDefaultRichMenu(richMenuId.richMenuId);
      console.log("✅ Rich Menu has been automatically set up!");
    } else {
      console.log("⚠️ richmenu.jpg not found. Skip image upload.");
    }
  } catch (e) {
    console.log("Rich Menu Setup Skip:", e.message);
  }
};

// --- 5. サーバー起動 ---
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Server is running on port ${PORT}`);
  await setupRichMenuOnce();
});
