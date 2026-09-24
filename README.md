# jpn-rap-nw

このリポジトリは「日本語ラップのフィーチャリング相関図」を作る Web アプリです。

公開済み（本番）
- フロント（Vercel）: https://vercel.com/nanastun/jpn-rap-nw
- バックエンド（Render）: https://jpn-rap-nw.onrender.com

主要機能
- Genius API からアーティスト／楽曲情報を集め、中心アーティストを軸にフィーチャリングネットワークを構築・可視化します。
- 何hop先の客演相手まで展開するか選択できます(1〜3、初期値2)。各ノードで共演曲数(次数)が多い上位3組(1曲のみの相手は除く)を対象に、指定したhop数まで再帰的に展開します。
- 表示ノード数の上限を選択できます（初期値50件）。コラボ数の多いアーティストを優先して表示します。
- サイドバーなど周囲のUIテキストは、暗い背景でも読みやすいようコントラスト比とサイズを調整しています。

## 目次
- 概要
- 技術スタック
- ローカルでの起動方法
- 環境変数
- フロントのデプロイ（Vercel）
- バックエンドのデプロイ（Render）
- CORS とセキュリティ注意点
- 長時間処理の扱い（キャンセル方法）
- モバイル対応
- トラブルシューティング
- 開発者向けメモ

## 概要
フロント（Vite/React）とバックエンド（Express）を分離した構成です。フロントは静的にホスティング、バックエンドは常駐 Node サービスとして動作します。

## 技術スタック
- フロント: React + TypeScript + Vite
- ビジュアライゼーション: D3
- バックエンド: Node.js + Express
- デプロイ: フロント→Vercel、バックエンド→Render

## ローカルでの起動方法
1. 依存をインストール

```bash
npm install
```

2. `.env` を作成（`.env.example` を参照）

3. フロントを起動

```bash
npm run dev
```

4. バックエンドを起動

```bash
npx tsx server.ts
```

ブラウザで `http://localhost:5173` にアクセスしてください。

## 環境変数
必須
- `GENIUS_ACCESS_TOKEN` — Genius の Client Access Token

運用/推奨
- `LOG_LEVEL` — `info`（省略可）
- `PORT` — Render 側で使用（例: `10000`）
- `CORS_ALLOWED_ORIGINS` — バックエンドが受け付けるオリジン（カンマ区切り）。例:

```
CORS_ALLOWED_ORIGINS=https://vercel.com/nanastun/jpn-rap-nw
```

- `CORS_ALLOW_VERCEL_PREVIEWS` — `true`にすると`*.vercel.app`のオリジンを一括許可します（プレビューデプロイ用。サブドメインがデプロイのたびに変わるため、`CORS_ALLOWED_ORIGINS`への都度追加が不要になります）。本番では`false`推奨（デフォルト）

- フロント環境変数（Vercel）: `VITE_API_BASE_URL=https://jpn-rap-nw.onrender.com`

`.env.example` にサンプルがあるので、それをコピーして値を設定してください。

## フロントのデプロイ（Vercel）
1. Vercel にリポジトリを接続
2. 環境変数に `VITE_API_BASE_URL` を追加（値: `https://jpn-rap-nw.onrender.com`）
3. デプロイ実行

注意: Vercel プレビューはサブドメインが頻繁に変わるため、プレビューからバックエンドにアクセスする場合は Render 側で `CORS_ALLOW_VERCEL_PREVIEWS=true` を設定してください。

## バックエンドのデプロイ（Render）
1. Render の Web Service を作成し、リポジトリを接続
2. Build コマンド: `npm install && npm run build`
3. Start コマンド: `npx tsx server.ts`
4. 環境変数を設定
   - `GENIUS_ACCESS_TOKEN`
   - `CORS_ALLOWED_ORIGINS=https://vercel.com/nanastun/jpn-rap-nw`
   - `CORS_ALLOW_VERCEL_PREVIEWS=true`（プレビューデプロイからアクセスする場合）
5. デプロイ/再起動

