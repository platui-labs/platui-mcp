import fs from "fs";
import path from "path";
import {
  createAuthContextFromEnv,
  HttpApiClient,
  loadCachedCredentials,
  type ApiClient,
  type AuthContext,
} from "platui-mcp-core";

/**
 * Production endpoints, baked in: a customer runs `npx @platui/mcp` with zero
 * configuration. The env overrides exist only for internal development against
 * other environments and are documented in CONTRIBUTING.md, not the README.
 */
export const DEFAULT_API_BASE_URL = "https://timon.platui.com";
export const DEFAULT_APP_BASE_URL = "https://chat.platui.com";

/**
 * This server's own version, read from the package.json that ships alongside
 * dist/ in both the dev checkout and the published npm package. Sent to the
 * backend as X-PlatUI-MCP-Version on every API call so outdated servers can
 * be blocked (HTTP 426) or nudged (X-PlatUI-MCP-Notice) server-side.
 */
export function readOwnVersion(): string {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"),
    ) as { version?: string };
    return packageJson.version || "0.0.0-unknown";
  } catch {
    return "0.0.0-unknown";
  }
}

export interface RuntimeOptions {
  auth: AuthContext;
  apiClient: ApiClient;
  appBaseUrl: string;
}

/**
 * Builds the stdio server's runtime configuration from the process environment,
 * falling back to production defaults for everything.
 *
 * Scopes default to "*": on a local stdio server the caller owns the process
 * and could grant themselves any scope via env anyway, so an empty default
 * would only break tools without adding security. Real authorization is
 * enforced server-side by the PlatUI API on every request.
 */
export function resolveRuntimeOptions(env: NodeJS.ProcessEnv): RuntimeOptions {
  const auth = createAuthContextFromEnv(env, "public");

  if (!env.PLATUI_MCP_SCOPES) {
    auth.scopes = ["*"];
  }

  // Fall back to a token cached by a prior platui_login/platui_check_login
  // device-flow run when no explicit PLATUI_MCP_ACCESS_TOKEN env var is set.
  if (!auth.accessToken) {
    const cached = loadCachedCredentials();
    if (cached) {
      auth.accessToken = cached.accessToken;
    }
  }

  const apiClient = new LoginHintApiClient(
    new HttpApiClient({
      baseUrl: env.PLATUI_PUBLIC_API_BASE_URL || DEFAULT_API_BASE_URL,
      clientVersion: readOwnVersion(),
    }),
  );

  return {
    auth,
    apiClient,
    appBaseUrl: env.PLATUI_APP_BASE_URL || DEFAULT_APP_BASE_URL,
  };
}

const LOGIN_HINT =
  "You are not signed in to PlatUI (or your session expired). Call the platui_login tool, open the returned URL in a browser, approve, then call platui_check_login.";

/**
 * Wraps the HTTP client so authentication failures tell the agent how to sign
 * in instead of surfacing a bare 401. A brand-new install has no token, so the
 * first API-backed tool call a customer makes hits exactly this path.
 */
export class LoginHintApiClient implements ApiClient {
  constructor(private readonly inner: HttpApiClient) {}

  request: HttpApiClient["request"] = async (...args) => {
    try {
      return await this.inner.request(...args);
    } catch (error) {
      throw withLoginHint(error);
    }
  };

  requestBinary: HttpApiClient["requestBinary"] = async (...args) => {
    try {
      return await this.inner.requestBinary(...args);
    } catch (error) {
      throw withLoginHint(error);
    }
  };
}

function withLoginHint(error: unknown): unknown {
  if (error instanceof Error && / failed with 401\b/.test(error.message)) {
    return new Error(`${error.message}\n\n${LOGIN_HINT}`);
  }
  return error;
}
