import express from "express";
import line from "@line/bot-sdk";

const app = express();
const PORT = Number(process.env.PORT || 8080);

// ここは絶対に動かす（Cloud Runヘルスチェック用）
app.get("/", (_req, res) => res.status(200).send("ok"));

// /webhook は環境変数が無い間でも落ちないようにする
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const SECRET = process.env.LINE_CHANNEL_SECRET;

if (TOKEN && SECRET) {
  const config = { channelAccessToken: TOKEN, channelSecret: SECRET };
  const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: TOKEN });

  app.post("/webhook", line.middleware(config), async (req, res) => {
    try {
      const events = req.body?.events || [];
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
      res.sendStatus(200); // LINEには200返して再送地獄を防ぐ
    }
  });
} else {
  console.log("LINE env vars are missing (LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET).");
  app.post("/webhook", (_req, res) => res.sendStatus(200));
}

// ★これが実行されないとPORT待受にならずCloud Runが死ぬ
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on ${PORT}`);
});
