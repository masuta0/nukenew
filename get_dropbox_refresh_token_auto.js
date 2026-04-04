const express = require("express");
const fetch = require("node-fetch");

const CLIENT_ID = process.env.DROPBOX_APP_KEY;
const CLIENT_SECRET = process.env.DROPBOX_APP_SECRET;
const REDIRECT_URI = "https://Nodejs.kuntekitou96.repl.co/auth"; // 半角に修正

const app = express();

// Dropbox認可後のリダイレクト先
app.get("/auth", async (req, res) => {
  const code = req.query.code; // 認可コードを取得
  if (!code) {
    return res.send("Dropboxからcodeが返ってきませんでした。認可URLを確認してください。");
  }

  const tokenUrl = "https://api.dropboxapi.com/oauth2/token";
  const params = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
  });

  try {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });

    const data = await response.json();
    res.send(`<pre>${JSON.stringify(data, null, 2)}</pre>`);
  } catch (err) {
    console.error(err);
    res.status(500).send("トークン取得エラー");
  }
});

// Replitでサーバを立てる
app.listen(3000, () => {
  console.log("Auth server running on http://localhost:3000");
});