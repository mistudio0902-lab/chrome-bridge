# Chrome Bridge v3 — マルチプロファイル対応 再設計 (作業指示書)

作成: 2026-07-09 / 起案: Fable(司令塔)/ 実装: Codex CLI

## 解決する問題

現行 v3 は次の2点が壊れている:

1. **接続先が「最後にアクティブだったプロファイル」に固定される。** コマンドは明示 `profile` が無いとグローバル変数 `activeProfile` にルーティングされる。`activeProfile` は最後に接続/再接続したプロファイルで上書きされるため、意図しない Chrome を叩く。
2. **複数セッションからバラバラのプロファイルに同時接続できない。** 各 Claude/Codex セッションが `server.js` を MCP サーバとして起動し、それぞれが WS:9239 / HTTP:9240 を bind しようとする。ポートは1プロセスしか持てないため、`CHROME_BRIDGE_TAKEOVER=1` だと後発が先発を kill、未設定だと後発が起動を待ち続ける。さらに v3 の MCP コマンド経路は自プロセスの `profiles` マップだけを見て HTTP フォールバックが無いため、ポートを握っていないセッションは `profiles` が空 → 全ツールが「no profile connected」で失敗する。結果、実際に機能するのは WS ポートを握った1セッションのみで、そのセッションの `activeProfile` 依存になる。

## 現状の実測(2026-07-09)

- 本番ハブ: PM2 `chrome-bridge-v3` が `server.js` を `CHROME_BRIDGE_HTTP_ONLY=1` + `CHROME_BRIDGE_TAKEOVER=1` で常駐。HTTP_ONLY 時は WS:9239 + HTTP:9240 を bind して MCP stdio へは繋がず、全プロファイルの WS 接続を保持する「ハブ」として機能している。
- 拡張機能: `20_tools/chrome-bridge-v2/extension`(v3 に extension は無く v2 を流用)。offscreen が `ws://127.0.0.1:9239` へ接続し `hello {profileId, email, alias, profileName}` を送る。ハブ側の profile key = `alias || email || profileId`。
- 各セッションの MCP サーバも同じ `server.js` を stdio 起動している(`40_logs/chrome-bridge/mcp-debug.log` に多数の spawn 記録)。

## 目標アーキテクチャ: Hub + Thin Client(半分できている構成を正式化)

**方針: プロセスの役割を「ハブ(ポート所有・全接続保持)」と「セッションごとの薄いMCPクライアント(ポート非所有・HTTPでハブに委譲)」に分離する。** これにより:

- 接続先はセッション内でだけ有効な `targetProfile` で決まる → 「指定した接続先を認識して接続」。
- 各セッションのクライアントは別プロセスで自分の `targetProfile` を持つ → セッションAはプロファイルalpha、セッションBはプロファイルbeta、を同時・独立に扱える。ハブはステートレスにルーティングするだけ。

### 1. `hub.js`(新規) — 唯一のポート所有者
現行 `server.js` の WS+HTTP 部分を抽出・整理。

- ポートを env で可変化: `CHROME_BRIDGE_WS_PORT`(既定 9239)/ `CHROME_BRIDGE_HTTP_PORT`(既定 9240)。**テストを本番ポートと衝突させないために必須。**
- 保持: WS 接続処理 / `profiles` マップ / 30s ping + grace period / `GET /health` / `POST /`(コマンドルーティング)/ HTTP アクション `list_profiles`・`chrome_bridge_health`。
- **変更: コマンドルーティングは明示 `profile` 必須。** `activeProfile` を暗黙のフォールバック先にしない。`profile` 欠落/不明のコマンドは 400 で「接続中プロファイル一覧」を返す。`list_profiles`・`health` は profile 不要。
- `set_active_profile` はハブから廃止(active はクライアントの関心事)。`list_profiles` の `active` フラグは廃止するか常に false。
- MCP/stdio コードはハブに持たせない。ハブは起動してブロックするだけ(現行 HTTP_ONLY 経路がそのまま常時動作になるイメージ)。
- 自身の起動時 TAKEOVER(`CHROME_BRIDGE_TAKEOVER=1` でポート占有プロセスを kill)は維持してよい(ハブは PM2 管理の単一インスタンス想定)。

