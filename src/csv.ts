// RFC 4180 CSV reader and writer. Handles quoted fields, escaped quotes, commas and newlines
// inside quotes, CRLF, and a UTF-8 byte order mark. No dependencies.

export interface Table {
  headers: string[];
  rows: Record<string, string>[];
}

/** Parses CSV text into rows of string cells. */
export function parseCsvRows(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** Parses CSV text with a header line into a table keyed by header. */
export function parseCsv(text: string): Table {
  const raw = parseCsvRows(text);
  if (raw.length === 0) return { headers: [], rows: [] };
  const headers = raw[0].map((h) => h.trim());
  const rows = raw.slice(1).map((cells) => {
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = cells[idx] ?? "";
    });
    return row;
  });
  return { headers, rows };
}

function quoteCell(value: string): string {
  return /[",\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Writes a table back to CSV text, header first, LF line endings. */
export function toCsv(table: Table): string {
  const lines = [table.headers.map(quoteCell).join(",")];
  for (const row of table.rows) lines.push(table.headers.map((h) => quoteCell(row[h] ?? "")).join(","));
  return lines.join("\n") + "\n";
}
