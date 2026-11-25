/**
 * Response shaping. A few DataWarehouse-API answers can be huge (observed live:
 * one project had 3,234 overdue PO lines; one WorkOrder has ~80 outstanding PO
 * lines). Returning all of that to an LLM wastes context and makes answers worse,
 * so the long lists are capped here while the summary figures stay complete -
 * and the response always says when it was truncated.
 */

interface OverduePOsResponse {
  lines?: unknown[];
  [key: string]: unknown;
}

export function capOverdueLines(response: unknown, maxLines: number): unknown {
  const r = response as OverduePOsResponse;
  if (!r || !Array.isArray(r.lines)) return response;
  const total = r.lines.length;
  return {
    ...r,
    lines: r.lines.slice(0, maxLines),
    linesReturned: Math.min(total, maxLines),
    linesTotal: total,
    linesTruncated: total > maxLines,
    linesOrder: "most overdue first",
  };
}

interface MaterialWorkOrder {
  outstandingPOs?: unknown[] | null;
  [key: string]: unknown;
}

interface MaterialAvailabilityResponse {
  waitingOnMaterial?: MaterialWorkOrder[];
  readyToProcess?: MaterialWorkOrder[];
  [key: string]: unknown;
}

export function capMaterialPOLines(response: unknown, maxPOLinesPerWorkOrder: number): unknown {
  const r = response as MaterialAvailabilityResponse;
  if (!r || typeof r !== "object") return response;

  const cap = (list: MaterialWorkOrder[] | undefined) =>
    list?.map((wo) => {
      if (!Array.isArray(wo.outstandingPOs)) return wo;
      const total = wo.outstandingPOs.length;
      return {
        ...wo,
        outstandingPOs: wo.outstandingPOs.slice(0, maxPOLinesPerWorkOrder),
        outstandingPOLineCount: total,
        outstandingPOLinesTruncated: total > maxPOLinesPerWorkOrder,
      };
    });

  return {
    ...r,
    ...(r.waitingOnMaterial ? { waitingOnMaterial: cap(r.waitingOnMaterial) } : {}),
    ...(r.readyToProcess ? { readyToProcess: cap(r.readyToProcess) } : {}),
  };
}
