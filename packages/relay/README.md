# @ccpocket/relay

WebSocket relay for CC Pocket Bridge connections.

The relay pairs one Bridge socket registered at `/bridge/register` with one app
socket at `/r/<roomId>` and forwards WebSocket frames between them. It stores
rooms in memory only and does not persist session data.

## Quick Start

### Official-style open relay

Leave `RELAY_ADMIN_TOKEN` unset to allow Bridge registration without a shared
admin token. This is the mode intended for a public official relay protected by
resource limits.

```bash
RELAY_PUBLIC_URL=wss://relay.example.com \
npm run relay
```

Then start the Bridge on your computer:

```bash
BRIDGE_RELAY_URL=wss://relay.example.com \
npm run bridge
```

The Bridge prints a `ccpocket://connect?...` pairing link and terminal QR code
for the relay path. Users do not need to handle relay admin tokens in this
mode.

### Trusted self-hosted relay

Set `RELAY_ADMIN_TOKEN` when you want Bridge registration to require a shared
deployment secret.

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

The Bridge prints the same pairing link and terminal QR code after registration.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `RELAY_HOST` | `0.0.0.0` | Bind address |
| `RELAY_PORT` | `8787` | HTTP/WebSocket port |
| `RELAY_ADMIN_TOKEN` | (none) | Optional token required for Bridge registration when set |
| `RELAY_PUBLIC_URL` | `ws://<host>:<port>` | Public `ws://` / `wss://` base URL printed back to the Bridge |
| `RELAY_MAX_ROOMS` | `500` | Maximum active rooms on this relay process |
| `RELAY_MAX_CONNECTIONS` | `1200` | Maximum active WebSocket connections |
| `RELAY_MAX_ROOMS_PER_IP` | `5` | Maximum active Bridge rooms from one client IP |
| `RELAY_MAX_CONNECTIONS_PER_IP` | `20` | Maximum active sockets from one client IP |
| `RELAY_MAX_MESSAGE_BYTES` | `1048576` | Maximum accepted WebSocket frame size |
| `RELAY_IDLE_ROOM_TTL_MS` | `1800000` | Close rooms idle for this many milliseconds |
| `RELAY_HEARTBEAT_INTERVAL_MS` | `30000` | WebSocket ping/pong and idle scan interval |
| `RELAY_ABUSE_WINDOW_MS` | `60000` | Rejection tracking window per client IP |
| `RELAY_MAX_REJECTIONS_PER_IP` | `30` | Rejections allowed in the abuse window before temporary refusal |

## Routes

- `GET /health` returns relay health, active counts, configured limits, and counters.
- `WS /bridge/register` registers a Bridge in open mode.
- `WS /bridge/register?token=<RELAY_ADMIN_TOKEN>` registers a Bridge in trusted self-hosted mode.
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

## Health Response

`GET /health` returns process-local state without exposing room ids, secrets, or
forwarded payloads:

```json
{
  "status": "ok",
  "uptime": 123,
  "rooms": 10,
  "connections": 21,
  "bridgeConnections": 10,
  "appConnections": 11,
  "limits": {
    "maxRooms": 500,
    "maxConnections": 1200,
    "maxRoomsPerIp": 5,
    "maxConnectionsPerIp": 20,
    "maxMessageBytes": 1048576
  },
  "counters": {
    "rejectedConnections": 0,
    "closedIdleRooms": 0,
    "closedOversizedMessages": 0
  }
}
```

## Resource Protection

The relay enforces global and per-IP connection limits, global and per-IP room
limits, maximum frame size, WebSocket heartbeat cleanup, idle room cleanup, and
lightweight per-IP rejection tracking. These protections are intentionally
process-local and conservative; place the relay behind TLS and platform-level
rate limiting for internet-facing deployments.

## Deployment Notes

Your hosting platform must support WebSocket Upgrade. Put TLS at the platform
or reverse proxy layer and set `RELAY_PUBLIC_URL` to the external `wss://`
origin that the mobile app can reach.

This v1 relay forwards plaintext CC Pocket protocol traffic and is not
end-to-end encrypted. Run it only where the relay operator is trusted. Do not
log forwarded payloads. For a public relay, monitor health counters and keep the
default limits conservative until real load is understood.

## Development

```bash
npm run build --workspace=packages/relay
npm run test --workspace=packages/relay
```
