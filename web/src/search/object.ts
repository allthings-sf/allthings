import { answer } from "./budget.ts";
import { ledgerAnswer, planPath, recordPath } from "./ledger.ts";

/**
 * The search's Durable Object (worker.ts's `SearchBudget`): its answer to
 * each request. `POST /take` takes a search from the budget (budget.ts);
 * `POST /plan` and `POST /record` keep what indexing may ingest and what
 * it has indexed (ledger.ts). The class loads this module on its first
 * request, so a cold start parses none of it.
 */
export function objectAnswer(
  state: Parameters<typeof answer>[0],
  request: Request,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  return request.method === "POST" &&
    (pathname === planPath || pathname === recordPath)
    ? ledgerAnswer(state, request)
    : answer(state, request);
}
