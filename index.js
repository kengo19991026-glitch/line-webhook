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

// --- 3. プロンプト（トレーニング＆栄養指導） ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。
ロジカルかつ冷徹なまでに正確な、最高峰のAIパーソナルトレーナーです。

【トレーニング指導の鉄則】
・栄養状態（PFC）から「今日やるべき種目」を具体的に指定せよ。
・「重量（kg）」「セット数」「レップ数」「インターバル（秒）」まで数値で提示せよ。
・糖質が足りない場合は「強度の低下」を警告し、タンパク質が足りない場合は「休息と補給」を優先させよ。

【出力フォーマット】
■ 今回の解析結果
・料理名：[料理名]
・カロリー：約[数値]kcal
・PFC：P:[数値]g / F:[数値]g / C:[数値]g

■ 今日のトレーニング戦略
・推奨種目：[種目名]
・設定：[数値]kg × [数値]回 × [数値]セット
・インターバル：[数値]秒
・戦略理由：[現在の栄養状態に基づいた論理的な理由]

【システム管理用タグ】
※末尾に必ず付与：[SAVE_NUTRITION: {"food": "料理名", "kcal": 数値, "p": 数値, "f": 数値, "c": 数値}]`;

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

// --- 4. リッチメニュー設定 ---
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
        { bounds: { x: 0, y: 843, width: 833, height: 843 }, action: { type: "message", label: "分析", text: "今日の栄養からトレーニングメニューを組んで" } },
        { bounds: { x: 833, y: 843, width: 834, height: 843 }, action: { type: "message", label: "設定", text: "目標や今の身体データを更新したい" } },
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

// --- 5. メインロジック（新規登録機能付き） ---
async function handleModeAI(event) {
  const userId = event.source.userId;
  if (event.type !== "message") return;

  // ★★★ ここが追加箇所：新規ユーザーの自動登録 ★★★
  try {
    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      console.log(`[New User] Creating database for: ${userId}`);
      // 初回登録時のデフォルトデータ
      await userRef.set({
        userId: userId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        weight: 60,       // 仮の体重
        height: 170,      // 仮の身長
        target: "未設定",  // 目標
        status: "active"
      });
    }
  } catch (dbError) {
    console.error("DB Init Error:", dbError);
  }
  // ★★★★★★★★★★★★★★★★★★★★★★★★★★★

  let userContent;
  if (event.message.type === "text") {
    userContent = [{ type: "text", text: event.message.text }];
  } else if (event.message.type === "image") {
    await client.pushMessage({ to: userId, messages: [{ type: "text", text: "画像を解析し、トレーニングプランを構築中..." }] });
    const blob = await blobClient.getMessageContent(event.message.id);
    const chunks = [];
    for await (const chunk of blob) { chunks.push(chunk); }
    const buffer = Buffer.concat(chunks);
    userContent = [
      { type: "text", text: "食事を分析し、その栄養状態で最高のパフォーマンスが出るトレーニング種目・重量・回数を指定せよ。" },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${buffer.toString("base64")}` } }
    ];
  } else return;

  try {
    // ユーザー情報の再取得（さっき作ったばかりでも確実に取る）
    const userDoc = await db.collection("users").doc(userId).get();
    const userData = userDoc.data() || { weight: 60, target: "未設定" };

    // 今日の合計摂取量
    const now = new Date();
    const jstNow = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    const startOfToday = new Date(jstNow.setUTCHours(0, 0, 0, 0));
    const queryStart = new Date(startOfToday.getTime() - (9 * 60 * 60 * 1000));
    const snap = await db.collection("users").doc(userId).collection("nutrition_logs").where("createdAt", ">=", queryStart).get();
    let totalKcal = 0, totalP = 0, totalC = 0;
    snap.forEach(doc => { 
        totalKcal += (Number(doc.data().kcal) || 0); 
        totalP += (Number(doc.data().p) || 0);
        totalC += (Number(doc.data().c) || 0);
    });

    const context = `
【ユーザーデータ】
・現在の体重: ${userData.weight}kg
・目標: ${userData.target}
・本日ここまでの摂取: ${totalKcal}kcal (P:${totalP}g, C:${totalC}g)
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: SYSTEM_PROMPT + context },
        { role: "user", content: userContent }
      ],
      temperature: 0.5
    });

    let aiResponse = completion.choices[0].message.content || "";

    // 栄養データの保存
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

    // クリーンアップして送信
    let finalOutput = aiResponse.replace(/\[SAVE_.*?\]/g, "").replace(/\*/g, "").replace(/#/g, "").trim();
    await client.pushMessage({ to: userId, messages: [{ type: "text", text: finalOutput }] });

  } catch (error) { console.error("Main Logic Error:", error); }
}

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Server started on port ${PORT}`);
  await setupRichMenu();
});
