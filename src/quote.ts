// The quote printed before any paid call: how many calls each column needs on this file, the
// cheapest listed price, and the most the run can spend with the per-call cap.

import { readRow, type Field } from "./columns.ts";
import type { Recipe } from "./recipes.ts";

export interface QuoteLine {
  recipe: string;
  job: string;
  /** Rows that have the inputs now. */
  calls: number;
  /** Rows that only qualify if the email column finds an address first. */
  ifEmailFound: number;
  /** Rows skipped because the output is already filled or inputs are missing. */
  skipped: number;
  cheapestPerCall: number | null;
  providerCount: number;
}

export interface Quote {
  rows: number;
  lines: QuoteLine[];
  /** Calls at the cheapest listed price. A miss or a failed call costs $0, so the real bill is usually lower. */
  low: number;
  /** Every possible call at the per-call cap. The run never spends more than this. */
  cap: number;
}

/** True when the recipe's first output column already has a value, so the row is done. */
export function alreadyFilled(row: Record<string, string>, recipe: Recipe): boolean {
  return (row[recipe.columns[0]] ?? "").trim() !== "";
}

/** Builds the quote for a file without any network call except the free price list. */
export function buildQuote(
  rows: Record<string, string>[],
  cols: Partial<Record<Field, string>>,
  recipes: Recipe[],
  prices: Map<string, { cheapestPerCall: number | null; providerCount: number }>,
  maxPerCall: number,
): Quote {
  const lines: QuoteLine[] = recipes.map((r) => ({
    recipe: r.id,
    job: r.job,
    calls: 0,
    ifEmailFound: 0,
    skipped: 0,
    cheapestPerCall: prices.get(r.job)?.cheapestPerCall ?? null,
    providerCount: prices.get(r.job)?.providerCount ?? 0,
  }));
  const emailRecipe = recipes.find((r) => r.id === "email");
  for (const row of rows) {
    const input = readRow(row, cols);
    const emailWillBeTried = emailRecipe !== undefined && !alreadyFilled(row, emailRecipe) && emailRecipe.input(input, {}) !== null;
    recipes.forEach((recipe, i) => {
      const line = lines[i];
      if (alreadyFilled(row, recipe)) {
        line.skipped++;
        return;
      }
      if (recipe.input(input, { work_email: row.work_email ?? "" }) !== null) {
        line.calls++;
      } else if (emailWillBeTried && recipe.id !== "email" && recipe.input(input, { work_email: "x@example.com" }) !== null) {
        line.ifEmailFound++;
      } else {
        line.skipped++;
      }
    });
  }
  let low = 0;
  let cap = 0;
  for (const l of lines) {
    low += l.calls * (l.cheapestPerCall ?? 0);
    cap += (l.calls + l.ifEmailFound) * maxPerCall;
  }
  return { rows: rows.length, lines, low, cap };
}

function usd(n: number | null): string {
  if (n === null) return "n/a";
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** Plain-text quote table for the terminal. */
export function formatQuote(q: Quote, maxPerCall: number): string {
  const out = [`Quote for ${q.rows} rows (nothing spent yet):`];
  for (const l of q.lines) {
    const extra = l.ifEmailFound > 0 ? ` + up to ${l.ifEmailFound} if an email is found` : "";
    out.push(`  ${l.recipe.padEnd(8)} job:${l.job.padEnd(24)} ${String(l.calls).padStart(5)} calls${extra}, from ${usd(l.cheapestPerCall)}/call, ${l.providerCount} providers, ${l.skipped} rows skipped`);
  }
  out.push(`  At the cheapest listed prices: ${usd(q.low)}. Most it can spend (${usd(maxPerCall)} cap per call): ${usd(q.cap)}.`);
  out.push("  Misses and failed calls cost $0.");
  return out.join("\n");
}
