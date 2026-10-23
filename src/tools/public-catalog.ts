import { z } from "zod";
import {
  imageResult,
  jsonResult,
  parseFigmaUrl,
  textResult,
  type ApiClient,
  type PlatuiToolDefinition,
  type ToolExecutionContext,
} from "platui-mcp-core";
import { completeDeviceLogin, startDeviceLogin } from "./device-auth";

const publicToolNames = [
  "platui_get_capabilities",
  "platui_login",
  "platui_check_login",
  "platui_get_connected_apps",
  "platui_get_project_context",
  "platui_list_projects",
  "platui_get_available_frameworks",
  "platui_get_available_languages",
  "platui_parse_figma_url",
  "platui_import_figma",
  "platui_import_figma_mcp_context",
  "platui_import_figma_plugin_payload",
  "platui_inspect_design",
  "platui_get_figma_screenshot",
  "platui_generate_code",
  "platui_create_preview",
  "platui_get_preview",
  "platui_get_artifacts",
  "platui_get_artifact_content",
  "platui_check_job_status",
  "platui_add_project_member",
  "platui_remove_project_member",
  "platui_list_project_members",
  "platui_trigger_web_builder_deploy",
  "platui_get_web_builder_logs",
  "platui_get_web_builder_artifacts",
  "platui_get_user_state",
  "platui_get_user_plan",
] as const;

function requireApiClient(context: ToolExecutionContext): ApiClient {
  if (!context.apiClient) {
    throw new Error("No PlatUI API client is configured for this MCP server.");
  }
  return context.apiClient;
}

const emptyObjectSchema = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

const projectIdSchema = {
  type: "object" as const,
  properties: {
    projectId: { type: "string", description: "PlatUI project id." },
  },
  required: ["projectId"],
  additionalProperties: false,
};

const projectIdValidator = z.object({ projectId: z.string().min(1) }).strict();

/** Inline cap for platui_get_artifact_content; larger files return their URL. */
const MAX_INLINE_ARTIFACT_BYTES = 200_000;

interface ArtifactFile {
  path: string;
  url: string;
}

/**
 * Flattens the /workspace/files/path listing (whose exact nesting is
 * backend-owned and varies) into path -> download-URL pairs by walking the
 * JSON for string values that look like URLs.
 */
function collectArtifactUrls(listing: unknown, prefix = ""): ArtifactFile[] {
  if (!listing || typeof listing !== "object") {
    return [];
  }
  const files: ArtifactFile[] = [];
  for (const [key, value] of Object.entries(listing as Record<string, unknown>)) {
    const path = prefix ? `${prefix}/${key}` : key;
    if (typeof value === "string" && value.startsWith("http")) {
      files.push({ path, url: value });
    } else if (value && typeof value === "object") {
      files.push(...collectArtifactUrls(value, path));
    }
  }
  return files;
}

/** Text artifacts come back inline; images/fonts/etc. return their URL. */
function isBinaryArtifact(contentType: string, buffer: Buffer): boolean {
  if (/^(text\/|application\/(json|javascript|xml|x-javascript|ecmascript))/.test(contentType)) {
    return false;
  }
  if (
    /^(image|video|audio|font)\//.test(contentType) ||
    contentType === "application/pdf" ||
    contentType === "application/octet-stream" ||
    contentType === "application/zip" ||
    contentType === "application/gzip"
  ) {
    return true;
  }
  return buffer.subarray(0, 1024).includes(0);
}

/**
 * Builds the customer-safe public MCP tool catalog.
 */
export const EXTERNAL_AGENT_GUIDANCE = {
  supportedAgents: ["Cursor", "Claude Code", "Antigravity"],
  s3AssetCaching:
    "Artifact listings from platui_get_artifacts return short-lived S3 presigned URLs, and background Sharp/S3 asset extraction (mabel) can lag behind code generation by several minutes. External agents (Cursor, Claude Code, Antigravity) MUST cache downloaded binary assets locally at the exact relative paths referenced by generated components instead of hotlinking presigned S3 URLs, and re-poll platui_get_artifacts if assets{} is initially empty or if a presigned URL returns HTTP 403.",
  figma429RateLimiting:
    "platui_import_figma and platui_get_figma_screenshot share the connected Figma OAuth rate-limit bucket. To avoid Figma HTTP 429 errors: (1) always call platui_list_projects first to reuse an existing project for the same Figma fileKey; (2) batch multiple frames in a single platui_import_figma call using comma-separated node-ids (?node-id=1-2,3-4); (3) on HTTP 429, apply exponential backoff (wait 60-180s) rather than retrying in a tight loop.",
} as const;

