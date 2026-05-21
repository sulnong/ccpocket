# Official Relay Hardening Design

## Context

The current self-hosted relay MVP proves that a phone can connect to a local
Bridge through a public WebSocket endpoint. It pairs one Bridge socket with one
app socket per room and forwards CC Pocket protocol frames without changing the
Flutter runtime protocol.

That MVP is suitable for trusted self-hosting, but it is not ready to become the
default official relay. The current registration path can be protected by a
single `RELAY_ADMIN_TOKEN`, which works for private deployments but cannot be
embedded in a public npm package. It also lacks connection limits, room limits,
message size limits, idle cleanup, heartbeat cleanup, and basic abuse controls.

The next step is to keep the user experience simple while making the official
relay safe enough for unauthenticated public use.

## Goals

- Let ordinary users start `ccpocket-bridge` without manually configuring relay
  credentials.
- Hide token concepts from the normal user flow. Users should see a QR code,
  pairing link, or connection link, not an admin token.
- Keep the existing app connection model: the phone connects to a relay app URL
  with a generated room secret carried in the existing deep link.
- Support an official open-registration relay with conservative resource
  limits.
- Preserve trusted self-hosted deployments that still want
  `RELAY_ADMIN_TOKEN`.
- Add enough observability to understand current relay load and resource
  pressure.
- Keep this phase independent of a future account system.

## Non-Goals

- No user accounts, sign-in, billing, or self-service tenant dashboard.
- No durable multi-process room state.
- No end-to-end encryption change in this phase.
- No mobile UI redesign.
- No promise that the official relay is ready for high-scale public abuse
  without further operational work.

## Recommended Approach

Use open Bridge registration for the official relay, protected by hard resource
limits and cleanup rules. The relay should accept `/bridge/register` without an
admin token when `RELAY_ADMIN_TOKEN` is not configured. When
`RELAY_ADMIN_TOKEN` is configured, the relay should keep the existing trusted
self-hosted behavior and require the token.

This gives the default official relay a zero-configuration Bridge path while
allowing advanced users to keep a stricter self-hosted mode.

## User Experience

The default user flow should be:

```bash
npm install -g @ccpocket/bridge
ccpocket-bridge
```

The Bridge connects to the official relay by default, registers a room, and
prints a QR code and pairing link. User-facing output should prefer terms such
as "Relay connected", "Scan this QR code with CC Pocket", and "Pairing link".
It should not ask normal users to understand `RELAY_ADMIN_TOKEN` or
`roomSecret`.

The generated room secret remains part of the deep link internally:

```text
ccpocket://connect?url=wss://relay.example.com/r/<roomId>&token=<roomSecret>
```

The app continues to connect to:

```text
wss://relay.example.com/r/<roomId>?token=<roomSecret>
```

## Relay Modes

### Official Open Mode

Enabled when `RELAY_ADMIN_TOKEN` is empty.

- Bridge registration at `/bridge/register` does not require a query token.
- The relay generates or accepts a room id and room secret from the Bridge
  registration payload.
- All registration and app connections are subject to global and per-IP limits.
- App connections must still present the room secret.

### Trusted Self-Hosted Mode

Enabled when `RELAY_ADMIN_TOKEN` is set.

- Bridge registration at `/bridge/register?token=<RELAY_ADMIN_TOKEN>` remains
  required.
- The same resource limits and cleanup rules still apply.
- Documentation can mention tokens in this advanced deployment section only.

## Server Limits

Add configurable limits with conservative defaults:

| Environment Variable | Default | Purpose |
| --- | ---: | --- |
| `RELAY_MAX_ROOMS` | `500` | Maximum active rooms on this relay process |
| `RELAY_MAX_CONNECTIONS` | `1200` | Maximum active WebSocket connections |
| `RELAY_MAX_ROOMS_PER_IP` | `5` | Maximum active Bridge rooms from one client IP |
| `RELAY_MAX_CONNECTIONS_PER_IP` | `20` | Maximum active sockets from one client IP |
| `RELAY_MAX_MESSAGE_BYTES` | `1048576` | Maximum forwarded WebSocket frame size |
| `RELAY_IDLE_ROOM_TTL_MS` | `1800000` | Close rooms idle for 30 minutes |
| `RELAY_HEARTBEAT_INTERVAL_MS` | `30000` | WebSocket ping/pong interval |
| `RELAY_ABUSE_WINDOW_MS` | `60000` | Time window for lightweight rejection tracking |
| `RELAY_MAX_REJECTIONS_PER_IP` | `30` | Rejection threshold before temporary refusal |

The defaults intentionally favor a small server, such as 1 CPU and 2 GB memory.
Operators can raise them after observing real load.

## Connection Accounting

Track these counters in memory:

- Total active WebSocket connections.
- Active Bridge connections.
- Active app connections.
- Active rooms.
- Active rooms per client IP.
- Active connections per client IP.
- Rejected connection attempts.
- Closed idle rooms.
- Closed oversized messages.

