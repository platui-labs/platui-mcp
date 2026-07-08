import { describe, expect, it, vi } from "vitest";
import { ToolRegistry, type ApiClient, type AuthContext } from "platui-mcp-core";
import { createPlatuiMcpServer } from "../../src/mcp/server";
import { buildPublicTools } from "../../src/tools/public-catalog";

// platui_check_login persists a granted token via platui-mcp-core's token
// store; keep this integration suite from writing a real
// ~/.platui/credentials.json.
vi.mock("platui-mcp-core", async () => {
  const actual = await vi.importActual<typeof import("platui-mcp-core")>("platui-mcp-core");
  return {
    ...actual,
    saveCachedCredentials: vi.fn(),
    loadCachedCredentials: vi.fn(() => undefined),
    clearCachedCredentials: vi.fn(),
  };
});

class RecordingApiClient implements ApiClient {
  calls: Array<{ method: string; path: string; body: unknown; subject?: string }> = [];
  binaryCalls: Array<{ method: string; path: string; subject?: string }> = [];

  async request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    auth?: AuthContext,
  ) {
    this.calls.push({ method, path, body, subject: auth?.subject });
    return { ok: true, method, path, body };
  }

  async requestBinary(method: "GET" | "POST", path: string, auth?: AuthContext) {
    this.binaryCalls.push({ method, path, subject: auth?.subject });
    return { data: Buffer.from("fake-png-bytes"), contentType: "image/png" };
  }
}

const auth: AuthContext = {
  subject: "integration-user",
  tenantId: "tenant-1",
  projectIds: ["project-1"],
  scopes: ["*"],
  adminScopes: ["admin:*"],
};

const publicToolCases: Array<{
  name: string;
  args: Record<string, unknown>;
  path?: string;
  method?: string;
}> = [
  { name: "platui_get_capabilities", args: {} },
  {
    name: "platui_parse_figma_url",
    args: { figmaUrl: "https://www.figma.com/design/fileKey/Test?node-id=1-2" },
  },
  {
    name: "platui_get_project_context",
    args: { projectId: "project-1" },
    method: "GET",
    path: "/project/project-1",
  },
  { name: "platui_list_projects", args: {}, method: "GET", path: "/project/all" },
  {
    name: "platui_get_available_frameworks",
    args: {},
    method: "GET",
    path: "/project/available/frameworks",
  },
  {
    name: "platui_get_available_languages",
    args: { framework: "React" },
    method: "GET",
    path: "/project/available/languages?framework=React",
  },
  {
    name: "platui_import_figma",
    args: {
      figmaUrl: "https://figma.com/file/fileKey/Test?node-id=1-2",
      projectName: "Project 1",
      framework: "React",
      language: "TypeScript",
    },
    method: "POST",
    path: "/project/publish/figma-url",
  },
  {
    name: "platui_import_figma_mcp_context",
    args: { projectId: "project-1", figmaMcpContext: { frame: "Hero" } },
    method: "POST",
    path: "/plugin/publish/screen",
  },
  {
    name: "platui_import_figma_plugin_payload",
    args: { projectId: "project-1", payload: [{ frame: "Hero" }] },
    method: "POST",
    path: "/plugin/publish/screen",
  },
  {
    name: "platui_inspect_design",
    args: { projectId: "project-1" },
    method: "GET",
    path: "/workspace/figma/tree/project-1",
  },
  {
    name: "platui_generate_code",
    args: { projectId: "project-1", figmaNodePayload: { frame: "Hero" } },
    method: "POST",
    path: "/plugin/project-1/preview/compile",
  },
  {
    name: "platui_create_preview",
    args: { projectId: "project-1", figmaNodePayload: { frame: "Hero" } },
    method: "POST",
    path: "/plugin/project-1/preview/compile",
  },
  {
    name: "platui_get_preview",
    args: { previewId: "preview-1" },
    method: "POST",
    path: "/preview?refreshToken=preview-1",
  },
  {
    name: "platui_get_artifacts",
    args: { projectId: "project-1" },
    method: "GET",
    path: "/workspace/files/path/project-1",
  },
  {
    name: "platui_check_job_status",
    args: { projectId: "project-1" },
    method: "GET",
    path: "/plugin/project-1/status",
  },
  { name: "platui_get_connected_apps", args: {}, method: "GET", path: "/user" },
  {
    name: "platui_add_project_member",
    args: { projectId: "project-1", userEmail: "a@b.com" },
    method: "POST",
    path: "/project/member/add",
  },
  {
    name: "platui_remove_project_member",
    args: { projectId: "project-1", userEmail: "a@b.com" },
    method: "DELETE",
    path: "/project/member/remove",
  },
  {
    name: "platui_list_project_members",
    args: { projectId: "project-1" },
    method: "GET",
    path: "/project/project-1/member/all",
  },
  {
    name: "platui_trigger_web_builder_deploy",
    args: {
      projectId: "project-1",
      genId: "gen-1",
      s3PathCodegen: "s3://a",
      s3PathDeploy: "s3://b",
    },
    method: "POST",
    path: "/web-builder/trigger",
  },
  {
    name: "platui_get_web_builder_logs",
    args: { genId: "gen-1" },
    method: "GET",
    path: "/web-builder/logs?genId=gen-1",
  },
  {
    name: "platui_get_web_builder_artifacts",
    args: { genId: "gen-1" },
    method: "GET",
    path: "/web-builder/artifacts?genId=gen-1",
  },
  { name: "platui_get_user_state", args: {}, method: "GET", path: "/user/state" },
  { name: "platui_get_user_plan", args: {}, method: "GET", path: "/user-plans" },
];

