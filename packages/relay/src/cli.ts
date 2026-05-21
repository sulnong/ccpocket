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
