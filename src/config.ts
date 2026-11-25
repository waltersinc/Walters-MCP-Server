/**
 * All configuration comes from environment variables - nothing secret is ever
 * hardcoded or baked into the image.
 */
export interface Config {
  /** Port the MCP server listens on INSIDE the container. */
  port: number;

  /** Base URL of the DataWarehouse-API container, e.g. http://datawarehouse-api:8080 */
  dwApiBaseUrl: string;
  /** Basic-auth credentials this server uses to call the DataWarehouse-API. */
  dwApiUsername: string;
  dwApiPassword: string;
  /** Per-request timeout when calling the DataWarehouse-API (ms). */
  dwApiTimeoutMs: number;

  /** Basic-auth credentials Microsoft Copilot (the custom connector) must present to THIS server. */
  mcpUsername: string;
  mcpPassword: string;

  /** Optional Host-header allow-list (DNS-rebinding protection), comma separated. */
  allowedHosts?: string[];
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`Required environment variable '${name}' is not set.`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a valid TCP port, got '${env.PORT}'.`);
  }

  const timeout = Number(env.DW_API_TIMEOUT_MS ?? "60000");
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`DW_API_TIMEOUT_MS must be a positive number, got '${env.DW_API_TIMEOUT_MS}'.`);
  }

  const allowedHosts = env.ALLOWED_HOSTS?.split(",")
    .map((h) => h.trim())
    .filter(Boolean);

  return {
    port,
    dwApiBaseUrl: required(env, "DW_API_BASE_URL").replace(/\/+$/, ""),
    dwApiUsername: required(env, "DW_API_USERNAME"),
    dwApiPassword: required(env, "DW_API_PASSWORD"),
    dwApiTimeoutMs: timeout,
    mcpUsername: required(env, "MCP_BASIC_AUTH_USERNAME"),
    mcpPassword: required(env, "MCP_BASIC_AUTH_PASSWORD"),
    allowedHosts: allowedHosts && allowedHosts.length > 0 ? allowedHosts : undefined,
  };
}
