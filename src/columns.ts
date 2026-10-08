// Finds which CSV columns hold names, emails, domains and so on, and reads one row into the
// canonical input names that looot job runs accept.

export type Field = "email" | "first_name" | "last_name" | "name" | "domain" | "company" | "linkedin_url";

const SYNONYMS: Record<Field, string[]> = {
  email: ["email", "emailaddress", "workemail", "mail", "e-mail"],
  first_name: ["firstname", "first", "givenname", "prenom"],
  last_name: ["lastname", "last", "surname", "familyname", "nom"],
  name: ["name", "fullname", "contact", "contactname", "person"],
  domain: ["domain", "website", "site", "url", "companydomain", "companywebsite", "web"],
  company: ["company", "companyname", "organization", "organisation", "account", "employer"],
  linkedin_url: ["linkedin", "linkedinurl", "linkedinprofile", "profileurl", "li"],
};

/** Lowercases a header and drops spaces, dashes and underscores so "First Name" matches "firstname". */
export function squash(header: string): string {
  return header.toLowerCase().replace(/[\s_\-.]/g, "");
}

/** Maps each canonical field to the first CSV header that matches it, or leaves it out. */
export function detectColumns(headers: string[], overrides: Partial<Record<Field, string>> = {}): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {};
  for (const field of Object.keys(SYNONYMS) as Field[]) {
    const forced = overrides[field];
    if (forced) {
      if (!headers.includes(forced)) throw new Error(`--map ${field}=${forced}: no column named "${forced}"`);
      out[field] = forced;
      continue;
    }
    const hit = headers.find((h) => SYNONYMS[field].includes(squash(h)));
    if (hit) out[field] = hit;
  }
  return out;
}

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.fr", "hotmail.com", "hotmail.fr", "outlook.com",
  "live.com", "msn.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com",
  "gmx.de", "web.de", "mail.com", "yandex.com", "yandex.ru", "orange.fr", "free.fr", "laposte.net",
]);

/** True for consumer mail domains, which say nothing about the person's company. */
export function isFreeMail(domain: string): boolean {
  return FREE_MAIL.has(domain.toLowerCase());
}

/** Reduces "https://www.Example.com/about" to "example.com". Returns "" when it is not a host. */
export function toDomain(value: string): string {
  let v = value.trim().toLowerCase();
  if (!v) return "";
  v = v.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
  v = v.split(/[/?#]/)[0] ?? "";
  if (!v.includes(".") || /[\s@]/.test(v)) return "";
  return v;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when the value looks like one email address with no surrounding spaces. */
export function isEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}

export interface RowInput {
  email: string;
  first_name: string;
  last_name: string;
  domain: string;
  company: string;
  linkedin_url: string;
}

/** Reads one CSV row into canonical inputs, filling name parts and domain from what is there. */
export function readRow(row: Record<string, string>, cols: Partial<Record<Field, string>>): RowInput {
  const get = (f: Field) => (cols[f] ? (row[cols[f] as string] ?? "").trim() : "");
  let first = get("first_name");
  let last = get("last_name");
  const full = get("name");
  if (!first && full) {
    const parts = full.split(/\s+/);
    first = parts[0] ?? "";
    last = last || parts.slice(1).join(" ");
  }
  const email = isEmail(get("email")) ? get("email") : "";
  let domain = toDomain(get("domain"));
  if (!domain && email) {
    const d = email.split("@")[1] ?? "";
    if (!isFreeMail(d)) domain = d.toLowerCase();
  }
  return { email, first_name: first, last_name: last, domain, company: get("company"), linkedin_url: get("linkedin_url") };
}