### 2. `server.js`(全面書き換え → 薄い MCP クライアント / ファイル名は維持)
**ファイル名を維持する理由: 現行の MCP 登録(server.js を stdio 起動)を壊さないため。** 中身をポート非所有の HTTP クライアントにする。

- ポート bind を一切しない。
- env: `CHROME_BRIDGE_HTTP_PORT`(既定 9240)/ `CHROME_BRIDGE_HUB_HOST`(既定 127.0.0.1)/ `CHROME_BRIDGE_PROFILE`(このセッションの初期 `targetProfile`)。
- セッションローカルな `targetProfile` をメモリに保持。初期値は `CHROME_BRIDGE_PROFILE`。
- TOOLS 一覧は現行と同一(ツール名・スキーマ互換)。
- `resolveProfile`: 明示 `profile` 引数 → なければ `targetProfile` → コマンド系ツールでどちらも無ければ「接続中プロファイル一覧付き」でエラー。`list_profiles`・`chrome_bridge_health` は profile 不要。**"last active" グローバルフォールバックは廃止。**
- `set_active_profile`: **セッションローカルの `targetProfile` だけを更新**(ハブには触れない)。可能ならハブの `/health`・`list_profiles` で存在検証し、未接続なら警告付きで受理。戻り値に `targetProfile` を含める。
- 全コマンド系ツール → ハブへ `POST /` `{action, profile, ...args}`。`screenshot` は従来どおり image content で返す。
- `list_profiles` → ハブへ問い合わせ、結果にこのセッションの `targetProfile` を併記。
- ハブ未到達時: 「ハブ未起動(PM2 chrome-bridge-v3 を確認)」の明確なエラー。**ツール一覧の登録自体はハブが落ちていても成功すること**(呼び出しだけ失敗)。
- stdin close/end で終了する現行挙動は維持。

### 3. `call.mjs`(更新) — ハブへの薄い HTTP クライアント
- **自前で server.js を spawn するのをやめ、ハブへ直接 HTTP POST する。** これで Codex のワンショット呼び出しがポート争奪を起こさない。
- CLI 互換維持: `node call.mjs <tool> [json | key=value ...]`。加えて `profile=` 引数 / `CHROME_BRIDGE_PROFILE` env を尊重。
- env でハブのホスト/ポートを解決(server.js と同じ)。

### 4. `test/multiprofile.test.mjs`(新規) — 本番ポート非依存の検証
- `hub.js` を **代替ポート**(例 WS:9339 / HTTP:9340)で起動。
- 偽の拡張 WS クライアントを2つ接続し、それぞれ `hello {alias:'alphaTEST'}` / `{alias:'betaTEST'}` を送る。
- `server.js`(薄いクライアント)を2プロセス、各々 `CHROME_BRIDGE_PROFILE` を別々 + 代替 HTTP ポート env で起動し、JSON-RPC(call.mjs と同じ手順)で駆動:
  - 各クライアントで `ping` → 返る `profileId` が自分の target と一致することを assert。
  - `list_profiles` に両プロファイルが見えることを assert。
  - 一方で `set_active_profile` を変えても他方に影響しないことを assert(セッション独立性)。
- PASS/FAIL を明示出力。**本番 9239/9240 には触れない。**

### 5. `README.md`(v3 に新規 or 更新)
Hub + Thin Client モデル、env 変数、複数セッションの使い方(セッションごとに `set_active_profile` か `CHROME_BRIDGE_PROFILE`、または呼び出しごとに `profile=`)を簡潔に記載。

## スコープ外(やらないこと)

- 拡張機能(v2/extension)の変更は不要(hello に email+alias を既に送っている)。触らない。
- ツール名・スキーマの変更はしない(後方互換)。
- 本番 PM2 デーモンの再起動・MCP 登録の変更・本番ポートでの起動は **この作業ではやらない**(承認ゲート、下記)。

## 本番反映(承認ゲート / 実装とは分離)

