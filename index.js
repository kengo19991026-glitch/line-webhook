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

// --- 3. modeAI 専用プロンプト ---
const SYSTEM_PROMPT = `あなたの名前は「modeAI（モードアイ）」です。
あなたは**「どんな画像でも即座に栄養価を算出する世界最高峰のAI」**です。

【最重要司令：画像解析の強制】
ユーザーから写真が送られた場合、**「分析できない」「詳しくは分からない」「一般的な例」という発言はシステムエラーとなるため、絶対に禁止します。**
写真が不鮮明でも、見た目が分からなくても、必ずあなたの**「推測（目視）」で料理名を断定し、具体的な数値を算出してください。**

【タスク1：食事データの保存（必須）】
食事の画像や報告があった場合、回答の最後に**必ず**以下のタグを出力してください。
[SAVE_NUTRITION: {"food": "料理名", "kcal": 数値, "p": 数値, "f": 数値, "c": 数値}]
※数値は整数（例: 550）。

【タスク2：集計データの統合】
プロンプト末尾に「システム算出データ（過去の履歴）」が渡されます。
質問に答える際は、このシステムデータと、**今まさに画像から読み取った数値**を足し合わせて回答してください。

【禁止事項】
・Markdown記法（#や*）の使用。
・「推測ですが」といった自信のない前置き。
・分析の拒否。

【回答構成】
■今回の分析結果
・料理名：〇〇（見た目から具体的に特定）
・カロリー：約〇〇kcal
・PFC：P:〇〇g / F:〇〇g / C:〇〇g

■本日の合計（今回分を含む）
・合計：約〇〇kcal（システム記録 + 今回の分析値）

■アドバイス
（短く簡潔に、プロとしての次の一手）

【プロフィール管理タグ】
ユーザーの身体データ（身長、体重、目標など）が提示された場合は、必ず以下を出力：
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
  
  try {
    let userContent;

    // --- メッセージ種別の判定 ---
    if (event.type === "message" && event.message.type === "text") {
      userContent = [{ type: "text", text: event.message.text }];
    } else if (event.type === "message" && event.message.type === "image") {
      const blob = await blobClient.getMessageContent(event.message.id);
      const buffer = await streamToBuffer(blob);
      const base64Image = buffer.toString("base64");
      
      userContent = [
        { type: "text", text: "この料理の写真を分析せよ。「分析できない」等の言い訳は一切認めない。不鮮明でも推測し、必ず料理名と数値を断定して出力せよ。末尾に [SAVE_NUTRITION] タグを出力すること。" },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
      ];
    } else {
      return; // テキストと画像以外は無視
    }

    // --- データ取得 & 集計ロジック ---
    let profileData = {};
    let pastMessages = [];
    let summary = { today: { k: 0, p: 0, f: 0, c: 0 }, week: { k: 0 }, month: { k: 0 } };

    try {
      // 1. プロフィール取得（存在しなくてもエラーにしない）
      const profileDoc = await db.collection("users").doc(userId).get();
      if (profileDoc.exists) {
        profileData = profileDoc.data();
      } else {
        console.log("New user or no profile data.");
        profileData = { weight: null, goal: "未設定" };
      }

      // 2. 履歴取得
      // docが存在しなくてもcollectionアクセスは空を返すだけなので安全だが、念の為tryで囲む
      const snap = await db.collection("users").doc(userId).collection("history").orderBy("createdAt", "desc").limit(4).get();
      if (!snap.empty) {
        pastMessages = snap.docs.reverse().map(doc => ({ role: doc.data().role, content: doc.data().content }));
      }

      // 3. ログ集計（nutrition_logsがない場合も考慮）
      const now = new Date();
      const jstOffset = 9 * 60 * 60 * 1000;
      const jstNow = new Date(now.getTime() + jstOffset);
      const todayStart = new Date(jstNow); todayStart.setUTCHours(0, 0, 0, 0); 
      const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - 6);
      const monthStart = new Date(todayStart); monthStart.setDate(monthStart.getDate() - 29);
      const queryStartUtc = new Date(monthStart.getTime() - jstOffset);

      // コレクションがなくてもエラーにならないが、念の為
      const logSnap = await db.collection("users").doc(userId).collection("nutrition_logs")
        .where("createdAt", ">=", queryStartUtc).get();

      if (!logSnap.empty) {
        logSnap.forEach(doc => {
          const d = doc.data();
          const logDateJst = new Date(d.createdAt.toDate().getTime() + jstOffset);
          const vals = { k: Number(d.kcal)||0, p: Number(d.p)||0, f: Number(d.f)||0, c: Number(d.c)||0 };
          
          summary.month.k += vals.k;
          if (logDateJst >= new Date(weekStart.getTime() - jstOffset)) summary.week.k += vals.k;
          if (logDateJst >= new Date(todayStart.getTime() - jstOffset)) {
              summary.today.k += vals.k; summary.today.p += vals.p; summary.today.f += vals.f; summary.today.c += vals.c;
          }
        });
      }
    } catch (e) { 
      console.warn("DB Fetch Warning (Safe to ignore for new users):", e); 
      // DBエラーがあっても会話は続ける
    }

    const getAvg = (sum, days) => Math.round(sum / days);

    // システムメッセージ作成
    const dynamicSystemMessage = `
