// looot-csv-enrich: add company, work email, email check, phone and person columns to a CSV.
// Prints a quote and stops unless --run is given.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { detectColumns, type Field } from "./columns.ts";
import { parseCsv, toCsv } from "./csv.ts";
import { enrichTable } from "./enrich.ts";
import { Looot, LoootError } from "./looot.ts";
import { buildQuote, formatQuote } from "./quote.ts";
import { RECIPES, selectRecipes } from "./recipes.ts";

export interface Args {
  input: string;
  out: string;
  add: string[];
  run: boolean;
  budget: number;
  maxPerCall: number;
  maxAttempts: number;
  concurrency: number;
  map: Partial<Record<Field, string>>;
  help: boolean;
}

const HELP = `Usage: looot-csv-enrich <file.csv> --add company,email,verify [options]

Columns you can add:
${RECIPES.map((r) => `  ${r.id.padEnd(8)} ${r.summary} (job:${r.job})`).join("\n")}

Options:
  --add <list>          Comma list of the columns above (required)
  --run                 Spend money. Without it the tool prints the quote and stops
  --out <file>          Output CSV (default: <file>.enriched.csv)
  --budget <usd>        Stop starting calls once this total could be passed (default 1.00)
  --max-per-call <usd>  Cap for one cell across all providers tried (default 0.05)
  --attempts <n>        Providers to try per cell before giving up (default 3, max 10)
  --concurrency <n>     Rows in flight at once (default 4)
  --map field=Header    Force a column, e.g. --map domain="Company Website"
                        fields: email, first_name, last_name, name, domain, company, linkedin_url

Env: LOOOT_TOKEN (needed only with --run). Get one at https://looot.ai.`;

function num(flag: string, v: string | undefined, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${flag} must be a number from ${min} to ${max}`);
  return n;
}

/** Parses argv (without node and the script path). */
export function parseArgs(argv: string[]): Args {
  const a: Args = { input: "", out: "", add: [], run: false, budget: 1, maxPerCall: 0.05, maxAttempts: 3, concurrency: 4, map: {}, help: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${t} needs a value`);
      return v;
    };
    switch (t) {
      case "-h": case "--help": a.help = true; break;
      case "--run": a.run = true; break;
      case "--add": a.add = val().split(",").map((x) => x.trim()).filter(Boolean); break;
      case "--out": a.out = val(); break;
      case "--budget": a.budget = num(t, val(), 0, 1000); break;
      case "--max-per-call": a.maxPerCall = num(t, val(), 0.0001, 100); break;
      case "--attempts": a.maxAttempts = Math.floor(num(t, val(), 1, 10)); break;
      case "--concurrency": a.concurrency = Math.floor(num(t, val(), 1, 16)); break;
      case "--map": {
        const [field, ...rest] = val().split("=");
        a.map[field.trim() as Field] = rest.join("=").trim();
        break;
      }
      default:
        if (t.startsWith("-")) throw new Error(`unknown option ${t}`);
        if (a.input) throw new Error(`one input file only, got ${a.input} and ${t}`);
        a.input = t;
    }
  }
  if (!a.out && a.input) a.out = a.input.replace(/\.csv$/i, "") + ".enriched.csv";
  return a;
}

/** Runs the CLI. Returns the exit code. */
export async function main(argv: string[], client = new Looot(), print = (s: string) => console.log(s)): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    print(`error: ${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (args.help || !args.input || args.add.length === 0) {
    print(HELP);
    return args.help ? 0 : 2;
  }
  if (!existsSync(args.input)) {
    print(`error: no such file ${args.input}`);
    return 2;
  }
  const recipes = selectRecipes(args.add);
  // Resume: if the output exists, start from it so filled cells are skipped.
  const source = existsSync(args.out) ? args.out : args.input;
  const table = parseCsv(readFileSync(source, "utf8"));
  const cols = detectColumns(table.headers, args.map);
  print(`Read ${table.rows.length} rows from ${source}.`);
  print(`Columns found: ${Object.entries(cols).map(([f, h]) => `${f}="${h}"`).join(", ") || "none"}`);

  const prices = await client.jobPrices();
  const quote = buildQuote(table.rows, cols, recipes, prices, args.maxPerCall);
  print(formatQuote(quote, args.maxPerCall));
  print(`  Budget for this run: $${args.budget.toFixed(2)}.`);

  if (!args.run) {
    print("\nDry run, nothing spent. Add --run to enrich.");
    return 0;
  }
  if (!client.token) {
    print("\nerror: --run needs LOOOT_TOKEN. Create an agent token at https://looot.ai (scopes catalog.read, runs.read, runs.execute, usage.read).");
    return 2;
  }

  const save = () => {
    const tmp = `${args.out}.tmp`;
    writeFileSync(tmp, toCsv(table));
    renameSync(tmp, args.out);
  };
  print("");
  try {
    const s = await enrichTable(table, cols, recipes, client, {
      budget: args.budget,
      maxPerCall: args.maxPerCall,
      maxAttempts: args.maxAttempts,
      concurrency: args.concurrency,
      log: print,
      onRowDone: save,
    });
    save();
    print(`\nDone. ${s.calls} calls: ${s.completed} found, ${s.misses} no match, ${s.failed} failed, ${s.pending} still running, ${s.replayed} replayed from an earlier run.`);
    print(`Spent $${s.spent.toFixed(4)}. Wrote ${args.out}.`);
    if (s.skippedForBudget > 0) print(`${s.skippedForBudget} cells not run because the budget was reached. Rerun with a higher --budget; finished cells are skipped.`);
    if (s.stoppedReason) {
      print(`Stopped: ${s.stoppedReason}`);
      return 1;
    }
    return 0;
  } catch (e) {
    save();
    print(`error: ${e instanceof LoootError ? `${e.code}: ${e.message}` : (e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
