# CC Pocket

CC Pocket は、Codex / Claude のコーディングエージェントセッションを扱う
モバイル・デスクトップクライアントです。エージェントは自分の Mac / Linux
マシンで実行し、iPhone、iPad、Android、macOS ネイティブアプリから
セッション開始、承認、質問への回答、差分レビューを行えます。

[English README](README.md) | [简体中文版 README](README.zh-CN.md)

<p align="center">
  <img src="docs/images/screenshots-ja.png" alt="CC Pocket screenshots" width="800">
</p>

## インストール

1. セッションを実行するマシンに、少なくとも1つのエージェント CLI を入れます:
   [Codex](https://github.com/openai/codex) または [Claude Code](https://docs.anthropic.com/en/docs/claude-code)。
2. 同じマシンに [Node.js](https://nodejs.org/) 18 以上を入れます。
3. CC Pocket Bridge Server を起動します。

```bash
npx @ccpocket/bridge@latest
```

4. CC Pocket をインストールし、Bridge Server が表示する QR コードをスキャンします。
5. プロジェクトを選び、Codex / Claude を選択して、アプリからセッションを開始します。

| プラットフォーム | インストール |
|------------------|--------------|
| **iOS / iPadOS** | <a href="https://apps.apple.com/jp/app/cc-pocket-%E3%81%A9%E3%81%93%E3%81%A7%E3%82%82%E3%82%B3%E3%83%BC%E3%83%87%E3%82%A3%E3%83%B3%E3%82%B0/id6759188790"><img height="40" alt="App Storeからダウンロード" src="docs/images/app-store-badge.svg" /></a> |
| **Android** | <a href="https://play.google.com/store/apps/details?id=com.k9i.ccpocket"><img height="40" alt="Google Play で手に入れよう" src="docs/images/google-play-badge-ja.svg" /></a> |
| **macOS** | 最新の `.dmg` は [GitHub Releases](https://github.com/K9i-0/ccpocket/releases?q=macos) からダウンロードできます。`macos/v*` タグのリリースを探してください。 |

## できること

- **どこからでもエージェントセッションを実行**: スマホ、タブレット、Mac から Codex / Claude セッションを開始・再開・監視できます。
- **承認待ちにすぐ対応**: コマンド、ファイル編集、MCP リクエスト、エージェントの質問にキーボードなしで応答できます。
- **変更をレビューしてから反映**: ファイル確認、git diff、画像 diff、stage / revert、コミットメッセージ生成に対応しています。
- **モバイルでもリッチにプロンプト作成**: Markdown、補完、音声入力、画像添付を使えます。
- **並列作業を安全に分離**: git worktree でセッションごとの作業ディレクトリを分けられます。
- **マシンを管理**: 保存済みホスト、QR、mDNS、SSH start/stop/update、プッシュ通知に対応しています。
- **大きな画面でも使いやすく**: iPad / macOS ではマルチペインレイアウトに適応します。

## 仕組み

CC Pocket は2つの部分で動きます。

```text
CC Pocket app  <->  自分のマシン上の Bridge Server  <->  Codex / Claude
```

アプリは操作画面です。Bridge Server は、プロジェクト、シェル、git リポジトリ、
エージェント CLI にアクセスできる自分のマシン上で動きます。コードはホスト型 IDE
へ移さず、自分のマシンに置いたまま使えます。

Claude Code の Remote Control は、Mac で開始したターミナルセッションをスマホへ
引き継ぐ機能です。CC Pocket はアプリからセッションを開始し、ホストマシンを
バックグラウンドの実行環境として使います。

## リモートアクセス

同じネットワーク内では、QR コード、mDNS 自動発見、または手入力の
`ws://` / `wss://` URL で接続できます。

自宅やオフィスの外から使う場合は、Tailscale がおすすめです。

1. ホストマシンとスマホに [Tailscale](https://tailscale.com/) を入れる
2. 同じ tailnet に参加する
3. CC Pocket から `ws://<host-tailscale-ip>:8765` に接続する

常時起動するホストでは、Bridge Server をバックグラウンドサービスとして登録できます。

```bash
npx @ccpocket/bridge@latest setup
```

サービス化は macOS launchd と Linux systemd に対応しています。

## 補足

- Claude セッションには `@ccpocket/bridge` `1.25.0` 以上と `ANTHROPIC_API_KEY` が必要です。
  新規 Bridge インストールでは、Claude subscription login の `/login` はサポートしていません。
  詳細は [Claude 認証トラブルシューティング](docs/auth-troubleshooting.ja.md) を参照してください。
- CC Pocket はセルフホストと最小限のデータ収集を前提にしています。Supporter 購入は
  同じ Apple ID / Google アカウント内で復元できますが、ストア間では共有されません。
  詳細は [Supporter / Purchases](docs/supporter_ja.md) を参照してください。
- macOS のスクリーンショット取得には、Bridge Server を実行するターミナルアプリへの
  画面収録権限が必要です。
- CC Pocket は Anthropic / OpenAI と提携、後援、または公式連携しているものではありません。

## 開発

```bash
git clone https://github.com/K9i-0/ccpocket.git
cd ccpocket
npm install
cd apps/mobile && flutter pub get && cd ../..
```

よく使うコマンド:

| コマンド | 説明 |
|----------|------|
| `npm run bridge` | Bridge Server を開発モードで起動 |
| `npm run bridge:build` | Bridge Server をビルド |
| `npm run dev` | Bridge を再起動して Flutter アプリを起動 |
| `npm run test:bridge` | Bridge Server のテストを実行 |
| `cd apps/mobile && flutter test` | Flutter テストを実行 |
| `cd apps/mobile && dart analyze` | Dart 静的解析を実行 |

貢献方法は [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## ライセンス

[FSL-1.1-MIT](LICENSE): Source available。2028-03-17 に MIT へ移行します。

このリポジトリには `@ccpocket/bridge` 向けの Bridge Redistribution Exception が含まれます。
非公式でありサポート対象外であることを明示する限り、環境固有の fork や再配布が許可されています。
