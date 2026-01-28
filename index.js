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

if (LINE_TOKEN && LINE_SECRET) {
  const config = { channelAccessToken: LINE_TOKEN, channelSecret: LINE_SECRET };
  const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: LINE_TOKEN });

  app.post("/webhook", line.middleware(config), async (req, res) => {
    const events = req.body?.events || [];

    // 先に200を返す（LINEの再送・タイムアウトを避ける）
    res.sendStatus(200);

    await Promise.all(
      events.map(async (event) => {
        if (event.type !== "message") return;
        if (event.message?.type !== "text") return;
        if (!event.replyToken) return;

        const userText = event.message.text;

        try {
          const response = await openai.responses.create({
            model: "gpt-4o-mini",
            input: [
              {
                role: "system",
                content:
                  "あなたはLINEの占い師AI。短く、静かで優しい口調。断定しすぎない。最後に一言アドバイスを添える。",
              },
              { role: "user", content: userText },
            ],
          });

          const aiText =
            response.output_text ||
            "今日は言葉がまとまりませんでした。少し時間をおいて、もう一度送ってください。";

          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: "text", text: aiText }],
          });
        } catch (err) {
          console.error("OpenAI error:", err);

          // OpenAI側が429/課金未反映でも、必ず返信して無言を避ける
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [
              {
                type: "text",
                text: "いま占い文の生成に失敗しました（混雑/設定の反映待ちの可能性）。少し時間をおいてもう一度送ってください。",
              },
            ],
          });
        }
      })
    );
  });
} else {
  console.log("LINE env vars are missing.");
  app.post("/webhook", (_req, res) => res.sendStatus(200));
}

app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
