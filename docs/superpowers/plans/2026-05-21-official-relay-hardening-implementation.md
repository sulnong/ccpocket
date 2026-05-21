# Official Relay Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden `@ccpocket/relay` so it can serve as the default official relay with open Bridge registration, resource limits, cleanup, and health reporting.

**Architecture:** Keep the relay as a single Node.js process with in-memory room state. Add a focused runtime configuration layer inside `packages/relay/src/server.ts`, then enforce limits at WebSocket acceptance, registration, and forwarding boundaries. Preserve the existing self-hosted `RELAY_ADMIN_TOKEN` mode when a token is configured.

**Tech Stack:** TypeScript ESM, Node.js HTTP server, `ws`, Vitest, npm workspaces.

---

## File Structure

- Modify `packages/relay/src/server.ts`: add open registration mode, config defaults, connection accounting, room/IP limits, message-size enforcement, heartbeat, idle cleanup, abuse tracking, and richer health output.
- Modify `packages/relay/src/cli.ts`: parse new `RELAY_*` environment variables and pass them to `startRelayServer()`.
- Modify `packages/relay/src/server.test.ts`: add integration tests for open mode, self-hosted mode, limits, oversized messages, idle cleanup, abuse blocking, and health output.
- Modify `packages/relay/README.md`: document official open mode, advanced self-hosted token mode, limits, health output, and deployment guidance.
- Create `docs/superpowers/plans/2026-05-21-official-relay-hardening-implementation.md`: this plan.

## Task 1: Relay Open Mode And Health Shape

**Files:**
- Modify: `packages/relay/src/server.ts`
- Modify: `packages/relay/src/cli.ts`
- Modify: `packages/relay/src/server.test.ts`

- [ ] **Step 1: Write failing tests for open mode and health output**

Add tests to `packages/relay/src/server.test.ts`:

```ts
it("allows bridge registration without an admin token in open mode", async () => {
  const { baseUrl } = await startTestRelay({ adminToken: "" });
  const bridge = await openSocket(`${baseUrl}/bridge/register`);

  bridge.send(JSON.stringify({
    type: "register",
    roomId: "open-room",
    secret: "test-key-open",
    bridgeVersion: "1.61.1",
  }));

  await expect(waitForMessage(bridge)).resolves.toBe(JSON.stringify({
    type: "registered",
    roomId: "open-room",
    secret: "test-key-open",
    appUrl: "ws://relay.test/r/open-room",
  }));

  bridge.close();
});

it("reports active counts, limits, and counters from health", async () => {
  const { baseUrl, httpUrl } = await startTestRelay({
    adminToken: "",
    maxRooms: 10,
    maxConnections: 20,
    maxRoomsPerIp: 5,
    maxConnectionsPerIp: 8,
    maxMessageBytes: 512,
  });
  const bridge = await openSocket(`${baseUrl}/bridge/register`);
  bridge.send(JSON.stringify({
    type: "register",
    roomId: "health-room",
    secret: "test-key-health",
    bridgeVersion: "1.61.1",
  }));
  await waitForMessage(bridge);

  const response = await fetch(`${httpUrl}/health`);
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, unknown>;

  expect(body).toMatchObject({
    status: "ok",
    rooms: 1,
    connections: 1,
    bridgeConnections: 1,
    appConnections: 0,
    limits: {
      maxRooms: 10,
      maxConnections: 20,
      maxRoomsPerIp: 5,
      maxConnectionsPerIp: 8,
      maxMessageBytes: 512,
    },
    counters: {
      rejectedConnections: 0,
      closedIdleRooms: 0,
      closedOversizedMessages: 0,
    },
  });

  bridge.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test --workspace=packages/relay -- src/server.test.ts
```

Expected: FAIL because `startRelayServer()` currently requires `adminToken` and `/health` only reports `status`, `uptime`, and `rooms`.

- [ ] **Step 3: Add relay options, defaults, open mode, and health output**

In `packages/relay/src/server.ts`, extend `RelayServerOptions`:

