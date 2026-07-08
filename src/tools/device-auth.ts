import { saveCachedCredentials, type ApiClient } from "platui-mcp-core";

export interface DeviceLoginStart {
  readKey: string;
  writeKey: string;
  authorizeUrl: string;
}

export interface DeviceLoginCheckResult {
  granted: boolean;
  accessToken?: string;
}

interface LoginResponseData {
  read_key: string;
  write_key: string;
}

interface CheckAccessResponseData {
  user_id: string;
  token: string;
  expiresAt: number;
}

/**
 * Starts the PlatUI API's device-auth flow (login -> read_key/write_key).
 */
export async function startDeviceLogin(
  apiClient: ApiClient,
  appBaseUrl: string,
): Promise<DeviceLoginStart> {
  const response = await apiClient.request<{ data: LoginResponseData }>(
    "POST",
    "/auth/plugin/figma/login",
    {},
  );

  const { read_key: readKey, write_key: writeKey } = response.data;
  const authorizeUrl = `${appBaseUrl.replace(/\/+$/, "")}/plugin/login?writeKey=${encodeURIComponent(writeKey)}&source=mcp`;

  return { readKey, writeKey, authorizeUrl };
}

/**
 * Polls the PlatUI API's checkAccess endpoint. Caches the resulting bearer token to disk
 * (loadCachedCredentials picks it up on future stdio server launches) when granted.
 */
export async function completeDeviceLogin(
  apiClient: ApiClient,
  readKey: string,
): Promise<DeviceLoginCheckResult> {
  const response = await apiClient.request<{ data: CheckAccessResponseData | null }>(
    "POST",
    "/auth/plugin/figma/checkAccess",
    { read_key: readKey },
  );

  if (!response.data?.token) {
    return { granted: false };
  }

  const { token, expiresAt } = response.data;
  saveCachedCredentials({ accessToken: token, expiresAt });

  return { granted: true, accessToken: token };
}
