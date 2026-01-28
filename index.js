import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";

const app = express();   // ← ★これが無いと死ぬ
const PORT = Number(process.env.PORT || 8080);

// 起動確認
app.get("/", (_req, res) => {
  res.status(200).send("ok");
});

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

if (LINE_TOKEN && LINE_SECRET) {
  const config = {
    channelAccessToken: LINE_TOKEN,
    channelSecret: LINE_SECRET,
  };

  const client = new line.messagingApi.MessagingApiClient({
    channelAccessToken: LINE_TOKEN,
  });

  app.post("/webhook", line.middleware(config), async (req, res) => {
    const events = req.body?.events || [];

    // 先に200を返す
    res.sendStatus(200);

    for (const event of events) {
      if (event.type !== "message") continue;
      if (event.message?.type !== "text") continue;
      if (!event.replyToken) continue;

      try {
        const userText = event.message.text;

        const response = await openai.responses.create({
          model: "gpt-4o-mini",
          input: [
            {
              role: "system",
              content:
                "あなたはLINEの占い師AI。短く、優しく、断定しすぎない口調。最後に一言アドバイス。",
            },
            { role: "user", content: userText },
          ],
        });

        const aiText =
          response.output_text ||
          "うまく占い結果を作れませんでした。もう一度送ってください。";

        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: aiText }],
        });
      } catch (err) {
        console.error("AI error:", err);

        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text: "現在AIが混雑しています。少し時間をおいて送ってください。",
            },
          ],
        });
      }
    }
  });
} else {
  console.log("LINE env vars are missing.");
  app.post("/webhook", (_req, res) => res.sendStatus(200));
}

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on", PORT);
});