```ts
export interface RelayServerOptions {
  host?: string;
  port?: number;
  adminToken?: string;
  publicUrl?: string;
  maxRooms?: number;
  maxConnections?: number;
  maxRoomsPerIp?: number;
  maxConnectionsPerIp?: number;
  maxMessageBytes?: number;
  idleRoomTtlMs?: number;
  heartbeatIntervalMs?: number;
  abuseWindowMs?: number;
  maxRejectionsPerIp?: number;
}
```

Add default limit resolution:

```ts
interface RelayLimits {
  maxRooms: number;
  maxConnections: number;
  maxRoomsPerIp: number;
  maxConnectionsPerIp: number;
  maxMessageBytes: number;
  idleRoomTtlMs: number;
  heartbeatIntervalMs: number;
  abuseWindowMs: number;
  maxRejectionsPerIp: number;
}

function resolveLimits(options: RelayServerOptions): RelayLimits {
  return {
    maxRooms: options.maxRooms ?? 500,
    maxConnections: options.maxConnections ?? 1200,
    maxRoomsPerIp: options.maxRoomsPerIp ?? 5,
    maxConnectionsPerIp: options.maxConnectionsPerIp ?? 20,
    maxMessageBytes: options.maxMessageBytes ?? 1_048_576,
    idleRoomTtlMs: options.idleRoomTtlMs ?? 1_800_000,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
    abuseWindowMs: options.abuseWindowMs ?? 60_000,
    maxRejectionsPerIp: options.maxRejectionsPerIp ?? 30,
  };
}
```

Add stats/accounting structures:

```ts
interface RelayCounters {
  rejectedConnections: number;
  closedIdleRooms: number;
  closedOversizedMessages: number;
}

interface RelayState {
  rooms: Map<string, Room>;
  connections: Set<WebSocket>;
  bridgeSockets: Set<WebSocket>;
  appSockets: Set<WebSocket>;
  connectionsByIp: Map<string, number>;
  roomsByIp: Map<string, number>;
  counters: RelayCounters;
}
```

Use `const adminToken = options.adminToken?.trim() ?? "";` and only validate `/bridge/register` query tokens when `adminToken` is non-empty.

Change `/health` to return:

```ts
res.end(JSON.stringify({
  status: "ok",
  uptime: Math.floor((Date.now() - startedAt) / 1000),
  rooms: state.rooms.size,
  connections: state.connections.size,
  bridgeConnections: state.bridgeSockets.size,
  appConnections: state.appSockets.size,
  limits: {
    maxRooms: limits.maxRooms,
    maxConnections: limits.maxConnections,
    maxRoomsPerIp: limits.maxRoomsPerIp,
    maxConnectionsPerIp: limits.maxConnectionsPerIp,
    maxMessageBytes: limits.maxMessageBytes,
  },
  counters: state.counters,
}));
```

- [ ] **Step 4: Parse limit environment variables in the CLI**

In `packages/relay/src/cli.ts`, add:

```ts
function parseOptionalInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}
```

Pass the parsed values:

```ts
startRelayServer({
  host,
  port,
  adminToken,
  publicUrl,
  maxRooms: parseOptionalInt("RELAY_MAX_ROOMS"),
  maxConnections: parseOptionalInt("RELAY_MAX_CONNECTIONS"),
  maxRoomsPerIp: parseOptionalInt("RELAY_MAX_ROOMS_PER_IP"),
  maxConnectionsPerIp: parseOptionalInt("RELAY_MAX_CONNECTIONS_PER_IP"),
  maxMessageBytes: parseOptionalInt("RELAY_MAX_MESSAGE_BYTES"),
  idleRoomTtlMs: parseOptionalInt("RELAY_IDLE_ROOM_TTL_MS"),
  heartbeatIntervalMs: parseOptionalInt("RELAY_HEARTBEAT_INTERVAL_MS"),
  abuseWindowMs: parseOptionalInt("RELAY_ABUSE_WINDOW_MS"),
  maxRejectionsPerIp: parseOptionalInt("RELAY_MAX_REJECTIONS_PER_IP"),
})
```

- [ ] **Step 5: Run tests to verify open mode and health pass**

Run:

```bash
npm run test --workspace=packages/relay -- src/server.test.ts
```

