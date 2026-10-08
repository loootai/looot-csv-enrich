import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseArgs } from "../src/cli.ts";
import { Looot } from "../src/looot.ts";
import { fakeFetch } from "./fake.ts";

function tmpCsv(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "csv-enrich-"));
  const p = join(dir, "leads.csv");
  writeFileSync(p, text);
  return p;
}

test("parseArgs reads flags and defaults the output name", () => {
  const a = parseArgs(["in.csv", "--add", "email, verify", "--budget", "2", "--map", "domain=Company Website"]);
  assert.deepEqual(a.add, ["email", "verify"]);
  assert.equal(a.out, "in.enriched.csv");
  assert.equal(a.budget, 2);
  assert.equal(a.map.domain, "Company Website");
  assert.throws(() => parseArgs(["--budget", "-1"]), /--budget/);
  assert.throws(() => parseArgs(["--nope"]), /unknown option/);
});

test("without --run it prints the quote, calls only the free price list and writes nothing", async () => {
  const p = tmpCsv("First Name,Last Name,Website\nAda,Lovelace,example.com\nGrace,Hopper,example.org\n");
  const fake = fakeFetch(() => undefined);
  const out: string[] = [];
  const code = await main([p, "--add", "email,verify"], new Looot({ token: "", baseUrl: "https://api.test", fetch: fake.fetch }), (s) => out.push(s));
  const text = out.join("\n");
  assert.equal(code, 0);
  assert.match(text, /email\s+job:people\.email\.find\s+2 calls/);
  assert.match(text, /verify\s+job:people\.email\.verify\s+0 calls \+ up to 2 if an email is found/);
  assert.match(text, /At the cheapest listed prices: \$0\.0080\. Most it can spend \(\$0\.05 cap per call\): \$0\.20/);
  assert.match(text, /Dry run, nothing spent/);
  assert.deepEqual(fake.calls.map((c) => c.path), ["/v1/catalog/overview?depth=jobs"]);
  assert.equal(fake.calls[0].auth, null);
  assert.equal(existsSync(p.replace(/\.csv$/, ".enriched.csv")), false);
});

test("--run without a token refuses before any paid call", async () => {
  const p = tmpCsv("Email\na@example.com\n");
  const fake = fakeFetch(() => undefined);
  const out: string[] = [];
  const code = await main([p, "--add", "verify", "--run"], new Looot({ token: "", baseUrl: "https://api.test", fetch: fake.fetch }), (s) => out.push(s));
  assert.equal(code, 2);
  assert.match(out.join("\n"), /--run needs LOOOT_TOKEN/);
  assert.equal(fake.calls.filter((c) => c.method === "POST").length, 0);
});

test("--run writes the enriched CSV, and a second run resumes from it without new calls", async () => {
  const p = tmpCsv("Email\na@example.com\n");
  const fake = fakeFetch((c) => (c.method === "POST" ? { body: { runId: "r", status: "completed", actualCost: 0.0015, normalized: { fields: { status: "valid" } } } } : undefined));
  const client = new Looot({ token: "t", baseUrl: "https://api.test", fetch: fake.fetch });
  assert.equal(await main([p, "--add", "verify", "--run"], client, () => {}), 0);
  const outPath = p.replace(/\.csv$/, ".enriched.csv");
  assert.equal(readFileSync(outPath, "utf8"), "Email,email_status,looot_cost_usd,looot_notes\na@example.com,valid,0.00150,\n");
  assert.equal(await main([p, "--add", "verify", "--run"], client, () => {}), 0);
  assert.equal(fake.calls.filter((c) => c.method === "POST").length, 1);
});
