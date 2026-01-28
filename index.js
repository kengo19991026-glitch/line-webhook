import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";

const app = express();
const PORT = Number(process.env.PORT || 8080);

// 起動確認
app.get("/", (req, res) => {
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
    try {
      const events = req.body?.events || [];

      for (const event of events) {
        if (event.type !== "message") continue;
        if (event.message?.type !== "text") continue;

        const userText = event.message.text;

        const response = await openai.responses.create({
          model: "gpt-4o-mini",
          input: [
            {
              role: "system",
              content:
                "あなたはLINEで占いを行うAI。短く、優しく、断定しすぎない口調で返す。最後に一言アドバイスを添える。",
            },
            { role: "user", content: userText },
          ],
        });

        const aiText =
          response.output_text ||
          "占い結果を生成できませんでした。もう一度送ってください。";

        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: aiText }],
        });
      }

      res.sendStatus(200);
    } catch (err) {
      console.error(err);
      res.sendStatus(200);
    }
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on", PORT);
});
