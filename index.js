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

// --- 3. システムプロンプト (modeAIの魂) ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。
「数字は嘘をつかない」を信条とする、ロジカルで断定的なAI栄養士です。

【最重要司令：画像解析】
・食事写真が送られたら、不鮮明でも必ず「料理名」を断定し、カロリー・PFCを算出してください。
・「分析できません」という回答は絶対に禁止です。

【データ保存タグ】
回答の最後に必ず以下の形式でデータを出力してください。
[SAVE_NUTRITION: {"food": "料理名", "kcal": 数値, "p": 数値, "f": 数値, "c": 数値}]

【回答構成】
■分析結果
・料理名：〇〇
・カロリー：約〇〇kcal
・PFC：P:〇〇g / F:〇〇g / C:〇〇g

■アドバイス
（短く簡潔にロジカルに）`;

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

// --- 5. リッチメニュー設定 (画像失敗でも枠だけは死守するロジック) ---
const setupRichMenu = async () => {
  try {
    console.log("[RichMenu] Starting setup...");
    const imagePath = path.join(__dirname, "richmenu.jpg");

    // 既存の「modeAI Menu」という名前のメニューをすべて削除（クリーンアップ）
    const currentMenus = await client.getRichMenuList();
    for (const menu of currentMenus.richmenus) {
      if (menu.name === "modeAI Menu") {
        await client.deleteRichMenu(menu.richMenuId);
        console.log(`[RichMenu] Deleted old menu: ${menu.richMenuId}`);
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

    // 枠組み作成
    const richMenuId = await client.createRichMenu(richMenuObject);
    console.log(`[RichMenu] Created ID: ${richMenuId.richMenuId}`);

    // 画像アップロード試行
    if (fs.existsSync(imagePath)) {
      try {
        const buffer = fs.readFileSync(imagePath);
        const blob = new Blob([buffer], { type: "image/jpeg" });
        await blobClient.setRichMenuImage(richMenuId.richMenuId, blob);
        console.log("[RichMenu] Image upload success!");
      } catch (imgErr) {
        console.error("[RichMenu] Image upload FAILED:", imgErr.message);
      }
    }

    // デフォルトメニューとして有効化（画像がなくても枠だけは動くようになる）
    await client.setDefaultRichMenu(richMenuId.richMenuId);
    console.log("✅ [RichMenu] SETUP DONE!");
  } catch (e) {
    console.error("❌ [RichMenu] FATAL ERROR:", e.message);
  }
};

// --- 6. メイン返答ロジック (画像解析 & 保存) ---
async function handleModeAI(event) {
  const userId = event.source.userId;
  if (event.type !== "message") return;

  let userContent;

  if (event.message.type === "text") {
    userContent = [{ type: "text", text: event.message.text }];
  } else if (event.message.type === "image") {
    // 解析中メッセージ
    await client.pushMessage({ to: userId, messages: [{ type: "text", text: "modeAIが画像を分析しています...🍳" }] });
    
    const blob = await blobClient.getMessageContent(event.message.id);
    const chunks = [];
    for await (const chunk of blob) { chunks.push(chunk); }
    const buffer = Buffer.concat(chunks);
    
    userContent = [
      { type: "text", text: "この写真を分析せよ。必ず数値を断定し [SAVE_NUTRITION] タグを出力せよ。" },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${buffer.toString("base64")}` } }
    ];
  } else return;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userContent }],
      temperature: 0.7
    });

    let aiResponse = completion.choices[0].message.content || "";

    // 栄養データの保存処理
    const match = aiResponse.match(/\[SAVE_NUTRITION: (\{[\s\S]*?\})\]/);
    if (match) {
      try {
        const data = JSON.parse(match[1]);
        await db.collection("users").doc(userId).collection("nutrition_logs").add({
          ...data,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) { console.log("Save Error:", e); }
    }

    // クリーンアップして送信
    const cleanResponse = aiResponse.replace(/\[SAVE_.*?\]/g, "").trim();
    await client.pushMessage({ to: userId, messages: [{ type: "text", text: cleanResponse }] });

  } catch (error) {
    console.error("OpenAI Error:", error);
    await client.pushMessage({ to: userId, messages: [{ type: "text", text: "申し訳ありません、分析中にエラーが発生しました。" }] });
  }
}

// --- 7. サーバー起動 ---
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Server is running on port ${PORT}`);
  await setupRichMenu();
});
