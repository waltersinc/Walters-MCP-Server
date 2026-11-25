import type { Config } from "./config.js";

/** Raised when the DataWarehouse-API returns an error a caller (the LLM) can act on. */
export class DwApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DwApiError";
  }
}

type QueryValue = string | number | boolean | undefined | null;

/**
 * Thin client for the DataWarehouse-API (see the DataWarehouse-API repo). Every
 * call is a GET with HTTP Basic auth. Responses are returned as parsed JSON.
 */
export class DwApiClient {
  private readonly authHeader: string;

  constructor(
    private readonly config: Pick<Config, "dwApiBaseUrl" | "dwApiUsername" | "dwApiPassword" | "dwApiTimeoutMs">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const token = Buffer.from(`${config.dwApiUsername}:${config.dwApiPassword}`, "utf8").toString("base64");
    this.authHeader = `Basic ${token}`;
  }

  /**
   * @param path  Path starting with "/", already URL-encoded where it has route segments.
   * @param query Optional query parameters; undefined/null/empty values are omitted.
   */
  async get<T = unknown>(path: string, query: Record<string, QueryValue> = {}): Promise<T> {
    const url = new URL(this.config.dwApiBaseUrl + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: this.authHeader, Accept: "application/json" },
        signal: AbortSignal.timeout(this.config.dwApiTimeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new DwApiError(
          `The DataWarehouse API did not respond within ${this.config.dwApiTimeoutMs / 1000}s. Try again shortly.`,
          504,
        );
      }
      // Don't leak hostnames/ports/stack details to the model - log server-side only.
      console.error("DataWarehouse-API request failed:", err);
      throw new DwApiError("The DataWarehouse API is unreachable right now.", 503);
    }

    const bodyText = await response.text();

    if (response.ok) {
      return (bodyText ? JSON.parse(bodyText) : null) as T;
    }

    // 400/404 carry a clean { error } body written for exactly this audience.
    if (response.status === 400 || response.status === 404) {
      throw new DwApiError(extractError(bodyText) ?? `Request rejected (HTTP ${response.status}).`, response.status);
    }
    if (response.status === 401 || response.status === 403) {
      console.error(`DataWarehouse-API rejected our credentials (HTTP ${response.status}) for ${url.pathname}`);
      throw new DwApiError("This MCP server is not authorised to call the DataWarehouse API (configuration problem).", 502);
    }
    console.error(`DataWarehouse-API returned HTTP ${response.status} for ${url.pathname}: ${bodyText.slice(0, 500)}`);
    throw new DwApiError(`The DataWarehouse API failed to answer (HTTP ${response.status}).`, 502);
  }
}

function extractError(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

/** Encode a value for use as a single URL path segment. */
export function seg(value: string): string {
  return encodeURIComponent(value);
}
