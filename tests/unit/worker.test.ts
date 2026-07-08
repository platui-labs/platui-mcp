import { describe, expect, it, vi } from "vitest";
import worker from "../../src/worker";

vi.mock("platui-mcp-core", async () => {
  const actual = await vi.importActual<typeof import("platui-mcp-core")>("platui-mcp-core");
  return {
    ...actual,
    validateWorkerJwt: vi.fn(async (authHeader) => {
      if (authHeader !== "Bearer valid") {
        throw new Error("Invalid Token");
      }
      return { subject: "user1", scopes: ["*"] };
    }),
  };
});

vi.mock("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js", () => {
  return {
    WebStandardStreamableHTTPServerTransport: class MockTransport {
      sessionId = "mock-session-id";
      onclose: (() => void) | undefined;

      async start() {}
      async close() {}

      async handleRequest(_req: Request) {
        return new Response("mock-response", {
          status: 200,
          headers: { "X-MCP-Session-Id": this.sessionId },
        });
      }
    },
  };
});

describe("Cloudflare Worker", () => {
  const env = {
    PLATUI_PUBLIC_API_BASE_URL: "https://api",
    PLATUI_JWKS_URL: "https://jwks",
    PLATUI_ISSUER: "issuer",
    PLATUI_AUDIENCE: "aud",
  };

  it("returns 404 for unknown routes", async () => {
    const req = new Request("https://worker.com/unknown");
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(404);
  });

  it("handles OPTIONS request for CORS", async () => {
    const req = new Request("https://worker.com/mcp", { method: "OPTIONS" });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns 401 for unauthorized requests", async () => {
    const req = new Request("https://worker.com/mcp", {
      method: "GET",
      headers: { Authorization: "Bearer bad" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Invalid Token");
  });

  it("handles GET /mcp and sets up transport", async () => {
    const req = new Request("https://worker.com/mcp", {
      method: "GET",
      headers: { Authorization: "Bearer valid" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("X-MCP-Session-Id")).toBe("mock-session-id");
  });

  it("handles POST /mcp/message with valid session ID", async () => {
    // Session is set up by explicit GET
    const setupReq = new Request("https://worker.com/mcp", {
      method: "GET",
      headers: { Authorization: "Bearer valid" },
    });
    await worker.fetch(setupReq, env);

    const req = new Request("https://worker.com/mcp/message", {
      method: "POST",
      headers: {
        Authorization: "Bearer valid",
        "X-MCP-Session-Id": "mock-session-id",
      },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("mock-response");
  });

  it("returns 400 for POST /mcp/message without session ID", async () => {
    const req = new Request("https://worker.com/mcp/message", {
      method: "POST",
      headers: { Authorization: "Bearer valid" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it("returns 404 for POST /mcp/message with unknown session ID", async () => {
    const req = new Request("https://worker.com/mcp/message", {
      method: "POST",
      headers: {
        Authorization: "Bearer valid",
        "X-MCP-Session-Id": "unknown",
      },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(404);
  });

  it("returns 405 for unsupported methods", async () => {
    const req = new Request("https://worker.com/mcp", {
      method: "PUT",
      headers: { Authorization: "Bearer valid" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(405);
  });
});
