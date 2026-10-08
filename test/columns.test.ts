import { test } from "node:test";
import assert from "node:assert/strict";
import { detectColumns, readRow, toDomain } from "../src/columns.ts";

test("detects common header spellings", () => {
  const cols = detectColumns(["First Name", "last_name", "Company Website", "Organization", "E-mail", "LinkedIn URL"]);
  assert.deepEqual(cols, {
    first_name: "First Name", last_name: "last_name", domain: "Company Website",
    company: "Organization", email: "E-mail", linkedin_url: "LinkedIn URL",
  });
});

test("--map overrides detection and rejects unknown headers", () => {
  assert.equal(detectColumns(["Site", "Home"], { domain: "Home" }).domain, "Home");
  assert.throws(() => detectColumns(["Site"], { domain: "Nope" }), /no column named/);
});

test("toDomain strips scheme, www and path, refuses non-hosts", () => {
  assert.equal(toDomain("https://www.Example.com/about?x=1"), "example.com");
  assert.equal(toDomain("example.org"), "example.org");
  assert.equal(toDomain("not a domain"), "");
  assert.equal(toDomain("jane@example.com"), "");
});

test("readRow splits a full name and takes the domain from a work email, not a free mail", () => {
  const cols = detectColumns(["Name", "Email"]);
  const work = readRow({ Name: "Jane van Doe", Email: "jane@example.com" }, cols);
  assert.equal(work.first_name, "Jane");
  assert.equal(work.last_name, "van Doe");
  assert.equal(work.domain, "example.com");
  const free = readRow({ Name: "Jo Bloggs", Email: "jo@gmail.com" }, cols); // leak-scan:allow (free-mail fixture)
  assert.equal(free.domain, "");
});

test("readRow ignores a malformed email", () => {
  const cols = detectColumns(["Email"]);
  assert.equal(readRow({ Email: "jane@example " }, cols).email, "");
});
