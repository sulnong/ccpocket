import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  startRelayServer,
  type RelayServerOptions,
  type RunningRelayServer,
} from "./server.js";

const servers: RunningRelayServer[] = [];

async function startTestRelay(options: Partial<RelayServerOptions> = {}) {
  const server = await startRelayServer({
    host: "127.0.0.1",
    port: 0,
    adminToken: "test-key-admin",
    publicUrl: "ws://relay.test",
    ...options,
  });
  servers.push(server);
  const address = server.httpServer.address() as AddressInfo;
  return {
    server,
    baseUrl: `ws://127.0.0.1:${address.port}`,
    httpUrl: `http://127.0.0.1:${address.port}`,
  };
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

async function registerBridge(
  baseUrl: string,
  roomId: string,
  secret: string,
): Promise<WebSocket> {
  const bridge = await openSocket(`${baseUrl}/bridge/register`);
  bridge.send(JSON.stringify({
    type: "register",
    roomId,
    secret,
    bridgeVersion: "1.61.1",
  }));
  await waitForMessage(bridge);
  return bridge;
}

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.close();
  }
});

describe("relay server", () => {
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

  it("registers a bridge and returns appUrl", async () => {
    const { baseUrl } = await startTestRelay();
    const bridge = await openSocket(`${baseUrl}/bridge/register?token=test-key-admin`);

    bridge.send(JSON.stringify({
      type: "register",
      roomId: "room-1",
      secret: "test-key-room",
      bridgeVersion: "1.61.1",
    }));

    await expect(waitForMessage(bridge)).resolves.toBe(JSON.stringify({
      type: "registered",
      roomId: "room-1",
      secret: "test-key-room",
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

  it("closes the sending socket when a forwarded frame is too large", async () => {
    const { baseUrl } = await startTestRelay({
      adminToken: "",
      maxMessageBytes: 128,
    });
    const bridge = await registerBridge(baseUrl, "room-size", "test-key-size");
    const app = await openSocket(`${baseUrl}/r/room-size?token=test-key-size`);

    app.send("x".repeat(129));

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

  it("pairs app and bridge sockets and forwards text frames", async () => {
    const { baseUrl } = await startTestRelay();
    const bridge = await openSocket(`${baseUrl}/bridge/register?token=test-key-admin`);

    bridge.send(JSON.stringify({
      type: "register",
      roomId: "room-2",
      secret: "test-key-room",
      bridgeVersion: "1.61.1",
    }));
    await waitForMessage(bridge);

    const app = await openSocket(`${baseUrl}/r/room-2?token=test-key-room`);

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
    const bridge = await openSocket(`${baseUrl}/bridge/register?token=test-key-admin`);

    bridge.send(JSON.stringify({
      type: "register",
      roomId: "room-3",
      secret: "test-key-room",
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
    const bridge = await openSocket(`${baseUrl}/bridge/register?token=test-key-admin`);

    bridge.send(JSON.stringify({
      type: "register",
      roomId: "room-4",
      secret: "test-key-room",
      bridgeVersion: "1.61.1",
    }));
    await waitForMessage(bridge);

    const firstApp = await openSocket(`${baseUrl}/r/room-4?token=test-key-room`);
    const firstClosed = waitForClose(firstApp);
    const secondApp = await openSocket(`${baseUrl}/r/room-4?token=test-key-room`);

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
    const bridge = await openSocket(`${baseUrl}/bridge/register?token=test-key-admin`);

    bridge.send(JSON.stringify({
      type: "register",
      roomId: "room-5",
      secret: "test-key-room",
      bridgeVersion: "1.61.1",
    }));
    await waitForMessage(bridge);

    const app = await openSocket(`${baseUrl}/r/room-5?token=test-key-room`);
    const appClosed = waitForClose(app);
    bridge.close();

    await expect(appClosed).resolves.toMatchObject({
      code: 4000,
      reason: "Bridge disconnected",
    });
  });
});