${SYSTEM_PROMPT}

【システム算出データ（参考情報）】
※以下は過去の記録です。**今送られてきた画像の分析には使用しないでください。**
今、画像が送られている場合は、このデータに「画像から読み取った数値」を足して、今日の合計を回答してください。

・本日記録済み: ${summary.today.k} kcal
・直近7日平均: ${getAvg(summary.week.k, 7)} kcal/日

【ユーザー情報】
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
      temperature: 0.7, 
      max_tokens: 1000
    });

    let aiResponse = completion.choices[0].message.content || "";

    // --- 保存処理（ここでのエラーは会話を止めない） ---
    // 1. プロフィール保存
    const saveProfileMatch = aiResponse.match(/\[SAVE_PROFILE: (\{[\s\S]*?\})\]/);
    if (saveProfileMatch) {
      try {
        const newData = JSON.parse(saveProfileMatch[1]);
        // merge: true で保存（ドキュメントがなければ作成される）
        await db.collection("users").doc(userId).set(newData, { merge: true });
        console.log("Profile Saved Successfully");
      } catch (e) { console.error("Profile Save Error:", e); }
    }

    // 2. 食事ログ保存
    const saveNutritionMatch = aiResponse.match(/\[SAVE_NUTRITION: (\{[\s\S]*?\})\]/);
    if (saveNutritionMatch) {
      try {
        const jsonStr = saveNutritionMatch[1];
        const nutritionData = JSON.parse(jsonStr);
        await db.collection("users").doc(userId).collection("nutrition_logs").add({
          ...nutritionData,
          createdAt: admin.firestore.FieldValue.serverTimestamp() // サーバー側でタイムスタンプ付与
        });
        console.log("Nutrition Log Saved");
      } catch (e) { console.error("Nutrition Save Error:", e); }
    }

    // --- クリーニング ---
    aiResponse = cleanMarkdown(aiResponse);

    await client.pushMessage({ to: userId, messages: [{ type: "text", text: aiResponse }] });

    // 履歴保存（非同期で投げっぱなし）
    const historyText = event.message.type === "text" ? event.message.text : "[画像送信]";
    db.collection("users").doc(userId).collection("history").add({
      role: "user", content: historyText, createdAt: admin.firestore.FieldValue.serverTimestamp()
    }).catch(e => console.error("History Save Error:", e));
    
    db.collection("users").doc(userId).collection("history").add({
      role: "assistant", content: aiResponse, createdAt: admin.firestore.FieldValue.serverTimestamp()
    }).catch(e => console.error("History Save Error:", e));

  } catch (error) {
    console.error("Main Process Critical Error:", error);
    // ユーザーに適切なエラーメッセージを返す
