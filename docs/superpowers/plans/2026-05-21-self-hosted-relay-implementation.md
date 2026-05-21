# Self-Hosted Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit opt-in, trusted self-hosted WebSocket relay path so the existing Flutter app can connect to a local Bridge through a public WebSocket endpoint without requiring Tailscale or same-LAN reachability.

**Architecture:** Add a standalone Node relay package that pairs `/bridge/register` sockets with `/r/<roomId>` app sockets and forwards text frames. Add a Bridge relay client that registers with the relay, opens a local WebSocket to `ws://127.0.0.1:<BRIDGE_PORT>`, proxies frames, and prints an existing-format CC Pocket deep link. Keep Flutter runtime behavior unchanged and add tests that lock the current relay-compatible URL parsing and token persistence behavior.

**Tech Stack:** TypeScript ESM, Node.js HTTP server, `ws`, Vitest, npm workspaces, existing Bridge startup and QR helpers, Flutter/Dart unit tests.

---

## File Structure

- Create `packages/relay/package.json`: npm workspace package metadata, scripts, and `ws` dependency.
- Create `packages/relay/tsconfig.json`: TypeScript build config for the relay package.
- Create `packages/relay/vitest.config.ts`: Vitest config for relay tests.
- Create `packages/relay/src/server.ts`: relay HTTP/WebSocket server, room registry, pairing, and frame forwarding.
- Create `packages/relay/src/cli.ts`: executable CLI entrypoint that reads env vars and starts the relay server.
- Create `packages/relay/src/server.test.ts`: integration tests using real local WebSocket clients.
- Modify `package.json`: workspace already includes `packages/*`; add optional root scripts for relay build/test if useful.
- Create `packages/bridge/src/relay-client.ts`: Bridge-side relay registration, local Bridge proxy socket, forwarding, reconnect, and deep link printing.
- Create `packages/bridge/src/relay-client.test.ts`: Bridge relay client unit/integration tests with local WebSocket servers.
- Modify `packages/bridge/src/startup-info.ts`: export a reusable QR/deep-link printer for relay connection info.
- Modify `packages/bridge/src/startup-info.test.ts`: test the reusable relay info printer.
- Modify `packages/bridge/src/cli-args.ts`: parse relay value flags.
- Modify `packages/bridge/src/cli-args.test.ts`: cover relay value flags.
- Modify `packages/bridge/src/cli.ts`: add help text and set relay env vars from flags.
- Modify `packages/bridge/src/index.ts`: start/stop the Bridge relay client when `BRIDGE_RELAY_URL` is configured.
- Modify `packages/bridge/README.md`: document trusted self-hosted relay setup and plaintext limitation.
- Modify `apps/mobile/test/connection_url_parser_test.dart`: assert relay path deep links parse.
- Modify `apps/mobile/test/services/bridge_service_usage_test.dart`: assert saving and auto-connecting a relay path URL appends token without losing the path.

## Implementation Notes

- Relay v1 is plaintext to the relay operator. Do not describe it as end-to-end encrypted.
- Relay v1 is explicit opt-in. Direct LAN, mDNS, Tailscale, and `BRIDGE_PUBLIC_WS_URL` must keep working unchanged.
- The relay server stores rooms in memory only.
- The relay server should not log forwarded payloads.
- The Bridge relay client should keep the local Bridge socket open across app disconnects so app reconnects can reuse the Bridge client state.
- Use high-entropy random IDs from `node:crypto`, for example `randomBytes(16).toString("base64url")` for room IDs and `randomBytes(32).toString("base64url")` for room secrets.
- Use existing `buildConnectionUrl()` for deep links so URL encoding stays consistent with current startup info.

---

### Task 1: Relay Server Package Skeleton

**Files:**
- Create: `packages/relay/package.json`
- Create: `packages/relay/tsconfig.json`
- Create: `packages/relay/vitest.config.ts`
- Create: `packages/relay/src/server.ts`
- Create: `packages/relay/src/cli.ts`

- [ ] **Step 1: Create the package metadata**

Add `packages/relay/package.json`:

```json
{
  "name": "@ccpocket/relay",
  "version": "0.1.0",
  "description": "Self-hosted WebSocket relay for CC Pocket Bridge connections",
  "private": true,
  "type": "module",
  "license": "SEE LICENSE IN LICENSE",
  "bin": {
    "ccpocket-relay": "./dist/cli.js"
  },
  "main": "dist/server.js",
  "files": [
    "dist",
    "LICENSE"
  ],
  "engines": {
    "node": ">=18.0.0"
  },
  "scripts": {
    "dev": "tsx src/cli.ts",
    "build": "tsc",
    "start": "node dist/cli.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^4.0.18"
  }
}
```

- [ ] **Step 2: Add TypeScript config**

Add `packages/relay/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts", "vitest.config.ts"]
}
```

- [ ] **Step 3: Add Vitest config**

Add `packages/relay/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Add the initial server module**

Add `packages/relay/src/server.ts`:

```ts
import { createServer, type Server as HttpServer } from "node:http";

export interface RelayServerOptions {
  host?: string;
  port?: number;
  adminToken: string;
  publicUrl?: string;
}

export interface RunningRelayServer {
  httpServer: HttpServer;
  close(): Promise<void>;
}

export async function startRelayServer(
  options: RelayServerOptions,
): Promise<RunningRelayServer> {
  if (!options.adminToken) {
    throw new Error("RELAY_ADMIN_TOKEN is required");
  }

  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 8787;
  const startedAt = Date.now();

  const httpServer = createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        rooms: 0,
      }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, resolve);
  });

  return {
    httpServer,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
```

- [ ] **Step 5: Add the CLI entrypoint**

Add `packages/relay/src/cli.ts`:

```ts
#!/usr/bin/env node
import { startRelayServer } from "./server.js";

const host = process.env.RELAY_HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.RELAY_PORT ?? "8787", 10);
const adminToken = process.env.RELAY_ADMIN_TOKEN ?? "";
const publicUrl = process.env.RELAY_PUBLIC_URL;

