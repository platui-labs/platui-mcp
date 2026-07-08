import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const clients: Client[] = [];

afterEach(async () => {
  while (clients.length) {
    await clients.pop()?.close();
  }
});

// The rc.1 regression: every other test injects PLATUI_MCP_SCOPES etc., so the
// real customer environment -- NO PlatUI variables at all -- was never
// exercised, and it shipped broken (empty scopes rejected 24 of 27 tools; no
// baked-in endpoints). This suite spawns the built server the way a customer's
// MCP client does: clean environment, nothing but PATH/HOME.
describe("zero-config customer environment", () => {
  it("serves and executes tools with no PLATUI_* env vars at all", async () => {
    const client = new Client({ name: "zero-config-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      cwd: process.cwd(),
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        // A throwaway HOME keeps a developer's real ~/.platui credential
        // cache from leaking into the "brand-new customer" scenario.
        HOME: fs.mkdtempSync(path.join(os.tmpdir(), "platui-zero-config-")),
      },
    });
    await client.connect(transport);
    clients.push(client);

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(28);

    // A scope-gated local tool must work without any scopes env var --
    // this exact call failed with "Missing required scope(s)" in rc.1.
    const parsed = await client.callTool({
      name: "platui_parse_figma_url",
      arguments: { figmaUrl: "https://www.figma.com/design/fileKey/Demo?node-id=10-20" },
    });
    expect(parsed.isError ?? false).toBe(false);
    expect(parsed.content[0].type === "text" ? parsed.content[0].text : "").toContain(
      '"fileKey": "fileKey"',
    );

    // The capabilities tool must not claim hardcoded framework targets.
    const capabilities = await client.callTool({
      name: "platui_get_capabilities",
      arguments: {},
    });
    const capsText = capabilities.content[0].type === "text" ? capabilities.content[0].text : "";
    expect(capsText).toContain("platui_get_available_frameworks");
    expect(capsText).not.toContain("SwiftUI");
  });
});
