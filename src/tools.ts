import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { currentDateInfo } from "./dates.js";
import { DwApiClient, DwApiError, seg } from "./dwApi.js";
import { capMaterialPOLines, capOverdueLines } from "./shape.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const OPERATION_HELP =
  'Optional operation filter - a friendly name ("Fit", "Weld", "Quality Assurance", "Material Handling", ' +
  '"Blast", "Hardware") or a raw 2-4 letter code. Omit for all operations. There is NO operation called "Assembly".';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = (what: string) =>
  z.string().regex(DATE_RE, "must be yyyy-MM-dd").describe(what);

function ok(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Run an API call, turning DataWarehouse-API errors into tool errors the model can read and act on. */
async function run(call: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await call());
  } catch (err) {
    if (err instanceof DwApiError) return fail(err.message);
    console.error("Unexpected tool failure:", err);
    return fail("Unexpected error while answering this question.");
  }
}

export interface ToolOptions {
  /** IANA time zone used by get_current_date. */
  timeZone: string;
}

export function registerTools(server: McpServer, api: DwApiClient, options: ToolOptions): void {
  // ---------------------------------------------------------------- utility
  server.registerTool(
    "get_current_date",
    {
      title: "Get current date",
      description:
        "Returns today's date plus ready-made date ranges (this/last week Monday-Sunday, this/last month). " +
        "Call this FIRST whenever a question uses a relative date such as 'last week', 'yesterday' or 'this month', " +
        "then pass concrete yyyy-MM-dd values to get_employee_hours. Note get_employee_hours treats endDate as EXCLUSIVE.",
      inputSchema: {},
      annotations: { ...READ_ONLY, title: "Get current date" },
    },
    async () => ok(currentDateInfo(new Date(), options.timeZone)),
  );

  // ------------------------------------------------------------------- tags
  server.registerTool(
    "get_tag_hours",
    {
      title: "Hours spent on a Tag ID",
      description:
        'Total labour hours logged against a fabrication Tag ID (an individual piece/assembly), broken down by operation ' +
        '(Fit, Weld, etc.) with an overall total. Answers "How many hours were spent on TAG ID 123456?" or "How many Fit hours ' +
        'were spent on tag 123456?". There is no operation called "Assembly" - omit operationName to get all operations.',
      inputSchema: {
        tagId: z.string().min(1).describe('The numeric Tag ID, e.g. "2010197".'),
        operationName: z.string().optional().describe(OPERATION_HELP),
        onlyApproved: z
          .boolean()
          .optional()
          .describe(
            "Default true: only finalized/approved timesheet lines. Set false to include still-pending lines (useful for very recent work).",
          ),
      },
      annotations: { ...READ_ONLY, title: "Hours spent on a Tag ID" },
    },
    ({ tagId, operationName, onlyApproved }) =>
      run(() => api.get(`/api/tags/${seg(tagId)}/hours`, { operationName, onlyApproved })),
  );

  server.registerTool(
    "get_tag_workers",
    {
      title: "Who worked on a Tag ID",
      description:
        'Employees who logged hours against a Tag ID, with hours per person and operation. Answers "Who worked on Tag ID 12322?". ' +
        '"Assembly" is NOT a real operation: if the user asks "who worked on Assembly with Tag ID X", treat it as "who worked on ' +
        "Tag ID X\" and omit operationName (passing 'Assembly' returns an error).",
      inputSchema: {
        tagId: z.string().min(1).describe('The numeric Tag ID, e.g. "2010197".'),
        operationName: z.string().optional().describe(OPERATION_HELP),
        onlyApproved: z.boolean().optional().describe("Default true: only finalized/approved timesheet lines."),
      },
      annotations: { ...READ_ONLY, title: "Who worked on a Tag ID" },
    },
    ({ tagId, operationName, onlyApproved }) =>
      run(() => api.get(`/api/tags/${seg(tagId)}/workers`, { operationName, onlyApproved })),
  );

  // -------------------------------------------------------------- workorders
  server.registerTool(
    "get_workorder_hours",
    {
      title: "Hours on a WorkOrder",
      description:
        'Total labour hours logged against a WorkOrder, optionally for one operation. Answers "How many hours did it take to Fit ' +
        'workorder 143256?" (operationName "Fit") or "How many hours were spent on workorder 143256?" (omit operationName). ' +
        "Totals may include unapproved timesheet lines. WorkOrder numbers are not guaranteed unique across projects - if the " +
        "response's project is null / its note mentions more than one project, repeat the call with project.",
      inputSchema: {
        workOrder: z.string().min(1).describe('The WorkOrder number, e.g. "143256".'),
        operationName: z.string().optional().describe(OPERATION_HELP),
        project: z.string().optional().describe('Optional project code to disambiguate, e.g. "DF-839".'),
      },
      annotations: { ...READ_ONLY, title: "Hours on a WorkOrder" },
    },
    ({ workOrder, operationName, project }) =>
      run(() => api.get(`/api/workorders/${seg(workOrder)}/hours`, { operationName, project })),
  );

  server.registerTool(
    "get_workorder_completion",
    {
      title: "WorkOrder Fit/Fab/Paint/Ship completion %",
      description:
        'What percentage of a WorkOrder\'s assemblies are Fit, Fab, Paint and Ship complete. Answers "What % is workorder X fit/fab/' +
        'paint/ship complete?". Stages are sequential (Fit -> Fab -> Paint -> Ship): an assembly that is Fab-complete is automatically ' +
        "counted as Fit-complete too, even though the source data does not always record the earlier date - relay the response note.",
      inputSchema: {
        workOrder: z.string().min(1).describe('The WorkOrder number, e.g. "833098".'),
        project: z.string().optional().describe("Optional project code to disambiguate."),
      },
      annotations: { ...READ_ONLY, title: "WorkOrder completion %" },
    },
    ({ workOrder, project }) =>
      run(() => api.get(`/api/workorders/${seg(workOrder)}/completion`, { project })),
  );

  server.registerTool(
    "get_material_availability_status",
    {
      title: "WorkOrder material availability status",
      description:
        'Status of WorkOrders\' material availability, sorted by priority week (soonest-needed first). Answers "Give me a status of ' +
        'workorders material availability", "which workorders are ready to process?" and "what are we waiting on for material?". ' +
        "Covers WorkOrders where programming is complete, Main Material is not 100% available and fabrication has not started. " +
        'Each is either "Ready, Waiting to be processed" (readyToProcess: no purchase-order line for it is still unreceived) or ' +
        '"Waiting on material" (waitingOnMaterial: lists the outstanding PO lines - supplier, PO #, part, description, quantity, ' +
        "due date). IMPORTANT: percentAvailable is location-aware - material counts only if received AND sitting in the StruMIS " +
        "inventory location of the WorkOrder's fab plant (see location). A 'Ready' WorkOrder whose percentAvailable is still below " +
        "100 is a location/inventory-transfer issue, NOT a purchasing issue - say so. When presenting, list waiting WorkOrders with " +
        "their outstanding POs and ready WorkOrders separately.",
      inputSchema: {
        project: z.string().optional().describe("Optional project code to scope to one project. Omit for all projects."),
        maxPOLinesPerWorkOrder: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(
            "Cap on outstanding PO lines listed per WorkOrder (default 10). Totals are always given in outstandingPOLineCount.",
          ),
      },
      annotations: { ...READ_ONLY, title: "WorkOrder material availability status" },
    },
    async ({ project, maxPOLinesPerWorkOrder }) =>
      run(async () =>
        capMaterialPOLines(await api.get("/api/workorders/material-availability", { project }), maxPOLinesPerWorkOrder ?? 10),
      ),
  );

  // --------------------------------------------------------------- employees
  server.registerTool(
    "get_employee_hours",
    {
      title: "Hours an employee worked",
      description:
        'Total hours an employee worked within a date range. Answers "How many hours did Chris Beach work last week?". Relative ' +
        "dates are NOT understood here - call get_current_date first and pass concrete dates. endDate is EXCLUSIVE (a Mon-Sun week " +
        "is startDate=Monday, endDate=the following Monday). Provide employeeName OR employeeId; prefer employeeId when known, since " +
        "name matching is an exact 'First Last' match and can miss nicknames/variant spellings. A 'no hours found' result may mean " +
        "the name did not match rather than that no hours exist.",
      inputSchema: {
        employeeName: z.string().optional().describe('Full name as "First Last", e.g. "Chris Beach".'),
        employeeId: z.string().optional().describe("Shop-floor employee ID, if known (preferred - unambiguous)."),
        startDate: isoDate("Inclusive start date, yyyy-MM-dd."),
        endDate: isoDate("EXCLUSIVE end date, yyyy-MM-dd - hours on this date itself are not included."),
      },
      annotations: { ...READ_ONLY, title: "Hours an employee worked" },
    },
    ({ employeeName, employeeId, startDate, endDate }) => {
      if (!employeeName && !employeeId) {
        return Promise.resolve(fail("Provide either employeeName or employeeId."));
      }
      return run(() => api.get("/api/employees/hours", { employeeName, employeeId, startDate, endDate }));
    },
  );

  // ------------------------------------------------------------------ plants
  server.registerTool(
    "get_plant_headcount",
    {
      title: "Plant headcount (proxy)",
      description:
        'Number of people who logged timesheet hours at a plant recently. Answers "How many people work at the Dartnall plant?". ' +
        "IMPORTANT: this is a PROXY, not an authoritative headcount - there is no HR/payroll roster behind it. It counts distinct " +
        "employees with hours at the plant since sinceDate, so it misses anyone on leave the whole window and cannot exclude " +
        "terminated employees. Always tell the user this alongside the number (the response note says so).",
      inputSchema: {
        plantName: z.string().min(1).describe('Friendly plant name, e.g. "Dartnall", "Hamilton", "Princeton", or a raw plant code.'),
        sinceDate: isoDate("Only count employees with hours on/after this date (yyyy-MM-dd). Defaults to 30 days ago.").optional(),
      },
      annotations: { ...READ_ONLY, title: "Plant headcount (proxy)" },
    },
    ({ plantName, sinceDate }) =>
      run(() => api.get(`/api/plants/${seg(plantName)}/headcount`, { sinceDate })),
  );

  // ---------------------------------------------------------------- projects
  server.registerTool(
    "list_active_projects",
    {
      title: "List active projects",
      description:
        'Lists all active projects with name, managers, start date, location and currency. Answers "List all active projects". ' +
        'Project status is Active/Pending/Complete - only "Active" is returned unless includePending is set.',
      inputSchema: {
        includePending: z
          .boolean()
          .optional()
          .describe('Also include "Pending" projects (not started, not closed). Default false.'),
      },
      annotations: { ...READ_ONLY, title: "List active projects" },
    },
    ({ includePending }) => run(() => api.get("/api/projects/active", { includePending })),
  );

  server.registerTool(
    "get_project_tonnage",
    {
      title: "Project tonnage",
      description:
        'Total tonnage (metric tons) of steel for a project. Answers "How many tons is project X?". Deduplicated so multi-tag ' +
        "assemblies are not double counted. If assembliesMissingWeight is non-zero the total may slightly understate true tonnage.",
      inputSchema: {
        project: z.string().min(1).describe('Project code, e.g. "DF-833".'),
      },
      annotations: { ...READ_ONLY, title: "Project tonnage" },
    },
    ({ project }) => run(() => api.get(`/api/projects/${seg(project)}/tonnage`)),
  );

  server.registerTool(
    "get_project_purchase_order_count",
    {
      title: "Project purchase order count",
      description: 'How many purchase orders a project has. Answers "How many purchase orders does project X have?".',
      inputSchema: {
        project: z.string().min(1).describe('Project code, e.g. "DF-833".'),
      },
      annotations: { ...READ_ONLY, title: "Project purchase order count" },
    },
    ({ project }) => run(() => api.get(`/api/projects/${seg(project)}/purchase-orders/count`)),
  );

  server.registerTool(
    "get_project_overdue_purchase_orders",
    {
      title: "Project overdue purchase orders",
      description:
        'Overdue purchase orders for a project, with supplier, PO #, description, quantities and dollar amount per line. Answers ' +
        '"How many purchase orders are overdue for project X?" and "Which POs are overdue?". A line is overdue when it has been ' +
        "released to the supplier, is not fully received and its expected date has passed. Counts (overduePOCount, " +
        "overdueLineCount) and totalsByCurrency always cover everything; lines is capped (default 25, most overdue first) because " +
        "projects can have thousands - check linesTruncated. Amounts are per line in that line's own currency (CAD/USD/EUR all occur) " +
        "and are NOT converted: never add CAD and USD together - quote totalsByCurrency.",
      inputSchema: {
        project: z.string().min(1).describe('Project code, e.g. "26-524".'),
        maxLines: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Maximum number of overdue lines to return in detail (default 25, max 200)."),
      },
      annotations: { ...READ_ONLY, title: "Project overdue purchase orders" },
    },
    async ({ project, maxLines }) =>
      run(async () =>
        capOverdueLines(await api.get(`/api/projects/${seg(project)}/purchase-orders/overdue`), maxLines ?? 25),
      ),
  );
}