startRelayServer({ host, port, adminToken, publicUrl })
  .then((server) => {
    console.log(`[relay] Listening on http://${host}:${port}`);
    if (publicUrl) {
      console.log(`[relay] Public URL: ${publicUrl}`);
    }

    const shutdown = () => {
      console.log("\n[relay] Shutting down...");
      server.close()
        .then(() => process.exit(0))
        .catch((err) => {
          console.error("[relay] Shutdown failed:", err);
          process.exit(1);
        });
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })
  .catch((err) => {
    console.error("[relay] Failed to start:", err);
    process.exit(1);
  });
```

- [ ] **Step 6: Install workspace metadata**

Run:

```bash
npm install
```

Expected: `package-lock.json` updates to include `packages/relay` and the command exits with status 0.

- [ ] **Step 7: Build the relay package**

Run:

```bash
npm run build --workspace=packages/relay
```

Expected: PASS with `tsc` completing successfully.

- [ ] **Step 8: Commit**

```bash
git add package-lock.json packages/relay
git commit -m "feat(relay): scaffold self-hosted relay package"
```

---

### Task 2: Relay Server Registration And App Pairing

**Files:**
- Modify: `packages/relay/src/server.ts`
- Create: `packages/relay/src/server.test.ts`

- [ ] **Step 1: Write failing relay server tests**

Add `packages/relay/src/server.test.ts`:

```ts
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startRelayServer, type RunningRelayServer } from "./server.js";

const servers: RunningRelayServer[] = [];

async function startTestRelay() {
  const server = await startRelayServer({
    host: "127.0.0.1",
    port: 0,
    adminToken: "admin-secret",
    publicUrl: "ws://relay.test",
  });
  servers.push(server);
  const address = server.httpServer.address() as AddressInfo;
  return { server, baseUrl: `ws://127.0.0.1:${address.port}` };
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(data.toString()));
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.close();
  }
});

