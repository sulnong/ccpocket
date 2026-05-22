import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface BridgeIdentity {
  version: 1;
  roomId: string;
  roomSecret: string;
  createdAt: string;
  updatedAt: string;
}

export interface BridgeRelayIdentity {
  roomId: string;
  roomSecret: string;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,}$/;

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export function getDefaultBridgeIdentityPath(home = homedir()): string {
  return join(home, ".ccpocket", "bridge-identity.json");
}

function isBridgeIdentity(value: unknown): value is BridgeIdentity {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    data.version === 1 &&
    typeof data.roomId === "string" &&
    TOKEN_PATTERN.test(data.roomId) &&
    typeof data.roomSecret === "string" &&
    TOKEN_PATTERN.test(data.roomSecret) &&
    typeof data.createdAt === "string" &&
    typeof data.updatedAt === "string"
  );
}

function createBridgeIdentity(): BridgeIdentity {
  const now = new Date().toISOString();
  return {
    version: 1,
    roomId: randomToken(16),
    roomSecret: randomToken(32),
    createdAt: now,
    updatedAt: now,
  };
}

export async function loadOrCreateBridgeIdentity(
  filePath = getDefaultBridgeIdentityPath(),
): Promise<BridgeIdentity> {
  await mkdir(dirname(filePath), { recursive: true });
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (isBridgeIdentity(parsed)) return parsed;
  } catch {
    // Missing or corrupt identity files are replaced with a fresh identity.
  }

  const identity = createBridgeIdentity();
  const tmp = join(dirname(filePath), `bridge-identity.${randomToken(8)}.tmp`);
  await writeFile(tmp, JSON.stringify(identity, null, 2), "utf-8");
  await rename(tmp, filePath);
  return identity;
}

export function resolveBridgeRelayIdentity(
  identity: BridgeIdentity,
  env: NodeJS.ProcessEnv = process.env,
): BridgeRelayIdentity {
  return {
    roomId: env["BRIDGE_RELAY_ROOM_ID"]?.trim() || identity.roomId,
    roomSecret: env["BRIDGE_RELAY_ROOM_SECRET"]?.trim() || identity.roomSecret,
  };
}
