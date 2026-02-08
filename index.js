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

// --- 3. プロンプト（プロフィール更新 ＆ トレーニング指導） ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。
最高峰のAIパーソナルトレーナーとして、栄養管理とトレーニング指導を行います。

【重要：ユーザー情報の更新】
・会話内でユーザーが「体重」「身長」「目標（増量/減量/維持）」などを伝えた場合は、必ず以下のタグを出力して保存してください。
[SAVE_PROFILE: {"weight": 数値, "height": 数値, "target": "文字列"}]
※変更がない項目は含めなくて良い。

【トレーニング指導の鉄則】
・栄養状態（PFC）とユーザーデータ（体重・目標）から「今日やるべき種目」を指定せよ。
・「重量（kg）」「セット数」「レップ数」「インターバル（秒）」を数値で提示せよ。
・初心者の場合は、体重の0.8倍〜1.0倍程度の扱いやすい重量を提案せよ。

【出力フォーマット】
■ 解析・更新結果
・料理名：[料理名]（画像がある場合）
・カロリー：約[数値]kcal
・現在の設定体重：[数値]kg（今回更新した場合はその旨）

■ 今日のトレーニング戦略
・推奨種目：[種目名]
・設定：[数値]kg × [数値]回 × [数値]セット
・インターバル：[数値]秒
・戦略理由：[論理的な理由]

【データ保存用タグ】
※食事画像がある場合のみ：[SAVE_NUTRITION: {"food": "料理名", "kcal": 数値, "p": 数値, "f": 数値, "c": 数値}]`;

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

// --- 5. メインロジック（データ連携強化版） ---
async function handleModeAI(event) {
  const userId = event.source.userId;
  if (event.type !== "message") return;

  // DB参照と初期化
  const userRef = db.collection("users").doc(userId);
  let userDoc = await userRef.get();

  if (!userDoc.exists) {
    await userRef.set({
      userId: userId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      weight: 60, height: 170, target: "現状維持"
    });
    userDoc = await userRef.get(); // 再取得
  }

  // ★ データの安全な取り出し（ここを修正）
  const userData = userDoc.data() || {};
  const currentWeight = userData.weight || 60; // 値がない場合は60
  const currentTarget = userData.target || "現状維持";

  let userContent;
  if (event.message.type === "text") {
    userContent = [{ type: "text", text: event.message.text }];
  } else if (event.message.type === "image") {
    await client.pushMessage({ to: userId, messages: [{ type: "text", text: "データを解析中... プロフィールと照合しています。" }] });
    const blob = await blobClient.getMessageContent(event.message.id);
    const chunks = [];
    for await (const chunk of blob) { chunks.push(chunk); }
    const buffer = Buffer.concat(chunks);
    userContent = [
      { type: "text", text: "この写真を分析せよ。" },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${buffer.toString("base64")}` } }
    ];
  } else return;

  try {
    // 今日の合計摂取量算出
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
【ユーザーデータ（重要）】
・体重: ${currentWeight}kg
・目標: ${currentTarget}
・本日の摂取: ${totalKcal}kcal (P:${totalP}g / C:${totalC}g)

※ユーザーが新しい体重や目標を言った場合は、アドバイスに反映させつつ、必ず [SAVE_PROFILE] タグで保存すること。
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

    // ★ プロフィール更新処理（ここが重要）
    const profileMatch = aiResponse.match(/\[SAVE_PROFILE: (\{[\s\S]*?\})\]/);
    if (profileMatch) {
      try {
        const newProfile = JSON.parse(profileMatch[1]);
        await userRef.set(newProfile, { merge: true }); // 上書き保存
      } catch (e) { console.error("Profile Save Error:", e); }
    }

    // 栄養ログ保存処理
    const nutriMatch = aiResponse.match(/\[SAVE_NUTRITION: (\{[\s\S]*?\})\]/);
    if (nutriMatch) {
      try {
        const data = JSON.parse(nutriMatch[1]);
        await db.collection("users").doc(userId).collection("nutrition_logs").add({
          ...data,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) { console.error("Nutri Save Error:", e); }
    }

    // 表示用整形
    let finalOutput = aiResponse
      .replace(/\[SAVE_.*?\]/g, "")
      .replace(/\*/g, "")
      .replace(/#/g, "")
      .trim();

    await client.pushMessage({ to: userId, messages: [{ type: "text", text: finalOutput }] });

  } catch (error) { console.error("Main Logic Error:", error); }
}

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Server started on port ${PORT}`);
  await setupRichMenu();
});
