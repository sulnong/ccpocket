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
