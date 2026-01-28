import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";

const app = express();
const PORT = Number(process.env.PORT || 8080);

// ヘルスチェック
app.get("/", (_req, res) => res.status(200).send("ok"));

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

if (!LINE_TOKEN || !LINE_SECRET) {
  console.log("LINE env vars are missing.");
  app.post("/webhook", (_req, res) => res.sendStatus(200));
} else {
  const config = {
    channelAccessToken: LINE_TOKEN,
    channelSecret: LINE_SECRET,
  };

  const client = new line.messagingApi.MessagingApiClient({
    channelAccessToken: LINE_TOKEN,
  });

  app.post("/webhook", line.middleware(config), async (req, res) => {
    const events = req.body?.events || [];

    // 先に200を返す（LINE再送防止）
    res.sendStatus(200);

    await Promise.all(
      events.map(async (event) => {
        if (event.type !== "message") return;
        if (event.message?.type !== "text") return;
        if (!event.replyToken) return;

        const userText = event.message.text.trim();

        try {
          const response = await openai.responses.create({
            model: "gpt-4o-mini",
            input: [
              {
                role: "system",
                content: `
あなたは共感力の高い占い師AIです。

最初に相手の気持ちや状況をやさしく受け止め、
「そう感じるのも自然です」「無理もありません」などの形で共感を示してください。

そのうえで、
占い・スピリチュアル・直感的な視点から、
今の流れ、相手の内面の状態、これから起こりやすい傾向を読み取り、
押し付けず、断定しすぎない表現で伝えてください。

最後に、
相手が少し安心できるような一言アドバイスや
心の持ち方のヒントを添えてください。

口調は穏やかで落ち着いていて、やさしい。
不安を煽らず、希望をにじませる。
文字数は400〜600文字程度。
箇条書きは使わず、自然な文章で書く。
                `,
              },
              {
                role: "user",
                content: userText,
              },
            ],
          });

          const aiText =
            response.output_text ||
            "うまく占い文を生成できませんでした。もう一度送ってください。";

          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [
              {
                type: "text",
                text: aiText.slice(0, 900),
              },
            ],
          });
        } catch (err) {
          console.error("OpenAI error:", err);

          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [
              {
                type: "text",
                text: "いま占い文の生成に失敗しました。少し時間をおいて、もう一度送ってください。",
              },
            ],
          });
        }
      })
    );
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on", PORT);
});
