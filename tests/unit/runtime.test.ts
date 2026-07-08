import { describe, expect, it, vi } from "vitest";
import { HttpApiClient } from "platui-mcp-core";

vi.mock("platui-mcp-core", async () => {
  const actual = await vi.importActual<typeof import("platui-mcp-core")>("platui-mcp-core");
  return {
    ...actual,
    // Keep unit tests hermetic: never read a real ~/.platui/credentials.json.
    loadCachedCredentials: vi.fn(() => undefined),
  };
});

import {
  DEFAULT_API_BASE_URL,
  DEFAULT_APP_BASE_URL,
  LoginHintApiClient,
  resolveRuntimeOptions,
} from "../../src/runtime";

describe("resolveRuntimeOptions", () => {
  it("gives a zero-config customer production endpoints and full local scopes", () => {
    const options = resolveRuntimeOptions({} as NodeJS.ProcessEnv);

    expect(DEFAULT_API_BASE_URL).toBe("https://timon.platui.com");
    expect(options.appBaseUrl).toBe(DEFAULT_APP_BASE_URL);
    expect(options.appBaseUrl).toBe("https://chat.platui.com");
    // Empty scopes would make the local registry reject 24 of the 27 tools
    // even after a successful login (the rc.1 defect).
    expect(options.auth.scopes).toEqual(["*"]);
    expect(options.apiClient).toBeInstanceOf(LoginHintApiClient);
  });

  it("lets team env overrides win over the baked-in defaults", () => {
    const options = resolveRuntimeOptions({
      PLATUI_PUBLIC_API_BASE_URL: "https://timon.sandbox.platui.com",
      PLATUI_APP_BASE_URL: "https://preview.example.com",
      PLATUI_MCP_SCOPES: "project:read design:read",
    } as NodeJS.ProcessEnv);

    expect(options.appBaseUrl).toBe("https://preview.example.com");
    expect(options.auth.scopes).toEqual(["project:read", "design:read"]);
  });

  it("prefers an explicit access token env var over the cached login", () => {
    const options = resolveRuntimeOptions({
      PLATUI_MCP_ACCESS_TOKEN: "explicit-token",
    } as NodeJS.ProcessEnv);

    expect(options.auth.accessToken).toBe("explicit-token");
  });
});

describe("LoginHintApiClient", () => {
  function clientHitting(status: number, body = "{}") {
    const fetchImpl = vi.fn(async () => new Response(body, { status }));
    return new LoginHintApiClient(
      new HttpApiClient({ baseUrl: "https://api.example.com", fetchImpl }),
    );
  }

  it("appends the platui_login hint to 401 failures", async () => {
    await expect(clientHitting(401).request("GET", "/project/all")).rejects.toThrow(/platui_login/);
  });

  it("passes non-401 failures through untouched", async () => {
    await expect(clientHitting(500).request("GET", "/project/all")).rejects.toThrow(
      /failed with 500/,
    );
    await expect(clientHitting(500).request("GET", "/project/all")).rejects.not.toThrow(
      /platui_login/,
    );
  });

  it("passes successful responses through", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const client = new LoginHintApiClient(
      new HttpApiClient({ baseUrl: "https://api.example.com", fetchImpl }),
    );
    await expect(client.request("GET", "/project/all")).resolves.toEqual({ ok: true });
  });

  it("appends the hint on binary 401s too", async () => {
    await expect(clientHitting(401).requestBinary("GET", "/preview.png")).rejects.toThrow(
      /platui_login/,
    );
  });
});
