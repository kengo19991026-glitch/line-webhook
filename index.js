import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// --- 0. パス設定 (ESモジュールでのファイル読み込み用) ---
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

// --- 3. システムプロンプト ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。
画像解析と栄養算出を行い、論理的かつ断定的にアドバイスします。
回答の末尾には必ず [SAVE_NUTRITION: {...}] タグを付与してください。`;

const eventCache = new Set();

app.get("/", (req, res) => res.status(200).send("OK"));

// --- 4. Webhook 受信設定 ---
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
      console.error("Webhook Error:", err);
    }
  });
});

// --- 5. リッチメニュー自動設定ロジック (クリーンアップ機能付き) ---
const setupRichMenu = async () => {
  try {
    const imagePath = path.join(__dirname, "richmenu.jpg");
    if (!fs.existsSync(imagePath)) {
      console.log("⚠️ richmenu.jpg が見つからないため、リッチメニュー設定をスキップします。");
      return;
    }

    // 重複を避けるため、既存の modeAI メニューを削除
    const currentMenus = await client.getRichMenuList();
    for (const menu of currentMenus.richmenus) {
      if (menu.name === "modeAI Menu") {
        await client.deleteRichMenu(menu.richMenuId);
        console.log(`Deleted old menu: ${menu.richMenuId}`);
      }
    }

    const richMenuObject = {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: "modeAI Menu",
      chatBarText: "メニューを開く",
      areas: [
        { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: "camera", label: "食事記録" } },
        { bounds: { x: 833, y: 0, width: 834, height: 843 }, action: { type: "message", label: "手入力", text: "食事を手入力します" } },
        { bounds: { x: 1667, y: 0, width: 833, height: 843 }, action: { type: "message", label: "合計", text: "今日の合計カロリーを教えて" } },
        { bounds: { x: 0, y: 843, width: 833, height: 843 }, action: { type: "message", label: "分析", text: "データ分析機能は準備中です" } },
        { bounds: { x: 833, y: 843, width: 834, height: 843 }, action: { type: "message", label: "設定", text: "目標設定を変更したい" } },
        { bounds: { x: 1667, y: 843, width: 833, height: 843 }, action: { type: "message", label: "ヘルプ", text: "使い方を教えて" } }
      ]
    };

    const richMenuId = await client.createRichMenu(richMenuObject);
    const buffer = fs.readFileSync(imagePath);
    const blob = new Blob([buffer], { type: "image/jpeg" });
    
    await blobClient.setRichMenuImage(richMenuId.richMenuId, blob);
    await client.setDefaultRichMenu(richMenuId.richMenuId);
    console.log("✅ Rich Menu SUCCESS!");
  } catch (e) {
    console.error("❌ Rich Menu Failed:", e.message);
  }
};

// --- 6. 返答ロジック ---
async function handleModeAI(event) {
  const userId = event.source.userId;
  if (event.type !== "message") return;

  let userContent;
  if (event.message.type === "text") {
    userContent = [{ type: "text", text: event.message.text }];
  } else if (event.message.type === "image") {
    const blob = await blobClient.getMessageContent(event.message.id);
    const chunks = [];
    for await (const chunk of blob) { chunks.push(chunk); }
    const buffer = Buffer.concat(chunks);
    userContent = [
      { type: "text", text: "この写真を分析してください。" },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${buffer.toString("base64")}` } }
    ];
  } else return;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userContent }],
  });

  const aiResponse = completion.choices[0].message.content;
  await client.pushMessage({ to: userId, messages: [{ type: "text", text: aiResponse.replace(/\[SAVE_.*?\]/g, "").trim() }] });
}

// --- 7. サーバー起動 ---
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Server running on port ${PORT}`);
  await setupRichMenu();
});
