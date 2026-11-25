# Walters MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server, packaged as a Docker
container, that lets Microsoft Copilot answer questions about Walters' fabrication operations.
It does no data work itself - every tool is a thin, read-only wrapper around an endpoint of the
[DataWarehouse-API](https://github.com/waltersgroup/DataWarehouse-API) container.

```
Microsoft Copilot -> custom connector -> (Microsoft proxy / gateway) -> THIS container --HTTP+Basic--> DataWarehouse-API -> SQL Server
```

- **Transport:** MCP Streamable HTTP, stateless, JSON responses (`POST /mcp`). This is the only MCP
  transport Copilot Studio supports (SSE support ended August 2025).
- **Inbound auth:** HTTP Basic (`MCP_BASIC_AUTH_USERNAME` / `MCP_BASIC_AUTH_PASSWORD`).
- **Outbound auth:** the DataWarehouse-API's own Basic credentials (`DW_API_USERNAME` / `DW_API_PASSWORD`).
- **Stack:** TypeScript, official `@modelcontextprotocol/sdk`, Express, Node 22.

## Tools

All tools are read-only. Descriptions (visible to Copilot) carry the same data caveats as the API.

| Tool | Answers |
|---|---|
| `get_current_date` | Today's date plus ready-made this/last week and month ranges. Call first for any relative date. |
| `get_tag_hours` | "How many hours were spent on TAG ID 123456?" |
| `get_tag_workers` | "Who worked on Tag ID 12322?" |
| `get_workorder_hours` | "How many hours did it take to Fit workorder 143256?" |
| `get_workorder_completion` | "What % is workorder X fit/fab/paint/ship complete?" |
| `get_material_availability_status` | "Give me a status of workorders material availability" (ready vs. waiting on POs) |
| `get_employee_hours` | "How many hours did Chris Beach work last week?" |
| `get_plant_headcount` | "How many people work at the Dartnall plant?" (a proxy, not true headcount) |
| `list_active_projects` | "List all active projects." |
| `get_project_tonnage` | "How many tons is project X?" |
| `get_project_purchase_order_count` | "How many purchase orders does project X have?" |
| `get_project_overdue_purchase_orders` | "Which / how many purchase orders are overdue for project X?" |

Behaviour worth knowing:

- **Long lists are capped** so Copilot isn't flooded: overdue PO `lines` default to 25 (`maxLines`, max 200;
  one live project has 3,000+), and `get_material_availability_status` lists up to 10 outstanding PO lines per
  WorkOrder (`maxPOLinesPerWorkOrder`). Counts and per-currency totals always cover everything, and the response
  says when it was truncated.
- **Relative dates are resolved here, not in the API.** The DataWarehouse-API only takes concrete dates, so
  `get_current_date` gives Copilot the dates to use (`endDate` is exclusive).
- **Errors are model-readable.** 400/404 messages from the API pass through; 5xx and network failures become
  generic messages (no internal detail leaks to the model; the detail is logged server-side).

## Configuration

Copy `.env.example` to `.env` and fill it in. `.env` is git-ignored.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `HOST_PORT` | No | `8081` | Host port mapped to the container's 8080. Set it in `.env`, not in `docker-compose.yml`. |
| `DW_API_BASE_URL` | **Yes** | - | How **this container** reaches the DataWarehouse-API (see below). |
| `DW_API_USERNAME` / `DW_API_PASSWORD` | **Yes** | - | The DataWarehouse-API's `BASIC_AUTH_USERNAME` / `BASIC_AUTH_PASSWORD`. |
| `DW_API_TIMEOUT_MS` | No | `60000` | Some endpoints are slow (material availability took ~20 s on a cold call). |
| `MCP_BASIC_AUTH_USERNAME` / `MCP_BASIC_AUTH_PASSWORD` | **Yes** | - | What Copilot's connector must present. Any values; use a strong password. |
| `TIME_ZONE` | No | `America/Toronto` | Decides "today" for `get_current_date`. |
| `ALLOWED_HOSTS` | No | empty | Optional comma-separated Host-header allow-list (DNS-rebinding protection). |

`DW_API_BASE_URL` examples (this is the value people most often get wrong - `localhost` inside a container is the
container itself):

- DataWarehouse-API published on **this same Docker host**: `http://host.docker.internal:<its HOST_PORT>` (the compose
  file maps `host.docker.internal` for Linux).
- Another machine: `http://<hostname-or-ip>:<port>`.
- Both services in one compose project / shared Docker network: `http://<service-name>:8080`.

## Deploy on the Ubuntu Docker server

Prerequisites: Docker Engine + the Compose plugin (`docker compose version`), and the DataWarehouse-API container
already running and healthy.

```bash
git clone https://github.com/waltersinc/Walters-MCP-Server.git
cd Walters-MCP-Server

cp .env.example .env
nano .env        # set DW_API_*, MCP_BASIC_AUTH_*, and HOST_PORT if 8081 is taken

docker compose up -d --build
docker compose logs -f
```

Verify, in order (each step narrows down where a problem is):

