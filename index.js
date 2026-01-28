app.post("/webhook", line.middleware(config), async (req, res) => {
  const events = req.body?.events || [];

  await Promise.all(events.map(async (event) => {
    if (event.type !== "message") return;
    if (event.message?.type !== "text") return;
    if (!event.replyToken) return;

    try {
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

      const aiText = response.output_text || "今日は言葉が出てこないみたい。少し時間をおいて、もう一度送ってね。";

      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: "text", text: aiText }],
      });

    } catch (err) {
      console.error("OpenAI or reply error:", err);

      // 失敗しても必ず返す（無言防止）
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: "text", text: "いま占い文の生成に失敗しました。少し時間をおいて、もう一度送ってください。" }],
      });
    }
  }));

  // LINEにはすぐ200を返す（再送ループ防止）
  res.sendStatus(200);
});
