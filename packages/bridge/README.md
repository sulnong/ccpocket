# @ccpocket/bridge

Bridge server that connects Claude sessions powered by the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) and [Codex CLI](https://github.com/openai/codex) to mobile devices via WebSocket.

This is the server component of [ccpocket](https://github.com/K9i-0/ccpocket) — a mobile client for Claude and Codex.

## Quick Start

```bash
npx @ccpocket/bridge@latest
```

A QR code will appear in your terminal. Scan it with the ccpocket mobile app to connect.

> Warning
> Versions older than `1.25.0` are deprecated and should not be used for new installs because current Anthropic Claude Agent SDK docs do not permit third-party products to use Claude subscription login.
> Upgrade to `>=1.25.0` and use `ANTHROPIC_API_KEY` instead of OAuth.

## Installation

```bash
# Run directly (no install needed)
npx @ccpocket/bridge@latest

# Or install globally
npm install -g @ccpocket/bridge
ccpocket-bridge

# Show CLI help or version
ccpocket-bridge --help
ccpocket-bridge --version
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `BRIDGE_PORT` | `8765` | WebSocket port |
| `BRIDGE_HOST` | `0.0.0.0` | Bind address |
| `BRIDGE_API_KEY` | (none) | API key authentication (enabled when set) |
| `BRIDGE_ALLOWED_DIRS` | `$HOME` | Comma-separated list of project directories the Bridge may access |
| `BRIDGE_PUBLIC_WS_URL` | (none) | Public `ws://` / `wss://` URL used for startup deep link and QR code |
| `BRIDGE_RELAY_URL` | (none) | Public `ws://` / `wss://` base URL of a relay |
| `BRIDGE_RELAY_TOKEN` | (none) | Optional admin token used only when the relay requires trusted self-hosted registration |
| `BRIDGE_RELAY_ROOM_ID` | random | Optional stable relay room id |
| `BRIDGE_RELAY_ROOM_SECRET` | random | Optional stable relay room secret used by the app connection |
| `BRIDGE_CODEX_APP_SERVER_MODE` | `private` | Experimental Codex app-server mode: `private`, `managed`, or `external` |
| `BRIDGE_CODEX_SHARED_APP_SERVER_URL` | `ws://127.0.0.1:8767` in `managed` mode | Experimental shared Codex app-server URL for Codex CLI co-presence |
| `BRIDGE_DEMO_MODE` | (none) | Demo mode: hide Tailscale IPs and API key from QR code / logs |
| `BRIDGE_RECORDING` | (none) | Enable session recording for debugging (enabled when set) |
| `BRIDGE_DISABLE_MDNS` | (none) | Disable mDNS auto-discovery advertisement (enabled when set) |
| `BRIDGE_PROMPT_HISTORY_FILE` | `$HOME/.ccpocket/prompt-history-v2.json` | Custom prompt history store path |
| `BRIDGE_RECENT_SESSIONS_PROFILE` | (none) | Log recent-session index timing when set to `1` or `true` |
| `DIFF_IMAGE_AUTO_DISPLAY_KB` | `1024` (1 MB) | Auto-display diff images up to this size, in KB |
| `DIFF_IMAGE_MAX_SIZE_MB` | `5` (5 MB) | Maximum diff image size available for on-demand loading, in MB |
| `ANTHROPIC_API_KEY` | (none) | Claude Agent SDK API key used for Claude sessions |
| `ANTHROPIC_AUTH_TOKEN` | (none) | Advanced Claude SDK auth token; prefer `ANTHROPIC_API_KEY` |
| `OPENAI_API_KEY` | (none) | Codex API key; Codex can also use `~/.codex/auth.json` |
| `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` | (none) | Proxy for outgoing fetch requests (`http://`, `https://`, `socks4://`, `socks5://`) |

Lowercase proxy variables (`https_proxy`, `http_proxy`, `all_proxy`) are also
supported. When `BRIDGE_PROMPT_HISTORY_FILE` is not set and `BRIDGE_PORT` is not
`8765`, prompt history is stored in
`$HOME/.ccpocket/prompt-history-v2-<port>.json`.

Push relay uses Firebase Anonymous Auth automatically; no FCM environment
variables are required.

```bash
# Example: custom port with API key
BRIDGE_PORT=9000 BRIDGE_API_KEY=my-secret npx @ccpocket/bridge@latest

# Example: expose Bridge through a reverse proxy / ngrok
BRIDGE_PUBLIC_WS_URL=wss://example.ngrok-free.app npx @ccpocket/bridge@latest

# Example: same setting via CLI flag
ccpocket-bridge --public-ws-url wss://example.ngrok-free.app

# Example: disable mDNS advertisement
BRIDGE_DISABLE_MDNS=1 npx @ccpocket/bridge@latest
# or via CLI flag
ccpocket-bridge --no-mdns
```

When `BRIDGE_PUBLIC_WS_URL` is set, the startup deep link and terminal QR code
use that public URL instead of the LAN address. This is useful when the Bridge
is reachable through a reverse proxy, tunnel, or public domain.

Without it, the printed QR code is LAN-oriented by default and typically encodes
something like `ws://192.168.x.x:8765`.

## Self-Hosted Relay

Relay mode lets the phone connect through a public WebSocket relay while the
Bridge still runs on your own computer. This is useful when the phone and
computer are not on the same reachable network and you do not want to set up
Tailscale.

For an official-style open relay, users only need the relay URL:

```bash
BRIDGE_RELAY_URL=wss://relay.example.com \
npx @ccpocket/bridge@latest
```

Or with CLI flags:

```bash
ccpocket-bridge --relay-url wss://relay.example.com
```

When registration succeeds, the Bridge prints a relay deep link and QR code.
The app connects to a path like `wss://relay.example.com/r/<roomId>` with the
room secret in the existing `token` query parameter. Users do not need to handle
relay admin tokens in this mode.

For a trusted self-hosted relay, run the relay server on a public host with an
admin token:

```bash
RELAY_ADMIN_TOKEN=change-me \
RELAY_PUBLIC_URL=wss://relay.example.com \
npm run relay
```

Then run the Bridge on your computer with the matching token:

```bash
BRIDGE_RELAY_URL=wss://relay.example.com \
BRIDGE_RELAY_TOKEN=change-me \
npx @ccpocket/bridge@latest
```

Or with CLI flags:

```bash
ccpocket-bridge \
  --relay-url wss://relay.example.com \
  --relay-token change-me
```

Existing direct LAN, Tailscale, mDNS, and `BRIDGE_PUBLIC_WS_URL` flows continue
to work unchanged.

### Loading a Bridge env file

The Bridge reads normal process environment variables. It does not parse `.env`
files by itself, so load the file with your shell, service manager, or
container runtime.

```bash
cp packages/bridge/.env.example ~/.ccpocket/bridge.env
```

Shell:

```bash
set -a
. ~/.ccpocket/bridge.env
set +a
npx @ccpocket/bridge@latest
```

Installed package:

```bash
set -a
. ~/.ccpocket/bridge.env
set +a
ccpocket-bridge
```

Security model: relay v1 is a trusted relay. It forwards WebSocket frames and
can see plaintext ccpocket protocol traffic. Run it only on infrastructure you
trust, use `wss://` in production, and treat `RELAY_ADMIN_TOKEN` plus the room
secret as credentials when trusted self-hosted registration is enabled. This is
not end-to-end encrypted.

## Experimental: Join a CC Pocket Codex Session from Codex CLI

By default, each Codex session uses a private app-server. To let Codex CLI join
the same live thread that CC Pocket started, run the Bridge with shared
app-server mode:

```bash
BRIDGE_CODEX_APP_SERVER_MODE=managed \
BRIDGE_CODEX_SHARED_APP_SERVER_URL=ws://127.0.0.1:8767 \
npx @ccpocket/bridge@latest
```

Then start or resume a Codex session from CC Pocket. When the session is ready,
the session screen can copy a session-specific command like:

```bash
codex resume <thread-id> --remote ws://127.0.0.1:8767
```

Run that command in a terminal on the same machine as the Bridge. The
`127.0.0.1` address is for the Mac/Linux machine running the Bridge and Codex
CLI, not for the phone.

Modes:

- `private`: default behavior. No Codex CLI co-presence.
- `managed`: Bridge starts one local WebSocket Codex app-server and shares it
  with Codex CLI.
- `external`: Bridge connects to an already-running app-server. In this mode,
  `BRIDGE_CODEX_SHARED_APP_SERVER_URL` is required.

This is experimental and currently targets Codex CLI co-presence only. Codex App
compatibility is not guaranteed and may use a different integration model in the
future.

## Requirements

- Node.js v18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) and/or [Codex CLI](https://github.com/openai/codex)

## Health Check

Run the built-in doctor command to verify your environment:

```bash
npx @ccpocket/bridge@latest doctor
```

It checks Node.js, Git, CLI providers, macOS permissions (Screen Recording, Keychain), network connectivity, and more.

## Architecture

```
Mobile App ←WebSocket→ Bridge Server ←stdio→ Claude Code CLI
```

The bridge server spawns and manages Claude Code CLI processes, translating WebSocket messages to/from the CLI's stdio interface. It supports multiple concurrent sessions.

## License

This package is governed by the [CC Pocket license](../../LICENSE).

The repository remains under FSL-1.1-MIT, with a specific Bridge Redistribution
Exception that allows unofficial redistribution of the Bridge Server, including
environment-specific builds and forks for Windows, WSL, proxy-restricted, or
other hard-to-validate environments.

If you redistribute this package or a modified fork:

- do not imply it is official, endorsed, or supported by the CC Pocket maintainer
- preserve the license text and clearly state that the software is provided "AS IS"
- make clear that compliance with Anthropic, OpenAI, network, enterprise, and other third-party terms is the responsibility of the redistributor and end user

In short: unofficial Bridge redistributions are permitted for compatibility and
support purposes, but they remain unsupported and at your own risk.
