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

// --- 3. システムプロンプト ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。
「数字は嘘をつかない」を信条とする、ロジカルで断定的なAI栄養士です。

【最重要司令】
・画像が送られたら、必ず料理名を断定し、カロリー・PFCを算出してください。
・回答の最後に必ず [SAVE_NUTRITION: {"food": "料理名", "kcal": 数値, "p": 数値, "f": 数値, "c": 数値}] を出力してください。
・Markdown（**や#）はLINEで見づらいため、一切使用禁止です。

【回答構成】
■分析結果
・料理名：〇〇
・カロリー：約〇〇kcal
・PFC：P:〇〇g / F:〇〇g / C:〇〇g

■本日の合計（今回分を含む）
・合計：約〇〇kcal

■アドバイス
（短く簡潔に）`;

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
      console.error("Webhook Error:", err);
    }
  });
});

// --- 4. リッチメニュー設定 (ボタン動作の最適化) ---
const setupRichMenu = async () => {
  try {
    const currentMenus = await client.getRichMenuList();
    for (const menu of currentMenus.richmenus) {
      if (menu.name === "modeAI Menu") {
        await client.deleteRichMenu(menu.richMenuId);
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
        { bounds: { x: 0, y: 843, width: 833, height: 843 }, action: { type: "message", label: "分析", text: "今の摂取傾向を分析して" } },
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
    }
    await client.setDefaultRichMenu(richMenuId.richMenuId);
    console.log("✅ Rich Menu Setup Done");
  } catch (e) { console.error("Rich Menu Error:", e.message); }
};

// --- 5. メインロジック (集計・クリーンアップ) ---
async function handleModeAI(event) {
  const userId = event.source.userId;
  if (event.type !== "message") return;

  let userContent;
  if (event.message.type === "text") {
    userContent = [{ type: "text", text: event.message.text }];
  } else if (event.message.type === "image") {
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
    // 今日の合計を取得
    const now = new Date();
    const jstOffset = 9 * 60 * 60 * 1000;
    const todayStartJst = new Date(now.getTime() + jstOffset);
    todayStartJst.setUTCHours(0, 0, 0, 0);
    const queryStartUtc = new Date(todayStartJst.getTime() - jstOffset);

    const logSnap = await db.collection("users").doc(userId).collection("nutrition_logs")
      .where("createdAt", ">=", queryStartUtc).get();

    let todayTotalKcal = 0;
    logSnap.forEach(doc => { todayTotalKcal += (Number(doc.data().kcal) || 0); });

    const dynamicSystemPrompt = `${SYSTEM_PROMPT}\n\n【システムデータ】本日の既摂取カロリー: ${todayTotalKcal}kcal`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "system", content: dynamicSystemPrompt }, { role: "user", content: userContent }],
      temperature: 0.7
    });

    let aiResponse = completion.choices[0].message.content || "";

    // 保存処理
    const match = aiResponse.match(/\[SAVE_NUTRITION: (\{[\s\S]*?\})\]/);
    if (match) {
      try {
        const data = JSON.parse(match[1]);
        await db.collection("users").doc(userId).collection("nutrition_logs").add({
          ...data,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) {}
    }

    // 表示のクリーンアップ（アスタリスク除去、タグ除去）
    let cleanResponse = aiResponse.replace(/\[SAVE_.*?\]/g, "").replace(/\*/g, "").trim();
    
    await client.pushMessage({ to: userId, messages: [{ type: "text", text: cleanResponse }] });

  } catch (error) {
    console.error("Error:", error);
  }
}

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Server running on port ${PORT}`);
  await setupRichMenu();
});
