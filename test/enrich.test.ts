import { test } from "node:test";
import assert from "node:assert/strict";
import { detectColumns } from "../src/columns.ts";
import { parseCsv } from "../src/csv.ts";
import { enrichTable, idempotencyKey } from "../src/enrich.ts";
import { Looot } from "../src/looot.ts";
import { selectRecipes } from "../src/recipes.ts";
import { fakeFetch, type Call } from "./fake.ts";

const opts = { budget: 1, maxPerCall: 0.05, maxAttempts: 3, concurrency: 2 };
const noSleep = async () => {};

function setup(csv: string, add: string[], handler: (c: Call) => { status?: number; body: unknown } | undefined) {
  const table = parseCsv(csv);
  const cols = detectColumns(table.headers);
  const fake = fakeFetch(handler);
  const client = new Looot({ token: "test-token", baseUrl: "https://api.test", fetch: fake.fetch, sleep: noSleep });
  return { table, cols, recipes: selectRecipes(add), client, calls: fake.calls };
}

const runs = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path.startsWith("/v1/runs"));

test("finds an email, then verifies that email in the same row, with fallback and a per-call cap", async () => {
  const { table, cols, recipes, client, calls } = setup("First Name,Last Name,Website\nAda,Lovelace,https://example.com\n", ["email", "verify"], (c) => {
    if (c.body?.endpointId === "job:people.email.find") return { body: { runId: "r1", status: "completed", actualCost: 0.004, normalized: { fields: { email: "ada@example.com" } } } };
    if (c.body?.endpointId === "job:people.email.verify") return { body: { runId: "r2", status: "completed", actualCost: 0.0015, result: { result: "deliverable" } } };
    return undefined;
  });
  const s = await enrichTable(table, cols, recipes, client, opts);
  const posted = runs(calls);
  assert.equal(posted.length, 2);
  assert.deepEqual(posted[0].body.input, { first_name: "Ada", last_name: "Lovelace", domain: "example.com" });
  assert.deepEqual(posted[0].body.fallback, { enabled: true, maxAttempts: 3, maxCostUsd: 0.05 });
  assert.equal(posted[0].auth, "Bearer test-token");
  assert.match(posted[0].path, /wait=30/);
  assert.deepEqual(posted[1].body.input, { email: "ada@example.com" });
  assert.equal(table.rows[0].work_email, "ada@example.com");
  assert.equal(table.rows[0].email_status, "valid");
  assert.equal(table.rows[0].looot_cost_usd, "0.00550");
  assert.equal(s.completed, 2);
  assert.ok(Math.abs(s.spent - 0.0055) < 1e-9);
});

test("a failed run and a miss cost nothing and are written to the notes", async () => {
  const { table, cols, recipes, client } = setup("Name,Website\nAda Lovelace,example.com\n", ["company", "email"], (c) => {
    if (c.body?.endpointId === "job:company.enrich") return { body: { runId: "r1", status: "failed", actualCost: 0, error: { code: "provider_error", message: "all providers failed" } } };
    if (c.body?.endpointId === "job:people.email.find") return { body: { runId: "r2", status: "completed", actualCost: 0, result: { data: null } } };
    return undefined;
  });
  const s = await enrichTable(table, cols, recipes, client, opts);
  assert.equal(s.failed, 1);
  assert.equal(s.misses, 1);
  assert.equal(s.spent, 0);
  assert.match(table.rows[0].looot_notes, /company: failed \(all providers failed\)/);
  assert.match(table.rows[0].looot_notes, /email: no match/);
});

test("polls a run that is still running until it is terminal", async () => {
  let polls = 0;
  const { table, cols, recipes, client, calls } = setup("Email\nada@example.com\n", ["verify"], (c) => {
    if (c.method === "POST") return { body: { runId: "slow", status: "running" } };
    if (c.path === "/v1/runs/slow") {
      polls++;
      return { body: polls < 2 ? { runId: "slow", status: "running" } : { runId: "slow", status: "completed", actualCost: 0.0015, normalized: { fields: { status: "catch_all" } } } };
    }
    return undefined;
  });
  await enrichTable(table, cols, recipes, client, opts);
  assert.equal(polls, 2);
  assert.equal(table.rows[0].email_status, "catch_all");
  assert.equal(calls.filter((c) => c.method === "GET" && c.path === "/v1/runs/slow").length, 2);
});

test("never starts a call that could pass the budget", async () => {
  const csv = "Email\n" + Array.from({ length: 5 }, (_, i) => `p${i}@example.com`).join("\n") + "\n";
  const { table, cols, recipes, client, calls } = setup(csv, ["verify"], () => ({ body: { runId: "r", status: "completed", actualCost: 0.04, normalized: { fields: { status: "valid" } } } }));
  const s = await enrichTable(table, cols, recipes, client, { ...opts, concurrency: 1, budget: 0.1, maxPerCall: 0.04 });
  // Each call reserves its 0.04 cap first: 0.04 + 0.04 fits in 0.10, a third would not.
  assert.equal(runs(calls).length, 2);
  assert.equal(s.skippedForBudget, 3);
  assert.ok(s.spent <= 0.1);
  assert.match(table.rows[4].looot_notes, /budget reached/);
});

test("a 402 stops the run and reports the top-up link", async () => {
  const { table, cols, recipes, client, calls } = setup("Email\na@example.com\nb@example.com\n", ["verify"], () => ({ status: 402, body: { error: { code: "insufficient_balance", message: "balance 0.00" }, topUpUrl: "https://looot.ai/top-up" } }));
  const s = await enrichTable(table, cols, recipes, client, { ...opts, concurrency: 1 });
  assert.match(s.stoppedReason ?? "", /balance too low.*https:\/\/looot.ai\/top-up/);
  assert.equal(runs(calls).length, 1);
});

test("rows with the output already filled are skipped, and replays are not counted as spend", async () => {
  const { table, cols, recipes, client, calls } = setup("Email,email_status\na@example.com,valid\nb@example.com,\n", ["verify"], () => ({ body: { runId: "old", status: "completed", replayed: true, actualCost: 0.0015, normalized: { fields: { status: "invalid" } } } }));
  const s = await enrichTable(table, cols, recipes, client, opts);
  assert.equal(runs(calls).length, 1);
  assert.equal(runs(calls)[0].body.input.email, "b@example.com");
  assert.equal(s.replayed, 1);
  assert.equal(s.spent, 0);
  assert.equal(table.rows[1].email_status, "invalid");
});

test("idempotency key is stable for the same input and changes with the input or cap", () => {
  const fb = { maxAttempts: 3, maxCostUsd: 0.05 };
  const a = idempotencyKey("people.email.verify", { email: "a@example.com" }, fb);
  assert.equal(a, idempotencyKey("people.email.verify", { email: "a@example.com" }, { ...fb }));
  assert.notEqual(a, idempotencyKey("people.email.verify", { email: "b@example.com" }, fb));
  assert.notEqual(a, idempotencyKey("people.email.verify", { email: "a@example.com" }, { ...fb, maxCostUsd: 0.02 }));
  assert.equal(idempotencyKey("j", { b: "1", a: "2" }, fb), idempotencyKey("j", { a: "2", b: "1" }, fb));
  assert.match(a, /^looot-csv-enrich-[0-9a-f]{40}$/);
});
