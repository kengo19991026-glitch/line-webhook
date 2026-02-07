import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import admin from "firebase-admin";

const app = express();
const PORT = Number(process.env.PORT || 8080);

// --- Firestoreの初期化（あなたのプロジェクトIDを指定） ---
admin.initializeApp({
  projectId: "project-d3eb52a5-cef2-40c7-bfc"
});
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

app.get("/", (_req, res) => res.status(200).send("ok"));

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- 強化プロンプト（プロフィール抽出命令を追加） ---
const SYSTEM_PROMPT = [
  "あなたは、超一流パーソナルトレーナー、管理栄養士、心理カウンセラーを統合したアドバイザーです。",
  "",
  "【あなたの重要な任務】",
  "1. ユーザーの基本情報（身長、現在の体重、目標体重、目的）を会話から把握してください。",
  "2. もし新しい情報（例：「今の体重は70kg」など）が出てきたら、回答の最後に必ず以下の形式で情報を付与してください。",
  "   [SAVE_PROFILE: {\"weight\": 70, \"height\": 175, \"targetWeight\": 65, \"goal\": \"減量\"}]",
  "   ※把握できた項目のみでOKです。このタグはユーザーには見えないように処理されます。",
  "",
  "【回答ルール】",
  "・提供されたユーザープロフィールに基づき、パーソナライズされた具体的な助言をしてください。",
  "・「私たちは最高のチーム」という温かい口調を維持してください。",
  "・LINEで読みやすいよう改行や絵文字を多用してください。"
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
        // 1. プロフィールと履歴の取得
        const [profileDoc, historySnapshot] = await Promise.all([
          db.collection("users").doc(userId).get(),
          db.collection("users").doc(userId).collection("history").orderBy("createdAt", "desc").limit(6).get()
        ]);

        const profileData = profileDoc.exists ? profileDoc.data() : {};
        const profileContext = `\n【現在のユーザープロフィール】\n${JSON.stringify(profileData)}`;

        let pastMessages = [];
        historySnapshot.forEach(doc => {
          const data = doc.data();
          pastMessages.unshift({ role: data.role, content: data.content });
        });

        // 2. OpenAI API呼び出し
        const completion = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: SYSTEM_PROMPT + profileContext },
            ...pastMessages,
            { role: "user", content: userText }
          ],
        });

        let aiResponse = completion.choices[0].message.content || "";

        // 3. プロフィール保存タグ [SAVE_PROFILE: ...] の解析と処理
        const saveProfileTag = aiResponse.match(/\[SAVE_PROFILE: ({.*?})\]/);
        if (saveProfileTag) {
          try {
            const newData = JSON.parse(saveProfileTag[1]);
            await db.collection("users").doc(userId).set(newData, { merge: true });
            console.log("[LOG] Profile Updated:", newData);
            // ユーザーに見えないよう、タグ部分を削除
            aiResponse = aiResponse.replace(/\[SAVE_PROFILE: {.*?}\]/g, "").trim();
          } catch (e) {
            console.error("Profile Parse Error", e);
          }
        }

        // 4. 会話履歴の保存
        const batch = db.batch();
        const userLogRef = db.collection("users").doc(userId).collection("history").doc();
        const aiLogRef = db.collection("users").doc(userId).collection("history").doc();

        batch.set(userLogRef, { role: "user", content: userText, createdAt: admin.firestore.FieldValue.serverTimestamp() });
        batch.set(aiLogRef, { role: "assistant", content: aiResponse, createdAt: admin.firestore.FieldValue.serverTimestamp() });
        await batch.commit();

        // 5. 返信
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: aiResponse }],
        });

      } catch (err) {
        console.error("[ERROR]", err);
      }
    }));
  });
}

app.listen(PORT, "0.0.0.0", () => console.log("Server running on", PORT));
