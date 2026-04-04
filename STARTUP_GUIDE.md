# nuke2 Bot 再起動ガイド & バグ修正・強化メモ

## 🚨 再起動前に必ずやること（チェックリスト）

### 1. `config.json` を新サーバー用に書き換える
```json
{
  "clientId": "新しいBotのアプリケーションID",
  "guildId":  "新しいサーバーのID"
}
```

### 2. `.env` ファイルを作成する
```bash
cp .env.example .env
# エディタで開いて各値を埋める
```
最低限必要なもの：
| 変数 | 説明 |
|---|---|
| `TOKEN` | Discordデベロッパーポータルのトークン |
| `GEMINI_API_KEY` | Google AI Studio のAPIキー |
| `ACTIVE_ROLE_ID` | アクティブロールのID |
| `FACE_LOG_CHANNEL` | 顔認識ログのチャンネルID |

### 3. Botの権限を確認する
Discordデベロッパーポータル → Bot設定で以下をONに：
- `SERVER MEMBERS INTENT`
- `MESSAGE CONTENT INTENT`  
- `PRESENCE INTENT`

### 4. スラッシュコマンドの再登録
```bash
node commands/register.js
```

---

## 🐛 発見されたバグと修正内容

### バグ① `utils/ai.js` — Gemini APIが400エラーを返す
**原因：** 会話開始時に `user` ロールのメッセージを2連続で送っていた（Gemini APIはこれを拒否する）  
**修正：** ペルソナ設定を `systemInstruction` フィールドで渡すように変更。  
→ **`utils/ai.js` を修正版に差し替えてください**

### バグ② `utils/ai.js` — メモリリーク
**原因：** 会話履歴に上限がなく、長時間起動するとメモリ不足でクラッシュ  
**修正：** 履歴を最大10往復に制限。古いものから自動削除。  
→ **`utils/ai.js` を修正版に差し替えてください**

### バグ③ `utils/weeklyManager.js` — `messageCreate` が二重登録される
**原因：** `index.js` の `messageCreate` ハンドラと、`setupWeekly()` 内のリスナーが両方登録されていた  
**修正：** `setupWeekly()` 内のリスナーを削除。`index.js` の `messageCreate` 内で `handleMessage()` を明示的に呼ぶ。  
→ **`utils/weeklyManager.js` を修正版に差し替えてください**

### バグ④ `utils/weeklyManager.js` — 週次リセットが複数回実行される
**原因：** 1分ごとのインターバルで `jst.getDay()===0 && getHours()===23 && getMinutes()===59` をチェックしているが、その1分間に複数回チェックが通ることがある  
**修正：** `lastResetMinute` フラグで同一分の二重実行を防止。  
→ **`utils/weeklyManager.js` を修正版に差し替えてください**

### バグ⑤ `index.js` — チャンネルIDとロールIDがハードコード
**原因：** `ACTIVE_ROLE_ID` と `FACE_LOG_CHANNEL` が直接コードに書かれている。新サーバーでは全て違うIDになるので必ず変更が必要。  
**修正：** 環境変数 `ACTIVE_ROLE_ID` / `FACE_LOG_CHANNEL` で設定するよう変更。  
→ **`index.js` の該当部分を `index.patch.js` の内容に従って書き換えてください**

### バグ⑥ `level.js` — ギルドIDとチャンネルIDがハードコード
```js
// この部分
const levelLogChannels = {
  "1420924251824848988": "1425643757902106704",
};
```
**修正：** `process.env.LEVEL_LOG_CHANNEL` などに移動。または `levels.json` に設定項目を追加。

### バグ⑦ `dropbox_token.json` がリポジトリに含まれている
**原因：** `.gitignore` に `dropbox_token.json` が入っていない可能性。  
**対処：** `.gitignore` に追加し、GitHubにプッシュしないこと。

---

## 📱 スマホで常時起動する方法

### 方法A：Railway（おすすめ・無料枠あり）
GitHubリポジトリをそのままデプロイできる。Dockerfileも既にある。

```
1. https://railway.app にアクセス（GitHubでログイン）
2. "New Project" → "Deploy from GitHub repo" → nuke2リポジトリを選択
3. Variables（環境変数）タブで .env の内容を全部入力
4. Deploy → 自動でDockerfileがビルドされて起動
5. あとはスマホのRailwayアプリで稼働状況を確認するだけ
```
**長所：** 完全クラウド。スマホを閉じても動き続ける。無料枠は月500時間（約20日分）。

### 方法B：Render（無料・常時起動）
```
1. https://render.com にアクセス
2. "New Web Service" → GitHubリポジトリ接続
3. Build Command: npm install
   Start Command: node index.js
4. 環境変数を設定して Deploy
```
**注意：** 無料プランはリクエストがないと15分でスリープ。Botは既に Express サーバーが入っているので、UptimeRobot（無料）でヘルスチェックURLを定期PONGすれば常時起動可能。

### 方法C：Replit（`.replit` ファイルが既に存在）
このBotにはすでに `.replit` ファイルがある。
```
1. https://replit.com にアクセス
2. "Import from GitHub" → nuke2リポジトリ
3. Secrets（環境変数）で .env の内容を設定
4. Run ボタンで起動
5. Replit DeployメニューからAlways On（有料）にするか、
   UptimeRobotで無料KeepAlive
```

### 方法D：Androidスマホ + Termux（ローカル起動）
スマホ自体でBotを動かす。ただし充電しながら常時起動が必要。

```bash
# Termux インストール（F-Droid から）
pkg update && pkg upgrade
pkg install nodejs-lts git

# リポジトリをクローン
git clone https://github.com/masuta0/nuke2.git
cd nuke2

# .env ファイルを作成して TOKEN等を設定
nano .env

# 依存パッケージインストール
npm install

# PM2でバックグラウンド起動（スリープ後も継続）
npm install -g pm2
pm2 start index.js --name nuke2
pm2 save

# Termuxをバックグラウンドアプリとして許可（バッテリー最適化をOFFに）
```
**注意：**
- TensorFlow（顔認識）が ARM Termux では動作しないことがある
- スマホのバッテリー最適化を必ずOFFにすること
- Wi-Fiが切れると Bot もオフラインになる

---

## ⚡ ファイル適用手順まとめ

```bash
# 1. 修正ファイルをコピー
cp utils/ai.js utils/ai.js.bak           # バックアップ
cp utils/weeklyManager.js utils/weeklyManager.js.bak

# 2. 修正版に差し替え（nuke2-fixedフォルダから）
cp nuke2-fixed/utils/ai.js utils/ai.js
cp nuke2-fixed/utils/weeklyManager.js utils/weeklyManager.js

# 3. .env を設定
cp .env.example .env && nano .env

# 4. config.json を新サーバー用に更新
nano config.json

# 5. スラッシュコマンド再登録
node commands/register.js

# 6. 起動
npm start
```
