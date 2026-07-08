import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const clients: Client[] = [];

async function connect(extraEnv: Record<string, string> = {}) {
  const client = new Client({ name: "platui-public-stdio-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      PLATUI_MCP_SUBJECT: "stdio-integration-test",
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

describe("compiled stdio MCP server", () => {
  it("lists only public tools and calls local public tools", async () => {
    const client = await connect();
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);

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
