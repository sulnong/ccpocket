import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { buildConnectionUrl, printConnectionQr } from "./startup-info.js";

export const DEFAULT_BRIDGE_RELAY_URL = "wss://nqqlcknhdxys.sealoshzh.site";

export interface RelayCredentials {
  roomId: string;
  roomSecret: string;
}

export interface BridgeRelayClientOptions {
  relayUrl: string;
  relayToken?: string;
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

export function resolveBridgeRelayUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env["BRIDGE_RELAY_URL"]?.trim() || DEFAULT_BRIDGE_RELAY_URL;
}

export function buildRelayRegistrationUrl(
  relayUrl: string,
  relayToken?: string,
): string {
  const url = new URL(relayUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/bridge/register`;
  const token = relayToken?.trim();
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

export function normalizeRelayAppUrl(appUrl: string, relayUrl: string): string {
  let parsedAppUrl: URL;
  let parsedRelayUrl: URL;
  try {
    parsedAppUrl = new URL(appUrl);
    parsedRelayUrl = new URL(relayUrl);
  } catch {
    return appUrl;
  }

  const hostname = parsedAppUrl.hostname.toLowerCase();
  const isUnreachableHost =
    hostname === "0.0.0.0" ||
    hostname === "::" ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]";

  if (!isUnreachableHost) return appUrl;

  parsedAppUrl.protocol = parsedRelayUrl.protocol;
  parsedAppUrl.hostname = parsedRelayUrl.hostname;
  parsedAppUrl.port = parsedRelayUrl.port;
  return parsedAppUrl.toString();
}

function parseRegisteredMessage(
  data: WebSocket.RawData,
): RegisteredMessage | null {
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
  let registeredWithRelay = false;
  const pendingRelayFrames: Array<{
    data: WebSocket.RawData;
    binary: boolean;
  }> = [];

  const cleanupSockets = () => {
    localOpen = false;
    registeredWithRelay = false;
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
      while (
        pendingRelayFrames.length > 0 &&
        localSocket?.readyState === WebSocket.OPEN
      ) {
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
    registeredWithRelay = false;
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
      registeredWithRelay = true;

      const appUrl = normalizeRelayAppUrl(registered.appUrl, options.relayUrl);
      const deepLink = buildConnectionUrl(appUrl, registered.secret);
      log(`[relay-client] Relay registered: ${appUrl}`);
      log(`[relay-client] Deep Link: ${deepLink}`);
      void printConnectionQr({
        title: "Relay Connection",
        wsUrl: appUrl,
        token: registered.secret,
      });

      connectLocalBridge();

      relaySocket?.on("message", (payload, binary) => {
        if (localOpen && localSocket?.readyState === WebSocket.OPEN) {
          localSocket.send(payload, { binary });
          return;
        }
        pendingRelayFrames.push({ data: payload, binary });
      });
    });

    relaySocket.on("close", (code, reason) => {
      if (!registeredWithRelay && !stopped) {
        const reasonText = reason.toString();
        warn(
          `[relay-client] Relay registration closed before QR code was printed: ${code}${
            reasonText ? ` ${reasonText}` : ""
          }. If the relay requires an admin token, set BRIDGE_RELAY_TOKEN to match RELAY_ADMIN_TOKEN; otherwise run the relay without RELAY_ADMIN_TOKEN.`,
        );
      }
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
