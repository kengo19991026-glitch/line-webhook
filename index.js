import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import admin from "firebase-admin";

const app = express();
const PORT = Number(process.env.PORT || 8080);

admin.initializeApp({ projectId: "project-d3eb52a5-cef2-40c7-bfc" });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });

const SYSTEM_PROMPT = `あなたは一流のトレーナー、栄養士、カウンセラーです。
ユーザー情報を踏まえ、短く的確にアドバイスしてください。
新情報があれば [SAVE_PROFILE: {...}] タグを末尾に付けて。`;

app.post("/webhook", line.middleware({ 
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN, 
  channelSecret: process.env.LINE_CHANNEL_SECRET 
}), async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events;

  for (const event of events) {
    if (event.type !== "message" || event.message.type !== "text") continue;
    const userId = event.source.userId;
    const userText = event.message.text;

    try {
      // --- 改善：プロフィールと履歴を「同時」に取得して時短 ---
      const [profileDoc, historySnapshot] = await Promise.all([
        db.collection("users").doc(userId).get(),
        db.collection("users").doc(userId).collection("history").orderBy("createdAt", "desc").limit(5).get()
      ]);

      const profileData = profileDoc.exists ? profileDoc.data() : {};
      const pastMessages = historySnapshot.docs.reverse().map(doc => ({
        role: doc.data().role,
        content: doc.data().content
      }));

      // --- 改善：モデルを mini にして生成速度アップ ---
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini", 
        messages: [
          { role: "system", content: SYSTEM_PROMPT + "\nユーザー情報: " + JSON.stringify(profileData) },
          ...pastMessages,
          { role: "user", content: userText }
        ],
      });

      let aiResponse = completion.choices[0].message.content || "";

      // プロフィール更新処理（以前と同様）
      const saveMatch = aiResponse.match(/\[SAVE_PROFILE: ({.*?})\]/);
      if (saveMatch) {
        await db.collection("users").doc(userId).set(JSON.parse(saveMatch[1]), { merge: true });
        aiResponse = aiResponse.replace(/\[SAVE_PROFILE: {.*?}\]/g, "").trim();
      }

      // 保存と返信を同時に実行して時短
      await Promise.all([
        db.collection("users").doc(userId).collection("history").add({
          role: "user", content: userText, createdAt: admin.firestore.FieldValue.serverTimestamp()
        }),
        db.collection("users").doc(userId).collection("history").add({
          role: "assistant", content: aiResponse, createdAt: admin.firestore.FieldValue.serverTimestamp()
        }),
        client.replyMessage({ replyToken: event.replyToken, messages: [{ type: "text", text: aiResponse }] })
      ]);

    } catch (err) {
      console.error(err);
    }
  }
});

app.listen(PORT, "0.0.0.0");
