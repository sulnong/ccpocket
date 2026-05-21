#!/usr/bin/env node
import { startRelayServer } from "./server.js";

const host = process.env.RELAY_HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.RELAY_PORT ?? "8787", 10);
const adminToken = process.env.RELAY_ADMIN_TOKEN ?? "";
const publicUrl = process.env.RELAY_PUBLIC_URL;

function parseOptionalInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

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