```bash
# 1. The MCP container is up (liveness - no auth, no downstream calls)
curl http://localhost:8081/health

# 2. It can reach the DataWarehouse-API (and through it the database)
curl http://localhost:8081/ready

# 3. Auth is enforced: expect HTTP 401
curl -i -X POST http://localhost:8081/mcp

# 4. A real MCP handshake with credentials: expect a JSON result containing "walters-mcp-server"
curl -u "<mcp-user>:<mcp-password>" -X POST http://localhost:8081/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

For a fuller check that lists the tools and calls several against live data, run the smoke test from any machine
with Node 20+ that can reach the server:

```bash
npm ci
MCP_URL=http://<server>:8081/mcp MCP_USERNAME=<mcp-user> MCP_PASSWORD=<mcp-password> node scripts/smoke.mjs
```

To update after new commits: `git pull && docker compose up -d --build`.

`/ready` returning 503 means the problem is between this container and the DataWarehouse-API (wrong `DW_API_BASE_URL`,
that container not running, or a firewall) - not the MCP code. `docker compose logs` shows the cause.

## Connecting to Microsoft Copilot

> **Status: not yet verified end to end.** The server itself was tested against the live DataWarehouse, but the
> Copilot-side wiring below has not been exercised. Microsoft's current MCP documentation
> ([Connect to an existing MCP server](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent))
> says nothing about routing an MCP connector through the **on-premises data gateway**, and its authentication
> options for the guided MCP wizard are None / API key / OAuth 2.0 (no Basic). The steps below are the best
> reading of the documented path plus what is known about gateway-routed custom connectors (Basic/Windows/None only).
> Treat "does the gateway carry Streamable HTTP MCP traffic?" as the first thing to test.

1. Edit `copilot/walters-mcp.swagger.yaml`: set `host` to the address the connector will call (for the gateway path,
   the internal host and port, e.g. `wincdocker:8081`).
2. In Power Apps / Power Automate: **Custom connectors -> New custom connector -> Import an OpenAPI file** and import
   that file. It defines one `POST /mcp` operation marked `x-ms-agentic-protocol: mcp-streamable-1.0`, which is what
   tells Copilot Studio to treat it as an MCP server.
3. On the connector's **General** tab, enable **Connect via on-premises data gateway** and pick your gateway
   (requires the standard-mode gateway installed on a Windows machine that can reach this server).
4. On the **Security** tab choose **Basic authentication**. The parameter labels are only display text (`Username` /
   `Password`); when creating the connection, enter `MCP_BASIC_AUTH_USERNAME` / `MCP_BASIC_AUTH_PASSWORD`.
5. Create the connector, then in Copilot Studio add it to your agent as a tool (**Add a tool -> Connector**). Review the
   12 tools it exposes.

**Testing in the connector's Test tab.** The tab lists two operations. `InvokeMCP` (POST) is the real one; the generated
`GetInvokeMCP` (GET) is expected to answer `405 Method not allowed`, because this server is stateless and offers no
server-push stream (the MCP spec allows that). A 405 there still proves the connector reached the server and
authenticated. For `InvokeMCP`, leave `Mcp-Session-Id` blank (sessions aren't used), switch **Raw Body** on, and paste a
full JSON-RPC message, for example:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_project_tonnage","arguments":{"project":"DF-833"}}}
```

(The `Accept` header the tab sends is tolerated: the server always answers with plain JSON.)

Things that may need a different approach, in order of likelihood:

- **The sample in Microsoft's docs uses `schemes: [https]`.** This container serves plain HTTP. If the connector or
  gateway insists on HTTPS, put TLS in front of it (reverse proxy such as Caddy/nginx/Traefik with a certificate the
  gateway machine trusts).
- **Basic auth rejected for an MCP connector.** If the connector won't accept Basic, the documented MCP auth options are
  None / API key / OAuth 2.0. An API-key-header check is a small change to `src/auth.ts` - ask for it rather than
  falling back to no auth.
- **Gateway doesn't pass Streamable HTTP.** Then the options are a publicly reachable HTTPS endpoint with strong auth,
  or an Azure-hosted relay in front of this container; the gateway-free path needs no changes to this server.

## Security notes

- Only `/health` and `/ready` are unauthenticated, and they return no data. `/mcp` requires Basic auth and credentials
  are compared in constant time.
- Credentials live only in `.env` / the container environment - never in the image or the repo.
- Plain HTTP between the gateway and this container is acceptable while it stays on the internal network; terminate TLS
  before it is reachable from anywhere else.
- The server holds the DataWarehouse-API credentials, which currently map to a SQL login with broad rights (see that
  repo's "Production hardening"). A least-privilege `EXECUTE`-only login for the `api` schema is still a to-do there.
- The Express startup warning "binding to 0.0.0.0 without DNS rebinding protection" is expected inside a container;
  set `ALLOWED_HOSTS` to silence it and restrict Host headers.

## Development

```bash
npm ci
npm test          # builds, then runs 20 tests (fake DataWarehouse-API + the official MCP client over real HTTP)
npm run typecheck
```

```
src/config.ts   environment configuration
src/auth.ts     Basic auth middleware (constant-time)
src/dwApi.ts    DataWarehouse-API client (Basic auth, timeouts, error mapping)
src/tools.ts    the 12 MCP tools
src/shape.ts    caps long result lists
src/dates.ts    get_current_date logic
src/app.ts      Express app: /mcp, /health, /ready
src/server.ts   entry point
copilot/        connector definition to import into Power Platform
scripts/        smoke test for a running server
```

Adding a tool: add a `server.registerTool(...)` in `src/tools.ts` mirroring a DataWarehouse-API endpoint, and extend the
expected-tool list in `src/test/app.test.ts`.
