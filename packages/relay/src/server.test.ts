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
