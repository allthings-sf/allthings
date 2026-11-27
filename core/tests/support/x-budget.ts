import { Effect, Layer } from "effect";
import { HttpClient } from "effect/http";
import { XBudget } from "../../src/x-budget.ts";

/**
 * X's daily budget as a test of one of its callers has it when it reads a
 * fake X and keeps no database: every request is sent, and nothing is
 * counted. tests/x-budget.test.ts tests the budget itself, and each
 * caller's refusal. Needs an `HttpClient`.
 */
export const xBudgetUncounted = Layer.effect(
  XBudget,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return XBudget.of({
      execute: (request) => client.execute(request),
      today: Effect.succeed({ day: "2026-10-03", spent: 0, budget: 2000 }),
    });
  }),
);