describe("catalog integration", () => {
  it("has the expected 27 public tools", () => {
    const publicNames = buildPublicTools().map((tool) => tool.name);

    // 27 tools: platui_refactor_code and platui_export_project_zip were
    // removed (redundant with platui_get_artifacts / not needed via MCP),
    // and 12 tools were added: project listing, available
    // frameworks/languages discovery, a Figma screenshot tool, project
    // collaboration (add/remove/list members), the web-builder deploy
    // pipeline (trigger/logs/artifacts), and read-only user state/plan.
    expect(publicNames).toHaveLength(27);
    expect(publicNames).toContain("platui_get_capabilities");
    expect(publicNames).toContain("platui_login");
    expect(publicNames).toContain("platui_check_login");
    expect(publicNames).not.toContain("platui_refactor_code");
    expect(publicNames).not.toContain("platui_export_project_zip");
    // Internal/admin tools live in the separate platui-mcp-internal repo now.
    expect(publicNames).not.toContain("platui_search_workspace");
    expect(publicNames).not.toContain("platui_compile_figma");
  });

  it("routes every public tool through local logic or the configured API client", async () => {
    const apiClient = new RecordingApiClient();
    const registry = new ToolRegistry("public", buildPublicTools());

    for (const testCase of publicToolCases) {
      const before = apiClient.calls.length;
      const result = await registry.call(testCase.name, testCase.args, {
        profile: "public",
        auth,
        apiClient,
      });

      expect(result.content[0].type).toBe("text");
      if (testCase.path && testCase.method) {
        expect(apiClient.calls).toHaveLength(before + 1);
        expect(apiClient.calls.at(-1)).toMatchObject({
          method: testCase.method,
          path: testCase.path,
          subject: "integration-user",
        });
      } else {
        expect(apiClient.calls).toHaveLength(before);
      }
    }
  });

  it("platui_get_figma_screenshot returns MCP image content from a binary API response", async () => {
    const apiClient = new RecordingApiClient();
    const registry = new ToolRegistry("public", buildPublicTools());

    const result = await registry.call(
      "platui_get_figma_screenshot",
      {
        figmaUrl: "https://figma.com/file/fileKey/Test?node-id=1-2",
      },
      { profile: "public", auth, apiClient },
    );

    expect(result.content[0].type).toBe("image");
    expect(result.content[0]).toMatchObject({ mimeType: "image/png" });
    expect(apiClient.binaryCalls).toHaveLength(1);
    expect(apiClient.binaryCalls[0]).toMatchObject({
      method: "GET",
      path: "/project/preview/figma-url?figmaUrl=https%3A%2F%2Ffigma.com%2Ffile%2FfileKey%2FTest%3Fnode-id%3D1-2",
    });
  });

  it("platui_get_figma_screenshot rejects a Figma URL missing node-id before calling the API", async () => {
    const apiClient = new RecordingApiClient();
    const registry = new ToolRegistry("public", buildPublicTools());

    await expect(
      registry.call(
        "platui_get_figma_screenshot",
        {
          figmaUrl: "https://figma.com/file/fileKey/Test",
        },
        { profile: "public", auth, apiClient },
      ),
    ).rejects.toThrow(/node-id/);

    expect(apiClient.binaryCalls).toHaveLength(0);
  });

  it("platui_get_figma_screenshot rejects when the configured API client doesn't support binary responses", async () => {
    const registry = new ToolRegistry("public", buildPublicTools());
    const textOnlyClient: ApiClient = {
      async request() {
        return { data: {} };
      },
    };

    await expect(
      registry.call(
        "platui_get_figma_screenshot",
        {
          figmaUrl: "https://figma.com/file/fileKey/Test?node-id=1-2",
        },
        { profile: "public", auth, apiClient: textOnlyClient },
      ),
    ).rejects.toThrow(/doesn't support binary responses/);
  });

  it("platui_get_connected_apps surfaces a hint to use the web app when apps are disconnected", async () => {
    const registry = new ToolRegistry("public", buildPublicTools());
    const disconnectedClient: ApiClient = {
      async request() {
        return { data: { username: "u1", email: "u1@example.com" } };
      },
    };

    const result = await registry.call(
      "platui_get_connected_apps",
      {},
      {
        profile: "public",
        auth,
        apiClient: disconnectedClient,
        appBaseUrl: "https://app.example.com",
      },
    );

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain('"figmaConnected": false');
    expect(text).toContain("https://app.example.com");
    expect(text).toContain("Figma, GitHub, Google");
  });

  it("platui_get_connected_apps hints without a web app URL when appBaseUrl isn't configured", async () => {
    const registry = new ToolRegistry("public", buildPublicTools());
    const disconnectedClient: ApiClient = {
      async request() {
        return { data: { username: "u1", email: "u1@example.com" } };
      },
    };

    const result = await registry.call(
      "platui_get_connected_apps",
      {},
      {
        profile: "public",
        auth,
        apiClient: disconnectedClient,
      },
    );

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("connect them in the PlatUI web app");
  });

  it("platui_get_connected_apps omits the hint when all apps are connected", async () => {
    const registry = new ToolRegistry("public", buildPublicTools());
    const connectedClient: ApiClient = {
      async request() {
        return {
          data: {
            username: "u1",
            email: "u1@example.com",
            figmaConnected: true,
            githubConnected: true,
            googleConnected: true,
          },
        };
      },
    };

    const result = await registry.call(
      "platui_get_connected_apps",
      {},
      {
        profile: "public",
        auth,
        apiClient: connectedClient,
        appBaseUrl: "https://app.example.com",
      },
    );

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).not.toContain("hint");
  });

  it("platui_get_connected_apps uses singular phrasing when only one app is disconnected", async () => {
    const registry = new ToolRegistry("public", buildPublicTools());
    const oneDisconnectedClient: ApiClient = {
      async request() {
        return {
          data: {
            username: "u1",
            email: "u1@example.com",
            figmaConnected: false,
            githubConnected: true,
            googleConnected: true,
          },
        };
      },
    };

    const withAppUrl = await registry.call(
      "platui_get_connected_apps",
      {},
      {
        profile: "public",
        auth,
        apiClient: oneDisconnectedClient,
        appBaseUrl: "https://app.example.com",
      },
    );
    const withAppUrlText = withAppUrl.content[0].type === "text" ? withAppUrl.content[0].text : "";
    expect(withAppUrlText).toContain("connect it there");

    const withoutAppUrl = await registry.call(
      "platui_get_connected_apps",
      {},
      {
        profile: "public",
        auth,
        apiClient: oneDisconnectedClient,
      },
    );
    const withoutAppUrlText =
      withoutAppUrl.content[0].type === "text" ? withoutAppUrl.content[0].text : "";
    expect(withoutAppUrlText).toContain("connect it in the PlatUI web app");
  });

  it("platui_get_connected_apps falls back to the raw response when it has no data field", async () => {
    const registry = new ToolRegistry("public", buildPublicTools());
    const rawResponseClient: ApiClient = {
      async request() {
        return { username: "u1", email: "u1@example.com" } as unknown as { data: unknown };
      },
    };

    const result = await registry.call(
      "platui_get_connected_apps",
      {},
      {
        profile: "public",
        auth,
        apiClient: rawResponseClient,
      },
    );

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain('"username": "u1"');
  });

  it("platui_get_connected_apps tolerates a nullish response entirely", async () => {
    const registry = new ToolRegistry("public", buildPublicTools());
    const emptyResponseClient: ApiClient = {
      async request() {
        return undefined as unknown as { data: unknown };
      },
    };

    const result = await registry.call(
      "platui_get_connected_apps",
      {},
      {
        profile: "public",
        auth,
        apiClient: emptyResponseClient,
      },
    );

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain('"figmaConnected": false');
  });

  it("platui_trigger_web_builder_deploy includes projectType in the request body when provided", async () => {
    const apiClient = new RecordingApiClient();
    const registry = new ToolRegistry("public", buildPublicTools());

    await registry.call(
      "platui_trigger_web_builder_deploy",
      {
        projectId: "project-1",
        genId: "gen-1",
        s3PathCodegen: "s3://a",
        s3PathDeploy: "s3://b",
        projectType: "react",
      },
      { profile: "public", auth, apiClient },
    );

    expect(apiClient.calls.at(-1)?.body).toMatchObject({ projectType: "react" });
  });

  it("platui_import_figma sends timon's real CreateProjectRequest field names (name/tech_stack, not projectName/techStack)", async () => {
    const apiClient = new RecordingApiClient();
    const registry = new ToolRegistry("public", buildPublicTools());

    await registry.call(
      "platui_import_figma",
      {
        figmaUrl: "https://figma.com/file/fileKey/Test?node-id=1-2",
        projectName: "Project 1",
        framework: "React",
        language: "TypeScript",
        techStack: "Node.js and Express",
      },
      { profile: "public", auth, apiClient },
    );

    expect(apiClient.calls.at(-1)?.body).toEqual({
      figmaUrl: "https://figma.com/file/fileKey/Test?node-id=1-2",
      data: {
        name: "Project 1",
        framework: "React",
        language: "TypeScript",
        tech_stack: { description: "Node.js and Express" },
      },
    });
  });

  it("platui_import_figma rejects a Figma URL missing node-id before calling the API", async () => {
    const apiClient = new RecordingApiClient();
    const registry = new ToolRegistry("public", buildPublicTools());

    await expect(
      registry.call(
        "platui_import_figma",
        {
          figmaUrl: "https://figma.com/file/fileKey/Test",
          projectName: "Project 1",
          framework: "React",
          language: "TypeScript",
        },
        { profile: "public", auth, apiClient },
      ),
    ).rejects.toThrow(/node-id/);

    expect(apiClient.calls).toHaveLength(0);
  });

  it("fails API-backed public tools when no API client is configured", async () => {
    const registry = new ToolRegistry("public", buildPublicTools());

    await expect(
      registry.call(
        "platui_get_project_context",
        { projectId: "project-1" },
        {
          profile: "public",
          auth,
        },
      ),
    ).rejects.toThrow(/No PlatUI API client/);
  });

  it("platui_login fails cleanly when no app base URL is configured", async () => {
    const registry = new ToolRegistry("public", buildPublicTools());

    await expect(
      registry.call(
        "platui_login",
        {},
        {
          profile: "public",
          auth,
          apiClient: new RecordingApiClient(),
        },
      ),
    ).rejects.toThrow(/No PlatUI app URL is configured/);
  });

  it("platui_login returns an authorize URL built from timon's device-login keys", async () => {
    const registry = new ToolRegistry("public", buildPublicTools());
    const deviceLoginClient: ApiClient = {
      async request() {
        return { data: { read_key: "txn:read", write_key: "txn:write" } };
      },
    };

    const result = await registry.call(
      "platui_login",
      {},
      {
        profile: "public",
        auth,
        apiClient: deviceLoginClient,
        appBaseUrl: "https://app.example.com",
      },
    );

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("txn%3Awrite");
    expect(text).toContain("source=mcp");
    expect(text).toContain("txn:read");
  });

  it("platui_check_login reports pending when timon has not granted access yet", async () => {
    const registry = new ToolRegistry("public", buildPublicTools());
    const pendingClient: ApiClient = {
      async request() {
        return { data: null };
      },
    };

    const result = await registry.call(
      "platui_check_login",
      { readKey: "txn:read" },
      {
        profile: "public",
        auth: { ...auth, accessToken: undefined },
        apiClient: pendingClient,
      },
    );

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain('"granted": false');
  });

  it("platui_check_login caches the token and updates the live auth context once granted", async () => {
    const registry = new ToolRegistry("public", buildPublicTools());
    const grantedClient: ApiClient = {
      async request() {
        return {
          data: { user_id: "u1", token: "eyJ.fake.jwt", expiresAt: Date.now() + 1_000_000 },
        };
      },
    };
    const sessionAuth: AuthContext = { ...auth, accessToken: undefined };

    const result = await registry.call(
      "platui_check_login",
      { readKey: "txn:read" },
      {
        profile: "public",
        auth: sessionAuth,
        apiClient: grantedClient,
      },
    );

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain('"granted": true');
    expect(sessionAuth.accessToken).toBe("eyJ.fake.jwt");
  });

  it("creates the public MCP server runtime", () => {
    const publicRuntime = createPlatuiMcpServer({ auth, apiClient: new RecordingApiClient() });

    expect(publicRuntime.registry.list().map((tool) => tool.name)).toContain(
      "platui_get_capabilities",
    );
    // Internal/admin tools live in the separate platui-mcp-internal repo now.
    expect(publicRuntime.registry.list().map((tool) => tool.name)).not.toContain(
      "platui_search_workspace",
    );
  });
});
