import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { HttpApiClient, validateWorkerJwt, type AuthContext } from "platui-mcp-core";
import { createPlatuiMcpServer } from "./mcp/server";

export interface Env {
  PLATUI_PUBLIC_API_BASE_URL: string;
  PLATUI_JWKS_URL: string;
  PLATUI_ISSUER: string;
  PLATUI_AUDIENCE: string;
}

// In a Cloudflare Worker, we keep a global map of active transports per session 
// for the lifetime of the isolate.
const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/mcp" && url.pathname !== "/mcp/message") {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // 1. Authenticate Request
    let auth: AuthContext;
    try {
      auth = await validateWorkerJwt(request.headers.get("Authorization"), {
        jwksUrl: env.PLATUI_JWKS_URL,
        issuer: env.PLATUI_ISSUER,
        audience: env.PLATUI_AUDIENCE,
      });
    } catch (error) {
      return new Response((error as Error).message, { status: 401 });
    }

    // 2. Routing
    // GET /mcp -> Start SSE Stream
    if (request.method === "GET") {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      
      const { server } = createPlatuiMcpServer({
        auth,
        apiClient: new HttpApiClient({ baseUrl: env.PLATUI_PUBLIC_API_BASE_URL, fetchImpl: fetch }),
      });

      await server.connect(transport);
      
      const response = await transport.handleRequest(request);
      
      // Store transport for incoming POSTs
      const sessionId = response.headers.get("X-MCP-Session-Id") || transport.sessionId;
      if (sessionId) {
        transports.set(sessionId, transport);
        
        transport.onclose = () => {
          transports.delete(sessionId);
        };
      }

      // Add CORS
      const newResponse = new Response(response.body, response);
      newResponse.headers.set("Access-Control-Allow-Origin", "*");
      return newResponse;
    }

    // POST /mcp/message -> Process Message
    if (request.method === "POST") {
      // Find transport by session ID
      const sessionId = request.headers.get("X-MCP-Session-Id") || new URL(request.url).searchParams.get("sessionId");
      
      if (!sessionId) {
        return new Response("Missing Session ID", { status: 400 });
      }

      const transport = transports.get(sessionId);
      if (!transport) {
        return new Response("Session not found or expired on this worker node", { status: 404 });
      }

      // We must pass the parsed body because the request stream is consumed by handleRequest
      const response = await transport.handleRequest(request);
      
      const newResponse = new Response(response.body, response);
      newResponse.headers.set("Access-Control-Allow-Origin", "*");
      return newResponse;
    }

    return new Response("Method Not Allowed", { status: 405 });
  },
};
