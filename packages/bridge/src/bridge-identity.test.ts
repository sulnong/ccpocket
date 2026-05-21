import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getDefaultBridgeIdentityPath,
  loadOrCreateBridgeIdentity,
} from "./bridge-identity.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ccpocket-bridge-identity-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("bridge identity", () => {
  it("uses ~/.ccpocket/bridge-identity.json by default", () => {
    expect(getDefaultBridgeIdentityPath("/Users/alice")).toBe(
      "/Users/alice/.ccpocket/bridge-identity.json",
    );
  });

  it("creates and reuses stable relay credentials", async () => {
    const filePath = join(tempDir, "bridge-identity.json");

    const first = await loadOrCreateBridgeIdentity(filePath);
    const second = await loadOrCreateBridgeIdentity(filePath);

    expect(first).toEqual(second);
    expect(first.version).toBe(1);
    expect(first.roomId).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(first.roomSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(first.createdAt).toEqual(first.updatedAt);

    const saved = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
    expect(saved).toEqual(first);
  });

  it("preserves an existing valid identity file", async () => {
    const filePath = join(tempDir, "bridge-identity.json");
    const existingRoomSecret = [
      "test-key-room",
      "secret-fixture-12345678901234567890",
    ].join("-");
    const existing = {
      version: 1,
      roomId: "stable-room-id-123456",
      roomSecret: existingRoomSecret,
      createdAt: "2026-05-21T00:00:00.000Z",
      updatedAt: "2026-05-21T00:00:00.000Z",
    };
    await writeFile(filePath, JSON.stringify(existing, null, 2), "utf-8");

    await expect(loadOrCreateBridgeIdentity(filePath)).resolves.toEqual(
      existing,
    );
  });

  it("replaces a corrupt identity file with a new valid identity", async () => {
    const filePath = join(tempDir, "bridge-identity.json");
    await writeFile(filePath, "not json", "utf-8");

    const identity = await loadOrCreateBridgeIdentity(filePath);

    expect(identity.version).toBe(1);
    expect(identity.roomId).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(identity.roomSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });
});
