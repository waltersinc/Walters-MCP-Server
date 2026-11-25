import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../app.js";
import type { Config } from "../config.js";

const MCP_USER = "copilot";
const MCP_PASS = "mcp-secret";
const DW_USER = "dw-user";
const DW_PASS = "dw-secret";

const basic = (u: string, p: string) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");

interface Seen {
  url: string;
  authorization: string | undefined;
}

let dwServer: Server;
let mcpServer: Server;
let mcpUrl: string;
let baseUrl: string;
const seen: Seen[] = [];

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Stand-in for the DataWarehouse-API. */
function fakeDwApi(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://fake");
  seen.push({ url: url.pathname + url.search, authorization: req.headers.authorization });

  if (url.pathname === "/health") return json(res, 200, { status: "healthy" });

  if (req.headers.authorization !== basic(DW_USER, DW_PASS)) return json(res, 401, { error: "no" });

  if (url.pathname === "/api/tags/2010197/hours") {
    return json(res, 200, { tagId: "2010197", totalHours: 12.51, breakdown: [] });
  }
  if (url.pathname === "/api/employees/hours") {
    return json(res, 404, { error: "No timesheet hours found for employeeName 'Nobody'." });
  }
  if (url.pathname === "/api/tags/BOOM/hours") {
    return json(res, 500, { error: "SELECT * FROM secrets - internal detail that must not leak" });
  }
  if (url.pathname === "/api/projects/26-524/purchase-orders/overdue") {
    const lines = Array.from({ length: 60 }, (_, i) => ({ po: `PO-${i}`, daysOverdue: 100 - i }));
    return json(res, 200, {
      project: "26-524",
      overdueLineCount: 60,
      overduePOCount: 60,
      totalsByCurrency: [{ currency: "CAD", totalAmount: 1 }],
      lines,
    });
  }
  if (url.pathname === "/api/workorders/material-availability") {
    const outstandingPOs = Array.from({ length: 30 }, (_, i) => ({ po: `PO-${i}` }));
    return json(res, 200, {
      waitingOnMaterial: [{ workOrder: "839530", status: "Waiting on material", outstandingPOs }],
      readyToProcess: [{ workOrder: "405011", status: "Ready, Waiting to be processed", outstandingPOs: null }],
      note: "n",
    });
  }
  if (url.pathname === "/api/workorders/A%2FB/completion") {
    return json(res, 200, { workOrder: "A/B" });
  }
  return json(res, 404, { error: "unexpected path in fake: " + url.pathname });
}

before(async () => {
  dwServer = createServer(fakeDwApi);
  await new Promise<void>((r) => dwServer.listen(0, "127.0.0.1", r));
  const dwPort = (dwServer.address() as AddressInfo).port;

  const config: Config = {
    port: 0,
    dwApiBaseUrl: `http://127.0.0.1:${dwPort}`,
    dwApiUsername: DW_USER,
    dwApiPassword: DW_PASS,
    dwApiTimeoutMs: 5000,
    mcpUsername: MCP_USER,
    mcpPassword: MCP_PASS,
  };
  mcpServer = createApp(config).listen(0, "127.0.0.1");
  await new Promise<void>((r) => mcpServer.once("listening", r));
  baseUrl = `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}`;
  mcpUrl = `${baseUrl}/mcp`;
});

after(() => {
  mcpServer.close();
  dwServer.close();
});

async function connect(authorization = basic(MCP_USER, MCP_PASS)): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: authorization } } }),
  );
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content[0]!.text;
}

test("/mcp rejects requests with no credentials", async () => {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: "{}",
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /^Basic /);
});

test("/mcp rejects a wrong password and a non-Basic scheme", async () => {
  for (const authorization of [basic(MCP_USER, "wrong"), basic("someone", MCP_PASS), "Bearer abc"]) {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: "{}",
    });
    assert.equal(res.status, 401, `expected 401 for ${authorization}`);
  }
});

test("/health needs no auth and /ready reflects the DataWarehouse-API", async () => {
  assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  const ready = await fetch(`${baseUrl}/ready`);
  assert.equal(ready.status, 200);
});

test("POSTs work with the Accept headers connector tooling actually sends", async () => {
  // Power Platform's connector test tool does not send 'application/json, text/event-stream'.
  for (const accept of ["application/json", "*/*", "application/json, text/event-stream"]) {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: accept, Authorization: basic(MCP_USER, MCP_PASS) },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_tag_hours", arguments: { tagId: "2010197" } },
      }),
    });
    assert.equal(res.status, 200, `Accept '${accept}' should be accepted`);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    assert.equal(JSON.parse(body.result.content[0]!.text).totalHours, 12.51);
  }
});

test("a POST with no Accept header at all is also accepted", async () => {
  const { request } = await import("node:http");
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      mcpUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: basic(MCP_USER, MCP_PASS) },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
  });
  assert.equal(status, 200);
});

test("GET /mcp is not allowed in stateless mode", async () => {
  const res = await fetch(mcpUrl, { headers: { Authorization: basic(MCP_USER, MCP_PASS) } });
  assert.equal(res.status, 405);
});

