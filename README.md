# Chrome Bridge

**AIエージェントから、ログイン済みのChromeをそのまま操作する。**

Claude Code / Codex / その他のMCP対応クライアントから、あなたが普段使っているChromeプロファイル（ログイン済みのセッション、Cookie、拡張機能つき）を直接動かすためのローカルブリッジです。

ヘッドレスブラウザではありません。**いま開いているChromeそのもの**を操作します。だからログインし直す必要がなく、2段階認証も、Cookieのコピーも要りません。

```
Claude Code ──stdio──▶ server.js ──HTTP──▶ hub.js ──WebSocket──▶ Chrome拡張 ──▶ あなたのChrome
  (MCPクライアント)      (薄いクライアント)     (常駐ハブ)                          (ログイン済み)
```

## 何ができるか

38個のMCPツールを提供します。

| 分類 | ツール |
|---|---|
| プロファイル | `list_profiles` `list_launchable_profiles` `launch_profile` `set_active_profile` |
| タブ | `tabs_list` `tabs_create` `tabs_close` `tabs_select` `tab_context` |
| 移動 | `navigate` `back` `forward` `reload` `wait_for` |
| 読み取り | `read_page` `get_page_text` `snapshot` `find` `screenshot` `read_console_messages` `read_network_requests` |
| 操作 | `click` `click_by_text` `hover` `type_text` `fill` `set_select` `press_key` `scroll` `upload_file` |
| 低レベル | `real_click` `real_type` `evaluate` `evaluate_debugger` `cdp` `ensure_visible` `detach_debugger` |
| その他 | `resize_window` `gif_start` `ping` |

### `real_click` / `real_type` と `evaluate_debugger` がある理由

JavaScriptの `element.click()` が効かないサイトがあります。ReactやWixで作られたフォームは、信頼できるマウスイベント（`isTrusted: true`）しか受け付けないことがあるためです。`real_click` はChrome DevTools Protocol経由で実際の入力イベントを送るので、こうしたページでも動きます。

同様に、Trusted Typesを有効にしたサイト（Googleフォームなど）では `evaluate` がブロックされます。`evaluate_debugger` はDebuggerドメイン経由で評価するので、そこを通り抜けられます。

これらは実際に壁にぶつかって足したものです。

## 複数プロファイルの同時利用

このブリッジの中心的な設計です。仕事用と個人用、あるいは複数の顧客アカウントを、**セッションごとに独立して**扱えます。

- ハブ（`hub.js`）は1本だけ常駐し、接続してきた拡張機能をプロファイル単位でルーティングします
- MCPクライアント（`server.js`）はセッションごとに別プロセスで起動し、それぞれ自分の `targetProfile` を持ちます
- あるセッションで `set_active_profile` を呼んでも、他のセッションには影響しません

Claude Codeを2つ立ち上げて、片方は仕事アカウント、もう片方は個人アカウントを操作する、といった使い方ができます。

## 必要なもの

- Node.js 18以上
- Google Chrome（Windows。他OSは未検証です）

## セットアップ

### 1. 依存関係

```bash
npm install
```

### 2. Chrome拡張機能を読み込む

1. Chromeで `chrome://extensions` を開く
2. 右上の「デベロッパーモード」をON
3. 「パッケージ化されていない拡張機能を読み込む」で `extension/` フォルダを選択
4. 拡張機能のポップアップを開き、`alias`（例: `work`, `personal`）を設定

複数のプロファイルで使う場合は、各プロファイルで同じ手順を繰り返し、それぞれ違う `alias` を付けてください。

### 3. ハブを起動

```bash
node hub.js
```

1台のマシンにつき1本だけ動かします。拡張機能がWebSocketで接続してきます。

### 4. MCPクライアントを繋ぐ

Claude Codeの場合、`.mcp.json` に追加します。

```json
{
  "mcpServers": {
    "chrome-bridge": {
      "command": "node",
      "args": ["/path/to/chrome-bridge/server.js"],
      "env": { "CHROME_BRIDGE_PROFILE": "work" }
    }
  }
}
```

## CLIから使う

MCPを介さず直接叩くこともできます。デバッグや、シェルスクリプトからの利用に便利です。

```bash
node call.mjs list_profiles
node call.mjs ping profile=work
node call.mjs tabs_list profile=personal
node call.mjs navigate profile=work url=https://example.com
node call.mjs chrome_bridge_health
```