export const RAZORPAY_MCP_PROJECT_METADATA = {
  remoteMcpServerUrl: "https://mcp.razorpay.com/mcp",
  dockerImage: "razorpay/mcp",
  recommendedTools: [
    "detect_stack",
    "integrate_razorpay_checkout",
    "create_order",
    "create_payment_link_upi",
    "create_qr_code",
    "fetch_settlement_recon_details",
  ],
  bharatSaasKitConventions: {
    currency: "INR",
    checkoutScriptUrl: "https://checkout.razorpay.com/v1/checkout.js",
    webhookSignatureHeader: "x-razorpay-signature",
    webhookHashAlgorithm: "HMAC-SHA256",
    features: [
      "UPI AutoPay & recurring subscription mandates",
      "18% GST tax invoicing (CGST 9% + SGST 9% or IGST 18%) with GSTIN capture",
      "+91 10-digit Indian mobile validation and en-IN currency formatting",
    ],
  },
  workflow:
    "After importing a Figma design with platui_import_figma and pulling code via platui_get_artifact_content, pair with the Razorpay MCP server (https://mcp.razorpay.com/mcp) to run detect_stack and integrate_razorpay_checkout, wiring Checkout.js + server-side order creation + HMAC-SHA256 webhook verification into the generated PlatUI screens.",
} as const;

