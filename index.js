import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import admin from "firebase-admin";

const app = express();
const PORT = Number(process.env.PORT || 8080);

admin.initializeApp({ projectId: "project-d3eb52a5-cef2-40c7-bfc" });
const db = admin.firestore();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });

// 処理済みのイベントを記録（重複防止）
const cache = new Set();

app.post("/webhook", line.middleware({ 
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN, 
  channelSecret: process.env.LINE_CHANNEL_SECRET 
}), (req, res) => {
  // ⚡ 対策1: LINEに即レスして「再送」を完全に防ぐ
  res.status(200).send("OK");

  const events = req.body.events;
  events.forEach(async (event) => {
    if (event.type !== "message" || event.message.type !== "text") return;
    if (cache.has(event.eventId)) return;
    cache.add(event.eventId);
    setTimeout(() => cache.delete(event.eventId), 60000);

    try {
      // ⚡ 対策2: 「考え中...」のスタンプやメッセージを即座に送る（これで5秒の壁を突破）
      // ※これを入れるとLINE側が「応答があった」と見なしてくれます
      // 今回はシンプルに、そのままAIの処理に入りますが、非同期なので問題ありません

      const userId = event.source.userId;
      const userText = event.message.text;

      // データの並列取得
      const [profileDoc, historySnapshot] = await Promise.all([
        db.collection("users").doc(userId).get(),
        db.collection("users").doc(userId).collection("history").orderBy("createdAt", "desc").limit(5).get()
      ]);

      const profileData = profileDoc.exists ? profileDoc.data() : {};
      const pastMessages = historySnapshot.docs.reverse().map(doc => ({
        role: doc.data().role,
        content: doc.data().content
      }));

      // AI思考（第2世代ならここが速くなります）
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "あなたはプロのトレーナーです。具体的に回答して。" + JSON.stringify(profileData) },
          ...pastMessages,
          { role: "user", content: userText }
        ]
      });

      const aiResponse = completion.choices[0].message.content;

      // LINEへの返信（pushMessageを使うことで5秒ルールを無視して送信可能）
      await client.pushMessage({
        to: userId,
        messages: [{ type: "text", text: aiResponse.replace(/\[SAVE_PROFILE: {.*?}\]/g, "").trim() }]
      });

      // 履歴保存
      await db.collection("users").doc(userId).collection("history").add({
        role: "assistant", content: aiResponse, createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

    } catch (err) {
      console.error(err);
    }
  });
});

app.listen(PORT, "0.0.0.0");
