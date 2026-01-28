const express = require("express");
const line = require("@line/bot-sdk");

const app = express();
const PORT = Number(process.env.PORT || 8080);

// Cloud Run起動確認用
app.get("/", (_req, res) => res.status(200).send("ok"));

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const SECRET = process.env.LINE_CHANNEL_SECRET;

if (TOKEN && SECRET) {
  const config = { channelAccessToken: TOKEN, channelSecret: SECRET };
  const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: TOKEN });

  app.post("/webhook", line.middleware(config), async (req, res) => {
    try {
      const events = (req.body && req.body.events) || [];
      for (const event of events) {
        if (event.type === "message" && event.replyToken) {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: "text", text: "OK（Webhook疎通）" }],
          });
        }
      }
      res.sendStatus(200);
    } catch (e) {
      console.error("webhook handler error:", e);
      res.sendStatus(200);
    }
  });
} else {
  console.log("LINE env vars are missing.");
  app.post("/webhook", (_req, res) => res.sendStatus(200));
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on ${PORT}`);
});
