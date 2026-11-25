import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Express, NextFunction, Request, Response } from "express";
import { basicAuth } from "./auth.js";
import type { Config } from "./config.js";
import { DwApiClient } from "./dwApi.js";
import { registerTools } from "./tools.js";

export const SERVER_INFO = { name: "walters-mcp-server", version: "1.0.0" } as const;

const SERVER_INSTRUCTIONS =
  "Answers questions about Walters' fabrication operations from the DataWarehouse: labour hours (by tag, workorder, employee), " +
  "plant headcount, active projects, tonnage, purchase orders (count and overdue), WorkOrder completion % and WorkOrder material " +
  "availability. All tools are read-only. Several answers carry caveats (plant headcount is a proxy, purchase-order amounts are " +
  "unconverted CAD/USD, % Available is location-aware) - relay any 'note' fields to the user. For relative dates ('last week') " +
  "call get_current_date first.";

export function buildMcpServer(api: DwApiClient, timeZone: string): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, api, { timeZone });
  return server;
}

export interface AppDeps {
  fetchImpl?: typeof fetch;
  timeZone?: string;
}

export function createApp(config: Config, deps: AppDeps = {}): Express {
  const app = createMcpExpressApp({
    host: "0.0.0.0",
    ...(config.allowedHosts ? { allowedHosts: config.allowedHosts } : {}),
  });
  app.disable("x-powered-by");

  const api = new DwApiClient(config, deps.fetchImpl);
  const timeZone = deps.timeZone ?? "America/Toronto";

  // Liveness - no auth, no downstream calls. Used by the Docker HEALTHCHECK.
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "healthy" });
  });

  // Readiness - confirms the DataWarehouse-API (and through it the database) is reachable.
  app.get("/ready", async (_req: Request, res: Response) => {
    try {
      const response = await (deps.fetchImpl ?? fetch)(`${config.dwApiBaseUrl}/health`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        res.json({ status: "ready", dataWarehouseApi: "reachable" });
        return;
      }
    } catch {
      /* fall through */
    }
    res.status(503).json({ status: "not ready", dataWarehouseApi: "unreachable" });
  });

  const auth = basicAuth(config.mcpUsername, config.mcpPassword);

  // Streamable HTTP, stateless: a fresh server+transport per request. No session state to
  // lose across restarts, and it works cleanly through proxies/gateways. JSON responses
  // (rather than SSE streams) keep it friendly to intermediaries.
  //
  // The SDK rejects POSTs whose Accept header lacks BOTH application/json and text/event-stream
  // (HTTP 406). Power Platform's connector test tool sends neither, and since this server only ever
  // answers with plain JSON, insisting on it buys nothing - so the header is normalised first.
  const acceptJsonAndSse = (req: Request, _res: Response, next: NextFunction): void => {
    const value = "application/json, text/event-stream";
    req.headers.accept = value;
    // Some transports build the Web Request from rawHeaders, so keep those in step too.
    const raw = req.rawHeaders;
    let replaced = false;
    for (let i = 0; i < raw.length; i += 2) {
      if (raw[i]!.toLowerCase() === "accept") {
        raw[i + 1] = value;
        replaced = true;
      }
    }
    if (!replaced) raw.push("Accept", value);
    next();
  };

  app.post("/mcp", auth, acceptJsonAndSse, async (req: Request, res: Response) => {
    const server = buildMcpServer(api, timeZone);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Error handling MCP request:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // No server-initiated streams or sessions in stateless mode.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  };
  app.get("/mcp", auth, methodNotAllowed);
  app.delete("/mcp", auth, methodNotAllowed);

  return app;
}
