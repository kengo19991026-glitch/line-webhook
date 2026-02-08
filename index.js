import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// --- パス設定 ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 8080);

// --- Firestore 初期化 ---
if (!admin.apps.length) {
  admin.initializeApp({ projectId: "project-d3eb52a5-cef2-40c7-bfc" });
}
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

// --- クライアント初期化 ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });
const blobClient = new line.messagingApi.MessagingApiBlobClient({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });

const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。画像解析と栄養算出を行います。`;

const eventCache = new Set();

app.get("/", (req, res) => res.status(200).send("OK"));

// WEBHOOK（ここが止まると返答が来ません）
app.post("/webhook", line.middleware({ 
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN, 
  channelSecret: process.env.LINE_CHANNEL_SECRET 
}), (req, res) => {
  res.status(200).send("OK");
  const events = req.body.events || [];
  events.forEach(async (event) => {
    if (eventCache.has(event.eventId)) return;
    eventCache.add(event.eventId);
    try {
      await handleModeAI(event);
    } catch (err) {
      console.error("Webhook Error:", err);
    }
  });
});

// リッチメニュー作成関数（失敗してもボットを止めないように try-catch で囲む）
const setupRichMenu = async () => {
  try {
    console.log("Checking Rich Menu setup...");
    const imagePath = path.join(__dirname, "richmenu.jpg");

    // 画像がない場合はここで終了（ボットは止めない）
    if (!fs.existsSync(imagePath)) {
      console.log("⚠️ richmenu.jpg が見つかりません。リッチメニュー設定をスキップします。");
      return;
    }

    const richMenuObject = {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: "modeAI Menu",
      chatBarText: "メニュー",
      areas: [
        { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: "camera", label: "食事記録" } },
        { bounds: { x: 833, y: 0, width: 834, height: 843 }, action: { type: "message", label: "手入力", text: "食事を手入力します" } },
        { bounds: { x: 1667, y: 0, width: 833, height: 843 }, action: { type: "message", label: "合計", text: "今日の合計カロリーを教えて" } },
        { bounds: { x: 0, y: 843, width: 833, height: 843 }, action: { type: "message", label: "分析", text: "データ分析は準備中です" } },
        { bounds: { x: 833, y: 843, width: 834, height: 843 }, action: { type: "message", label: "設定", text: "目標設定を変更したい" } },
        { bounds: { x: 1667, y: 843, width: 833, height: 843 }, action: { type: "message", label: "ヘルプ", text: "使い方を教えて" } }
      ]
    };

    const richMenuId = await client.createRichMenu(richMenuObject);
    const buffer = fs.readFileSync(imagePath);
    // Cloud Run環境に合わせたBlob変換
    const blob = new Blob([buffer], { type: "image/jpeg" });
    
    await blobClient.setRichMenuImage(richMenuId.richMenuId, blob);
    await client.setDefaultRichMenu(richMenuId.richMenuId);
    console.log("✅ Rich Menu Success!");
  } catch (e) {
    console.error("❌ Rich Menu Setup Failed (but bot will run):", e.message);
  }
};

// 実際の返答ロジック（中身は以前と同じ）
async function handleModeAI(event) {
    const userId = event.source.userId;
    if (event.type !== "message") return;
    
    let text = event.message.type === "text" ? event.message.text : "写真を解析します";
    await client.pushMessage({
        to: userId,
        messages: [{ type: "text", text: `modeAIです。${text}を受信しました。` }]
    });
}

// サーバー起動
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Server running on port ${PORT}`);
  // ここでリッチメニューを呼び出す。失敗してもサーバーは落ちない
  setupRichMenu();
});
