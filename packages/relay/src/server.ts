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
  if (
    ws.readyState === WebSocket.OPEN ||
    ws.readyState === WebSocket.CONNECTING
  ) {
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
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );

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
          if (room.appSocket) {
            closeSocket(room.appSocket, 1001, "Relay shutting down");
          }
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
      if (existing.appSocket) {
        closeSocket(existing.appSocket, 4000, "Bridge replaced");
      }
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
      if (!room.appSocket || room.appSocket.readyState !== WebSocket.OPEN) {
        return;
      }
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