コード完成・代替ポート検証 PASS の後、ユーザー承認を得てから:
1. PM2 `chrome-bridge-v3` を `hub.js` 起動に切り替え(`server.js` HTTP_ONLY からの移行)。exec path 変更のため要 `pm2 delete` + 再登録 or ecosystem 更新。
2. MCP 登録(server.js を spawn している箇所)はファイル名維持のため原則変更不要。必要なら `CHROME_BRIDGE_PROFILE` を渡す名前付きサーバを追加。
3. 拡張のリロードは不要(WS 再接続は自動)。

## 完了条件

- `hub.js` / 書き換え後 `server.js` / 更新後 `call.mjs` / テストが揃っている。
- `node test/multiprofile.test.mjs` が代替ポートで PASS。
- 本番ポート(9239/9240)と PM2 デーモンには一切触れていない。

---

# 追加機能: 未起動プロファイルの起動 (launch_profile) — 2026-07-09

## 背景 / 制約

- ブリッジは「拡張が起動して WS 接続してきたプロファイル」しか `profiles` に持てない。Chrome が閉じている profile は対象にできない。
- 目標: 指定 profile が未接続なら、その Chrome プロファイルを起動して接続させる。
- **対応付け:** ブリッジは profile を email/alias でしか知らない。OS 側の起動には Chrome プロファイル**ディレクトリ**(`Default` / `Profile 10` 等)が要る。Chrome の `Local State` の `profile.info_cache` が `dir → {user_name(email), name, gaia_name}` を持つので、これで email → ディレクトリを解決する。
- **前提:** 起動しても、そのプロファイルに拡張(`chrome-bridge-v2/extension`)が読み込まれていなければ接続してこない。実測(2026-07-09)では Profile 18 以外の全プロファイルに導入済み。未導入時は「起動はしたが接続せず」を明確に返す。

## hub.js に追加

- 設定 env: `CHROME_BRIDGE_CHROME_EXE`(既定は `C:\Program Files\Google\Chrome\Application\chrome.exe` を検出)/ `CHROME_BRIDGE_USER_DATA_DIR`(既定 `%LOCALAPPDATA%\Google\Chrome\User Data`)。
- `Local State` の `info_cache` を読む helper。target(email/alias/name/dir、大小無視・email 完全一致優先)→ ディレクトリ解決。
- HTTP アクション `launch_profile` `{profile, url?, timeoutMs?}`:
  1. 既に接続済みなら `{success:true, alreadyRunning:true, profileId}` を即返す。
  2. info_cache で解決。見つからなければ起動可能プロファイル一覧付きでエラー。
  3. `chrome.exe --profile-directory="<dir>" [url]` を detached + unref で spawn。
  4. `timeoutMs`(既定 20000)まで profiles を polling し、`hello.email === info_cache.user_name`(または profileId 一致)のエントリ出現を待つ。
  5. 接続すれば `{success:true, launched:true, profileId}`。時間内に来なければ `{success:false, launched:true, error:"起動したが拡張が時間内に接続しなかった。該当プロファイルに拡張が読み込まれているか確認"}`。
- HTTP アクション `list_launchable_profiles`: info_cache 由来の `{dir, email, name, connected}` 一覧(connected は現在 profiles にいるか)。profile 不要。

## server.js(薄いクライアント)に追加

- MCP ツール `launch_profile`(input: `profile`(必須), `url?`, `timeoutMs?`)→ ハブへ委譲。成功時はこのセッションの `targetProfile` を接続した profileId に更新。
- MCP ツール `list_launchable_profiles` → ハブへ委譲。
- `call.mjs` は汎用パススルーで自動対応(`node call.mjs launch_profile profile=...`)。

## テスト

- `CHROME_BRIDGE_CHROME_EXE` を「起動されると指定 email で WS hello を送る偽 exe(node スクリプト)」に差し替え、`launch_profile` が spawn→接続待ち→成功 を返す経路を代替ポートで検証。実 Chrome には依存しない。
- 既接続時の no-op、未解決 profile のエラーも assert。

## スコープ外

- コマンド系ツールの「未接続なら自動起動」は今回やらない(明示 `launch_profile` のみ)。
- 拡張未導入プロファイルへの自動インストールはしない(手動で1回読み込む前提)。