describe("relay server", () => {
  it("registers a bridge and returns appUrl", async () => {
    const { baseUrl } = await startTestRelay();
    const bridge = await openSocket(`${baseUrl}/bridge/register?token=admin-secret`);

    bridge.send(JSON.stringify({
      type: "register",
      roomId: "room-1",
      secret: "room-secret",
      bridgeVersion: "1.61.1",
    }));

    await expect(waitForMessage(bridge)).resolves.toBe(JSON.stringify({
      type: "registered",
      roomId: "room-1",
      secret: "room-secret",
      appUrl: "ws://relay.test/r/room-1",
    }));

    bridge.close();
  });

  it("rejects invalid bridge admin tokens", async () => {
    const { baseUrl } = await startTestRelay();
    const bridge = await openSocket(`${baseUrl}/bridge/register?token=wrong`);

    const closed = await waitForClose(bridge);
    expect(closed.code).toBe(4001);
    expect(closed.reason).toBe("Unauthorized");
  });

  it("pairs app and bridge sockets and forwards text frames", async () => {
    const { baseUrl } = await startTestRelay();
    const bridge = await openSocket(`${baseUrl}/bridge/register?token=admin-secret`);

    bridge.send(JSON.stringify({
      type: "register",
      roomId: "room-2",
      secret: "room-secret",
      bridgeVersion: "1.61.1",
    }));
    await waitForMessage(bridge);

    const app = await openSocket(`${baseUrl}/r/room-2?token=room-secret`);

    app.send(JSON.stringify({ type: "list_sessions" }));
    await expect(waitForMessage(bridge)).resolves.toBe(JSON.stringify({
      type: "list_sessions",
    }));

    bridge.send(JSON.stringify({ type: "session_list", sessions: [] }));
    await expect(waitForMessage(app)).resolves.toBe(JSON.stringify({
      type: "session_list",
      sessions: [],
    }));

    app.close();
    bridge.close();
  });

  it("rejects app sockets with a wrong room secret", async () => {
    const { baseUrl } = await startTestRelay();
    const bridge = await openSocket(`${baseUrl}/bridge/register?token=admin-secret`);

    bridge.send(JSON.stringify({
      type: "register",
      roomId: "room-3",
      secret: "room-secret",
      bridgeVersion: "1.61.1",
    }));
    await waitForMessage(bridge);

    const app = await openSocket(`${baseUrl}/r/room-3?token=wrong`);
    const closed = await waitForClose(app);

    expect(closed.code).toBe(4001);
    expect(closed.reason).toBe("Unauthorized");

    bridge.close();
  });

  it("replaces the old app socket when a new app connects", async () => {
    const { baseUrl } = await startTestRelay();
    const bridge = await openSocket(`${baseUrl}/bridge/register?token=admin-secret`);

    bridge.send(JSON.stringify({
      type: "register",
      roomId: "room-4",
      secret: "room-secret",
      bridgeVersion: "1.61.1",
    }));
    await waitForMessage(bridge);

    const firstApp = await openSocket(`${baseUrl}/r/room-4?token=room-secret`);
    const firstClosed = waitForClose(firstApp);
    const secondApp = await openSocket(`${baseUrl}/r/room-4?token=room-secret`);

    await expect(firstClosed).resolves.toMatchObject({
      code: 4000,
      reason: "Replaced by a new app connection",
    });

    secondApp.send("hello");
    await expect(waitForMessage(bridge)).resolves.toBe("hello");

    secondApp.close();
    bridge.close();
  });

  it("closes paired app socket when bridge disconnects", async () => {
    const { baseUrl } = await startTestRelay();
    const bridge = await openSocket(`${baseUrl}/bridge/register?token=admin-secret`);

    bridge.send(JSON.stringify({
      type: "register",
      roomId: "room-5",
      secret: "room-secret",
      bridgeVersion: "1.61.1",
    }));
    await waitForMessage(bridge);

    const app = await openSocket(`${baseUrl}/r/room-5?token=room-secret`);
    const appClosed = waitForClose(app);
    bridge.close();

    await expect(appClosed).resolves.toMatchObject({
      code: 4000,
      reason: "Bridge disconnected",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test --workspace=packages/relay -- src/server.test.ts
```

Expected: FAIL because `/bridge/register` and `/r/<roomId>` are not implemented.

- [ ] **Step 3: Implement relay WebSocket pairing**

Replace `packages/relay/src/server.ts` with:

```ts
import { randomBytes } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

export interface RelayServerOptions {
  host?: string;
  port?: number;
  adminToken: string;
  publicUrl?: string;
}

export interface RunningRelayServer {
  httpServer: HttpServer;
  close(): Promise<void>;
}

interface Room {
  roomId: string;
  secret: string;
  bridgeSocket: WebSocket;
  appSocket?: WebSocket;
  createdAt: number;
  lastSeenAt: number;
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function normalizePublicUrl(options: RelayServerOptions): string {
  const raw = options.publicUrl?.trim();
  if (raw) return raw.replace(/\/+$/, "");
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 8787;
  return `ws://${host}:${port}`;
}

function closeSocket(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close(code, reason);
  }
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export async function startRelayServer(
  options: RelayServerOptions,
): Promise<RunningRelayServer> {
  if (!options.adminToken) {
    throw new Error("RELAY_ADMIN_TOKEN is required");
  }

  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 8787;
  const publicUrl = normalizePublicUrl(options);
  const startedAt = Date.now();
  const rooms = new Map<string, Room>();

  const httpServer = createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        rooms: rooms.size,
      }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/bridge/register") {
      if (url.searchParams.get("token") !== options.adminToken) {
        closeSocket(ws, 4001, "Unauthorized");
        return;
      }
      handleBridgeRegistration(ws, rooms, publicUrl);
      return;
    }

    const match = url.pathname.match(/^\/r\/([^/]+)$/);
    if (match) {
      handleAppConnection(ws, rooms, match[1], url.searchParams.get("token"));
      return;
    }

    closeSocket(ws, 4004, "Unknown relay path");
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, resolve);
  });

  return {
    httpServer,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const room of rooms.values()) {
          closeSocket(room.appSocket ?? room.bridgeSocket, 1001, "Relay shutting down");
          closeSocket(room.bridgeSocket, 1001, "Relay shutting down");
        }
        wss.close(() => {
          httpServer.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }),
  };
}

function handleBridgeRegistration(
  ws: WebSocket,
  rooms: Map<string, Room>,
  publicUrl: string,
): void {
  ws.once("message", (data, isBinary) => {
    if (isBinary) {
      closeSocket(ws, 4002, "Registration must be JSON text");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      closeSocket(ws, 4002, "Registration must be valid JSON");
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      closeSocket(ws, 4002, "Registration must be an object");
      return;
    }
    const body = parsed as Record<string, unknown>;
    if (body.type !== "register") {
      closeSocket(ws, 4002, "First message must be register");
      return;
    }

    const roomId =
      typeof body.roomId === "string" && body.roomId.trim()
        ? body.roomId.trim()
        : randomToken(16);
    const secret =
      typeof body.secret === "string" && body.secret.trim()
        ? body.secret.trim()
        : randomToken(32);

    const existing = rooms.get(roomId);
    if (existing) {
      closeSocket(existing.appSocket ?? existing.bridgeSocket, 4000, "Bridge replaced");
      closeSocket(existing.bridgeSocket, 4000, "Bridge replaced");
    }

    const room: Room = {
      roomId,
      secret,
      bridgeSocket: ws,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    rooms.set(roomId, room);

    sendJson(ws, {
      type: "registered",
      roomId,
      secret,
      appUrl: `${publicUrl}/r/${encodeURIComponent(roomId)}`,
    });

    ws.on("message", (payload, isBinary) => {
      room.lastSeenAt = Date.now();
      if (!room.appSocket || room.appSocket.readyState !== WebSocket.OPEN) return;
      room.appSocket.send(payload, { binary: isBinary });
    });

    ws.on("close", () => {
      const current = rooms.get(roomId);
      if (current?.bridgeSocket !== ws) return;
      rooms.delete(roomId);
      if (current.appSocket) {
        closeSocket(current.appSocket, 4000, "Bridge disconnected");
      }
    });
  });
}

function handleAppConnection(
  ws: WebSocket,
  rooms: Map<string, Room>,
  roomId: string,
  token: string | null,
): void {
  const room = rooms.get(roomId);
  if (!room || room.bridgeSocket.readyState !== WebSocket.OPEN) {
    closeSocket(ws, 4004, "Room not found");
    return;
  }
  if (token !== room.secret) {
    closeSocket(ws, 4001, "Unauthorized");
    return;
  }

  if (room.appSocket && room.appSocket.readyState === WebSocket.OPEN) {
    closeSocket(room.appSocket, 4000, "Replaced by a new app connection");
  }
  room.appSocket = ws;
  room.lastSeenAt = Date.now();

  ws.on("message", (payload, isBinary) => {
    room.lastSeenAt = Date.now();
    if (room.bridgeSocket.readyState !== WebSocket.OPEN) {
      closeSocket(ws, 4000, "Bridge disconnected");
      return;
    }
    room.bridgeSocket.send(payload, { binary: isBinary });
  });

  ws.on("close", () => {
    if (room.appSocket === ws) {
      room.appSocket = undefined;
    }
  });
}
```

- [ ] **Step 4: Run relay tests**

Run:

```bash
npm run test --workspace=packages/relay -- src/server.test.ts
```

Expected: PASS.

- [ ] **Step 5: Build relay**

Run:

```bash
npm run build --workspace=packages/relay
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/relay/src/server.ts packages/relay/src/server.test.ts
git commit -m "feat(relay): pair bridge and app sockets"
```

---

### Task 3: Bridge Relay Client Core

**Files:**
- Create: `packages/bridge/src/relay-client.ts`
- Create: `packages/bridge/src/relay-client.test.ts`

- [ ] **Step 1: Write failing Bridge relay client tests**

Add `packages/bridge/src/relay-client.test.ts`:

```ts
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import {
  buildRelayRegistrationUrl,
  createRelayCredentials,
  startBridgeRelayClient,
} from "./relay-client.js";

const closeFns: Array<() => Promise<void>> = [];

function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function createWsServer(
  onConnection: (ws: WebSocket, reqUrl: string) => void,
) {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws, req) => onConnection(ws, req.url ?? "/"));

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  closeFns.push(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await closeHttpServer(httpServer);
  });

  const address = httpServer.address() as AddressInfo;
  return `ws://127.0.0.1:${address.port}`;
}

