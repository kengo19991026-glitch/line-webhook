import express from "express";
import line from "@line/bot-sdk";

const app = express();
const PORT = process.env.PORT || 8080;

// ヘルスチェック
app.get("/", (req, res) => {
  res.status(200).send("ok");
});

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const SECRET = process.env.LINE_CHANNEL_SECRET;

if (TOKEN && SECRET) {
  const config = {
    channelAccessToken: TOKEN,
    channelSecret: SECRET
  };

  const client = new line.messagingApi.MessagingApiClient({
    channelAccessToken: TOKEN
  });

  app.post("/webhook", line.middleware(config), async (req, res) => {
    const events = req.body.events || [];

    for (const event of events) {
      if (event.type === "message") {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            { type: "text", text: "OK（Webhook疎通）" }
          ]
        });
      }
    }

    res.sendStatus(200);
  });
} else {
  // トークン未設定でも落ちないように
  app.post("/webhook", (req, res) => {
    res.sendStatus(200);
  });

  console.log("LINE env vars not set");
}

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
