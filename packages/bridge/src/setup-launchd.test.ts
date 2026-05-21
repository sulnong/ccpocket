import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockExecSync = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
}));

vi.mock("node:os", () => ({
  homedir: () => "/Users/testuser",
}));

const { setupLaunchd, uninstallLaunchd } = await import("./setup-launchd.js");

const PLIST_PATH = "/Users/testuser/Library/LaunchAgents/com.ccpocket.bridge.plist";
const originalBridgeEnv = {
  publicWsUrl: process.env.BRIDGE_PUBLIC_WS_URL,
  relayUrl: process.env.BRIDGE_RELAY_URL,
  relayToken: process.env.BRIDGE_RELAY_TOKEN,
  relayRoomId: process.env.BRIDGE_RELAY_ROOM_ID,
  relayRoomSecret: process.env.BRIDGE_RELAY_ROOM_SECRET,
  codexAppServerMode: process.env.BRIDGE_CODEX_APP_SERVER_MODE,
  codexSharedAppServerUrl: process.env.BRIDGE_CODEX_SHARED_APP_SERVER_URL,
  codexAppServerPort: process.env.BRIDGE_CODEX_APP_SERVER_PORT,
  codexAppServerUrl: process.env.BRIDGE_CODEX_APP_SERVER_URL,
};

describe("setup-launchd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBridgeEnv();
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue("/usr/bin/npx\n");
  });

  afterEach(() => {
    restoreBridgeEnv();
  });

  describe("setupLaunchd", () => {
    it("writes correct plist with default options", () => {
      setupLaunchd({});

      expect(mockWriteFileSync).toHaveBeenCalledOnce();
      const [path, content] = mockWriteFileSync.mock.calls[0] as [string, string];
      expect(path).toBe(PLIST_PATH);
      expect(content).toContain("<key>BRIDGE_PORT</key>");
      expect(content).toContain("<string>8765</string>");
      expect(content).toContain("<key>BRIDGE_HOST</key>");
      expect(content).toContain(
        "<string>exec npx --yes @gotokens/bridge@latest</string>",
      );
      expect(content).not.toContain("BRIDGE_API_KEY");
      expect(content).not.toContain("BRIDGE_PUBLIC_WS_URL");
      expect(content).not.toContain("BRIDGE_RELAY_URL");
      expect(content).not.toContain("BRIDGE_RELAY_TOKEN");
      expect(content).not.toContain("BRIDGE_CODEX_APP_SERVER_MODE");
      expect(content).not.toContain("BRIDGE_CODEX_SHARED_APP_SERVER_URL");
    });

    it("includes BRIDGE_PUBLIC_WS_URL when publicWsUrl is provided", () => {
      setupLaunchd({ publicWsUrl: "wss://example.com/ws" });

      const content = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(content).toContain("<key>BRIDGE_PUBLIC_WS_URL</key>");
      expect(content).toContain("<string>wss://example.com/ws</string>");
    });

    it("prefers explicit publicWsUrl over environment", () => {
      process.env.BRIDGE_PUBLIC_WS_URL = "wss://env.example.com";

      setupLaunchd({ publicWsUrl: "wss://flag.example.com" });

      const content = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(content).toContain("<string>wss://flag.example.com</string>");
      expect(content).not.toContain("wss://env.example.com");
    });

    it("includes relay startup options when provided", () => {
      setupLaunchd({
        relayUrl: "wss://relay.example.com",
        relayToken: "test-key-admin",
        relayRoomId: "room-1",
        relayRoomSecret: "test-key-room",
      });

      const content = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(content).toContain("<key>BRIDGE_RELAY_URL</key>");
      expect(content).toContain("<string>wss://relay.example.com</string>");
      expect(content).toContain("<key>BRIDGE_RELAY_TOKEN</key>");
      expect(content).toContain("<string>test-key-admin</string>");
      expect(content).toContain("<key>BRIDGE_RELAY_ROOM_ID</key>");
      expect(content).toContain("<string>room-1</string>");
      expect(content).toContain("<key>BRIDGE_RELAY_ROOM_SECRET</key>");
      expect(content).toContain("<string>test-key-room</string>");
    });

    it("includes relay URL from environment without requiring relay token", () => {
      process.env.BRIDGE_RELAY_URL = "wss://relay.example.com";

      setupLaunchd({});

      const content = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(content).toContain("<key>BRIDGE_RELAY_URL</key>");
      expect(content).toContain("<string>wss://relay.example.com</string>");
      expect(content).not.toContain("BRIDGE_RELAY_TOKEN");
    });

    it("does not persist shared app-server URL without an explicit mode", () => {
      process.env.BRIDGE_CODEX_SHARED_APP_SERVER_URL = "ws://127.0.0.1:18766";

      setupLaunchd({});

      const content = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(content).not.toContain("BRIDGE_CODEX_APP_SERVER_MODE");
      expect(content).not.toContain("BRIDGE_CODEX_SHARED_APP_SERVER_URL");
    });

    it("includes explicit Codex app-server startup options", () => {
      setupLaunchd({
        codexAppServerMode: "external",
        codexSharedAppServerUrl: "ws://127.0.0.1:18766",
      });

      const content = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(content).toContain("<key>BRIDGE_CODEX_APP_SERVER_MODE</key>");
      expect(content).toContain("<string>external</string>");
      expect(content).toContain("<key>BRIDGE_CODEX_SHARED_APP_SERVER_URL</key>");
      expect(content).toContain("<string>ws://127.0.0.1:18766</string>");
      expect(content).not.toContain("BRIDGE_CODEX_APP_SERVER_PORT");
      expect(content).not.toContain("BRIDGE_CODEX_APP_SERVER_URL");
    });

    it("requires a shared app-server URL for external mode", () => {
      expect(() => setupLaunchd({ codexAppServerMode: "external" })).toThrow(
        "BRIDGE_CODEX_SHARED_APP_SERVER_URL is required",
      );
    });

    it("uses the documented default shared URL when managed mode is enabled", () => {
      setupLaunchd({ port: "8765", codexAppServerMode: "managed" });

      const content = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(content).toContain("<key>BRIDGE_PORT</key>");
      expect(content).toContain("<string>8765</string>");
      expect(content).toContain("<key>BRIDGE_CODEX_APP_SERVER_MODE</key>");
      expect(content).toContain("<string>managed</string>");
      expect(content).toContain("<key>BRIDGE_CODEX_SHARED_APP_SERVER_URL</key>");
      expect(content).toContain("<string>ws://127.0.0.1:8767</string>");
    });

    it("moves the default shared app-server URL when Bridge uses 8767", () => {
      setupLaunchd({ port: "8767", codexAppServerMode: "managed" });

      const content = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(content).toContain("<key>BRIDGE_PORT</key>");
      expect(content).toContain("<string>8767</string>");
      expect(content).toContain("<key>BRIDGE_CODEX_SHARED_APP_SERVER_URL</key>");
      expect(content).toContain("<string>ws://127.0.0.1:8768</string>");
    });
  });

  describe("uninstallLaunchd", () => {
    it("deletes plist when it exists", () => {
      mockExistsSync.mockReturnValue(true);

      uninstallLaunchd();

      expect(mockUnlinkSync).toHaveBeenCalledWith(PLIST_PATH);
    });
  });
});

