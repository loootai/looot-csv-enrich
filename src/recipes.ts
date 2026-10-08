// The columns this tool can add. Each recipe is one looot job, the inputs it needs from a row,
// and how to read its answer. Providers answer in their own shapes, so readers look at the
// normalized block first and then search the raw result for common key names.

import type { RowInput } from "./columns.ts";

export interface RunLike {
  status: string;
  result?: unknown;
  normalized?: { fields?: Record<string, unknown> };
}

export interface Recipe {
  id: string;
  job: string;
  summary: string;
  /** Output columns, in order. */
  columns: string[];
  /** The job input for this row, or null when the row lacks what the job needs. */
  input(row: RowInput, filled: Record<string, string>): Record<string, string> | null;
  /** Values for the output columns. Empty object means the provider found nothing. */
  read(run: RunLike): Record<string, string>;
}

function squash(k: string): string {
  return k.toLowerCase().replace(/[\s_\-.]/g, "");
}

function scalar(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/**
 * Breadth-first search for the first non-empty scalar under any of the keys, at most 5 levels
 * deep. Within one object, earlier keys in the list win.
 */
export function findValue(source: unknown, keys: string[]): string {
  const wanted = keys.map(squash);
  let level: unknown[] = [source];
  for (let depth = 0; depth < 5 && level.length > 0; depth++) {
    const next: unknown[] = [];
    for (const node of level) {
      if (node === null || typeof node !== "object") continue;
      if (Array.isArray(node)) {
        next.push(...node.slice(0, 5));
        continue;
      }
      const entries = Object.entries(node as Record<string, unknown>);
      for (const key of wanted) {
        for (const [k, v] of entries) {
          if (squash(k) !== key) continue;
          const s = scalar(v);
          if (s) return s;
        }
      }
      for (const [, v] of entries) if (v !== null && typeof v === "object") next.push(v);
    }
    level = next;
  }
  return "";
}

function pick(run: RunLike, keys: string[]): string {
  return findValue(run.normalized?.fields ?? null, keys) || findValue(run.result ?? null, keys);
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** The found email from the normalized block, else the first address in the raw result. */
export function readEmail(run: RunLike): string {
  const direct = pick(run, ["email", "work_email", "emailAddress"]);
  if (direct && EMAIL_RE.test(direct)) return direct.match(EMAIL_RE)?.[0] ?? "";
  const m = JSON.stringify(run.result ?? "").match(EMAIL_RE);
  return m ? m[0] : "";
}

const STATUS_WORDS: Record<string, string> = {
  valid: "valid", deliverable: "valid", ok: "valid", safe: "valid", verified: "valid",
  invalid: "invalid", undeliverable: "invalid", bounce: "invalid", bad: "invalid",
  catchall: "catch_all", acceptall: "catch_all", accept_all: "catch_all", catch_all: "catch_all",
  risky: "risky", unknown: "unknown",
};

/** One status word: valid, invalid, catch_all, risky or unknown. */
export function readStatus(run: RunLike): string {
  const raw = pick(run, ["email_status", "verdict", "result", "status", "check", "state"]);
  return STATUS_WORDS[squash(raw)] ?? STATUS_WORDS[raw.toLowerCase()] ?? (raw ? "unknown" : "");
}

type JobInput = Record<string, string> | null;

const needName = (r: RowInput) => r.first_name !== "" && r.last_name !== "";

export const RECIPES: Recipe[] = [
  {
    id: "company",
    job: "company.enrich",
    summary: "Company name, industry, size, country and LinkedIn from the domain or company name",
    columns: ["company_name", "company_industry", "company_employees", "company_country", "company_linkedin"],
    input(r): JobInput {
      if (r.domain) return { domain: r.domain };
      if (r.company) return { name: r.company };
      return null;
    },
    read(run) {
      return {
        company_name: pick(run, ["name", "company_name", "companyName", "display_name"]),
        company_industry: pick(run, ["industry", "category", "sector"]),
        company_employees: pick(run, ["employees", "employee_count", "employeeCount", "size", "headcount", "estimated_num_employees"]),
        company_country: pick(run, ["country", "country_code", "countryCode", "hq_country"]),
        company_linkedin: pick(run, ["linkedin_url", "linkedinUrl", "linkedin"]),
      };
    },
  },
  {
    id: "email",
    job: "people.email.find",
    summary: "Work email from first name, last name and company domain",
    columns: ["work_email"],
    input(r): JobInput {
      if (r.email || !needName(r)) return null;
      if (r.domain) return { first_name: r.first_name, last_name: r.last_name, domain: r.domain };
      if (r.company) return { first_name: r.first_name, last_name: r.last_name, company: r.company };
      return null;
    },
    read(run) {
      return { work_email: readEmail(run) };
    },
  },
  {
    id: "verify",
    job: "people.email.verify",
    summary: "Deliverability of the row's email (or the work_email this tool found)",
    columns: ["email_status"],
    input(r, filled): JobInput {
      const email = r.email || filled.work_email || "";
      return email ? { email } : null;
    },
    read(run) {
      return { email_status: readStatus(run) };
    },
  },
  {
    id: "phone",
    job: "people.phone.find",
    summary: "Phone number from a LinkedIn URL, an email, or name plus domain",
    columns: ["phone"],
    input(r, filled): JobInput {
      if (r.linkedin_url) return { linkedin_url: r.linkedin_url };
      const email = r.email || filled.work_email || "";
      if (email) return { email };
      if (needName(r) && r.domain) return { first_name: r.first_name, last_name: r.last_name, domain: r.domain };
      return null;
    },
    read(run) {
      return { phone: pick(run, ["phone", "mobile", "phone_number", "phoneNumber", "mobile_phone", "number"]) };
    },
  },
  {
    id: "person",
    job: "people.enrich.by-email",
    summary: "Job title, LinkedIn URL and location from the email address",
    columns: ["person_title", "person_linkedin", "person_location"],
    input(r, filled): JobInput {
      const email = r.email || filled.work_email || "";
      return email ? { email } : null;
    },
    read(run) {
      return {
        person_title: pick(run, ["title", "job_title", "jobTitle", "headline", "position"]),
        person_linkedin: pick(run, ["linkedin_url", "linkedinUrl", "linkedin", "profile_url"]),
        person_location: pick(run, ["location", "city", "location_name", "country"]),
      };
    },
  },
];

/** Looks up recipes by id, in the fixed order above so email runs before verify. */
export function selectRecipes(ids: string[]): Recipe[] {
  const unknown = ids.filter((id) => !RECIPES.some((r) => r.id === id));
  if (unknown.length > 0) {
    throw new Error(`unknown column set: ${unknown.join(", ")}. Choose from: ${RECIPES.map((r) => r.id).join(", ")}`);
  }
  return RECIPES.filter((r) => ids.includes(r.id));
}