test("lists all tools, each marked read-only", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "get_current_date",
    "get_employee_hours",
    "get_material_availability_status",
    "get_plant_headcount",
    "get_project_overdue_purchase_orders",
    "get_project_purchase_order_count",
    "get_project_tonnage",
    "get_tag_hours",
    "get_tag_workers",
    "get_workorder_completion",
    "get_workorder_hours",
    "list_active_projects",
  ]);
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} should be read-only`);
    assert.ok((tool.description ?? "").length > 40, `${tool.name} needs a real description`);
  }
  await client.close();
});

test("a tool call reaches the DW API with the server's own Basic credentials and the right query", async () => {
  const client = await connect();
  seen.length = 0;
  const result = await client.callTool({ name: "get_tag_hours", arguments: { tagId: "2010197", onlyApproved: false } });
  assert.notEqual(result.isError, true);
  assert.equal(JSON.parse(textOf(result)).totalHours, 12.51);

  const call = seen.find((s) => s.url.startsWith("/api/tags/2010197/hours"));
  assert.ok(call, "DW API was never called");
  assert.equal(call.url, "/api/tags/2010197/hours?onlyApproved=false");
  assert.equal(call.authorization, basic(DW_USER, DW_PASS));
  await client.close();
});

test("omitted optional arguments are not sent as query parameters", async () => {
  const client = await connect();
  seen.length = 0;
  await client.callTool({ name: "get_tag_hours", arguments: { tagId: "2010197" } });
  assert.equal(seen.find((s) => s.url.startsWith("/api/tags"))?.url, "/api/tags/2010197/hours");
  await client.close();
});

test("route values are URL-encoded", async () => {
  const client = await connect();
  seen.length = 0;
  const result = await client.callTool({ name: "get_workorder_completion", arguments: { workOrder: "A/B" } });
  assert.notEqual(result.isError, true);
  assert.equal(seen.find((s) => s.url.includes("completion"))?.url, "/api/workorders/A%2FB/completion");
  await client.close();
});

test("a 404 from the DW API becomes a readable tool error", async () => {
  const client = await connect();
  const result = await client.callTool({
    name: "get_employee_hours",
    arguments: { employeeName: "Nobody", startDate: "2026-11-16", endDate: "2026-11-23" },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /No timesheet hours found/);
  await client.close();
});

test("a 500 from the DW API does not leak its internal detail to the model", async () => {
  const client = await connect();
  const result = await client.callTool({ name: "get_tag_hours", arguments: { tagId: "BOOM" } });
  assert.equal(result.isError, true);
  assert.doesNotMatch(textOf(result), /secrets|SELECT/);
  await client.close();
});

test("invalid dates are rejected before reaching the DW API", async () => {
  const client = await connect();
  seen.length = 0;
  let rejected = false;
  try {
    const result = await client.callTool({
      name: "get_employee_hours",
      arguments: { employeeName: "Chris Beach", startDate: "last week", endDate: "2026-11-23" },
    });
    rejected = result.isError === true;
  } catch {
    rejected = true;
  }
  assert.ok(rejected, "bad date should be rejected");
  assert.equal(seen.filter((s) => s.url.startsWith("/api/employees")).length, 0);
  await client.close();
});

test("get_employee_hours requires a name or an id", async () => {
  const client = await connect();
  const result = await client.callTool({
    name: "get_employee_hours",
    arguments: { startDate: "2026-11-16", endDate: "2026-11-23" },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /employeeName or employeeId/);
  await client.close();
});

test("overdue PO lines are capped but the summary stays complete", async () => {
  const client = await connect();
  const result = await client.callTool({
    name: "get_project_overdue_purchase_orders",
    arguments: { project: "26-524" },
  });
  const body = JSON.parse(textOf(result));
  assert.equal(body.lines.length, 25);
  assert.equal(body.linesTotal, 60);
  assert.equal(body.linesTruncated, true);
  assert.equal(body.overdueLineCount, 60);
  assert.deepEqual(body.totalsByCurrency, [{ currency: "CAD", totalAmount: 1 }]);

  const wide = JSON.parse(
    textOf(await client.callTool({ name: "get_project_overdue_purchase_orders", arguments: { project: "26-524", maxLines: 60 } })),
  );
  assert.equal(wide.lines.length, 60);
  assert.equal(wide.linesTruncated, false);
  await client.close();
});

test("material-availability PO lines are capped per WorkOrder, ready WorkOrders untouched", async () => {
  const client = await connect();
  const body = JSON.parse(textOf(await client.callTool({ name: "get_material_availability_status", arguments: {} })));
  const waiting = body.waitingOnMaterial[0];
  assert.equal(waiting.outstandingPOs.length, 10);
  assert.equal(waiting.outstandingPOLineCount, 30);
  assert.equal(waiting.outstandingPOLinesTruncated, true);
  assert.equal(body.readyToProcess[0].outstandingPOs, null);
  assert.equal(body.note, "n");
  await client.close();
});

test("get_current_date returns concrete week boundaries", async () => {
  const client = await connect();
  const body = JSON.parse(textOf(await client.callTool({ name: "get_current_date", arguments: {} })));
  assert.match(body.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(body.lastWeekStart, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(body.lastWeekEndExclusive, body.thisWeekStart);
  await client.close();
});