function clearBridgeEnv(): void {
  delete process.env.BRIDGE_PUBLIC_WS_URL;
  delete process.env.BRIDGE_RELAY_URL;
  delete process.env.BRIDGE_RELAY_TOKEN;
  delete process.env.BRIDGE_RELAY_ROOM_ID;
  delete process.env.BRIDGE_RELAY_ROOM_SECRET;
  delete process.env.BRIDGE_CODEX_APP_SERVER_MODE;
  delete process.env.BRIDGE_CODEX_SHARED_APP_SERVER_URL;
  delete process.env.BRIDGE_CODEX_APP_SERVER_PORT;
  delete process.env.BRIDGE_CODEX_APP_SERVER_URL;
}

function restoreBridgeEnv(): void {
  restoreEnvVar("BRIDGE_PUBLIC_WS_URL", originalBridgeEnv.publicWsUrl);
  restoreEnvVar("BRIDGE_RELAY_URL", originalBridgeEnv.relayUrl);
  restoreEnvVar("BRIDGE_RELAY_TOKEN", originalBridgeEnv.relayToken);
  restoreEnvVar("BRIDGE_RELAY_ROOM_ID", originalBridgeEnv.relayRoomId);
  restoreEnvVar(
    "BRIDGE_RELAY_ROOM_SECRET",
    originalBridgeEnv.relayRoomSecret,
  );
  restoreEnvVar(
    "BRIDGE_CODEX_APP_SERVER_MODE",
    originalBridgeEnv.codexAppServerMode,
  );
  restoreEnvVar(
    "BRIDGE_CODEX_SHARED_APP_SERVER_URL",
    originalBridgeEnv.codexSharedAppServerUrl,
  );
  restoreEnvVar(
    "BRIDGE_CODEX_APP_SERVER_PORT",
    originalBridgeEnv.codexAppServerPort,
  );
  restoreEnvVar(
    "BRIDGE_CODEX_APP_SERVER_URL",
    originalBridgeEnv.codexAppServerUrl,
  );
}

function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
