import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("package metadata", () => {
  it("publishes gotokens-bridge as the only installed command", async () => {
    const raw = await readFile(new URL("../package.json", import.meta.url), "utf-8");
    const pkg = JSON.parse(raw) as { bin?: Record<string, string> };

    expect(pkg.bin).toEqual({
      "gotokens-bridge": "./dist/cli.js",
    });
  });

  it("documents the gotokens bridge command in the npm README", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf-8");

    expect(readme).toContain("gotokens-bridge --help");
    expect(readme).toContain("gotokens-bridge --version");
    expect(readme).not.toContain("ccpocket-bridge");
  });
});
