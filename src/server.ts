import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = createApp(config, { timeZone: process.env.TIME_ZONE ?? "America/Toronto" });

const httpServer = app.listen(config.port, "0.0.0.0", () => {
  console.log(`Walters MCP server listening on :${config.port} (POST /mcp, GET /health, GET /ready)`);
  console.log(`DataWarehouse-API: ${config.dwApiBaseUrl}`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