The relay should determine the client IP from the socket remote address by
default. The first implementation should not trust `X-Forwarded-For` or other
forwarded headers; operators that need proxy-aware IP limiting should enforce
rate limits at the reverse proxy until an explicit trusted proxy option is
designed.

## Registration Flow

When a Bridge connects to `/bridge/register`:

1. Reject immediately if the IP is temporarily blocked by rejection tracking.
2. In trusted self-hosted mode, validate the admin token.
3. Check global connection and room limits.
4. Check per-IP connection and room limits.
5. Accept the registration frame only if it is text JSON and under
   `RELAY_MAX_MESSAGE_BYTES`.
6. Create or replace the room.
7. Return the existing `registered` response.

If a Bridge reuses an existing room id, the relay should keep the MVP behavior:
close the previous Bridge and app sockets for that room, then replace the room.

## App Connection Flow

When an app connects to `/r/<roomId>?token=<roomSecret>`:

1. Reject immediately if the IP is temporarily blocked by rejection tracking.
2. Check global and per-IP connection limits.
3. Validate that the room exists and has an open Bridge socket.
4. Validate the room secret.
5. Replace any existing app socket for that room.
6. Forward text or binary frames only if each frame is within
   `RELAY_MAX_MESSAGE_BYTES`.

The room secret remains a pairing credential, not a user-facing token concept.

## Message Size Enforcement

Before forwarding any WebSocket frame, the relay should check its byte length.
If the frame is larger than `RELAY_MAX_MESSAGE_BYTES`, close the sending socket
with a clear application close code and increment `closedOversizedMessages`.

This protects the relay process from unbounded memory pressure while preserving
the current opaque forwarding model.

## Heartbeat And Idle Cleanup

The relay should send WebSocket pings at `RELAY_HEARTBEAT_INTERVAL_MS`. If a
socket does not respond before the next heartbeat check, terminate it and clean
up related room state.

The relay should also scan rooms periodically and close rooms whose
`lastSeenAt` is older than `RELAY_IDLE_ROOM_TTL_MS`. Closing a room should close
both Bridge and app sockets if they are still present.

Any message forwarded in either direction should update `lastSeenAt`.

## Lightweight Abuse Controls

For the first official relay, use in-memory rejection tracking per IP. Count
events such as:

- Invalid self-hosted admin token.
- Unknown relay path.
- Missing room.
- Invalid room secret.
- Limit exceeded.
- Malformed registration message.
- Oversized frame.

If an IP exceeds `RELAY_MAX_REJECTIONS_PER_IP` within
`RELAY_ABUSE_WINDOW_MS`, reject new WebSocket attempts from that IP until the
window expires. This is intentionally simple and process-local; stronger abuse
protection can move to a reverse proxy, managed firewall, or future account
system.

## Health Endpoint

Extend `GET /health` to return:

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

The endpoint should not expose room ids, secrets, payloads, or user-provided
message content.

## Bridge Defaults

After the relay hardening lands, the Bridge should default to the official
relay URL when no custom relay configuration is provided. This can be controlled
by a build-time or runtime constant so local development and self-hosted
deployments remain easy.

Advanced users should still be able to override:

- `BRIDGE_RELAY_URL`
- `BRIDGE_RELAY_TOKEN` for trusted self-hosted mode
- `BRIDGE_RELAY_ROOM_ID`
- `BRIDGE_RELAY_ROOM_SECRET`

Normal docs should emphasize the zero-config path. Advanced docs can explain
self-hosting and tokens.

## Testing

Relay tests should cover:

- Open mode allows Bridge registration without an admin token.
- Trusted self-hosted mode still rejects missing or invalid admin tokens.
- Global room limits reject additional Bridge registrations.
- Per-IP room limits reject additional Bridge registrations.
- Global connection limits reject new sockets.
- Per-IP connection limits reject new sockets.
- Oversized registration or forwarded frames close the sender.
- Idle room cleanup closes Bridge and app sockets and removes the room.
- Heartbeat cleanup terminates dead sockets.
- App and Bridge frame forwarding still works under the new accounting layer.
- `/health` reports limits, counters, and active counts without secrets.

Bridge tests should cover:

- Default official relay output avoids user-facing token language.
- Existing self-hosted relay configuration still works.
- Pairing deep links still use the existing `token` query parameter internally.

## Rollout

1. Add relay limits, accounting, heartbeat, idle cleanup, and health fields.
2. Change relay registration auth to support open mode when
   `RELAY_ADMIN_TOKEN` is unset.
3. Update relay and Bridge documentation to separate normal zero-config usage
   from advanced self-hosted token usage.
4. Add Docker and npm release packaging after the hardened relay tests pass.
5. Deploy a small official relay with conservative defaults and monitor
   health counters before raising limits.

## Future Extensions

- Anonymous device credentials for better long-term quota without immediate
  accounts.
- User accounts and per-account quotas.
- End-to-end encryption over the relay.
- Multi-process room coordination with Redis or another shared state backend.
- Reverse proxy integration for stronger IP rate limiting and TLS operations.
