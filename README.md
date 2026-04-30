# CC Pocket

CC Pocket is a mobile and desktop client for Codex and Claude coding-agent sessions.
Use it as a Codex mobile client when you want to control Codex from your phone:
run the agents on your own Mac or Linux machine, then start sessions, approve actions,
answer questions, and review diffs from iPhone, iPad, Android, or the native macOS app.

[日本語版 README](README.ja.md) | [简体中文版 README](README.zh-CN.md) | [한국어 README](README.ko.md)

<p align="center">
  <img src="docs/images/screenshots.png" alt="CC Pocket screenshots" width="800">
</p>

## Install

1. Install at least one agent CLI on the machine that will run your sessions:
   [Codex](https://github.com/openai/codex) or [Claude Code](https://docs.anthropic.com/en/docs/claude-code).
2. Install [Node.js](https://nodejs.org/) 18 or newer on that same machine.
3. Start the CC Pocket Bridge Server:

```bash
npx @ccpocket/bridge@latest
```

4. Install CC Pocket and scan the QR code printed by the Bridge Server.
5. Pick a project, choose Codex or Claude, and start coding from the app.

| Platform | Install |
|----------|---------|
| **iOS / iPadOS** | <a href="https://apps.apple.com/us/app/cc-pocket-code-anywhere/id6759188790"><img height="40" alt="Download on the App Store" src="docs/images/app-store-badge.svg" /></a> |
| **Android** | <a href="https://play.google.com/store/apps/details?id=com.k9i.ccpocket"><img height="40" alt="Get it on Google Play" src="docs/images/google-play-badge-en.svg" /></a> |
| **macOS** | Download the latest `.dmg` from [GitHub Releases](https://github.com/K9i-0/ccpocket/releases?q=macos). Look for releases tagged `macos/v*`. |

New to mobile coding agents? See [How to run Codex from iPhone or Android](https://k9i-0.github.io/ccpocket/how-to-run-codex-from-iphone-android/).

## What You Can Do

- **Control Codex from your phone**: start, resume, and monitor Codex or Claude sessions from phone, tablet, or Mac.
- **Stay in the approval loop**: approve commands, file edits, MCP requests, and agent questions without returning to your keyboard.
- **Review changes before they land**: inspect files, browse git diffs, preview image diffs, stage or revert files, and generate commit messages.
- **Write rich prompts on mobile**: use Markdown, completions, voice input, and image attachments.
- **Work in parallel safely**: run sessions in separate git worktrees and keep long-running work isolated.
- **Manage your machines**: save hosts, use QR codes or mDNS discovery, start/stop/update over SSH, and receive push notifications.
- **Use larger screens when helpful**: CC Pocket adapts to iPad and macOS with multi-pane layouts.

## How It Works

CC Pocket has two parts:

```text
CC Pocket app  <->  Bridge Server on your machine  <->  Codex / Claude
```

The app is the control surface. The Bridge Server runs locally on the machine that
has access to your projects, shell, git repository, and agent CLI. Your code stays
on your own machine instead of moving into a hosted IDE.

This is different from Claude Code Remote Control. Remote Control hands off a
terminal session that started on your Mac. CC Pocket starts sessions from the app
and uses your host machine as the background runner.

## Remote Access

On the same network, connect with the QR code, mDNS discovery, or a manual
`ws://` / `wss://` URL.

For access away from home or the office, Tailscale is the recommended setup:

1. Install [Tailscale](https://tailscale.com/) on your host machine and phone.
2. Join the same tailnet.
3. Connect to `ws://<host-tailscale-ip>:8765` from CC Pocket.

For an always-on host, the Bridge Server can also be registered as a background service:

```bash
npx @ccpocket/bridge@latest setup
```

Service setup supports macOS launchd and Linux systemd.

## Notes

- Claude sessions require `@ccpocket/bridge` `1.25.0` or newer and an `ANTHROPIC_API_KEY`.
  Claude subscription login via `/login` is not supported for new Bridge installs.
  See [Claude authentication troubleshooting](docs/auth-troubleshooting.md).
- CC Pocket is designed around self-hosting and minimal data collection. Supporter purchases
  restore within the same Apple ID or Google account, but do not sync across stores.
  See [Supporter / Purchases](docs/supporter.md).
- Screenshot capture on macOS requires Screen Recording permission for the terminal app
  running the Bridge Server.
- CC Pocket is not affiliated with, endorsed by, or associated with Anthropic or OpenAI.

## Development

```bash
git clone https://github.com/K9i-0/ccpocket.git
cd ccpocket
npm install
cd apps/mobile && flutter pub get && cd ../..
```

Common commands:

| Command | Description |
|---------|-------------|
| `npm run bridge` | Start Bridge Server in dev mode |
| `npm run bridge:build` | Build the Bridge Server |
| `npm run dev` | Restart Bridge and launch the Flutter app |
| `npm run test:bridge` | Run Bridge Server tests |
| `cd apps/mobile && flutter test` | Run Flutter tests |
| `cd apps/mobile && dart analyze` | Run Dart static analysis |

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## License

[FSL-1.1-MIT](LICENSE): Source available. Converts to MIT on 2028-03-17.

The repository includes a Bridge Redistribution Exception for `@ccpocket/bridge`.
Unofficial Bridge redistributions and environment-specific forks are allowed, as long as
they remain clearly unofficial and unsupported.
