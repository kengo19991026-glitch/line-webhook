import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import admin from "firebase-admin";

const app = express();
const PORT = Number(process.env.PORT || 8080);

// --- Firestoreの初期化（Cloud RunのIAM権限を利用） ---
admin.initializeApp();
const db = admin.firestore();

app.get("/", (_req, res) => res.status(200).send("ok"));

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- 強化された専門家プロンプト ---
const SYSTEM_PROMPT = [
  "あなたは、超一流パーソナルトレーナー、管理栄養士、心理カウンセラーの3つの専門知識を統合した、ユーザーに一生寄り添う『究極のアドバイザー』です。",
  "",
  "【各専門家としての振る舞い】",
  "1. トレーナー: 具体的数値（セット数、RPE、可動域の注意点）に基づいた分析を行います。単に「頑張りましたね」ではなく、「その重量なら次はこれを目指しましょう」「その種目ならここを意識するとより効きます」と技術的指導を行ってください。",
  "2. 栄養士: 食事内容からPFCバランスを推測し、不足している栄養素（ビタミン、ミネラル含む）や、次に摂取すべき食材を具体的に提示してください。",
  "3. カウンセラー: ユーザーの言葉の裏にある「疲れ」や「焦り」を察知し、受容した上で、明日また一歩踏み出したくなるような力強い励ましを送ってください。",
  "",
  "【回答の指針】",
  "・過去の会話履歴を把握していることを示してください（例：「前回言っていた〇〇ですが…」）。",
  "・曖昧な助言を避け、今日から実践できる『最初の一歩』を具体的に提案してください。",
  "・LINE特有の読みやすさを重視し、重要なポイントは太字や絵文字で強調してください。",
  "・「私たちは最高のチーム」という信頼感を醸成する口調を維持してください。"
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
        // 1. Firestoreから直近の会話履歴（最大6件）を取得
        const historyRef = db.collection("users").doc(userId).collection("history")
          .orderBy("createdAt", "desc")
          .limit(6);
        const snapshot = await historyRef.get();
        let pastMessages = [];
        snapshot.forEach(doc => {
          const data = doc.data();
          pastMessages.unshift({ role: data.role, content: data.content });
        });

        // 2. OpenAI API呼び出し（履歴を含めて送信）
        const completion = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            ...pastMessages,
            { role: "user", content: userText }
          ],
        });

        const aiText = completion.choices[0].message.content || "申し訳ありません。アドバイスを生成できませんでした。";

        // 3. 今回の会話（ユーザーとAI両方）を保存
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

        // 4. LINEに返信
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: aiText }],
        });

      } catch (err) {
        console.error("Error:", err);
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: "少し通信が不安定なようです。もう一度送っていただけますか？" }],
        });
      }
    }));
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on", PORT);
});
