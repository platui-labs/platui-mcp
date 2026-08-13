import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AuthorizationError, errorResult, ToolRegistry } from "platui-mcp-core";
import type { ApiClient, AuthContext } from "platui-mcp-core";
import { buildPublicTools } from "../tools/public-catalog";
import { readOwnVersion } from "../runtime";

export interface PlatuiMcpServerOptions {
  auth: AuthContext;
  apiClient?: ApiClient;
  appBaseUrl?: string;
}

export interface PlatuiMcpServerRuntime {
  server: Server;
  registry: ToolRegistry;
}

const PUBLIC_BOUNDARY_RESOURCE = `# PlatUI Public MCP Boundary

This MCP server exposes project-scoped design import, code generation, preview, and artifact workflows, all through the PlatUI cloud API.

It never executes shell commands, reads or writes local files (beyond its own credential cache), or touches infrastructure directly.
`;

const GENERATE_FROM_FIGMA_PROMPT = {
  name: "generate_from_figma",
  description: "Guide an IDE agent from Figma URL/context to PlatUI import, codegen, and preview.",
  arguments: [
    {
      name: "figmaUrl",
      description: "Figma design or file URL to import.",
      required: false,
    },
    {
      name: "projectId",
      description:
        "Existing PlatUI project id to add the design to. Omit to create a new project instead.",
      required: false,
    },
  ],
};

/**
 * Creates the public PlatUI MCP server.
 */
export function createPlatuiMcpServer(options: PlatuiMcpServerOptions): PlatuiMcpServerRuntime {
  const registry = new ToolRegistry("public", buildPublicTools());
  const server = new Server(
    { name: "platui-public-mcp", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.onerror = (error) => {
    console.error("[MCP Error]", error);
  };

  registerToolHandlers(server, registry, options);
  registerResourceHandlers(server);
  registerPromptHandlers(server);

  return { server, registry };
}

/**
 * Starts the configured MCP server over stdio transport.
 */
export async function runStdioServer(options: PlatuiMcpServerOptions): Promise<void> {
  const runtime = createPlatuiMcpServer(options);
  const transport = new StdioServerTransport();
  await runtime.server.connect(transport);
  console.error("PlatUI public MCP server running on stdio transport.");
}

function registerToolHandlers(
  server: Server,
  registry: ToolRegistry,
  options: PlatuiMcpServerOptions,
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    let outcome: "success" | "error" = "success";

    try {
      const result = await registry.call(name, args, {
        profile: "public",
        auth: options.auth,
        apiClient: options.apiClient,
        appBaseUrl: options.appBaseUrl,
      });
      return result as any;
    } catch (error) {
      outcome = "error";
      if (error instanceof z.ZodError) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid parameters: ${ToolRegistry.formatValidationError(error)}`,
        );
      }
      if (error instanceof AuthorizationError) {
        throw new McpError(ErrorCode.InvalidRequest, error.message);
      }
      if (error instanceof Error && error.message.startsWith("Unknown tool")) {
        throw new McpError(ErrorCode.MethodNotFound, error.message);
      }
      return errorResult(error instanceof Error ? error.message : String(error)) as any;
    } finally {
      void trackToolUsage(name, outcome);
    }
  });
}

/**
 * Fire-and-forget usage telemetry to Mixpanel's ingestion API. Must never
 * throw, block tool execution, or leak anything sensitive. The Mixpanel
 * project token is public by design (same model as the Figma plugin);
 * tracking is skipped entirely when no token is configured.
 */
async function trackToolUsage(tool: string, outcome: "success" | "error"): Promise<void> {
  try {
    const token = process.env.PLATUI_MIXPANEL_TOKEN;
    if (!token) {
      return;
    }
    await fetch("https://api.mixpanel.com/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        {
          event: "MCP Tool Invoked",
          properties: {
            token,
            distinct_id: process.env.PLATUI_MIXPANEL_DISTINCT_ID ?? "anonymous",
            time: Date.now(),
            $insert_id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            Tool: tool,
            Outcome: outcome,
            Version: readOwnVersion(),
          },
        },
      ]),
    });
  } catch {
    // Intentional: telemetry must never break the MCP server.
  }
}

function registerResourceHandlers(server: Server): void {
  // No resource templates: earlier versions advertised project/preview/artifact
  // templates that ReadResource could not actually serve. Everything dynamic is
  // a tool call; the only readable resource is the static boundary doc below.
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return { resourceTemplates: [] };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: "platui://docs/public-boundary",
          name: "PlatUI Public MCP Boundary",
          mimeType: "text/markdown",
          description: "Explains what public MCP is allowed to expose.",
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === "platui://docs/public-boundary") {
      return {
        contents: [{ uri, mimeType: "text/markdown", text: PUBLIC_BOUNDARY_RESOURCE }],
      };
    }

    throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI "${uri}"`);
  });
}

function registerPromptHandlers(server: Server): void {
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: [GENERATE_FROM_FIGMA_PROMPT] };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    if (name === GENERATE_FROM_FIGMA_PROMPT.name) {
      const projectId = args.projectId ? String(args.projectId) : undefined;
      const figmaUrl = args.figmaUrl ? String(args.figmaUrl) : undefined;
      return {
        description: GENERATE_FROM_FIGMA_PROMPT.description,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: renderGenerateFromFigmaPrompt(projectId, figmaUrl),
            },
          },
        ],
      };
    }

    throw new McpError(ErrorCode.MethodNotFound, `Unknown prompt "${name}"`);
  });
}

function renderGenerateFromFigmaPrompt(projectId?: string, figmaUrl?: string): string {
  const firstStep = figmaUrl
    ? `1. Call \`platui_parse_figma_url\` with \`${figmaUrl}\` and verify the file key/node id.`
    : "1. If you have a Figma URL, call `platui_parse_figma_url`; otherwise get design context from Figma MCP.";

  // platui_import_figma always creates a NEW project; adding to an existing
  // one goes through the plugin-payload/MCP-context import path instead.
  const importStep = projectId
    ? `2. Add the design to existing project \`${projectId}\` with \`platui_import_figma_mcp_context\` (or \`platui_import_figma_plugin_payload\`).`
    : "2. Create a new project with `platui_import_figma` (ask the user for the project name; pick framework/language from `platui_get_available_frameworks` / `platui_get_available_languages`).";

  return `${firstStep}
${importStep}
3. Call \`platui_generate_code\` for the selected target framework.
4. Poll \`platui_check_job_status\` until the job completes.
5. Read generated code with \`platui_get_artifacts\` + \`platui_get_artifact_content\`, AND download the referenced assets (images/vectors/fonts) from the same listing to the paths the code expects. Then \`platui_create_preview\` / \`platui_get_preview\` for a hosted preview.

Modes: for a FULL PROTOTYPE, repeat the import for every screen (same project, one node-id per screen) and assemble the app from all artifacts. For a SINGLE COMPONENT, import just that component's frame and adapt its generated code into the user's existing codebase.

Expectations: generated code is a structural mapping of the design JSON -- your raw material, not a finished app. Designs without Figma Auto Layout yield absolute positioning: refactor it for responsiveness. If output looks wrong, \`platui_inspect_design\` shows the design's true structure; keep the artifacts as your base layout, and preserve generated visual values (sizes, colors, typography) when you refactor.`;
}