Expected: PASS for the new open mode and health tests plus existing tests.

## Task 2: Connection And Room Limits

**Files:**
- Modify: `packages/relay/src/server.ts`
- Modify: `packages/relay/src/server.test.ts`

- [ ] **Step 1: Write failing tests for global and per-IP limits**

Add tests:

```ts
it("rejects bridge registration when the global room limit is reached", async () => {
  const { baseUrl } = await startTestRelay({ adminToken: "", maxRooms: 1 });
  const first = await registerBridge(baseUrl, "room-a", "test-key-a");

  const second = await openSocket(`${baseUrl}/bridge/register`);
  second.send(JSON.stringify({
    type: "register",
    roomId: "room-b",
    secret: "test-key-b",
    bridgeVersion: "1.61.1",
  }));

  await expect(waitForClose(second)).resolves.toMatchObject({
    code: 4008,
    reason: "Room limit exceeded",
  });

  first.close();
});

it("rejects bridge registration when the per-IP room limit is reached", async () => {
  const { baseUrl } = await startTestRelay({
    adminToken: "",
    maxRooms: 10,
    maxRoomsPerIp: 1,
  });
  const first = await registerBridge(baseUrl, "room-a", "test-key-a");

  const second = await openSocket(`${baseUrl}/bridge/register`);
  second.send(JSON.stringify({
    type: "register",
    roomId: "room-b",
    secret: "test-key-b",
    bridgeVersion: "1.61.1",
  }));

  await expect(waitForClose(second)).resolves.toMatchObject({
    code: 4008,
    reason: "Room limit exceeded",
  });

  first.close();
});

it("rejects new sockets when the global connection limit is reached", async () => {
  const { baseUrl } = await startTestRelay({
    adminToken: "",
    maxConnections: 1,
  });
  const first = await openSocket(`${baseUrl}/bridge/register`);
  const second = await openSocket(`${baseUrl}/bridge/register`);

  await expect(waitForClose(second)).resolves.toMatchObject({
    code: 4008,
    reason: "Connection limit exceeded",
  });

  first.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test --workspace=packages/relay -- src/server.test.ts
```

Expected: FAIL because the relay does not yet enforce room or connection limits.

- [ ] **Step 3: Implement connection and room limit checks**

Add helpers to `packages/relay/src/server.ts`:

```ts
function incrementMap(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decrementMap(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 0) - 1;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

function getClientIp(req: import("node:http").IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}
```

At WebSocket connection acceptance, add the socket to connection accounting and reject above `maxConnections` or `maxConnectionsPerIp`.

Before creating a new room, check global and per-IP room limits. Replacement of an existing room id should be allowed even when the room count is already at the limit because it does not increase the room count.

- [ ] **Step 4: Run tests to verify limits pass**

Run:

```bash
npm run test --workspace=packages/relay -- src/server.test.ts
```

Expected: PASS.

## Task 3: Message Size Enforcement And Abuse Tracking

**Files:**
- Modify: `packages/relay/src/server.ts`
- Modify: `packages/relay/src/server.test.ts`

- [ ] **Step 1: Write failing tests for oversized messages and abuse blocking**

Add tests:

```ts
it("closes the sending socket when a forwarded frame is too large", async () => {
  const { baseUrl } = await startTestRelay({
    adminToken: "",
    maxMessageBytes: 8,
  });
  const bridge = await registerBridge(baseUrl, "room-size", "test-key-size");
  const app = await openSocket(`${baseUrl}/r/room-size?token=test-key-size`);

  app.send("too-large-frame");

  await expect(waitForClose(app)).resolves.toMatchObject({
    code: 4009,
    reason: "Message too large",
  });

  bridge.close();
});

it("temporarily rejects an IP after too many rejected attempts", async () => {
  const { baseUrl } = await startTestRelay({
    adminToken: "",
    maxRejectionsPerIp: 2,
    abuseWindowMs: 60_000,
  });

  const first = await openSocket(`${baseUrl}/missing`);
  await waitForClose(first);
  const second = await openSocket(`${baseUrl}/missing`);
  await waitForClose(second);
  const third = await openSocket(`${baseUrl}/bridge/register`);

  await expect(waitForClose(third)).resolves.toMatchObject({
    code: 4008,
    reason: "Too many rejected attempts",
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test --workspace=packages/relay -- src/server.test.ts
```

