import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry, type ApiClient, type AuthContext } from "platui-mcp-core";
import { buildPublicTools } from "../../src/tools/public-catalog";

const auth: AuthContext = {
  subject: "artifact-test-user",
  projectIds: [],
  scopes: ["*"],
  adminScopes: [],
};

// The /workspace/files/path listing shape is backend-owned; this mirrors the
// nested folders -> file -> presigned-URL structure seen in real responses.
const listing = {
  data: {
    src: {
      "App.jsx": "https://s3.example/signed/App.jsx?sig=abc",
      components: {
        "Login.jsx": "https://s3.example/signed/Login.jsx?sig=def",
      },
      // Non-URL strings and null values must be ignored, not treated as files.
      note: "not-a-url",
      empty: null,
    },
    assets: {
      "logo.png": "https://s3.example/signed/logo.png?sig=ghi",
    },
  },
};

function call(response: unknown, args: Record<string, unknown>) {
  const apiClient: ApiClient = { request: vi.fn(async () => response) };
  return new ToolRegistry("public", buildPublicTools()).call("platui_get_artifact_content", args, {
    profile: "public",
    auth,
    apiClient,
  });
}

function stubFetch(body: BodyInit | null, init: ResponseInit & { contentType?: string } = {}) {
  const { contentType, ...responseInit } = init;
  const response = new Response(body, {
    status: 200,
    ...responseInit,
    headers: contentType ? { "content-type": contentType } : {},
  });
  const impl = vi.fn(async () => response);
  vi.stubGlobal("fetch", impl);
  return impl;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("platui_get_artifact_content", () => {
  it("returns a text file's content inline with its path header", async () => {
    const fetchImpl = stubFetch("export default function App() {}", {
      contentType: "text/plain",
    });

    const result = await call(listing, {
      projectId: "p1",
      filePath: "data/src/App.jsx",
    });

    expect(fetchImpl).toHaveBeenCalledWith("https://s3.example/signed/App.jsx?sig=abc");
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("// data/src/App.jsx");
    expect(text).toContain("export default function App()");
  });

  it("matches by unique path suffix so agents can use natural file names", async () => {
    const fetchImpl = stubFetch("const login = true;", { contentType: "application/javascript" });

    await call(listing, { projectId: "p1", filePath: "components/Login.jsx" });

    expect(fetchImpl).toHaveBeenCalledWith("https://s3.example/signed/Login.jsx?sig=def");
  });

  it("returns the download URL instead of inline content for binary files", async () => {
    stubFetch(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { contentType: "image/png" });

    const result = await call(listing, { projectId: "p1", filePath: "logo.png" });

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain('"inline": false');
    expect(text).toContain("is not text");
    expect(text).toContain("https://s3.example/signed/logo.png?sig=ghi");
  });

  it("treats octet-stream as binary", async () => {
    stubFetch("anything", { contentType: "application/octet-stream" });

    const result = await call(listing, { projectId: "p1", filePath: "App.jsx" });
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain('"inline": false');
  });

  it("falls back to null-byte sniffing when the content type is unhelpful", async () => {
    stubFetch(Buffer.from([0x00, 0x01, 0x02]), { contentType: "who/knows" });

    const result = await call(listing, { projectId: "p1", filePath: "App.jsx" });
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain('"inline": false');
  });

  it("treats unhelpful content types without null bytes as text", async () => {
    stubFetch("plain enough", { contentType: "who/knows" });

    const result = await call(listing, { projectId: "p1", filePath: "App.jsx" });
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("plain enough");
  });

  it("returns the URL for files over the inline cap", async () => {
    stubFetch("x".repeat(200_001), { contentType: "text/plain" });

    const result = await call(listing, { projectId: "p1", filePath: "App.jsx" });
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain('"inline": false');
    expect(text).toContain("inline cap");
  });

  it("handles a missing content-type header as sniffable text", async () => {
    const response = new Response("no header", { status: 200 });
    response.headers.delete("content-type");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    const result = await call(listing, { projectId: "p1", filePath: "App.jsx" });
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("no header");
  });

  it("lists available files when the path matches nothing", async () => {
    await expect(call(listing, { projectId: "p1", filePath: "does/not/exist.ts" })).rejects.toThrow(
      /No artifact matches[\s\S]*data\/src\/App\.jsx[\s\S]*data\/src\/components\/Login\.jsx/,
    );
  });

  it("explains when a project has no artifacts at all", async () => {
    await expect(
      call({ data: { assets: { images: {} } } }, { projectId: "p1", filePath: "App.jsx" }),
    ).rejects.toThrow(/No artifact files found[\s\S]*platui_check_job_status/);
  });

  it("tolerates a non-object listing response", async () => {
    await expect(call(null, { projectId: "p1", filePath: "App.jsx" })).rejects.toThrow(
      /No artifact files found/,
    );
  });

  it("surfaces expired download URLs with a refresh hint", async () => {
    stubFetch(null, { status: 403 });

    await expect(call(listing, { projectId: "p1", filePath: "App.jsx" })).rejects.toThrow(
      /failed with 403[\s\S]*platui_get_artifacts again/,
    );
  });

  it("rejects ambiguous suffix matches with matching candidates", async () => {
    const ambiguousListing = {
      data: {
        "src/App.jsx": "https://s3.example.com/app1.jsx",
        "lib/App.jsx": "https://s3.example.com/app2.jsx",
      },
    };
    await expect(call(ambiguousListing, { projectId: "p1", filePath: "App.jsx" })).rejects.toThrow(
      /Ambiguous artifact suffix "App.jsx"/,
    );
  });

  it("treats application/pdf artifacts as binary even without NUL bytes", async () => {
    stubFetch("PDF header text without nul byte", { contentType: "application/pdf" });
    const result = await call(listing, { projectId: "p1", filePath: "App.jsx" });
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain('"inline": false');
  });
});
