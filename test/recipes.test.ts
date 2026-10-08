import { test } from "node:test";
import assert from "node:assert/strict";
import { RECIPES, findValue, readEmail, readStatus, selectRecipes } from "../src/recipes.ts";

const recipe = (id: string) => RECIPES.find((r) => r.id === id)!;
const base = { email: "", first_name: "", last_name: "", domain: "", company: "", linkedin_url: "" };

test("selectRecipes keeps the fixed order so email runs before verify", () => {
  assert.deepEqual(selectRecipes(["verify", "email"]).map((r) => r.id), ["email", "verify"]);
  assert.throws(() => selectRecipes(["emails"]), /unknown column set: emails/);
});

test("email recipe needs both name parts and a domain or company, and skips rows with an email", () => {
  const r = recipe("email");
  assert.equal(r.input({ ...base, first_name: "Ada" , domain: "example.com" }, {}), null);
  assert.deepEqual(r.input({ ...base, first_name: "Ada", last_name: "L", domain: "example.com" }, {}), { first_name: "Ada", last_name: "L", domain: "example.com" });
  assert.deepEqual(r.input({ ...base, first_name: "Ada", last_name: "L", company: "Acme" }, {}), { first_name: "Ada", last_name: "L", company: "Acme" });
  assert.equal(r.input({ ...base, email: "a@example.com", first_name: "Ada", last_name: "L", domain: "example.com" }, {}), null);
});

test("verify uses the email the email recipe found", () => {
  assert.deepEqual(recipe("verify").input(base, { work_email: "ada@example.com" }), { email: "ada@example.com" });
  assert.equal(recipe("verify").input(base, {}), null);
});

test("findValue prefers the normalized key order and searches nested objects", () => {
  assert.equal(findValue({ data: { company: { Industry: "Software" } } }, ["industry"]), "Software");
  assert.equal(findValue({ status: "success", result: "deliverable" }, ["result", "status"]), "deliverable");
  assert.equal(findValue({ a: { b: { c: { d: { e: { f: { industry: "deep" } } } } } } }, ["industry"]), "");
});

test("readEmail reads normalized fields first, then any address in the raw body", () => {
  assert.equal(readEmail({ status: "completed", normalized: { fields: { email: "ada@example.com" } } }), "ada@example.com");
  assert.equal(readEmail({ status: "completed", result: { data: [{ value: "grace@example.org" }] } }), "grace@example.org");
  assert.equal(readEmail({ status: "completed", result: { data: [] } }), "");
});

test("readStatus maps provider words to one vocabulary", () => {
  assert.equal(readStatus({ status: "completed", normalized: { fields: { status: "valid" } } }), "valid");
  assert.equal(readStatus({ status: "completed", result: { result: "undeliverable" } }), "invalid");
  assert.equal(readStatus({ status: "completed", result: { data: { status: "accept_all" } } }), "catch_all");
  assert.equal(readStatus({ status: "completed", result: { result: "weird" } }), "unknown");
  assert.equal(readStatus({ status: "completed", result: {} }), "");
});

test("company recipe reads common shapes", () => {
  const out = recipe("company").read({ status: "completed", result: { data: { name: "Example Inc", industry: "Software", employee_count: 120, country: "US" } } });
  assert.deepEqual(out, { company_name: "Example Inc", company_industry: "Software", company_employees: "120", company_country: "US", company_linkedin: "" });
});
