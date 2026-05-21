import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
} from "node:http";
import { WebSocket, WebSocketServer } from "ws";

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

export interface RunningRelayServer {
  httpServer: HttpServer;
  close(): Promise<void>;
}

interface Room {
  roomId: string;
  secret: string;
  bridgeSocket: WebSocket;
  appSocket?: WebSocket;
  clientIp: string;
  createdAt: number;
  lastSeenAt: number;
}

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
  rejectionsByIp: Map<string, number[]>;
  socketAlive: WeakMap<WebSocket, boolean>;
  counters: RelayCounters;
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

function createRelayState(): RelayState {
  return {
    rooms: new Map(),
    connections: new Set(),
    bridgeSockets: new Set(),
    appSockets: new Set(),
    connectionsByIp: new Map(),
    roomsByIp: new Map(),
    rejectionsByIp: new Map(),
    socketAlive: new WeakMap(),
    counters: {
      rejectedConnections: 0,
      closedIdleRooms: 0,
      closedOversizedMessages: 0,
    },
  };
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

function incrementMap(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decrementMap(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 0) - 1;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

function getClientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function pruneRejections(
  state: RelayState,
  clientIp: string,
  now: number,
  abuseWindowMs: number,
): number[] {
  const cutoff = now - abuseWindowMs;
  const entries = (state.rejectionsByIp.get(clientIp) ?? []).filter((time) =>
    time >= cutoff
  );
  if (entries.length === 0) state.rejectionsByIp.delete(clientIp);
  else state.rejectionsByIp.set(clientIp, entries);
  return entries;
}

function isIpBlocked(
  state: RelayState,
  limits: RelayLimits,
  clientIp: string,
): boolean {
  return pruneRejections(
    state,
    clientIp,
    Date.now(),
    limits.abuseWindowMs,
  ).length >= limits.maxRejectionsPerIp;
}

function recordRejection(
  state: RelayState,
  limits: RelayLimits,
  clientIp: string,
): void {
  const now = Date.now();
  const entries = pruneRejections(state, clientIp, now, limits.abuseWindowMs);
  entries.push(now);
  state.rejectionsByIp.set(clientIp, entries);
  state.counters.rejectedConnections++;
}

function rejectConnection(
  state: RelayState,
  limits: RelayLimits,
  clientIp: string,
  ws: WebSocket,
  code: number,
  reason: string,
): void {
  recordRejection(state, limits, clientIp);
  closeSocket(ws, code, reason);
}

function rawDataBytes(data: WebSocket.RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.reduce((sum, item) => sum + item.byteLength, 0);
}

function closeOversizedMessage(
  state: RelayState,
  limits: RelayLimits,
  clientIp: string,
  ws: WebSocket,
): void {
  state.counters.closedOversizedMessages++;
  rejectConnection(state, limits, clientIp, ws, 4009, "Message too large");
}

function removeRoom(
  state: RelayState,
  room: Room,
  bridgeCode: number,
  reason: string,
): void {
  if (room.appSocket) {
    closeSocket(room.appSocket, bridgeCode, reason);
  }
  closeSocket(room.bridgeSocket, bridgeCode, reason);
  state.rooms.delete(room.roomId);
  decrementMap(state.roomsByIp, room.clientIp);
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export async function startRelayServer(
  options: RelayServerOptions,
): Promise<RunningRelayServer> {
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 8787;
  const adminToken = options.adminToken?.trim() ?? "";
  const publicUrl = normalizePublicUrl(options);
  const limits = resolveLimits(options);
  const startedAt = Date.now();
  const state = createRelayState();

  const httpServer = createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
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
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws, req) => {
    const clientIp = getClientIp(req);
    if (isIpBlocked(state, limits, clientIp)) {
      state.counters.rejectedConnections++;
      closeSocket(ws, 4008, "Too many rejected attempts");
      return;
    }
    if (state.connections.size >= limits.maxConnections) {
      rejectConnection(
        state,
        limits,
        clientIp,
        ws,
        4008,
        "Connection limit exceeded",
      );
      return;
    }
    if (
      (state.connectionsByIp.get(clientIp) ?? 0) >=
      limits.maxConnectionsPerIp
    ) {
      rejectConnection(
        state,
        limits,
        clientIp,
        ws,
        4008,
        "Connection limit exceeded",
      );
      return;
    }

    state.connections.add(ws);
    incrementMap(state.connectionsByIp, clientIp);
    state.socketAlive.set(ws, true);
    ws.on("pong", () => {
      state.socketAlive.set(ws, true);
    });
    ws.on("close", () => {
      state.connections.delete(ws);
      decrementMap(state.connectionsByIp, clientIp);
    });

    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );

    if (url.pathname === "/bridge/register") {
      if (adminToken && url.searchParams.get("token") !== adminToken) {
        rejectConnection(state, limits, clientIp, ws, 4001, "Unauthorized");
        return;
      }
      handleBridgeRegistration(ws, state, publicUrl, limits, clientIp);
      return;
    }

    const match = url.pathname.match(/^\/r\/([^/]+)$/);
    if (match) {
      handleAppConnection(
        ws,
        state,
        match[1],
        url.searchParams.get("token"),
        limits,
        clientIp,
      );
      return;
    }

    rejectConnection(state, limits, clientIp, ws, 4004, "Unknown relay path");
  });

  const maintenanceInterval = setInterval(() => {
    const now = Date.now();
    for (const room of [...state.rooms.values()]) {
      if (now - room.lastSeenAt >= limits.idleRoomTtlMs) {
        state.counters.closedIdleRooms++;
        removeRoom(state, room, 4000, "Room idle timeout");
      }
    }

    for (const ws of [...state.connections]) {
      if (ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      if (state.socketAlive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      state.socketAlive.set(ws, false);
      ws.ping();
    }
  }, limits.heartbeatIntervalMs);

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, resolve);
  });

  return {
    httpServer,
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(maintenanceInterval);
        for (const room of state.rooms.values()) {
          if (room.appSocket) {
            closeSocket(room.appSocket, 1001, "Relay shutting down");
          }
          closeSocket(room.bridgeSocket, 1001, "Relay shutting down");
        }
        for (const connection of state.connections) {
          closeSocket(connection, 1001, "Relay shutting down");
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
  state: RelayState,
  publicUrl: string,
  limits: RelayLimits,
  clientIp: string,
): void {
  ws.once("message", (data, isBinary) => {
    if (isBinary) {
      rejectConnection(
        state,
        limits,
        clientIp,
        ws,
        4002,
        "Registration must be JSON text",
      );
      return;
    }
    if (rawDataBytes(data) > limits.maxMessageBytes) {
      closeOversizedMessage(state, limits, clientIp, ws);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      rejectConnection(
        state,
        limits,
        clientIp,
        ws,
        4002,
        "Registration must be valid JSON",
      );
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      rejectConnection(
        state,
        limits,
        clientIp,
        ws,
        4002,
        "Registration must be an object",
      );
      return;
    }
    const body = parsed as Record<string, unknown>;
    if (body.type !== "register") {
      rejectConnection(
        state,
        limits,
        clientIp,
        ws,
        4002,
        "First message must be register",
      );
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

    const existing = state.rooms.get(roomId);
    if (!existing && state.rooms.size >= limits.maxRooms) {
      rejectConnection(state, limits, clientIp, ws, 4008, "Room limit exceeded");
      return;
    }
    if (
      !existing &&
      (state.roomsByIp.get(clientIp) ?? 0) >= limits.maxRoomsPerIp
    ) {
      rejectConnection(state, limits, clientIp, ws, 4008, "Room limit exceeded");
      return;
    }

    if (existing) {
      if (existing.appSocket) {
        closeSocket(existing.appSocket, 4000, "Bridge replaced");
      }
      closeSocket(existing.bridgeSocket, 4000, "Bridge replaced");
      decrementMap(state.roomsByIp, existing.clientIp);
    }

    const room: Room = {
      roomId,
      secret,
      bridgeSocket: ws,
      clientIp,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    state.rooms.set(roomId, room);
    state.bridgeSockets.add(ws);
    incrementMap(state.roomsByIp, clientIp);

    sendJson(ws, {
      type: "registered",
      roomId,
      secret,
      appUrl: `${publicUrl}/r/${encodeURIComponent(roomId)}`,
    });

    ws.on("message", (payload, isBinary) => {
      room.lastSeenAt = Date.now();
      if (rawDataBytes(payload) > limits.maxMessageBytes) {
        closeOversizedMessage(state, limits, clientIp, ws);
        return;
      }
      if (!room.appSocket || room.appSocket.readyState !== WebSocket.OPEN) {
        return;
      }
      room.appSocket.send(payload, { binary: isBinary });
    });

    ws.on("close", () => {
      state.bridgeSockets.delete(ws);
      const current = state.rooms.get(roomId);
      if (current?.bridgeSocket !== ws) return;
      state.rooms.delete(roomId);
      decrementMap(state.roomsByIp, current.clientIp);
      if (current.appSocket) {
        closeSocket(current.appSocket, 4000, "Bridge disconnected");
      }
    });
  });
}

function handleAppConnection(
  ws: WebSocket,
  state: RelayState,
  roomId: string,
  token: string | null,
  limits?: RelayLimits,
  clientIp = "unknown",
): void {
  const room = state.rooms.get(roomId);
  if (!room || room.bridgeSocket.readyState !== WebSocket.OPEN) {
    if (limits) {
      rejectConnection(state, limits, clientIp, ws, 4004, "Room not found");
    } else {
      closeSocket(ws, 4004, "Room not found");
    }
    return;
  }
  if (token !== room.secret) {
    if (limits) {
      rejectConnection(state, limits, clientIp, ws, 4001, "Unauthorized");
    } else {
      closeSocket(ws, 4001, "Unauthorized");
    }
    return;
  }

  if (room.appSocket && room.appSocket.readyState === WebSocket.OPEN) {
    closeSocket(room.appSocket, 4000, "Replaced by a new app connection");
  }
  room.appSocket = ws;
  state.appSockets.add(ws);
  room.lastSeenAt = Date.now();

  ws.on("message", (payload, isBinary) => {
    room.lastSeenAt = Date.now();
    if (limits && rawDataBytes(payload) > limits.maxMessageBytes) {
      closeOversizedMessage(state, limits, clientIp, ws);
      return;
    }
    if (room.bridgeSocket.readyState !== WebSocket.OPEN) {
      closeSocket(ws, 4000, "Bridge disconnected");
      return;
    }
    room.bridgeSocket.send(payload, { binary: isBinary });
  });

  ws.on("close", () => {
    state.appSockets.delete(ws);
    if (room.appSocket === ws) {
      room.appSocket = undefined;
    }
  });
}
