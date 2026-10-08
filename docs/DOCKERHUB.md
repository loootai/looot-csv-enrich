# Docker Hub overview for `looot-csv-enrich`

Paste the text under the line into the repository overview on hub.docker.com. Short description
(100 characters max): `Add company, work email, email check and phone columns to a CSV. Quote first, pay per call.`

Set the repository's "Source Repository" field (hub.docker.com, the repository, Settings or the
General tab) to `https://github.com/loootai/looot-csv-enrich`.

---

# looot-csv-enrich

Give it the CSV you already have. It adds the columns you ask for: company details, work email, email check, phone, job title. It prints a quote for the whole file before it spends anything, runs only with `--run`, and stops at your budget.

It runs on [looot](https://looot.ai): one token and one prepaid balance for 2,500+ data API endpoints from 90+ providers. Each cell is one looot job run. If the first provider misses, looot tries the next one, and a failed call costs $0.

## Quote, no token needed

```bash
docker run --rm -v "$PWD:/data" loootai/looot-csv-enrich leads.csv --add company,email,verify
```

No CSV at hand? The image ships a 5-row sample:

```bash
docker run --rm loootai/looot-csv-enrich /app/examples/leads.csv --add company,email,verify,phone
```

## Paid run

```bash
export LOOOT_TOKEN=...   # agent token from https://looot.ai
docker run --rm -e LOOOT_TOKEN -v "$PWD:/data" loootai/looot-csv-enrich leads.csv --add company,email,verify --budget 2 --run
```

The result is written next to your file as `leads.enriched.csv`. Run the same command again to resume: filled cells are skipped and repeated calls reuse their idempotency key, so nothing is charged twice.

The container runs as the unprivileged `node` user (uid 1000). On Linux, if your folder belongs to another uid, add `--user "$(id -u):$(id -g)"`.

## Tags

- `latest`, `0.1`, `0.1.0`: linux/amd64 and linux/arm64, on `node:22-alpine`.

## Links

- Source and full options: https://github.com/loootai/looot-csv-enrich
- looot: https://looot.ai
- Docs: https://docs.looot.ai
- License: MIT
