// Smoke test for a RUNNING Walters MCP server (local or deployed).
//
//   MCP_URL=http://localhost:8081/mcp MCP_USERNAME=copilot MCP_PASSWORD=... node scripts/smoke.mjs
//
// Connects with the official MCP client over Streamable HTTP + Basic auth (exactly what a
// custom connector does), lists the tools, then calls a few read-only tools against live data.
// Optional: SMOKE_PROJECT (default DF-833), SMOKE_TAG (default 2010197).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL;
const user = process.env.MCP_USERNAME;
const pass = process.env.MCP_PASSWORD;
if (!url || !user || !pass) {
  console.error("Set MCP_URL, MCP_USERNAME and MCP_PASSWORD.");
  process.exit(2);
}
const project = process.env.SMOKE_PROJECT ?? "DF-833";
const tag = process.env.SMOKE_TAG ?? "2010197";

const client = new Client({ name: "walters-smoke", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") } },
  }),
);

let failures = 0;
const { tools } = await client.listTools();
console.log(`OK  listed ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

async function call(name, args) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  const ms = Date.now() - started;
  if (result.isError) {
    failures++;
    console.log(`FAIL ${name} (${ms}ms): ${text.slice(0, 200)}`);
  } else {
    console.log(`OK  ${name} (${ms}ms, ${text.length} chars): ${text.slice(0, 160)}${text.length > 160 ? "..." : ""}`);
  }
  return result.isError ? undefined : JSON.parse(text);
}

const today = await call("get_current_date", {});
await call("list_active_projects", {});
await call("get_project_tonnage", { project });
await call("get_project_purchase_order_count", { project });
await call("get_tag_hours", { tagId: tag, onlyApproved: false });
if (today) {
  await call("get_employee_hours", {
    employeeName: "William Marshall",
    startDate: today.lastWeekStart,
    endDate: today.lastWeekEndExclusive,
  });
}
await call("get_plant_headcount", { plantName: "Dartnall" });
await call("get_material_availability_status", {});

await client.close();
if (failures > 0) {
  console.error(`${failures} call(s) failed`);
  process.exit(1);
}
console.log("Smoke test passed.");