**注意**: JSON引数と `key=value` 形式を1つのコマンドで混ぜないでください。引数が失われます。どちらかに統一します。

## 停止中のプロファイルを起動する

Chromeの `Local State` には存在するが、まだ起動していないプロファイルを立ち上げられます。

```bash
node call.mjs launch_profile profile=you@example.com
node call.mjs launch_profile profile="Profile 10" url=https://example.com
```

ハブは `profile.info_cache` からメールアドレス、プロファイル名、Gaia名、ディレクトリ名の順に解決します。Chromeは起動したが拡張機能が `timeoutMs`（既定20秒）以内に接続しない場合、HTTPは200を返しますが `success:false` になります。そのプロファイルで拡張機能を入れて再試行してください。

## 環境変数

**ハブ側**

| 変数 | 既定値 | 説明 |
|---|---|---|
| `CHROME_BRIDGE_WS_PORT` | `9239` | 拡張機能用WebSocketポート |
| `CHROME_BRIDGE_HTTP_PORT` | `9240` | クライアント用HTTPポート |
| `CHROME_BRIDGE_TAKEOVER` | — | `1` でbind前に既存のポート保持プロセスを掃除 |
| `CHROME_BRIDGE_CHROME_EXE` | 自動検出 | `launch_profile` が使うChrome実行ファイル |
| `CHROME_BRIDGE_USER_DATA_DIR` | `%LOCALAPPDATA%\Google\Chrome\User Data` | `Local State` の読み取り先 |

**クライアント / CLI側**

| 変数 | 既定値 | 説明 |
|---|---|---|
| `CHROME_BRIDGE_HUB_HOST` | `127.0.0.1` | ハブのホスト |
| `CHROME_BRIDGE_HTTP_PORT` | `9240` | ハブのHTTPポート |
| `CHROME_BRIDGE_PROFILE` | — | セッション初期の対象プロファイル |

## つまずきやすいところ

実運用で踏んだものです。

**画面が描画されない / クリックが効かない**
ウィンドウが非表示・非最前面だと、Chromeがレンダリングを止めることがあります。スクリーンショットが真っ白になったり、クリック座標がずれたりします。CDPで `Emulation.setFocusEmulationEnabled` を有効にすると解決します。

```bash
node call.mjs cdp profile=work method=Emulation.setFocusEmulationEnabled params='{"enabled":true}'
```

**`evaluate` が `Uncaught` で失敗する**
Trusted Typesを使っているサイトです。`evaluate_debugger` に切り替えてください。また、`evaluate_debugger` に渡すスクリプトは**改行を含まない1行**にしてください。複数行のスクリプトは失敗します。

**タブが応答しなくなる**
`evaluate_debugger` が20秒でタイムアウトするようになったら、そのタブは死んでいます。`tabs_select` では復旧しません。新しいタブを作り直してください。

**`.click()` が無反応**
`real_click` を使ってください。セレクタを指定できます。チェックボックスの場合、`input` 要素ではなく親の `<label>` や `<div>` をクリックしないと入らないことがあります。

## テスト

代替ポートを使うので、稼働中のハブ（9239/9240）には触れません。

```bash
node test/multiprofile.test.mjs
node test/launch-profile.test.mjs
```

## 責任について

この道具は、あなたのログイン済みブラウザセッションに対する完全な操作権限をAIエージェントに渡します。認証済みのアカウントで、購入・送信・削除といった取り消せない操作が実行できてしまうということです。

- **信頼できるエージェントとプロンプトでのみ使ってください。** Webページの内容を読ませる場合、そのページに書かれた文字列は指示ではなくデータとして扱う設計にしてください
- **取り消せない操作の前には人間の確認を挟んでください。** 送信・購入・削除・公開は特にそうです
- ハブは `127.0.0.1` だけをlistenします。ネットワークに公開しないでください
- 各サービスの利用規約を確認してください。ブラウザ自動化を禁止しているサイトがあります

作者はこの道具の使用結果について責任を負いません。

## ライセンス

MIT

## 由来

25個の個人プロジェクトを1人で運用する中で、AIエージェントに「ログイン済みのブラウザ」を触らせる必要があって作りました。ヘッドレスブラウザでは、2段階認証とCookieの持ち回りで毎回止まるためです。実際に使いながら、動かなかったところを1つずつ潰しています。
