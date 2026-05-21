import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import {
  buildRelayRegistrationUrl,
  createRelayCredentials,
  normalizeRelayAppUrl,
  resolveBridgeRelayUrl,
  startBridgeRelayClient,
} from "./relay-client.js";

const closeFns: Array<() => Promise<void>> = [];
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

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

beforeEach(() => {
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  consoleLogSpy.mockRestore();
  while (closeFns.length > 0) {
    await closeFns.pop()!();
  }
});

describe("bridge relay client", () => {
  it("builds relay registration URL", () => {
    expect(
      buildRelayRegistrationUrl("wss://relay.example.com/", "test-key-admin"),
    ).toBe("wss://relay.example.com/bridge/register?token=test-key-admin");
  });

  it("omits registration token when relay token is not configured", () => {
    expect(buildRelayRegistrationUrl("wss://relay.example.com/")).toBe(
      "wss://relay.example.com/bridge/register",
    );
  });

  it("uses the default public relay when no relay URL is configured", () => {
    expect(resolveBridgeRelayUrl({})).toBe("wss://nqqlcknhdxys.sealoshzh.site");
  });

  it("prefers configured relay URL over the default public relay", () => {
    expect(resolveBridgeRelayUrl({
      BRIDGE_RELAY_URL: " wss://custom-relay.example.com ",
    })).toBe("wss://custom-relay.example.com");
  });

  it("rewrites wildcard relay app URLs using the configured relay URL", () => {
    expect(
      normalizeRelayAppUrl(
        "ws://0.0.0.0:8787/r/room-1",
        "wss://nqqlcknhdxys.sealoshzh.site",
      ),
    ).toBe("wss://nqqlcknhdxys.sealoshzh.site/r/room-1");
  });

  it("preserves valid relay app URLs", () => {
    expect(
      normalizeRelayAppUrl(
        "wss://relay.example.com/r/room-1",
        "wss://nqqlcknhdxys.sealoshzh.site",
      ),
    ).toBe("wss://relay.example.com/r/room-1");
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
          secret: "test-key-room",
          appUrl: "ws://relay.test/r/room-1",
        }));
      });
    });

    const log = vi.fn();
    const client = startBridgeRelayClient({
      relayUrl,
      localBridgeUrl,
      roomId: "room-1",
      roomSecret: "test-key-room",
      bridgeVersion: "1.61.1",
      reconnectDelayMs: 10_000,
      log,
    });
    closeFns.push(() => client.stop());

    await vi.waitFor(() => {
      expect(registered).toHaveBeenCalledWith({
        type: "register",
        roomId: "room-1",
        secret: "test-key-room",
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
      expect.stringContaining("ccpocket://connect?url=ws%3A%2F%2Frelay.test%2Fr%2Froom-1&token=test-key-room"),
    );
  });

  it("warns when relay registration is rejected before a QR code can be printed", async () => {
    const relayUrl = await createWsServer((ws) => {
      ws.close(4001, "Unauthorized");
    });

    const warn = vi.fn();
    const client = startBridgeRelayClient({
      relayUrl,
      localBridgeUrl: "ws://127.0.0.1:9",
      bridgeVersion: "1.61.1",
      reconnectDelayMs: 10_000,
      warn,
    });
    closeFns.push(() => client.stop());

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Relay registration closed before QR code was printed: 4001 Unauthorized"),
      );
    });
  });
});