function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(data.toString()));
  });
}

afterEach(async () => {
  while (closeFns.length > 0) {
    await closeFns.pop()!();
  }
});

describe("bridge relay client", () => {
  it("builds relay registration URL", () => {
    expect(buildRelayRegistrationUrl("wss://relay.example.com/", "secret")).toBe(
      "wss://relay.example.com/bridge/register?token=secret",
    );
  });

  it("generates high entropy relay credentials", () => {
    const first = createRelayCredentials();
    const second = createRelayCredentials();

    expect(first.roomId).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(first.roomSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(first.roomId).not.toBe(second.roomId);
    expect(first.roomSecret).not.toBe(second.roomSecret);
  });

  it("registers and proxies frames through a local Bridge socket", async () => {
    let localBridgeSocket: WebSocket | undefined;
    const localBridgeUrl = await createWsServer((ws) => {
      localBridgeSocket = ws;
      ws.on("message", (data) => {
        if (data.toString() === JSON.stringify({ type: "list_sessions" })) {
          ws.send(JSON.stringify({ type: "session_list", sessions: [] }));
        }
      });
    });

    let relaySocket: WebSocket | undefined;
    const registered = vi.fn();
    const relayUrl = await createWsServer((ws) => {
      relaySocket = ws;
      ws.once("message", (data) => {
        registered(JSON.parse(data.toString()));
        ws.send(JSON.stringify({
          type: "registered",
          roomId: "room-1",
          secret: "room-secret",
          appUrl: "ws://relay.test/r/room-1",
        }));
      });
    });

    const log = vi.fn();
    const client = startBridgeRelayClient({
      relayUrl,
      relayToken: "admin-secret",
      localBridgeUrl,
      roomId: "room-1",
      roomSecret: "room-secret",
      bridgeVersion: "1.61.1",
      reconnectDelayMs: 10_000,
      log,
    });
    closeFns.push(() => client.stop());

    await vi.waitFor(() => {
      expect(registered).toHaveBeenCalledWith({
        type: "register",
        roomId: "room-1",
        secret: "room-secret",
        bridgeVersion: "1.61.1",
      });
    });

    relaySocket!.send(JSON.stringify({ type: "list_sessions" }));
    await expect(waitForMessage(relaySocket!)).resolves.toBe(JSON.stringify({
      type: "session_list",
      sessions: [],
    }));

    expect(localBridgeSocket).toBeDefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("ccpocket://connect?url=ws%3A%2F%2Frelay.test%2Fr%2Froom-1&token=room-secret"),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test --workspace=packages/bridge -- src/relay-client.test.ts
```

Expected: FAIL because `relay-client.ts` does not exist.

- [ ] **Step 3: Implement the Bridge relay client**

Add `packages/bridge/src/relay-client.ts`:

```ts
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { buildConnectionUrl } from "./startup-info.js";

export interface RelayCredentials {
  roomId: string;
  roomSecret: string;
}

export interface BridgeRelayClientOptions {
  relayUrl: string;
  relayToken: string;
  localBridgeUrl: string;
  roomId?: string;
  roomSecret?: string;
  bridgeVersion: string;
  reconnectDelayMs?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface BridgeRelayClient {
  stop(): Promise<void>;
}

interface RegisteredMessage {
  type: "registered";
  roomId: string;
  secret: string;
  appUrl: string;
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export function createRelayCredentials(): RelayCredentials {
  return {
    roomId: randomToken(16),
    roomSecret: randomToken(32),
  };
}

export function buildRelayRegistrationUrl(
  relayUrl: string,
  relayToken: string,
): string {
  const url = new URL(relayUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/bridge/register`;
  url.searchParams.set("token", relayToken);
  return url.toString();
}

function parseRegisteredMessage(data: WebSocket.RawData): RegisteredMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  if (
    value.type !== "registered" ||
    typeof value.roomId !== "string" ||
    typeof value.secret !== "string" ||
    typeof value.appUrl !== "string"
  ) {
    return null;
  }
  return {
    type: "registered",
    roomId: value.roomId,
    secret: value.secret,
    appUrl: value.appUrl,
  };
}

export function startBridgeRelayClient(
  options: BridgeRelayClientOptions,
): BridgeRelayClient {
  const log = options.log ?? ((message) => console.log(message));
  const warn = options.warn ?? ((message) => console.warn(message));
  const reconnectDelayMs = options.reconnectDelayMs ?? 5_000;
  const generated = createRelayCredentials();
  const requestedRoomId = options.roomId ?? generated.roomId;
  const requestedSecret = options.roomSecret ?? generated.roomSecret;

  let stopped = false;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let relaySocket: WebSocket | undefined;
  let localSocket: WebSocket | undefined;
  let localOpen = false;
  const pendingRelayFrames: Array<{ data: WebSocket.RawData; binary: boolean }> = [];

  const cleanupSockets = () => {
    localOpen = false;
    if (localSocket) {
      localSocket.removeAllListeners();
      localSocket.close();
      localSocket = undefined;
    }
    if (relaySocket) {
      relaySocket.removeAllListeners();
      relaySocket.close();
      relaySocket = undefined;
    }
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, reconnectDelayMs);
  };

  const connectLocalBridge = () => {
    localOpen = false;
    localSocket = new WebSocket(options.localBridgeUrl);
    localSocket.on("open", () => {
      localOpen = true;
      while (pendingRelayFrames.length > 0 && localSocket?.readyState === WebSocket.OPEN) {
        const frame = pendingRelayFrames.shift()!;
        localSocket.send(frame.data, { binary: frame.binary });
      }
    });
    localSocket.on("message", (data, isBinary) => {
      if (relaySocket?.readyState === WebSocket.OPEN) {
        relaySocket.send(data, { binary: isBinary });
      }
    });
    localSocket.on("close", () => {
      localOpen = false;
      if (!stopped) {
        warn("[relay-client] Local Bridge socket closed");
      }
    });
    localSocket.on("error", (err) => {
      warn(`[relay-client] Local Bridge socket error: ${err.message}`);
    });
  };

  const connect = () => {
    cleanupSockets();
    const registrationUrl = buildRelayRegistrationUrl(
      options.relayUrl,
      options.relayToken,
    );
    relaySocket = new WebSocket(registrationUrl);

    relaySocket.on("open", () => {
      relaySocket?.send(JSON.stringify({
        type: "register",
        roomId: requestedRoomId,
        secret: requestedSecret,
        bridgeVersion: options.bridgeVersion,
      }));
    });

    relaySocket.once("message", (data, isBinary) => {
      if (isBinary) {
        warn("[relay-client] Relay registration response was binary");
        relaySocket?.close();
        return;
      }
      const registered = parseRegisteredMessage(data);
      if (!registered) {
        warn("[relay-client] Relay registration response was invalid");
        relaySocket?.close();
        return;
      }

      const deepLink = buildConnectionUrl(registered.appUrl, registered.secret);
      log(`[relay-client] Relay registered: ${registered.appUrl}`);
      log(`[relay-client] Deep Link: ${deepLink}`);

      connectLocalBridge();

      relaySocket?.on("message", (payload, binary) => {
        if (localOpen && localSocket?.readyState === WebSocket.OPEN) {
          localSocket.send(payload, { binary });
          return;
        }
        pendingRelayFrames.push({ data: payload, binary });
      });
    });

    relaySocket.on("close", () => {
      cleanupSockets();
      scheduleReconnect();
    });
    relaySocket.on("error", (err) => {
      warn(`[relay-client] Relay socket error: ${err.message}`);
    });
  };

  connect();

  return {
    stop: async () => {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      cleanupSockets();
    },
  };
}
```

- [ ] **Step 4: Run Bridge relay client tests**

Run:

```bash
npm run test --workspace=packages/bridge -- src/relay-client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck Bridge**

Run:

```bash
npx tsc --noEmit -p packages/bridge/tsconfig.json
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/bridge/src/relay-client.ts packages/bridge/src/relay-client.test.ts
git commit -m "feat(bridge): add relay client"
```

---

### Task 4: Bridge CLI And Startup Integration

**Files:**
- Modify: `packages/bridge/src/cli-args.ts`
- Modify: `packages/bridge/src/cli-args.test.ts`
- Modify: `packages/bridge/src/cli.ts`
- Modify: `packages/bridge/src/index.ts`

- [ ] **Step 1: Write failing CLI arg tests**

Append to `packages/bridge/src/cli-args.test.ts`:

```ts
  it("parses relay value flags", () => {
    const parsed = parseCliArgs([
      "--relay-url",
      "wss://relay.example.com",
      "--relay-token=admin-secret",
      "--relay-room-id",
      "room-1",
      "--relay-room-secret=room-secret",
    ]);

    expect(parseFlag(parsed, "relay-url")).toBe("wss://relay.example.com");
    expect(parseFlag(parsed, "relay-token")).toBe("admin-secret");
    expect(parseFlag(parsed, "relay-room-id")).toBe("room-1");
    expect(parseFlag(parsed, "relay-room-secret")).toBe("room-secret");
  });
```

- [ ] **Step 2: Run CLI arg tests to verify they fail**

Run:

```bash
npm run test --workspace=packages/bridge -- src/cli-args.test.ts
```

Expected: FAIL because relay flags are not in `VALUE_FLAGS`.

- [ ] **Step 3: Add relay flags to `cli-args.ts`**

Modify the `VALUE_FLAGS` set in `packages/bridge/src/cli-args.ts`:

```ts
const VALUE_FLAGS = new Set([
  "port",
  "host",
  "api-key",
  "public-ws-url",
  "relay-url",
  "relay-token",
  "relay-room-id",
  "relay-room-secret",
  "codex-app-server-mode",
  "codex-shared-app-server-url",
  "codex-app-server-port",
  "codex-app-server-url",
]);
```

- [ ] **Step 4: Update CLI help and env propagation**

In `packages/bridge/src/cli.ts`, add help text under `--public-ws-url`:

```ts
      --relay-url <url> Public ws:// or wss:// relay URL for self-hosted relay mode
      --relay-token <token>
                         Admin token used to register this Bridge with the relay
      --relay-room-id <id>
                         Optional stable relay room id
      --relay-room-secret <secret>
                         Optional stable relay room secret used by the app
```

In the server mode section, add parsing:

```ts
  const relayUrl = parseFlag(parsed, "relay-url");
  const relayToken = parseFlag(parsed, "relay-token");
  const relayRoomId = parseFlag(parsed, "relay-room-id");
  const relayRoomSecret = parseFlag(parsed, "relay-room-secret");
```

After `if (publicWsUrl) process.env.BRIDGE_PUBLIC_WS_URL = publicWsUrl;`, add:

```ts
  if (relayUrl) process.env.BRIDGE_RELAY_URL = relayUrl;
  if (relayToken) process.env.BRIDGE_RELAY_TOKEN = relayToken;
  if (relayRoomId) process.env.BRIDGE_RELAY_ROOM_ID = relayRoomId;
  if (relayRoomSecret) process.env.BRIDGE_RELAY_ROOM_SECRET = relayRoomSecret;
```

Do not add relay options to `setup` service templates in this task; service
installation can keep using environment variables manually until relay mode is
stable.

- [ ] **Step 5: Start the Bridge relay client from `index.ts`**

In `packages/bridge/src/index.ts`, add imports:

```ts
import { startBridgeRelayClient, type BridgeRelayClient } from "./relay-client.js";
```

After `let wsServer: BridgeWebSocketServer | null = null;`, add:

```ts
  let relayClient: BridgeRelayClient | null = null;
```

Inside the `httpServer.listen(PORT, HOST, () => { ... })` callback, after
`printStartupInfo(PORT, HOST, API_KEY);`, add:

```ts
    const relayUrl = process.env.BRIDGE_RELAY_URL?.trim();
    if (relayUrl) {
      const relayToken = process.env.BRIDGE_RELAY_TOKEN?.trim();
      if (!relayToken) {
        console.warn("[bridge] Relay disabled: BRIDGE_RELAY_TOKEN is required when BRIDGE_RELAY_URL is set");
      } else {
        relayClient = startBridgeRelayClient({
          relayUrl,
          relayToken,
          localBridgeUrl: `ws://127.0.0.1:${PORT}${API_KEY ? `?token=${encodeURIComponent(API_KEY)}` : ""}`,
          roomId: process.env.BRIDGE_RELAY_ROOM_ID,
          roomSecret: process.env.BRIDGE_RELAY_ROOM_SECRET,
          bridgeVersion: getVersionInfo(startedAt).version,
        });
      }
    }
```

In `shutdown()`, before `wsServer?.close();`, add:

```ts
    void relayClient?.stop();
```

- [ ] **Step 6: Run targeted Bridge tests**

Run:

```bash
npm run test --workspace=packages/bridge -- src/cli-args.test.ts src/relay-client.test.ts
```

Expected: PASS.

- [ ] **Step 7: Typecheck Bridge**

Run:

```bash
npx tsc --noEmit -p packages/bridge/tsconfig.json
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/bridge/src/cli-args.ts packages/bridge/src/cli-args.test.ts packages/bridge/src/cli.ts packages/bridge/src/index.ts
git commit -m "feat(bridge): wire relay client startup"
```

---

### Task 5: Relay Deep Link QR Output

**Files:**
- Modify: `packages/bridge/src/startup-info.ts`
- Modify: `packages/bridge/src/startup-info.test.ts`
- Modify: `packages/bridge/src/relay-client.ts`
- Modify: `packages/bridge/src/relay-client.test.ts`

- [ ] **Step 1: Write failing startup info test**

Append to `packages/bridge/src/startup-info.test.ts`:

```ts
  describe("printConnectionQr", () => {
    it("prints a labelled relay deep link and QR code", async () => {
      const { printConnectionQr } = await import("./startup-info.js");

      await printConnectionQr({
        title: "Relay Connection",
        wsUrl: "wss://relay.example.com/r/room-1",
        token: "room-secret",
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("[bridge] ─── Relay Connection"),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Deep Link: ccpocket://connect?url=wss%3A%2F%2Frelay.example.com%2Fr%2Froom-1&token=room-secret",
        ),
      );
      expect(mockQrToString).toHaveBeenCalledWith(
        "ccpocket://connect?url=wss%3A%2F%2Frelay.example.com%2Fr%2Froom-1&token=room-secret",
        expect.objectContaining({ type: "terminal", small: true }),
      );
    });
  });
```

- [ ] **Step 2: Run startup info test to verify it fails**

Run:

```bash
npm run test --workspace=packages/bridge -- src/startup-info.test.ts
```

Expected: FAIL because `printConnectionQr` is not exported.

- [ ] **Step 3: Add reusable QR printer**

In `packages/bridge/src/startup-info.ts`, add:

```ts
export async function printConnectionQr(params: {
  title: string;
  wsUrl: string;
  token?: string;
}): Promise<void> {
  const deepLink = buildConnectionUrl(params.wsUrl, params.token);
  const lines: string[] = [];
  lines.push("");
  lines.push(`[bridge] ─── ${params.title} ───────────────────────────`);
  lines.push(`[bridge]   URL:        ${params.wsUrl}`);
  lines.push("");
  lines.push(`[bridge]   Deep Link: ${deepLink}`);
  lines.push("");
  lines.push("[bridge]   Scan QR code with ccpocket app:");
  console.log(lines.join("\n"));

  try {
    const qrText = await QRCode.toString(deepLink, {
      type: "terminal",
      small: true,
    });
    const indented = qrText
      .split("\n")
      .map((line) => `           ${line}`)
      .join("\n");
    console.log(indented);
  } catch {
    console.log("[bridge]   (QR code generation failed)");
  }

  console.log("[bridge] ───────────────────────────────────────────────");
}
```

Leave `printStartupInfo()` behavior unchanged for direct connection info.

- [ ] **Step 4: Use QR printer in relay client**

In `packages/bridge/src/relay-client.ts`, change the import:

```ts
import { buildConnectionUrl, printConnectionQr } from "./startup-info.js";
```

After a valid registration, replace the two deep-link log lines:

```ts
      const deepLink = buildConnectionUrl(registered.appUrl, registered.secret);
      log(`[relay-client] Relay registered: ${registered.appUrl}`);
      log(`[relay-client] Deep Link: ${deepLink}`);
```

with:

```ts
      const deepLink = buildConnectionUrl(registered.appUrl, registered.secret);
      log(`[relay-client] Relay registered: ${registered.appUrl}`);
      log(`[relay-client] Deep Link: ${deepLink}`);
      void printConnectionQr({
        title: "Relay Connection",
        wsUrl: registered.appUrl,
        token: registered.secret,
      });
```

The log calls stay in place so existing tests can keep asserting without
mocking QR output.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
npm run test --workspace=packages/bridge -- src/startup-info.test.ts src/relay-client.test.ts
```

Expected: PASS.

- [ ] **Step 6: Typecheck Bridge**

Run:

```bash
npx tsc --noEmit -p packages/bridge/tsconfig.json
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/bridge/src/startup-info.ts packages/bridge/src/startup-info.test.ts packages/bridge/src/relay-client.ts packages/bridge/src/relay-client.test.ts
git commit -m "feat(bridge): print relay connection QR"
```

---

### Task 6: Flutter Compatibility Tests

**Files:**
- Modify: `apps/mobile/test/connection_url_parser_test.dart`
- Modify: `apps/mobile/test/services/bridge_service_usage_test.dart`

- [ ] **Step 1: Add relay deep link parser test**

In `apps/mobile/test/connection_url_parser_test.dart`, inside
`group('deep link - connect (ccpocket://connect)', () { ... })`, add:

```dart
      test('parses relay path deep link with token', () {
        final result =
            ConnectionUrlParser.parse(
                  'ccpocket://connect?url=wss://relay.example.com/r/room-1&token=room-secret',
                )
                as ConnectionParams?;

        expect(result, isNotNull);
        expect(result!.serverUrl, 'wss://relay.example.com/r/room-1');
        expect(result.token, 'room-secret');
      });
```

- [ ] **Step 2: Add relay token append test**

In `apps/mobile/test/services/bridge_service_usage_test.dart`, inside the top
`group('BridgeService usage cache', () { ... })`, add:

```dart
    test('autoConnect preserves relay path when appending token', () async {
      SharedPreferences.setMockInitialValues({
        'bridge_url': 'ws://127.0.0.1:9/r/room-1',
      });

      final bridge = BridgeService();

      final attempted = await bridge.autoConnect(apiKey: 'room-secret');

      expect(attempted, isTrue);
      expect(
        bridge.lastUrl,
        'ws://127.0.0.1:9/r/room-1?token=room-secret',
      );

      bridge.disconnect();
      bridge.dispose();
    });
```

- [ ] **Step 3: Run Flutter compatibility tests**

Run:

```bash
cd apps/mobile && flutter test test/connection_url_parser_test.dart test/services/bridge_service_usage_test.dart
```

Expected: PASS.

- [ ] **Step 4: Format Dart files**

Run:

```bash
dart format apps/mobile/test/connection_url_parser_test.dart apps/mobile/test/services/bridge_service_usage_test.dart
```

Expected: formatter exits with status 0.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/test/connection_url_parser_test.dart apps/mobile/test/services/bridge_service_usage_test.dart
git commit -m "test(mobile): cover relay-compatible connection URLs"
```

---

### Task 7: Documentation And Package Scripts

**Files:**
- Modify: `package.json`
- Modify: `packages/bridge/README.md`
- Create: `packages/relay/README.md`

- [ ] **Step 1: Add root relay scripts**

In root `package.json`, add scripts:

```json
    "relay": "npm run dev --workspace=packages/relay",
    "relay:build": "npm run build --workspace=packages/relay",
    "test:relay": "npm run test --workspace=packages/relay",
```

Keep existing scripts unchanged.

- [ ] **Step 2: Document Bridge relay mode**

In `packages/bridge/README.md`, add environment variables to the configuration
table:

```markdown
| `BRIDGE_RELAY_URL` | (none) | Trusted self-hosted relay `ws://` / `wss://` URL. Relay mode is disabled when unset |
| `BRIDGE_RELAY_TOKEN` | (none) | Admin token used by Bridge to register with the relay |
| `BRIDGE_RELAY_ROOM_ID` | generated | Optional stable relay room id |
| `BRIDGE_RELAY_ROOM_SECRET` | generated | Optional stable room secret used by the app deep link |
```

After the `BRIDGE_PUBLIC_WS_URL` explanation, add:

```markdown
## Trusted self-hosted relay

Relay mode is an explicit opt-in path for a trusted server you control. It is
useful when the phone cannot directly reach the computer and you do not want to
set up Tailscale.

Start the relay on the public server:

```bash
RELAY_ADMIN_TOKEN=change-me \
RELAY_PUBLIC_URL=wss://relay.example.com \
npm run relay
```

Start the Bridge with relay mode:

```bash
BRIDGE_RELAY_URL=wss://relay.example.com \
BRIDGE_RELAY_TOKEN=change-me \
npx @ccpocket/bridge@latest
```

The Bridge prints a `ccpocket://connect?...` deep link and QR code. Scan it with
the existing app.

Relay v1 forwards the normal CC Pocket WebSocket protocol as plaintext inside
the relay process. Use it only with a trusted self-hosted relay. A public shared
relay should add app-level end-to-end encryption first.
```

- [ ] **Step 3: Add relay package README**

Add `packages/relay/README.md`:

```markdown
# @ccpocket/relay

Trusted self-hosted WebSocket relay for CC Pocket.

This package lets a local Bridge register an outbound WebSocket connection with
a public server. The mobile app then connects to the public relay URL, and the
relay forwards WebSocket text frames between the app and Bridge.

## Usage

```bash
RELAY_ADMIN_TOKEN=change-me \
RELAY_PUBLIC_URL=wss://relay.example.com \
npm run dev --workspace=packages/relay
```

The public endpoint must support WebSocket Upgrade. Use `wss://` for mobile and
public internet usage.

## Privacy

Relay v1 is for trusted self-hosted use. It forwards the normal CC Pocket
protocol through the relay process, so the relay operator can observe plaintext
payloads. Do not run this as a public shared relay without adding application
level encryption.
```

- [ ] **Step 4: Run docs-adjacent checks**

Run:

```bash
npm run relay:build
npm run bridge:build
```

Expected: both builds PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json packages/bridge/README.md packages/relay/README.md
git commit -m "docs: document self-hosted relay setup"
```

---

### Task 8: End-To-End Local Relay Smoke Test

**Files:**
- No committed source changes expected unless this test exposes a bug.

- [ ] **Step 1: Build Bridge and relay**

Run:

```bash
npm run bridge:build
npm run relay:build
```

Expected: both builds PASS.

- [ ] **Step 2: Start local relay**

Run in a terminal:

```bash
RELAY_ADMIN_TOKEN=dev-secret \
RELAY_PUBLIC_URL=ws://127.0.0.1:8787 \
npm run relay
```

Expected: relay logs that it is listening on `http://0.0.0.0:8787`.

- [ ] **Step 3: Start Bridge with relay mode on a non-default port**

Run in another terminal:

```bash
BRIDGE_PORT=8766 \
BRIDGE_RELAY_URL=ws://127.0.0.1:8787 \
BRIDGE_RELAY_TOKEN=dev-secret \
npm run bridge
```

Expected: Bridge starts, relay client registers, and Bridge prints a relay deep
link like:

```text
ccpocket://connect?url=ws%3A%2F%2F127.0.0.1%3A8787%2Fr%2F<room>&token=<secret>
```

- [ ] **Step 4: Connect through relay with a WebSocket client**

Copy the decoded relay URL from the Bridge log and connect with `wscat`:

```bash
npx wscat -c "ws://127.0.0.1:8787/r/<room>?token=<secret>"
```

Send:

```json
{"type":"list_sessions"}
```

Expected: receive a `session_list` JSON message from the local Bridge.

- [ ] **Step 5: Stop smoke-test processes**

Stop the Bridge and relay terminals with Ctrl-C.

Expected: both shut down without uncaught exceptions.

- [ ] **Step 6: Commit smoke-test fixes when source files changed**

Run:

```bash
git status --short
```

Expected when the smoke test passed without fixes: no source changes.

If Step 4 exposed a bug and you fixed source files, inspect the exact changed
paths from `git status --short`, stage only those relay-related files, and
commit the focused fix:

```bash
git add packages/bridge/src/relay-client.ts packages/relay/src/server.ts
git commit -m "fix(relay): handle local smoke test flow"
```

If only one of those files changed, stage only that file. Do not create an empty
commit when `git status --short` is clean.

---

### Task 9: Final Verification

**Files:**
- No source changes expected unless verification exposes a bug.

- [ ] **Step 1: Run Bridge tests for relay-adjacent files**

Run:

```bash
npm run test --workspace=packages/bridge -- src/cli-args.test.ts src/startup-info.test.ts src/relay-client.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run relay tests**

Run:

```bash
npm run test --workspace=packages/relay
```

Expected: PASS.

- [ ] **Step 3: Typecheck Bridge**

Run:

```bash
npx tsc --noEmit -p packages/bridge/tsconfig.json
```

Expected: PASS.

- [ ] **Step 4: Build relay**

Run:

```bash
npm run build --workspace=packages/relay
```

Expected: PASS.

- [ ] **Step 5: Run Flutter compatibility tests**

Run:

```bash
cd apps/mobile && flutter test test/connection_url_parser_test.dart test/services/bridge_service_usage_test.dart
```

Expected: PASS.

- [ ] **Step 6: Check worktree status**

Run:

```bash
git status --short
```

Expected: no unstaged source changes except any intentional final documentation or lockfile updates already committed.

---

## Self-Review Notes

- Spec coverage: relay server, Bridge relay client, explicit opt-in config, plaintext trusted boundary, Flutter no-runtime-change compatibility, WebSocket Upgrade/WSS requirement, docs, and local smoke test are all represented.
- Scope: one deployable relay server plus Bridge integration. Public multi-tenant hardening and app-level encryption remain out of scope.
- Type consistency: plan uses `roomId`, `roomSecret`, `relayUrl`, `relayToken`, `BridgeRelayClient`, and `RunningRelayServer` consistently across tasks.
