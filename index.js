import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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

// --- 3. システムプロンプト（画像解析・集計指示） ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。
世界最高峰の画像認識能力を持つAI栄養士として、断定的な数値で食事指導を行います。

【最優先ルール】
・画像が送られたら、必ず推測でカロリーとPFCを断定してください。
・「分析できません」は禁止です。
・回答の最後に必ず [SAVE_NUTRITION: {"food": "料理名", "kcal": 数値, "p": 数値, "f": 数値, "c": 数値}] を出力してください。

【集計ルール】
・「今日の合計は？」等の質問には、システムから渡される本日分データと、今解析した分を合算して回答してください。`;

const eventCache = new Set();

app.get("/", (req, res) => res.status(200).send("OK"));

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
      console.error("Webhook Event Error:", err);
    }
  });
});

// --- 4. リッチメニュー設定ロジック（ログ強化版） ---
const setupRichMenu = async () => {
  try {
    const imagePath = path.join(__dirname, "richmenu.jpg");
    console.log(`[RichMenu] Looking for image at: ${imagePath}`);

    if (!fs.existsSync(imagePath)) {
      console.error("[RichMenu] Error: richmenu.jpg NOT FOUND in directory.");
      return;
    }
    console.log("[RichMenu] Image file confirmed.");

    const richMenuObject = {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: "modeAI Menu",
      chatBarText: "メニューを開く",
      areas: [
        { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: "camera", label: "食事記録" } },
        { bounds: { x: 833, y: 0, width: 834, height: 843 }, action: { type: "message", label: "手入力", text: "食事を手入力します" } },
        { bounds: { x: 1667, y: 0, width: 833, height: 843 }, action: { type: "message", label: "合計", text: "今日の合計カロリーを教えて" } },
        { bounds: { x: 0, y: 843, width: 833, height: 843 }, action: { type: "message", label: "分析", text: "データ分析は準備中です" } },
        { bounds: { x: 833, y: 843, width: 834, height: 843 }, action: { type: "message", label: "設定", text: "目標設定を変更したい" } },
        { bounds: { x: 1667, y: 843, width: 833, height: 843 }, action: { type: "message", label: "ヘルプ", text: "使い方を教えて" } }
      ]
    };

    console.log("[RichMenu] Creating menu structure...");
    const richMenuId = await client.createRichMenu(richMenuObject);
    console.log(`[RichMenu] Created ID: ${richMenuId.richMenuId}`);

    const buffer = fs.readFileSync(imagePath);
    const blob = new Blob([buffer], { type: "image/jpeg" });
    
    console.log("[RichMenu] Uploading image...");
    await blobClient.setRichMenuImage(richMenuId.richMenuId, blob);
    
    console.log("[RichMenu] Setting as default...");
    await client.setDefaultRichMenu(richMenuId.richMenuId);
    console.log("✅ [RichMenu] SETUP COMPLETED SUCCESSFULLY!");

  } catch (e) {
    console.error("❌ [RichMenu] FAILED:", e.message);
    if (e.response) console.error("[RichMenu] API Response:", e.response.data);
  }
};

// --- 5. メインロジック（画像解析・履歴・集計） ---
async function handleModeAI(event) {
  const userId = event.source.userId;
  if (event.type !== "message") return;

  let userContent;
  if (event.message.type === "text") {
    userContent = [{ type: "text", text: event.message.text }];
  } else if (event.message.type === "image") {
    await client.pushMessage({ to: userId, messages: [{ type: "text", text: "画像を解析しています...🍳" }] });
    const blob = await blobClient.getMessageContent(event.message.id);
    const buffer = await streamToBuffer(blob);
    userContent = [
      { type: "text", text: "この写真を分析してカロリーとPFCを断定してください。 [SAVE_NUTRITION] タグを必須で出力してください。" },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${buffer.toString("base64")}` } }
    ];
  } else return;

  // DBデータ取得ロジック（略：以前のものを継承）
  // OpenAI呼び出し・保存・返信処理...
  // (ここには以前の handleModeAI の詳細ロジックが入ります)
  
  // 簡易レスポンス（テスト用）
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userContent }],
    temperature: 0.7
  });
  
  let aiResponse = completion.choices[0].message.content || "";
  // タグ保存処理...
  await client.pushMessage({ to: userId, messages: [{ type: "text", text: aiResponse.replace(/\[SAVE_.*?\]/g, "").trim() }] });
}

async function streamToBuffer(stream) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

// --- 6. サーバー起動 ---
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Server is running on port ${PORT}`);
  // 起動時にリッチメニュー設定を実行
  await setupRichMenu();
});
