# looot-csv-enrich as a container. No build step and no npm install: the CLI has no runtime
# dependencies and Node 22.18+ runs the .ts files directly.
#
# Base: node:22.23.3-alpine3.24 (multi-arch index digest, read from Docker Hub on 2026-10-08).
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

LABEL org.opencontainers.image.title="looot-csv-enrich" \
      org.opencontainers.image.description="Add company, work email, email check, phone and person columns to any CSV. Quote first, pay per call through looot." \
      org.opencontainers.image.source="https://github.com/loootai/looot-csv-enrich" \
      org.opencontainers.image.url="https://looot.ai" \
      org.opencontainers.image.documentation="https://docs.looot.ai" \
      org.opencontainers.image.vendor="looot" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production

WORKDIR /app
COPY package.json LICENSE ./
COPY src ./src
COPY examples ./examples

# Mount your folder here: -v "$PWD:/data". Paths on the command line are relative to it.
RUN mkdir /data && chown node:node /data
WORKDIR /data
USER 1000:1000

ENTRYPOINT ["node", "/app/src/cli.ts"]
CMD ["--help"]
