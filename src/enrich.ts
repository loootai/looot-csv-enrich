// The paid part. For each row, runs the chosen columns in order (email before verify, phone and
// person, so they can use the email it found), inside a total budget, a few rows at a time.

import { createHash } from "node:crypto";
import { readRow, type Field } from "./columns.ts";
import type { Table } from "./csv.ts";
import { LoootError, type FallbackOptions, type Looot, type Run } from "./looot.ts";
import { alreadyFilled } from "./quote.ts";
import type { Recipe } from "./recipes.ts";

export const COST_COLUMN = "looot_cost_usd";
export const NOTES_COLUMN = "looot_notes";

export interface EnrichOptions {
  budget: number;
  maxPerCall: number;
  maxAttempts: number;
  concurrency: number;
  timeoutMs?: number;
  log?: (line: string) => void;
  /** Called after each finished row, so the caller can save progress. */
  onRowDone?: () => void | Promise<void>;
}

export interface EnrichSummary {
  calls: number;
  completed: number;
  misses: number;
  failed: number;
  pending: number;
  replayed: number;
  skippedForBudget: number;
  spent: number;
  stoppedReason: string | null;
}

/**
 * Same job, same input, same fallback settings -> same key. looot returns the first run for a
 * repeated key, so rerunning a file never pays twice for a cell.
 */
export function idempotencyKey(job: string, input: Record<string, string>, fallback: FallbackOptions): string {
  const sorted = Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
  const digest = createHash("sha256").update(JSON.stringify([job, sorted, fallback])).digest("hex");
  return `looot-csv-enrich-${digest.slice(0, 40)}`;
}

function costOf(run: Run): number {
  if (typeof run.actualCost === "number" && Number.isFinite(run.actualCost)) return run.actualCost;
  if (typeof run.route?.chargedUsd === "number") return run.route.chargedUsd;
  return 0;
}

/** Adds output, cost and notes columns to the table (in place) and fills them. */
export async function enrichTable(
  table: Table,
  cols: Partial<Record<Field, string>>,
  recipes: Recipe[],
  client: Looot,
  opts: EnrichOptions,
): Promise<EnrichSummary> {
  const log = opts.log ?? (() => {});
  for (const c of [...recipes.flatMap((r) => r.columns), COST_COLUMN, NOTES_COLUMN]) {
    if (!table.headers.includes(c)) table.headers.push(c);
  }
  const fallback: FallbackOptions = { maxAttempts: opts.maxAttempts, maxCostUsd: opts.maxPerCall };
  const s: EnrichSummary = { calls: 0, completed: 0, misses: 0, failed: 0, pending: 0, replayed: 0, skippedForBudget: 0, spent: 0, stoppedReason: null };
  let reserved = 0;

  async function doRow(row: Record<string, string>, index: number): Promise<void> {
    const input = readRow(row, cols);
    const notes: string[] = [];
    let rowCost = Number(row[COST_COLUMN] || 0) || 0;
    for (const recipe of recipes) {
      if (s.stoppedReason) break;
      if (alreadyFilled(row, recipe)) continue;
      const jobInput = recipe.input(input, { work_email: row.work_email ?? "" });
      if (!jobInput) continue;
      if (s.spent + reserved + opts.maxPerCall > opts.budget + 1e-9) {
        s.skippedForBudget++;
        notes.push(`${recipe.id}: not run, budget reached`);
        continue;
      }
      reserved += opts.maxPerCall;
      s.calls++;
      let run: Run;
      try {
        run = await client.runJob(recipe.job, jobInput, idempotencyKey(recipe.job, jobInput, fallback), fallback, opts.timeoutMs);
      } catch (err) {
        reserved -= opts.maxPerCall;
        if (err instanceof LoootError && (err.status === 401 || err.status === 402 || err.status === 403)) {
          s.stoppedReason = err.status === 402
            ? `balance too low (${err.message})${err.topUpUrl ? `. Top up: ${err.topUpUrl}` : ""}`
            : `token refused (${err.status} ${err.code}): ${err.message}`;
          notes.push(`${recipe.id}: not run, ${err.code}`);
          break;
        }
        s.failed++;
        notes.push(`${recipe.id}: error ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      reserved -= opts.maxPerCall;
      const cost = run.replayed ? 0 : costOf(run);
      if (run.replayed) s.replayed++;
      s.spent += cost;
      rowCost += cost;
      if (run.status === "completed") {
        const values = recipe.read(run);
        const found = Object.values(values).some((v) => v !== "");
        for (const [k, v] of Object.entries(values)) row[k] = v;
        if (found) s.completed++;
        else {
          s.misses++;
          notes.push(`${recipe.id}: no match`);
        }
      } else if (run.status === "failed" || run.status === "blocked" || run.status === "stopped") {
        s.failed++;
        notes.push(`${recipe.id}: ${run.status}${run.error?.message ? ` (${run.error.message})` : ""}`);
      } else {
        s.pending++;
        notes.push(`${recipe.id}: still ${run.status}, rerun to collect ${run.runId}`);
      }
    }
    row[COST_COLUMN] = rowCost > 0 ? rowCost.toFixed(5) : row[COST_COLUMN] ?? "";
    row[NOTES_COLUMN] = notes.join("; ");
    log(`row ${index + 1}: ${notes.length ? notes.join("; ") : "ok"}`);
    await opts.onRowDone?.();
  }

  let next = 0;
  async function worker(): Promise<void> {
    while (next < table.rows.length && !s.stoppedReason) {
      const i = next++;
      await doRow(table.rows[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, () => worker()));
  return s;
}