export function buildPublicTools(): PlatuiToolDefinition[] {
  return [
    {
      name: "platui_get_capabilities",
      description:
        "Return supported PlatUI MCP targets, tool names, deployment boundaries, external agent guidance (Cursor, Claude Code, Antigravity) for S3 asset caching and Figma 429 rate-limiting, and Razorpay MCP project creation metadata.",
      inputSchema: emptyObjectSchema,
      validator: z.object({}).strict(),
      visibility: "public",
      requiredScopes: [],
      riskLevel: "read",
      executionPlane: "edge",
      async execute() {
        return jsonResult("PlatUI MCP Capabilities", {
          server: "platui-mcp",
          publicTools: publicToolNames,
          targets:
            "Framework/language support is backend-owned and changes over time -- call platui_get_available_frameworks and platui_get_available_languages for the current set.",
          imports: ["figma-url", "figma-mcp-context", "figma-plugin-payload"],
          execution: "Public tools call the PlatUI cloud API.",
          positioning:
            "PlatUI converts Figma designs into code artifacts that are RAW MATERIAL for you, the agent: use them to build a full prototype (whole design -> app) or extract a single screen/component's generated code and adapt it into the user's codebase. Generated code is a structural mapping of the design JSON -- designs without Figma Auto Layout yield absolute positioning you should refactor. When output looks wrong, platui_inspect_design shows the design's true structure and the artifacts remain your base layout. Preserve generated visual values (sizes, colors, typography) when refactoring, and always download the referenced assets alongside the code.",
          agentGuidance: EXTERNAL_AGENT_GUIDANCE,
          razorpayMcpIntegration: RAZORPAY_MCP_PROJECT_METADATA,
        });
      },
    },
    {
      name: "platui_login",
      description:
        "Start the PlatUI sign-in flow: returns a URL to open in a browser where the user is (or can get) signed in to PlatUI. Approving there grants this MCP server access -- no password, token, or OTP is ever entered here. Call platui_check_login afterward.",
      inputSchema: emptyObjectSchema,
      validator: z.object({}).strict(),
      visibility: "public",
      requiredScopes: [],
      riskLevel: "read",
      executionPlane: "api",
      async execute(_args, context) {
        const client = requireApiClient(context);
        if (!context.appBaseUrl) {
          throw new Error(
            "No PlatUI app URL is configured for this MCP server, so a sign-in link cannot be built. This is a server configuration problem, not a user error.",
          );
        }
        const { readKey, authorizeUrl } = await startDeviceLogin(client, context.appBaseUrl);
        return jsonResult("PlatUI Login Started", {
          authorizeUrl,
          readKey,
          instructions: `Open ${authorizeUrl} in a browser where you're already signed in to PlatUI, then call platui_check_login with readKey "${readKey}".`,
        });
      },
    },
    {
      name: "platui_check_login",
      description:
        "Poll whether the platui_login browser step has been completed. If not yet granted, wait a few seconds and call this again.",
      inputSchema: {
        type: "object",
        properties: {
          readKey: { type: "string", description: "The readKey returned by platui_login." },
        },
        required: ["readKey"],
        additionalProperties: false,
      },
      validator: z.object({ readKey: z.string().min(1) }).strict(),
      visibility: "public",
      requiredScopes: [],
      riskLevel: "read",
      executionPlane: "api",
      async execute(args, context) {
        const client = requireApiClient(context);
        const result = await completeDeviceLogin(client, args.readKey);
        if (!result.granted) {
          return jsonResult("PlatUI Login Pending", {
            granted: false,
            message:
              "Not yet authorized. Open the authorizeUrl from platui_login, then call platui_check_login again.",
          });
        }
        // Update the live auth context so subsequent tool calls in this session use the
        // new token immediately, without requiring the MCP server process to restart.
        context.auth.accessToken = result.accessToken;
        return jsonResult("PlatUI Login Complete", {
          granted: true,
          message:
            "Signed in. Your PlatUI access token has been cached locally and will be used automatically for subsequent calls.",
        });
      },
    },
    {
      name: "platui_get_project_context",
      description:
        "Return project metadata, framework, active designs, and status. The genId field identifies the latest code generation -- pass it to platui_get_web_builder_logs / platui_get_web_builder_artifacts / platui_trigger_web_builder_deploy.",
      inputSchema: projectIdSchema,
      validator: projectIdValidator,
      visibility: "public",
      requiredScopes: ["project:read"],
      riskLevel: "read",
      executionPlane: "api",
      async execute(args, context) {
        const client = requireApiClient(context);
        const response = await client.request(
          "GET",
          `/project/${encodeURIComponent(args.projectId)}`,
          undefined,
          context.auth,
        );
        return jsonResult("Project Context", response);
      },
    },
    {
      name: "platui_list_projects",
      description:
        "List the current user's projects. ALWAYS check here before platui_import_figma: if a project already exists for the same Figma file, reuse it instead of creating a duplicate. Also the way to discover project ids for every other project-scoped tool.",
      inputSchema: emptyObjectSchema,
      validator: z.object({}).strict(),
      visibility: "public",
      requiredScopes: ["project:read"],
      riskLevel: "read",
      executionPlane: "api",
      async execute(_args, context) {
        const client = requireApiClient(context);
        const response = await client.request("GET", "/project/all", undefined, context.auth);
        return jsonResult("Projects", response);
      },
    },
    {
      name: "platui_get_available_frameworks",
      description:
        "List the frameworks platui_import_figma currently accepts. Call this instead of guessing a framework value.",
      inputSchema: emptyObjectSchema,
      validator: z.object({}).strict(),
      visibility: "public",
      requiredScopes: ["project:read"],
      riskLevel: "read",
      executionPlane: "api",
      async execute(_args, context) {
        const client = requireApiClient(context);
        const response = await client.request(
          "GET",
          "/project/available/frameworks",
          undefined,
          context.auth,
        );
        return jsonResult("Available Frameworks", response);
      },
    },
    {
      name: "platui_get_available_languages",
      description:
        'List the language/styling values platui_import_figma accepts for a given framework (e.g. for React this is a styling approach like "Tailwind" or "CSS(inline)", not a programming language). Call this instead of guessing.',
      inputSchema: {
        type: "object",
        properties: {
          framework: {
            type: "string",
            description:
              "Framework to list languages for, e.g. a value from platui_get_available_frameworks.",
          },
        },
        required: ["framework"],
        additionalProperties: false,
      },
      validator: z.object({ framework: z.string().min(1) }).strict(),
      visibility: "public",
      requiredScopes: ["project:read"],
      riskLevel: "read",
      executionPlane: "api",
      async execute(args, context) {
        const client = requireApiClient(context);
        const response = await client.request(
          "GET",
          `/project/available/languages?framework=${encodeURIComponent(args.framework)}`,
          undefined,
          context.auth,
        );
        return jsonResult("Available Languages", response);
      },
    },
    {
      name: "platui_parse_figma_url",
      description: "Parse a Figma design/file URL into fileKey and optional nodeId before import.",
      inputSchema: {
        type: "object",
        properties: {
          figmaUrl: { type: "string", description: "Figma design or file URL." },
        },
        required: ["figmaUrl"],
        additionalProperties: false,
      },
      validator: z.object({ figmaUrl: z.string().url() }).strict(),
      visibility: "public",
      requiredScopes: ["design:read"],
      riskLevel: "read",
      executionPlane: "edge",
      async execute(args) {
        return jsonResult("Parsed Figma URL", parseFigmaUrl(args.figmaUrl));
      },
    },
    {
      name: "platui_import_figma",
      description:
        "Start a BRAND-NEW PlatUI project from a Figma URL. This always creates a new project -- there is no update/overwrite path. BEFORE calling this: (1) call platui_list_projects and REUSE any existing project for this same Figma file (add screens with platui_import_figma_mcp_context / platui_import_figma_plugin_payload) instead of creating duplicates; (2) look at the design first -- platui_get_figma_screenshot and platui_parse_figma_url -- and SUGGEST a project name from the Figma file/frame name for the user to confirm; never pass a name the user hasn't agreed to. Multiple screens can be imported in ONE call: put comma-separated ids in the node-id param (e.g. ?node-id=1-2,3-4) to avoid Figma 429 rate-limiting. For payment-enabled apps, combine the generated project with Razorpay MCP (see razorpayMcpIntegration in platui_get_capabilities).",
      inputSchema: {
        type: "object",
        properties: {
          figmaUrl: { type: "string", description: "Figma design or file URL." },
          projectName: {
            type: "string",
            description:
              "Name of the new project. Ask the user for this rather than inventing one.",
          },
          // Valid values are backend-owned and can change (e.g. React's
          // "language" is actually a styling approach: "CSS(inline)" or
          // "Tailwind", not a programming language) -- discover the current
          // set via GET /project/available/frameworks and
          // GET /project/available/languages?framework=<framework> rather
          // than trusting a hardcoded list here, which previously drifted
          // out of sync with the deployed backend.
          framework: {
            type: "string",
            description:
              "Framework, e.g. React, Html, Flutter. See GET /project/available/frameworks for the current set.",
          },
          language: {
            type: "string",
            description:
              "Language/styling approach for the given framework, e.g. Tailwind, CSS(inline), Dart. See GET /project/available/languages?framework=<framework> for the current set.",
          },
          techStack: { type: "string", description: "Optional details about the tech stack." },
        },
        required: ["figmaUrl", "projectName", "framework", "language"],
        additionalProperties: false,
      },
      validator: z
        .object({
          figmaUrl: z.string().url(),
          projectName: z.string().min(1),
          framework: z.string().min(1),
          language: z.string().min(1),
          techStack: z.string().optional(),
        })
        .strict(),
      visibility: "public",
      requiredScopes: ["design:import"],
      riskLevel: "write",
      executionPlane: "api",
      async execute(args, context) {
        const client = requireApiClient(context);
        if (!new URL(args.figmaUrl).searchParams.get("node-id")) {
          throw new Error(
            "figmaUrl must include a node-id query param (e.g. ?node-id=1-2) -- PlatUI needs it to locate the frame to import.",
          );
        }
        const response = await client.request(
          "POST",
          "/project/publish/figma-url",
          {
            figmaUrl: args.figmaUrl,
            data: {
              // Wire field names are the API's CreateProjectRequest shape: name/tech_stack,
              // not projectName/techStack (verified against the live API).
              name: args.projectName,
              framework: args.framework,
              language: args.language,
              tech_stack: args.techStack ? { description: args.techStack } : {},
            },
          },
          context.auth,
        );
        return jsonResult("Figma Import Triggered", response);
      },
    },
    {
      name: "platui_import_figma_mcp_context",
      description:
        "Add a screen to an EXISTING PlatUI project from structured design context returned by Figma MCP (Dev Mode). Requires the target project's id -- use platui_list_projects to find it, or platui_import_figma first if the user wants a new project.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          figmaMcpContext: {
            type: "object",
            description: "Raw Figma node selection JSON payload.",
          },
        },
        required: ["projectId", "figmaMcpContext"],
        additionalProperties: false,
      },
      validator: z
        .object({
          projectId: z.string().min(1),
          figmaMcpContext: z.record(z.any()),
        })
        .strict(),
      visibility: "public",
      requiredScopes: ["design:import"],
      riskLevel: "write",
      executionPlane: "api",
      async execute(args, context) {
        const client = requireApiClient(context);
        const response = await client.request(
          "POST",
          "/plugin/publish/screen",
          {
            project_id: args.projectId,
            screen: [{ selection: [args.figmaMcpContext] }],
          },
          context.auth,
        );
        return jsonResult("Figma MCP Context Imported", response);
      },
    },
    {
      name: "platui_import_figma_plugin_payload",
      description:
        "Add one or MANY screens to an EXISTING PlatUI project in a single push. screens is an array where each entry is one screen's Figma node selection (an array of nodes). Alternatively, payload is accepted as a compatible single-screen selection array. Requires the target project's id -- use platui_list_projects to find it, or platui_import_figma first if the user wants a new project.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          screens: {
            type: "array",
            items: { type: "array", items: { type: "object" } },
            description: "One entry per screen; each entry is that screen's node selection array.",
          },
          payload: {
            type: "array",
            items: { type: "object" },
            description: "Compatible single-screen alias: an array of Figma nodes for one screen.",
          },
        },
        required: ["projectId"],
        additionalProperties: false,
      },
      validator: z
        .object({
          projectId: z.string().min(1),
          screens: z.array(z.array(z.record(z.any()))).min(1).optional(),
          payload: z.array(z.record(z.any())).min(1).optional(),
        })
        .refine((data) => data.screens !== undefined || data.payload !== undefined, {
          message: "Either 'screens' or 'payload' must be provided",
        }),
      visibility: "public",
      requiredScopes: ["design:import"],
      riskLevel: "write",
      executionPlane: "api",
      async execute(args, context) {
        const client = requireApiClient(context);
        const screens = (args as { screens?: Record<string, unknown>[][]; payload?: Record<string, unknown>[] }).screens ?? 
          ((args as { payload?: Record<string, unknown>[] }).payload ? [(args as { payload: Record<string, unknown>[] }).payload] : []);
        const response = await client.request(
          "POST",
          "/plugin/publish/screen",
          {
            project_id: args.projectId,
            screen: screens.map((selection: Record<string, unknown>[]) => ({ selection })),
          },
          context.auth,
        );
        return jsonResult("Figma Plugin Payload Imported", response);
      },
    },
    {
      name: "platui_inspect_design",
      description:
        "Summarize screens, layers, components, fonts, assets, and routes. Use this when generated code looks wrong: the node tree shows the design's true structure (including whether Auto Layout was used) so you can fix layout issues in the generated base code yourself.",
      inputSchema: projectIdSchema,
      validator: projectIdValidator,
      visibility: "public",
      requiredScopes: ["design:read"],
      riskLevel: "read",
      executionPlane: "api",
      async execute(args, context) {
        const client = requireApiClient(context);
        const response = await client.request(
          "GET",
          `/workspace/figma/tree/${encodeURIComponent(args.projectId)}`,
          undefined,
          context.auth,
        );
        return jsonResult("Design Node Tree", response);
      },
    },
    {
      name: "platui_get_figma_screenshot",
      description:
        "Render a Figma frame/node to an image via PlatUI's server-side Figma connector (uses the Figma account connected in the PlatUI web app). figmaUrl must include a node-id query param, same as platui_import_figma. Great for LOOKING at a design before importing (suggest a name, confirm scope with the user). Agent rate-limit guidance (Cursor, Claude Code, Antigravity): if this fails with a Figma 429, both screenshots and platui_import_figma share the same Figma rate-limit bucket -- back off for 60-180s instead of hammering.",
      inputSchema: {
        type: "object",
        properties: {
          figmaUrl: {
            type: "string",
            description:
              "Figma design or file URL, including ?node-id=... for the frame to render.",
          },
        },
        required: ["figmaUrl"],
        additionalProperties: false,
      },
      validator: z.object({ figmaUrl: z.string().url() }).strict(),
      visibility: "public",
      requiredScopes: ["design:read"],
      riskLevel: "read",
      executionPlane: "api",
      async execute(args, context) {
        const client = requireApiClient(context);
        if (!new URL(args.figmaUrl).searchParams.get("node-id")) {
          throw new Error(
            "figmaUrl must include a node-id query param (e.g. ?node-id=1-2) -- PlatUI needs it to locate the frame to render.",
          );
        }
        if (!client.requestBinary) {
          throw new Error("The configured PlatUI API client doesn't support binary responses.");
        }
        const { data, contentType } = await client.requestBinary(
          "GET",
          `/project/preview/figma-url?figmaUrl=${encodeURIComponent(args.figmaUrl)}`,
          context.auth,
        );
        return imageResult(data, contentType);
      },
    },
    {
      name: "platui_generate_code",
      description:
        "Compile Figma node JSON payload to code synchronously. Expectation: this is a structural mapping of the design JSON to framework code -- output quality mirrors design hygiene. Designs using Figma Auto Layout produce clean flex layouts; free-floating layers produce absolute positioning that YOU should refactor for responsiveness. If output looks wrong, call platui_inspect_design to see the design's true structure and treat the generated code as the base layout to improve, not a finished result. When refactoring, PRESERVE the generated visual values (dimensions, colors, typography, spacing) -- they are the design's ground truth; restructure code, do not reinvent visuals.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          figmaNodePayload: { type: "object", description: "Raw Figma selection node JSON." },
        },
        required: ["projectId", "figmaNodePayload"],
        additionalProperties: false,
      },
      validator: z
        .object({
          projectId: z.string().min(1),
          figmaNodePayload: z.record(z.any()),
        })
        .strict(),
      visibility: "public",
      requiredScopes: ["codegen:run"],
      riskLevel: "write",
      executionPlane: "api",
      async execute(args, context) {
        const client = requireApiClient(context);
        const response = await client.request(
          "POST",
          `/plugin/${encodeURIComponent(args.projectId)}/preview/compile`,
          {
            json_data: args.figmaNodePayload,
            imgData: "",
          },
          context.auth,
        );
        return jsonResult("Codegen Output", response);
      },
    },
    {
      name: "platui_create_preview",
      description: "Generate preview for Figma node selection payload.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          figmaNodePayload: { type: "object", description: "Raw Figma selection node JSON." },
          imgData: { type: "string", description: "Optional base64 or URL screenshot image." },
        },
        required: ["projectId", "figmaNodePayload"],
        additionalProperties: false,
      },
      validator: z
        .object({
          projectId: z.string().min(1),
          figmaNodePayload: z.record(z.any()),
          imgData: z.string().optional(),
        })
        .strict(),
      visibility: "public",
      requiredScopes: ["preview:write"],
      riskLevel: "write",
      executionPlane: "api",
      async execute(args, context) {
        const client = requireApiClient(context);
        const response = await client.request(
          "POST",
          `/plugin/${encodeURIComponent(args.projectId)}/preview/compile`,
          {
            json_data: args.figmaNodePayload,
            imgData: args.imgData ?? "",
          },
          context.auth,
        );
        return jsonResult("Preview Compilation", response);
      },
    },
    {
      name: "platui_get_preview",
      description: "Return preview data using a refresh token.",
      inputSchema: {
        type: "object",
        properties: {
          previewId: { type: "string", description: "Short-lived refresh token/preview ID." },
        },
        required: ["previewId"],
        additionalProperties: false,
      },
      validator: z.object({ previewId: z.string().min(1) }).strict(),
      visibility: "public",
      requiredScopes: ["preview:read"],
      riskLevel: "read",
      executionPlane: "api",
      async execute(args, context) {
        const client = requireApiClient(context);
        const responseWithQuery = await client.request(
          "POST",
          `/preview?refreshToken=${encodeURIComponent(args.previewId)}`,
          undefined,
          context.auth,
        );
        return jsonResult("Preview Data", responseWithQuery);
      },
    },
    {
      name: "platui_get_artifacts",
      description:
        "List generated artifact files (paths + S3 presigned download URLs) for a project. To read a specific file's code, call platui_get_artifact_content. External agent guidance (Cursor, Claude Code, Antigravity): (1) the listing contains the design's ASSETS (images/vectors/fonts) that the code references -- download and cache them locally at the exact paths the code expects, never hotlink expiring S3 presigned URLs; (2) S3 asset extraction runs asynchronously in the background AFTER code generation and can lag by several minutes -- if assets{} is empty or missing files shortly after generation succeeded, wait and re-poll platui_get_artifacts before concluding assets don't exist.",
      inputSchema: projectIdSchema,
      validator: projectIdValidator,
      visibility: "public",
      requiredScopes: ["artifact:read"],
      riskLevel: "read",
      executionPlane: "api",
      async execute(args, context) {
        const client = requireApiClient(context);
        const response = await client.request(
          "GET",
          `/workspace/files/path/${encodeURIComponent(args.projectId)}`,
          undefined,
          context.auth,
        );
        return jsonResult("Project Artifact Files", response);
      },
    },
    {
      name: "platui_get_artifact_content",
      description:
        "Fetch one generated file's code as text, ready to write into the workspace with your own file tools -- no manual downloading. filePath is a path from platui_get_artifacts; a partial suffix match works (e.g. 'src/App.jsx'). Binary or oversized files return their S3 presigned download URL instead of inline content (cache binary assets locally before the presigned URL expires; if HTTP 403 occurs, call platui_get_artifacts for fresh S3 URLs).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "PlatUI project id." },
          filePath: {
            type: "string",
            description: "Artifact file path (or unique path suffix) from platui_get_artifacts.",
          },
        },
        required: ["projectId", "filePath"],
        additionalProperties: false,
      },
      validator: z
        .object({
          projectId: z.string().min(1),
          filePath: z.string().min(1),
        })
        .strict(),
      visibility: "public",
      requiredScopes: ["artifact:read"],
      riskLevel: "read",
      executionPlane: "api",
      async execute(args, context) {
        const client = requireApiClient(context);
        const listing = await client.request<unknown>(
          "GET",
          `/workspace/files/path/${encodeURIComponent(args.projectId)}`,
          undefined,
          context.auth,
        );

        const files = collectArtifactUrls(listing);
        if (files.length === 0) {
          throw new Error(
            "No artifact files found for this project. Generation may have failed or not run yet -- check platui_check_job_status.",
          );
        }

        const exactMatch = files.find((file) => file.path === args.filePath);
        let match = exactMatch;
        if (!match) {
          const suffixMatches = files.filter(
            (file) => file.path.endsWith("/" + args.filePath) || file.path.endsWith(args.filePath),
          );
          if (suffixMatches.length > 1) {
            throw new Error(
              `Ambiguous artifact suffix "${args.filePath}". Matches multiple files:\n${suffixMatches
                .map((file) => file.path)
                .join("\n")}\nPlease provide the exact path.`,
            );
          }
          match = suffixMatches[0];
        }
        if (!match) {
          throw new Error(
            `No artifact matches "${args.filePath}". Available files:\n${files
              .map((file) => file.path)
              .join("\n")}`,
          );
        }

        const response = await fetch(match.url);
        if (!response.ok) {
          throw new Error(
            `Downloading "${match.path}" failed with ${response.status}. The URL may have expired -- call platui_get_artifacts again for a fresh listing.`,
          );
        }

        const contentType = response.headers.get("content-type") ?? "";
        const buffer = Buffer.from(await response.arrayBuffer());
        if (isBinaryArtifact(contentType, buffer) || buffer.length > MAX_INLINE_ARTIFACT_BYTES) {
          return jsonResult(`Artifact: ${match.path}`, {
            path: match.path,
            inline: false,
            reason:
              buffer.length > MAX_INLINE_ARTIFACT_BYTES
                ? `File is ${buffer.length} bytes (inline cap ${MAX_INLINE_ARTIFACT_BYTES}).`
                : `Content type "${contentType}" is not text.`,
            downloadUrl: match.url,
          });
        }

        return textResult(`// ${match.path}\n${buffer.toString("utf-8")}`);
      },
    },
    {
      name: "platui_check_job_status",
      description: "Check asynchronous codegen queue and build pipeline status.",
      inputSchema: projectIdSchema,
      validator: projectIdValidator,
      visibility: "public",
      requiredScopes: ["project:read"],
      riskLevel: "read",
      executionPlane: "api",
      async execute(args, context) {
        const client = requireApiClient(context);
        const response = await client.request(
          "GET",
          `/plugin/${encodeURIComponent(args.projectId)}/status`,
          undefined,
          context.auth,
        );
        return jsonResult("Job Pipeline Status", response);
      },
    },
    {
      name: "platui_get_connected_apps",
      description: "Check connection status of third-party apps like Figma, GitHub, and Google.",
      inputSchema: emptyObjectSchema,
      validator: z.object({}).strict(),
      visibility: "public",
      requiredScopes: ["project:read"],
      riskLevel: "read",
      executionPlane: "api",
      async execute(_args, context) {
        const user = await requireApiClient(context).request<any>(
          "GET",
          "/user",
          undefined,
          context.auth,
        );
        const data = user?.data || user || {};
        // The /user endpoint never returns raw OAuth token material -- only
        // server-computed connection booleans -- so there is nothing sensitive
        // to leak here by design.
        const figmaConnected = !!data.figmaConnected;
        const githubConnected = !!data.githubConnected;
        const googleConnected = !!data.googleConnected;
        const disconnected = [
          !figmaConnected && "Figma",
          !githubConnected && "GitHub",
          !googleConnected && "Google",
        ].filter((v): v is string => Boolean(v));

        return jsonResult("Connected Apps", {
          figmaConnected,
          githubConnected,
          googleConnected,
          username: data.username,
          email: data.email,
          ...(disconnected.length > 0
            ? {
                hint: context.appBaseUrl
                  ? `${disconnected.join(", ")} not connected. Ask the user to open ${context.appBaseUrl} and connect ${disconnected.length > 1 ? "them" : "it"} there -- app connections are handled in the PlatUI web UI, not via MCP.`
                  : `${disconnected.join(", ")} not connected. Ask the user to connect ${disconnected.length > 1 ? "them" : "it"} in the PlatUI web app.`,
              }
            : {}),
        });
      },
    },
    {
      name: "platui_add_project_member",
      description: "Invite a user (by email) to collaborate on a project.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          userEmail: { type: "string", description: "Email of the user to add." },
        },
        required: ["projectId", "userEmail"],
        additionalProperties: false,
      },
      validator: z
        .object({
          projectId: z.string().min(1),
          userEmail: z.string().email(),
        })
        .strict(),
      visibility: "public",
      requiredScopes: ["project:write"],
      riskLevel: "write",
      executionPlane: "api",
      async execute(args, context) {
        const client = requireApiClient(context);
        const response = await client.request(
          "POST",
          "/project/member/add",
          { project_id: args.projectId, user_email: args.userEmail },
          context.auth,
        );
        return jsonResult("Project Member Added", response);
      },
    },
    {
      name: "platui_remove_project_member",
      description: "Remove a user (by email) from a project.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          userEmail: { type: "string", description: "Email of the user to remove." },
        },
        required: ["projectId", "userEmail"],
        additionalProperties: false,
      },
      validator: z
        .object({
          projectId: z.string().min(1),
          userEmail: z.string().email(),
        })
        .strict(),
      visibility: "public",
      requiredScopes: ["project:write"],
      riskLevel: "write",
      executionPlane: "api",
      async execute(args, context) {
        const client = requireApiClient(context);
        const response = await client.request(
          "DELETE",
          "/project/member/remove",
          { project_id: args.projectId, user_email: args.userEmail },
          context.auth,
        );
        return jsonResult("Project Member Removed", response);
      },
    },
    {
      name: "platui_list_project_members",
      description: "List everyone with access to a project.",
      inputSchema: projectIdSchema,
      validator: projectIdValidator,
      visibility: "public",
      requiredScopes: ["project:read"],
      riskLevel: "read",
      executionPlane: "api",
      async execute(args, context) {
        const client = requireApiClient(context);
        const response = await client.request(
          "GET",
          `/project/${encodeURIComponent(args.projectId)}/member/all`,
          undefined,
          context.auth,
        );
        return jsonResult("Project Members", response);
      },
    },
    {
      name: "platui_trigger_web_builder_deploy",
      description:
        "Trigger the web-builder build/deploy pipeline for a generated project. genId/s3PathCodegen/s3PathDeploy come from platui_get_project_context and platui_get_artifacts, not from the user.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          genId: {
            type: "string",
            description: "Generation id, e.g. from platui_get_project_context's genId field.",
          },
          s3PathCodegen: { type: "string", description: "S3 path of the generated code." },
          s3PathDeploy: { type: "string", description: "S3 path to deploy the built output to." },
          projectType: { type: "string", description: "Project type, e.g. react." },
        },
        required: ["projectId", "genId", "s3PathCodegen", "s3PathDeploy"],
        additionalProperties: false,
      },
      validator: z
        .object({
          projectId: z.string().min(1),
          genId: z.string().min(1),
          s3PathCodegen: z.string().min(1),
          s3PathDeploy: z.string().min(1),
          projectType: z.string().optional(),
        })
        .strict(),
      visibility: "public",
      requiredScopes: ["codegen:run"],
      riskLevel: "write",
      executionPlane: "api",
      async execute(args, context) {
        const client = requireApiClient(context);
        const response = await client.request(
          "POST",
          "/web-builder/trigger",
          {
            projectId: args.projectId,
            genId: args.genId,
            s3PathCodegen: args.s3PathCodegen,
            s3PathDeploy: args.s3PathDeploy,
            ...(args.projectType ? { projectType: args.projectType } : {}),
          },
          context.auth,
        );
        return jsonResult("Web Builder Deploy Triggered", response);
      },
    },
    {
      name: "platui_get_web_builder_logs",
      description: "Fetch build logs for a web-builder deploy by generation id.",
      inputSchema: {
        type: "object",
        properties: {
          genId: {
            type: "string",
            description: "Generation id, e.g. from platui_get_project_context's genId field.",
          },
        },
        required: ["genId"],
        additionalProperties: false,
      },
      validator: z.object({ genId: z.string().min(1) }).strict(),
      visibility: "public",
      requiredScopes: ["project:read"],
      riskLevel: "read",
      executionPlane: "api",
      async execute(args, context) {
        const client = requireApiClient(context);
        const response = await client.request(
          "GET",
          `/web-builder/logs?genId=${encodeURIComponent(args.genId)}`,
          undefined,
          context.auth,
        );
        return jsonResult("Web Builder Logs", response);
      },
    },
    {
      name: "platui_get_web_builder_artifacts",
      description: "List deploy artifacts for a web-builder build by generation id.",
      inputSchema: {
        type: "object",
        properties: {
          genId: {
            type: "string",
            description: "Generation id, e.g. from platui_get_project_context's genId field.",
          },
        },
        required: ["genId"],
        additionalProperties: false,
      },
      validator: z.object({ genId: z.string().min(1) }).strict(),
      visibility: "public",
      requiredScopes: ["artifact:read"],
      riskLevel: "read",
      executionPlane: "api",
      async execute(args, context) {
        const client = requireApiClient(context);
        const response = await client.request(
          "GET",
          `/web-builder/artifacts?genId=${encodeURIComponent(args.genId)}`,
          undefined,
          context.auth,
        );
        return jsonResult("Web Builder Artifacts", response);
      },
    },
    {
      name: "platui_get_user_state",
      description: "Return the current user's state/preferences.",
      inputSchema: emptyObjectSchema,
      validator: z.object({}).strict(),
      visibility: "public",
      requiredScopes: ["project:read"],
      riskLevel: "read",
      executionPlane: "api",
      async execute(_args, context) {
        const client = requireApiClient(context);
        const response = await client.request("GET", "/user/state", undefined, context.auth);
        return jsonResult("User State", response);
      },
    },
    {
      name: "platui_get_user_plan",
      description: "Return the current user's plan/usage details.",
      inputSchema: emptyObjectSchema,
      validator: z.object({}).strict(),
      visibility: "public",
      requiredScopes: ["project:read"],
      riskLevel: "read",
      executionPlane: "api",
      async execute(_args, context) {
        const client = requireApiClient(context);
        const response = await client.request("GET", "/user-plans", undefined, context.auth);
        return jsonResult("User Plan", response);
      },
    },
  ];
}
