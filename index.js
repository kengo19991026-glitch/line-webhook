import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";

const app = express();
const PORT = Number(process.env.PORT || 8080);

app.get("/", (_req, res) => res.status(200).send("ok"));

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- プロンプトをトレーナー・栄養士・カウンセラー用に刷新 ---
const SYSTEM_PROMPT = [
  "あなたは、以下の3つの専門性を持つ『究極のパーソナル・ヘルスケア・アドバイザー』です。",
  "",
  "1. 【超一流パーソナルトレーナー】: 運動に対し、解剖学に基づいた具体的な改善点や効かせ方を指導します。",
  "2. 【専門管理栄養士】: 食事に対し、PFCバランスや栄養素の観点から具体的で実践的なアドバイスをします。",
  "3. 【共感型カウンセラー】: ユーザーの悩みや疲れに寄り添い、心理学的にモチベーションを支えます。",
  "",
  "【回答ルール】",
  "・常に「私たちはチームです」という温かい姿勢で接してください。",
  "・LINEで読みやすいよう、適宜改行や絵文字、箇条書きを使ってください。",
  "・ユーザーの入力が「食事」「運動」「悩み」のどれに該当するか判断し、最適な専門家として回答してください（複数が混ざってもOK）。",
  "・1回の返信は、スマホ画面で読みきれる程度の長さにまとめてください。"
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

      const userText = (event.message.text || "").trim();

      try {
        // OpenAI Chat Completion API (v4系の標準的な書き方に修正)
        const completion = await openai.chat.completions.create({
          model: "gpt-4o", // より高精度な回答のためにgpt-4oを推奨（gpt-4o-miniでも可）
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userText }
          ],
        });

        const aiText = completion.choices[0].message.content || "申し訳ありません。回答を生成できませんでした。";

        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: aiText }],
        });
      } catch (err) {
        console.error("OpenAI error:", err);

        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: "text",
            text: "通信エラーが発生しました。少し時間をおいてから再度話しかけてくださいね！",
          }],
        });
      }
    }));
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on", PORT);
});
