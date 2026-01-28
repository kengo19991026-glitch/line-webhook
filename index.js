import express from "express";
import line from "@line/bot-sdk";

const PORT = process.env.PORT || 8080;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

const config = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN
});

const middleware = line.middleware(config);
const app = express();

app.get("/", (req, res) => {
  res.send("ok");
});

app.post("/webhook", middleware, async (req, res) => {
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

app.listen(PORT, () => {
  console.log("Server running");
});
