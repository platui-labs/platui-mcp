import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "platui-mcp-core";

const saveCachedCredentials = vi.fn();

vi.mock("platui-mcp-core", async () => {
  const actual = await vi.importActual<typeof import("platui-mcp-core")>("platui-mcp-core");
  return {
    ...actual,
    saveCachedCredentials: (...args: unknown[]) => saveCachedCredentials(...args),
  };
});

import { completeDeviceLogin, startDeviceLogin } from "../../src/tools/device-auth";

function fakeClient(response: unknown): ApiClient {
  return {
    request: vi.fn(async () => response),
  };
}

describe("device-auth", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("startDeviceLogin", () => {
    it("calls timon's plugin login endpoint and builds a source=mcp authorize URL", async () => {
      const client = fakeClient({ data: { read_key: "txn:read", write_key: "txn:write" } });

      const result = await startDeviceLogin(client, "https://app.example.com/");

      expect(client.request).toHaveBeenCalledWith("POST", "/auth/plugin/figma/login", {});
      expect(result).toEqual({
        readKey: "txn:read",
        writeKey: "txn:write",
        authorizeUrl: "https://app.example.com/plugin/login?writeKey=txn%3Awrite&source=mcp",
      });
    });

    it("strips trailing slashes from the app base URL", async () => {
      const client = fakeClient({ data: { read_key: "r", write_key: "w" } });
      const result = await startDeviceLogin(client, "https://app.example.com///");
      expect(result.authorizeUrl).toBe(
        "https://app.example.com/plugin/login?writeKey=w&source=mcp",
      );
    });
  });

  describe("completeDeviceLogin", () => {
    it("returns granted:false and does not cache anything when access is not yet granted", async () => {
      const client = fakeClient({ data: null });

      const result = await completeDeviceLogin(client, "txn:read");

      expect(client.request).toHaveBeenCalledWith("POST", "/auth/plugin/figma/checkAccess", {
        read_key: "txn:read",
      });
      expect(result).toEqual({ granted: false });
      expect(saveCachedCredentials).not.toHaveBeenCalled();
    });

    it("returns granted:true and caches the token when access has been granted", async () => {
      const client = fakeClient({ data: { user_id: "u1", token: "eyJ.fake.jwt", expiresAt: 123 } });

      const result = await completeDeviceLogin(client, "txn:read");

      expect(result).toEqual({ granted: true, accessToken: "eyJ.fake.jwt" });
      expect(saveCachedCredentials).toHaveBeenCalledWith({
        accessToken: "eyJ.fake.jwt",
        expiresAt: 123,
      });
    });
  });
});
