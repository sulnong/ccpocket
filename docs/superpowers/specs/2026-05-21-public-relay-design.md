# Self-Hosted WebSocket Relay Design

## Context

CC Pocket currently connects the Flutter app directly to a local Bridge
WebSocket server. That works well on the same LAN, through Tailscale, or through
a user-managed public reverse proxy configured with `BRIDGE_PUBLIC_WS_URL`.

The first relay version targets a narrower personal use case:

- The relay is self-hosted on a trusted public server.
- The public hosting platform supports WebSocket Upgrade.
- The Flutter app should remain unchanged or receive only minimal connection
  parser tests.
- Relay use is explicit opt-in for the local Bridge.
- The relay may see plaintext CC Pocket protocol messages in this version.

This design intentionally does not make a public default relay promise. A later
public relay should add app-level end-to-end encryption and durable trusted
device authorization before being offered broadly.

## Goals

- Let a phone connect to a Bridge even when the phone and computer are on
  different network segments.
- Avoid requiring Tailscale, LAN reachability, or a per-user reverse proxy.
- Preserve the existing Flutter WebSocket protocol and deep link format.
- Keep direct LAN, mDNS, Tailscale, and `BRIDGE_PUBLIC_WS_URL` behavior
  unchanged by default.
- Make relay use transparent at Bridge startup with a printed deep link and QR
  code.

## Non-Goals

- No end-to-end encryption in the first implementation.
- No durable account system or trusted-device management.
- No multi-tenant public relay guarantees.
- No HTTP polling fallback for platforms that do not support WebSocket Upgrade.
- No major Flutter connection UI redesign.

## Recommended Approach

Use a path-based relay URL that already looks like a normal Bridge WebSocket URL
to the Flutter app:

```text
ccpocket://connect?url=wss://relay.example.com/r/<roomId>&token=<roomSecret>
```

The existing app parses the `url` and `token` query parameters. When it connects,
the final WebSocket URL becomes:

```text
wss://relay.example.com/r/<roomId>?token=<roomSecret>
```

The relay validates the room and token, then forwards raw WebSocket text frames
between the app socket and the registered local Bridge proxy socket.

## Architecture

```text
Flutter App
  connects to wss://relay.example.com/r/<roomId>?token=<roomSecret>
        |
        v
Self-hosted Relay Server
  pairs sockets by roomId and roomSecret
        |
        v
Local Bridge Relay Client
  outbound-connects to relay
  proxies messages to ws://127.0.0.1:<BRIDGE_PORT>
        |
        v
Existing BridgeWebSocketServer
```

The relay server does not parse CC Pocket business messages. It only validates
room membership and forwards frames.

The local Bridge relay client acts as a local app proxy. It connects to the
existing local `BridgeWebSocketServer` through `ws://127.0.0.1:<BRIDGE_PORT>`
and relays messages between that local socket and the public relay socket. This
keeps changes out of the large `websocket.ts` message handler.

## Components

### Relay Server

Create an independently runnable relay package, preferably `packages/relay/`,
for deployment on the public server.

Responsibilities:

- Listen for WebSocket connections.
- Accept Bridge registration connections at `/bridge/register`.
- Accept app connections at `/r/<roomId>`.
- Keep an in-memory room table:

```text
roomId -> {
  secret,
  bridgeSocket,
  appSocket?,
  createdAt,
  lastSeenAt
}
```

- Require a server-side `RELAY_ADMIN_TOKEN` for Bridge registration.
- Validate app `token` against the room secret.
- Allow one app socket per room. A new valid app socket replaces the old one.
- Close app sockets when their Bridge socket disconnects.
- Expose `/health` for platform health checks.

The relay should log connection lifecycle events and errors, but it should not
log forwarded payloads.

### Bridge Relay Client

Add a relay client to `packages/bridge`, for example
`packages/bridge/src/relay-client.ts`.

Responsibilities:

- Be disabled by default.
- Enable through CLI and environment configuration:

```text
ccpocket-bridge --relay-url wss://relay.example.com --relay-token <admin-token>
BRIDGE_RELAY_URL=wss://relay.example.com
BRIDGE_RELAY_TOKEN=<admin-token>
```

- Generate high-entropy `roomId` and `roomSecret` unless explicitly provided by
  future configuration.
- Connect to:

```text
wss://relay.example.com/bridge/register?token=<admin-token>
```

- Send a registration message:

```json
{
  "type": "register",
  "roomId": "<roomId>",
  "secret": "<roomSecret>",
  "bridgeVersion": "1.61.1"
}
```

- Handle a registration response:

```json
{
  "type": "registered",
  "roomId": "<roomId>",
  "secret": "<roomSecret>",
  "appUrl": "wss://relay.example.com/r/<roomId>"
}
```

- Print an existing-format deep link and QR code:

```text
ccpocket://connect?url=wss://relay.example.com/r/<roomId>&token=<roomSecret>
```

- Open a local WebSocket client to the local Bridge:

```text
ws://127.0.0.1:<BRIDGE_PORT>
```

- Forward text frames in both directions.
- Reconnect to the relay after transient failures.
- Print a fresh deep link after a successful reconnect if the room changes.

