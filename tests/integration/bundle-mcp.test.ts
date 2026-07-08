import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Exercises the esbuild-bundled npm artifact (dist/cli.js) over real stdio.
// `npm run verify` runs `bundle` before the test suite, so dist/cli.js is
// guaranteed to exist and be current when this file runs.
const clients: Client[] = [];

async function connect(extraEnv: Record<string, string> = {}) {
  const client = new Client({ name: "platui-public-bundle-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/cli.js"],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      PLATUI_MCP_SUBJECT: "bundle-integration-test",
      PLATUI_MCP_SCOPES: "*",
      ...extraEnv,
    },
  });

  await client.connect(transport);
  clients.push(client);
  return client;
}

afterEach(async () => {
  while (clients.length) {
    await clients.pop()?.close();
  }
});

describe("bundled stdio MCP server (dist/cli.js)", () => {
  it("lists the 28 public tools and calls local public tools", async () => {
    const client = await connect();
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);

    expect(toolNames).toHaveLength(28);
    expect(toolNames).toContain("platui_get_capabilities");
    expect(toolNames).toContain("platui_parse_figma_url");
    expect(toolNames).toContain("platui_import_figma");
    expect(toolNames).not.toContain("platui_search_workspace");
    expect(toolNames).not.toContain("platui_compile_figma");

    const parsed = await client.callTool({
      name: "platui_parse_figma_url",
      arguments: {
        figmaUrl: "https://www.figma.com/design/fileKey/Demo?node-id=10-20",
      },
    });

    expect(parsed.content[0]).toMatchObject({ type: "text" });
    expect(parsed.content[0].type === "text" ? parsed.content[0].text : "").toContain(
      '"fileKey": "fileKey"',
    );
    expect(parsed.content[0].type === "text" ? parsed.content[0].text : "").toContain(
      '"nodeId": "10:20"',
    );
  });
});
