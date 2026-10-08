import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, toCsv } from "../src/csv.ts";

test("parses quotes, escaped quotes, commas and newlines inside quotes, CRLF and BOM", () => {
  const text = '﻿name,note\r\n"Doe, Jane","said ""hi""\nthen left"\r\nBob,\r\n';
  const t = parseCsv(text);
  assert.deepEqual(t.headers, ["name", "note"]);
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0].name, "Doe, Jane");
  assert.equal(t.rows[0].note, 'said "hi"\nthen left');
  assert.equal(t.rows[1].note, "");
});

test("round-trips through toCsv", () => {
  const t = parseCsv('a,b\n"x,1","y""z"\n');
  assert.deepEqual(parseCsv(toCsv(t)), t);
});

test("short rows get empty cells, blank lines are dropped", () => {
  const t = parseCsv("a,b,c\n1\n\n2,3,4\n");
  assert.deepEqual(t.rows, [{ a: "1", b: "", c: "" }, { a: "2", b: "3", c: "4" }]);
});