Expected: FAIL because oversized messages and abuse blocking are not enforced.

- [ ] **Step 3: Implement message-size checks and rejection tracking**

Add:

```ts
function rawDataBytes(data: WebSocket.RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.reduce((sum, item) => sum + item.byteLength, 0);
}
```

Before forwarding a frame or parsing the registration frame, close the sender with code `4009` and reason `"Message too large"` when `rawDataBytes(payload) > limits.maxMessageBytes`.

Track rejection timestamps by IP in memory. On each rejection-worthy close, increment `rejectedConnections`. Before routing a new socket, close it with code `4008` and reason `"Too many rejected attempts"` if the IP is over `maxRejectionsPerIp` within `abuseWindowMs`.

- [ ] **Step 4: Run tests to verify protections pass**

Run:

```bash
npm run test --workspace=packages/relay -- src/server.test.ts
```

Expected: PASS.

## Task 4: Heartbeat And Idle Room Cleanup

**Files:**
- Modify: `packages/relay/src/server.ts`
- Modify: `packages/relay/src/server.test.ts`

- [ ] **Step 1: Write failing test for idle cleanup**

Add test:

```ts
it("closes idle rooms and removes them from health counts", async () => {
  const { baseUrl, httpUrl } = await startTestRelay({
    adminToken: "",
    idleRoomTtlMs: 20,
    heartbeatIntervalMs: 10,
  });
  const bridge = await registerBridge(baseUrl, "idle-room", "test-key-idle");
  const closed = waitForClose(bridge);

  await expect(closed).resolves.toMatchObject({
    code: 4000,
    reason: "Room idle timeout",
  });

  const response = await fetch(`${httpUrl}/health`);
  const body = await response.json() as Record<string, unknown>;
  expect(body).toMatchObject({
    rooms: 0,
    counters: {
      closedIdleRooms: 1,
    },
  });
});
```

- [ ] **Step 2: Run tests to verify it fails**

Run:

```bash
npm run test --workspace=packages/relay -- src/server.test.ts
```

Expected: FAIL because idle cleanup does not exist.

- [ ] **Step 3: Implement heartbeat and idle cleanup intervals**

Maintain `isAlive` per socket with a `WeakMap<WebSocket, boolean>`. On `pong`, set it true. At each heartbeat interval, terminate sockets that did not respond to the previous ping and ping the rest.

At the same interval, scan rooms and close both sockets for rooms whose `lastSeenAt` is older than `idleRoomTtlMs`, incrementing `closedIdleRooms`.

Clear the interval in `RunningRelayServer.close()`.

- [ ] **Step 4: Run tests to verify cleanup passes**

Run:

```bash
npm run test --workspace=packages/relay -- src/server.test.ts
```

Expected: PASS.

## Task 5: Documentation And Final Verification

**Files:**
- Modify: `packages/relay/README.md`

- [ ] **Step 1: Update README**

Update `packages/relay/README.md` to describe:

- Official open mode when `RELAY_ADMIN_TOKEN` is unset.
- Trusted self-hosted mode when `RELAY_ADMIN_TOKEN` is set.
- New limit environment variables.
- Expanded `/health` fields.
- The plaintext trusted-relay security model.

- [ ] **Step 2: Run relay test suite**

Run:

```bash
npm run test --workspace=packages/relay
```

Expected: PASS.

- [ ] **Step 3: Run relay build**

Run:

```bash
npm run build --workspace=packages/relay
```

Expected: PASS.

- [ ] **Step 4: Run bridge relay-related tests**

Run:

```bash
npm run test --workspace=packages/bridge -- src/relay-client.test.ts src/cli-args.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/relay/src/server.ts packages/relay/src/cli.ts packages/relay/src/server.test.ts packages/relay/README.md docs/superpowers/plans/2026-05-21-official-relay-hardening-implementation.md
git commit -m "feat(relay): harden official relay mode"
```
