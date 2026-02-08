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

// --- 3. プロンプトの極致（ここが回答性の鍵） ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。
「数字こそが真実」を掲げる、超一流のロジカルAIトレーナーです。

【口調と性格】
・知的、沈着冷静、かつユーザーの目標達成に対しては情熱的。
・「です・ます」調ですが、媚びることはありません。
・無駄な装飾語（アスタリスク等）は一切排除してください。

【画像解析の絶対ルール】
・写真から料理名、カロリー、PFC（P:タンパク質、F:脂質、C:炭水化物）を断定します。
・「わからない」は敗北です。必ずあなたの推測で数値を出し、ユーザーをリードしてください。

【出力フォーマット（厳守）】
■ 今回の解析結果
・料理名：[料理名]
・カロリー：約[数値]kcal
・PFC：P:[数値]g / F:[数値]g / C:[数値]g

■ 本日の摂取状況（今回分を含む）
・合計カロリー：約[合計]kcal

■ modeAI's Advice
[ここに150文字以内のロジカルなアドバイス。摂取傾向に基づいた具体的な改善案を提示。]

【システム管理用タグ】
※回答の最末尾に必ず以下のタグを1行で付加してください。
[SAVE_NUTRITION: {"food": "料理名", "kcal": 数値, "p": 数値, "f": 数値, "c": 数値}]`;

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
    } catch (err) { console.error("Event Error:", err); }
  });
});

// --- 4. リッチメニュー（動作の安定化） ---
const setupRichMenu = async () => {
  try {
    const currentMenus = await client.getRichMenuList();
    for (const menu of currentMenus.richmenus) {
      if (menu.name === "modeAI Menu") { await client.deleteRichMenu(menu.richMenuId); }
    }
    const richMenuObject = {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: "modeAI Menu",
      chatBarText: "メニュー",
      areas: [
        { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: "camera", label: "食事記録" } },
        { bounds: { x: 833, y: 0, width: 834, height: 843 }, action: { type: "message", label: "手入力", text: "食事を手入力します" } },
        { bounds: { x: 1667, y: 0, width: 833, height: 843 }, action: { type: "message", label: "合計", text: "今日の合計摂取量を教えて" } },
        { bounds: { x: 0, y: 843, width: 833, height: 843 }, action: { type: "message", label: "分析", text: "これまでの摂取傾向を詳しく分析して" } },
        { bounds: { x: 833, y: 843, width: 834, height: 843 }, action: { type: "message", label: "設定", text: "目標設定の変更をお願いします" } },
        { bounds: { x: 1667, y: 843, width: 833, height: 843 }, action: { type: "message", label: "ヘルプ", text: "modeAIの使い方を教えて" } }
      ]
    };
    const richMenuId = await client.createRichMenu(richMenuObject);
    const imagePath = path.join(__dirname, "richmenu.jpg");
    if (fs.existsSync(imagePath)) {
      const buffer = fs.readFileSync(imagePath);
      await blobClient.setRichMenuImage(richMenuId.richMenuId, new Blob([buffer], { type: "image/jpeg" }));
    }
    await client.setDefaultRichMenu(richMenuId.richMenuId);
  } catch (e) { console.error("Menu Setup Error:", e); }
};

// --- 5. メインロジック（高品質化） ---
async function handleModeAI(event) {
  const userId = event.source.userId;
  if (event.type !== "message") return;

  let userContent;
  if (event.message.type === "text") {
    userContent = [{ type: "text", text: event.message.text }];
  } else if (event.message.type === "image") {
    await client.pushMessage({ to: userId, messages: [{ type: "text", text: "画像を分析中... データを照合しています。" }] });
    const blob = await blobClient.getMessageContent(event.message.id);
    const chunks = [];
    for await (const chunk of blob) { chunks.push(chunk); }
    const buffer = Buffer.concat(chunks);
    userContent = [
      { type: "text", text: "この写真を分析し、カロリーとPFCを断定してください。[SAVE_NUTRITION]タグの付与を忘れないでください。" },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${buffer.toString("base64")}` } }
    ];
  } else return;

  try {
    // 今日の合計値を計算
    const now = new Date();
    const jstNow = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    const startOfToday = new Date(jstNow.setUTCHours(0, 0, 0, 0));
    const queryStart = new Date(startOfToday.getTime() - (9 * 60 * 60 * 1000));

    const snap = await db.collection("users").doc(userId).collection("nutrition_logs").where("createdAt", ">=", queryStart).get();
    let totalKcal = 0;
    snap.forEach(doc => { totalKcal += (Number(doc.data().kcal) || 0); });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: `${SYSTEM_PROMPT}\n\n【重要：現在の統計】本日のこれまでの摂取カロリー: ${totalKcal}kcal` },
        { role: "user", content: userContent }
      ],
      temperature: 0.3 // 回答のブレを抑え、安定性を向上
    });

    let aiResponse = completion.choices[0].message.content || "";

    // データの保存
    const match = aiResponse.match(/\[SAVE_NUTRITION: (\{[\s\S]*?\})\]/);
    if (match) {
      try {
        const data = JSON.parse(match[1]);
        await db.collection("users").doc(userId).collection("nutrition_logs").add({
          ...data,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) { console.error("JSON Parse Error:", e); }
    }

    // 表示の徹底洗浄
    let finalOutput = aiResponse
      .replace(/\[SAVE_.*?\]/g, "") // タグ除去
      .replace(/\*/g, "")           // アスタリスク除去
      .replace(/#/g, "")            // ハッシュタグ除去
      .trim();

    await client.pushMessage({ to: userId, messages: [{ type: "text", text: finalOutput }] });

  } catch (error) { console.error("Main Logic Error:", error); }
}

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Server started on port ${PORT}`);
  await setupRichMenu();
});
