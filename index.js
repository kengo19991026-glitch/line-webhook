import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import admin from "firebase-admin";

const app = express();
const PORT = Number(process.env.PORT || 8080);

// --- Firestoreの初期化（プロジェクトIDを明示的に指定） ---
admin.initializeApp({
  projectId: "project-d3eb52a5-cef2-40c7-bfc" // ←ここをご自身のプロジェクトIDに書き換えてください
});
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

app.get("/", (_req, res) => res.status(200).send("ok"));

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- 強化プロンプト ---
const SYSTEM_PROMPT = [
  "あなたは、超一流パーソナルトレーナー、管理栄養士、心理カウンセラーの3つの専門知識を統合したアドバイザーです。",
  "【ルール】",
  "1. トレーナー: 具体的数値に基づいた分析と技術的指導を行う。",
  "2. 栄養士: PFCバランスを推測し、次に摂取すべき具体的食材を提示する。",
  "3. カウンセラー: 心理学的に寄り添い、明日へのモチベーションを高める。",
  "・過去の会話履歴を把握し、文脈に沿った回答をする。",
  "・LINEで読みやすいよう、適宜改行や絵文字、箇条書きを使う。"
].join("\n");

if (!LINE_TOKEN || !LINE_SECRET) {
  console.log("LINE env vars are missing.");
  app.post("/webhook", (_req, res) => res.sendStatus(200));
} else {
  const config = { channelAccessToken: LINE_TOKEN, channelSecret: LINE_SECRET };
  const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: LINE_TOKEN });

  app.post("/webhook", line.middleware(config), async (req, res) => {
    const events = req.body?.events || [];
    res.sendStatus(200);

    await Promise.all(events.map(async (event) => {
      if (event.type !== "message" || event.message?.type !== "text") return;
      if (!event.replyToken) return;

      const userId = event.source.userId;
      const userText = (event.message.text || "").trim();

      try {
        console.log(`[LOG] Start processing for user: ${userId}`);

        // 1. 会話履歴の取得（一旦シンプルに取得）
        const historyRef = db.collection("users").doc(userId).collection("history")
          .orderBy("createdAt", "desc")
          .limit(6);
        
        const snapshot = await historyRef.get();
        let pastMessages = [];
        snapshot.forEach(doc => {
          const data = doc.data();
          pastMessages.unshift({ role: data.role, content: data.content });
        });

        // 2. OpenAI API呼び出し
        const completion = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            ...pastMessages,
            { role: "user", content: userText }
          ],
        });

        const aiText = completion.choices[0].message.content || "アドバイスを生成できませんでした。";

        // 3. Firestoreへの保存
        console.log("[LOG] Saving to Firestore...");
        const batch = db.batch();
        const userLogRef = db.collection("users").doc(userId).collection("history").doc();
        const aiLogRef = db.collection("users").doc(userId).collection("history").doc();

        batch.set(userLogRef, { 
          role: "user", 
          content: userText, 
          createdAt: admin.firestore.FieldValue.serverTimestamp() 
        });
        batch.set(aiLogRef, { 
          role: "assistant", 
          content: aiText, 
          createdAt: admin.firestore.FieldValue.serverTimestamp() 
        });
        await batch.commit();
        console.log("[LOG] Successfully saved to Firestore");

        // 4. LINEに返信
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: aiText }],
        });

      } catch (err) {
        console.error("[ERROR DETAILED]", err);
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: "すみません、少し調子が悪いようです。時間を置いてもう一度教えてください！" }],
        });
      }
    }));
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on", PORT);
});
