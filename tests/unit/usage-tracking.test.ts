import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthContext } from "platui-mcp-core";
import packageJson from "../../package.json";

vi.mock("platui-mcp-core", async () => {
  const actual = await vi.importActual<typeof import("platui-mcp-core")>("platui-mcp-core");
  return {
    ...actual,
    loadCachedCredentials: vi.fn(() => undefined),
  };
});

import { createPlatuiMcpServer } from "../../src/mcp/server";

const VALID_FIGMA_URL = "https://www.figma.com/design/abc123/My-Design?node-id=1-2";

interface TrackedRequest {
  url: string;
  body: string;
}

async function connectClient(server: ReturnType<typeof createPlatuiMcpServer>["server"]) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("usage telemetry", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let tracked: TrackedRequest[];

  beforeEach(() => {
    tracked = [];
    fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
      tracked.push({ url: String(url), body: String(init?.body ?? "") });
      return { ok: true };
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.PLATUI_MIXPANEL_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PLATUI_MIXPANEL_TOKEN;
    delete process.env.PLATUI_MIXPANEL_DISTINCT_ID;
  });

  function lastEvent() {
    expect(tracked).toHaveLength(1);
    expect(tracked[0].url).toBe("https://api.mixpanel.com/track");
    return JSON.parse(tracked[0].body)[0] as {
      event: string;
      properties: Record<string, unknown>;
    };
  }

  it("sends an MCP Tool Invoked event to Mixpanel after a successful tool call", async () => {
    const { server } = createPlatuiMcpServer({
      auth: { subject: "test-user", scopes: ["*"] } as AuthContext,
    });
    const client = await connectClient(server);

    const result = await client.callTool({
      name: "platui_parse_figma_url",
      arguments: { figmaUrl: VALID_FIGMA_URL },
    });
    expect(result).toBeDefined();

    // Fire-and-forget: let the telemetry request settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const event = lastEvent();
    expect(event.event).toBe("MCP Tool Invoked");
    expect(event.properties.token).toBe("test-token");
    expect(event.properties.Tool).toBe("platui_parse_figma_url");
    expect(event.properties.Outcome).toBe("success");
    expect(event.properties.Version).toBe(packageJson.version);
    expect(event.properties.distinct_id).toBe("anonymous");
  });

  it("records Outcome=error when the tool invocation fails", async () => {
    const { server } = createPlatuiMcpServer({
      auth: { subject: "test-user", scopes: ["*"] } as AuthContext,
    });
    const client = await connectClient(server);

    await expect(
      client.callTool({ name: "platui_does_not_exist", arguments: {} }),
    ).rejects.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 0));

    const event = lastEvent();
    expect(event.properties.Outcome).toBe("error");
  });

  it("never breaks tool execution when telemetry itself fails", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    const { server } = createPlatuiMcpServer({
      auth: { subject: "test-user", scopes: ["*"] } as AuthContext,
    });
    const client = await connectClient(server);

    const result = await client.callTool({
      name: "platui_parse_figma_url",
      arguments: { figmaUrl: VALID_FIGMA_URL },
    });
    expect(result).toBeDefined();
  });

  it("skips telemetry entirely when no Mixpanel token is configured", async () => {
    delete process.env.PLATUI_MIXPANEL_TOKEN;

    const { server } = createPlatuiMcpServer({
      auth: { subject: "test-user", scopes: ["*"] } as AuthContext,
    });
    const client = await connectClient(server);

    const result = await client.callTool({
      name: "platui_parse_figma_url",
      arguments: { figmaUrl: VALID_FIGMA_URL },
    });
    expect(result).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tracked).toHaveLength(0);
  });
});