### Flutter App

The first implementation should not change Flutter runtime behavior.

Expected existing behavior:

- `ConnectionUrlParser` accepts `ccpocket://connect?url=wss://host/r/id&token=x`.
- `BridgeService.connect()` connects to arbitrary `ws://` and `wss://` URLs.
- Existing token appending preserves the path and adds `?token=...`.

Tests may be added to lock this behavior, but UI changes are outside first
scope.

## Protocol

### Bridge Registration

Bridge connects to:

```text
GET /bridge/register?token=<relayAdminToken>
Upgrade: websocket
```

The first client message is:

```json
{
  "type": "register",
  "roomId": "<optional-or-generated-room-id>",
  "secret": "<optional-or-generated-room-secret>",
  "bridgeVersion": "<bridge-version>"
}
```

The relay responds:

```json
{
  "type": "registered",
  "roomId": "<room-id>",
  "secret": "<room-secret>",
  "appUrl": "wss://relay.example.com/r/<room-id>"
}
```

After registration, the Bridge registration socket becomes the relay-side
transport for app traffic.

### App Connection

The app connects to:

```text
GET /r/<roomId>?token=<roomSecret>
Upgrade: websocket
```

Relay validation:

- `roomId` exists.
- Room has an active Bridge socket.
- Query `token` exactly matches the room secret.

After validation, the relay forwards raw text frames between the app socket and
the Bridge registration socket.

### Frame Forwarding

The relay forwards CC Pocket protocol payloads as opaque WebSocket text frames.
Binary frames are not required for the current app protocol and may be rejected
or closed in the first implementation.

## Error Handling

- Invalid Bridge admin token: close registration socket.
- Malformed registration message: close registration socket.
- Duplicate Bridge registration for the same room: replace the old Bridge socket
  and close any paired app socket.
- App room not found: close app socket with a clear reason.
- App token mismatch: close app socket.
- App connects before Bridge: close app socket.
- Bridge disconnects: delete room and close paired app socket.
- App disconnects: keep the room and Bridge registration socket alive.
- Relay server restart: rooms are lost; Bridge reconnect creates a new room.
- Local Bridge socket failure inside the relay client: close or pause the relay
  app side, reconnect locally, and report the state in logs.

## Security And Privacy

This version is for trusted self-hosted relay use.

- Use `wss://` for mobile and public internet usage.
- Use a high-entropy room secret in the app deep link.
- Keep `RELAY_ADMIN_TOKEN` separate from room secrets.
- Do not log forwarded CC Pocket payloads.
- Do not enable relay by default.
- Document that the relay operator can observe plaintext payloads in this first
  version.

A future public relay should add:

- App-to-Bridge application-layer encryption.
- One-time pairing codes separate from long-lived device credentials.
- Trusted device revoke flows.
- Abuse limits and room quotas.
- Metrics that do not expose payload content.

## Configuration

Bridge environment variables:

```text
BRIDGE_RELAY_URL=wss://relay.example.com
BRIDGE_RELAY_TOKEN=<relay-admin-token>
BRIDGE_RELAY_ROOM_ID=<optional-stable-room-id>
BRIDGE_RELAY_ROOM_SECRET=<optional-stable-room-secret>
```

Bridge CLI flags:

```text
--relay-url <url>
--relay-token <token>
--relay-room-id <roomId>
--relay-room-secret <secret>
```

Relay server environment variables:

```text
RELAY_HOST=0.0.0.0
RELAY_PORT=8787
RELAY_ADMIN_TOKEN=<admin-token>
RELAY_PUBLIC_URL=wss://relay.example.com
```

The relay public URL must support WebSocket Upgrade. Public mobile use should
prefer `wss://`; a plain `ws://` endpoint can be used only for trusted testing
or where the platform allows cleartext traffic.

## Testing

Relay tests:

- Registers a Bridge socket with a valid admin token.
- Rejects invalid admin tokens.
- Rejects malformed registration messages.
- Accepts app socket with matching room secret.
- Rejects app socket with missing or wrong token.
- Forwards app-to-Bridge and Bridge-to-app text frames.
- Replaces an old app socket when a new valid app socket connects.
- Deletes room and closes app socket when Bridge disconnects.

Bridge relay client tests:

- Builds registration URL correctly.
- Sends registration payload with generated room credentials.
- Builds existing-format deep link with `url` and `token`.
- Proxies frames between relay and local Bridge sockets.
- Reconnects after relay disconnect.

Bridge startup tests:

- Relay is disabled when no relay URL is configured.
- CLI flags populate relay environment/config.
- Existing startup info and `BRIDGE_PUBLIC_WS_URL` behavior remain unchanged.

Flutter tests:

- Deep link parser accepts relay path URLs.
- Token appending preserves URL path and existing behavior.

## Rollout

1. Implement relay server and local relay client behind explicit flags.
2. Verify against a local relay with `ws://127.0.0.1:<port>`.
3. Verify against the public hosting platform with WebSocket Upgrade.
4. Document the self-hosted trusted relay setup.
5. Consider app-level encryption only after the plaintext self-hosted path is
   stable.