## CORS とセキュリティ注意点
- `CORS_ALLOWED_ORIGINS` はオリジン（スキーム + ドメイン）のみ指定します。ポートは不要です。
- 開発やプレビューでサブドメインが変わる場合は `CORS_ALLOW_VERCEL_PREVIEWS=true` を使ってください（セキュリティリスクを理解した上で、本番では既定の`false`のままにすることを推奨）。
- `GENIUS_ACCESS_TOKEN` は機密情報です。Render のシークレット機能を使って保存してください。

## 長時間処理の扱い（キャンセル方法）
- 人気アーティストのネットワーク構築は数十秒かかることがあります。hop数を2・3に増やすと、各hopで最大3組ずつ追加展開されるため(3hopでは最大1+3+9=13アーティスト分)、数分単位で時間が延びることがあります。フロントは `AbortController` による検索キャンセルを実装しています。
- サーバー側での更なる改善: ジョブ化（ワーカーキュー）やタイムアウト設定の導入を検討してください。

## モバイル対応
- モバイルでは検索バーを縦並びにし、ランキングをチップ状の横スクロールに変更しています。操作性向上のためタップ領域を確保しています。

## トラブルシューティング
- `CORS blocked for origin: ...` → Render の `CORS_ALLOWED_ORIGINS` にフロントのオリジンを追加
- `GENIUS_ACCESS_TOKEN` 未設定 → `.env` にトークンを追加してサーバー再起動
- ビルドエラー → ローカルで `npm run build` を実行して原因を確認

## 依存関係の更新
Renovate（`renovate.json`）により、依存パッケージの更新PRが週次で自動作成されます（実際に動かすにはGitHub Appとして[Renovate](https://github.com/apps/renovate)を本リポジトリにインストールしてください）。lockfile（`package-lock.json`）によりインストールされるバージョンは常に固定されているため、PRを確認してからマージする運用です。

## 開発者向けメモ
- 主要ファイル
  - `server.ts` — バックエンド API エントリポイント
  - `src/feat-network.tsx` — 可視化 UI と検索ロジック
  - `src/main.tsx`, `src/App.tsx` — アプリエントリ
- アプリアイコン
  - `public/favicon.svg` — 中心アーティストから客演相手へ広がる相関ネットワークを描いたアイコン（暗紫の地に紫 `#a78bfa` × シアン `#22d3ee`）。Vite のデフォルトから差し替え済み
  - `public/favicon.ico` と `public/favicon-32.png` — **Safari は `rel="icon"` の SVG を使わない**ため、SVG だけ置くと Safari のタブが空になる。ico と PNG を併せて置き、`index.html` で ico → PNG → SVG の順に宣言している
  - 上記以外はすべて `favicon.svg` から書き出している。図形を変えるときは SVG 側だけを直し、以下で残りを作り直す

    ```sh
    rsvg-convert -w 180 -h 180 public/favicon.svg -o public/apple-touch-icon.png
    rsvg-convert -w  32 -h  32 public/favicon.svg -o public/favicon-32.png
    rsvg-convert -w 192 -h 192 public/favicon.svg -o public/icon-192.png
    rsvg-convert -w 512 -h 512 public/favicon.svg -o public/icon-512.png
    node scripts/make-favicon-ico.mjs public/favicon.svg public/favicon.ico
    ```

  - [`scripts/make-favicon-ico.mjs`](./scripts/make-favicon-ico.mjs) — ico の生成スクリプト。ico の中身は BMP ではなく PNG をそのまま詰めており、その PNG は RGBA にしてある（`rsvg-convert` は全ピクセルが不透明だと RGB で書き出すが、RGB の PNG を入れた ico を受け付けないデコーダーがあるため）

  - `public/manifest.webmanifest` — ホーム画面に追加したときの名称とアイコン。`index.html` から `link` タグで参照している
  - `index.html` の `link` タグには `?v=2` を付けている。ファビコンはブラウザが通常のHTTPキャッシュ制御とは別の仕組みで保持しており、`Cache-Control: must-revalidate` を返してもリロードでは差し替わらない。URLが変わらないと古い絵柄が出続けるため、**絵柄を変えたらこの番号も上げること**

## 改善案 / TODO
- 長時間処理のワーカー化とジョブ管理

---

必要ならこの README をコミットしておきます。どのレベルまで詳細を入れるか指示ください（簡潔/詳細）。
