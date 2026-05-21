# @ccpocket/relay

Trusted self-hosted WebSocket relay for CC Pocket Bridge connections.

The relay pairs one Bridge socket registered at `/bridge/register` with one app
socket at `/r/<roomId>` and forwards WebSocket frames between them. It stores
rooms in memory only and does not persist session data.

## Quick Start

```bash
RELAY_ADMIN_TOKEN=change-me \
RELAY_PUBLIC_URL=wss://relay.example.com \
npm run relay
```

Then start the Bridge on your computer:

```bash
BRIDGE_RELAY_URL=wss://relay.example.com \
BRIDGE_RELAY_TOKEN=change-me \
npm run bridge
```

The Bridge prints a `ccpocket://connect?...` deep link and terminal QR code for
the relay path.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `RELAY_HOST` | `0.0.0.0` | Bind address |
| `RELAY_PORT` | `8787` | HTTP/WebSocket port |
| `RELAY_ADMIN_TOKEN` | (required) | Token required for Bridge registration |
| `RELAY_PUBLIC_URL` | `ws://<host>:<port>` | Public `ws://` / `wss://` base URL printed back to the Bridge |

## Routes

- `GET /health` returns relay health and in-memory room count.
- `WS /bridge/register?token=<RELAY_ADMIN_TOKEN>` registers a Bridge.
- `WS /r/<roomId>?token=<roomSecret>` connects the app to a registered room.

The first Bridge frame must be JSON:

```json
{
  "type": "register",
  "roomId": "optional-stable-room-id",
  "secret": "optional-stable-room-secret",
  "bridgeVersion": "1.61.1"
}
```

The relay responds with:

```json
{
  "type": "registered",
  "roomId": "room-id",
  "secret": "room-secret",
  "appUrl": "wss://relay.example.com/r/room-id"
}
```

If `roomId` or `secret` is omitted, the relay generates high-entropy random
values. If the same room id registers again, the previous Bridge and app sockets
are closed and replaced.

## Deployment Notes

Your hosting platform must support WebSocket Upgrade. Put TLS at the platform
or reverse proxy layer and set `RELAY_PUBLIC_URL` to the external `wss://`
origin that the mobile app can reach.

This v1 relay is intended for trusted self-hosting. It forwards plaintext
ccpocket protocol traffic and is not end-to-end encrypted. Do not run it as an
open public service without additional abuse protection, rate limiting, logging
policy, and operational monitoring.

## Development

```bash
npm run build --workspace=packages/relay
npm run test --workspace=packages/relay
```
