# AGENTS.md

Instructions for AI coding agents working in this repo.

## What this is

The public, customer-facing MCP server for PlatUI (design-to-code). TypeScript, CommonJS, stdio transport. The published artifact is a single esbuild bundle (`dist/cli.js`) with zero runtime dependencies.

## Commands

- `npm run build` — tsc
- `npm run bundle` — esbuild -> `dist/cli.js`
- `npm test` — all vitest suites (integration tests spawn the built server; build + bundle first)
- `npm run verify` — the full gate: lint, format check, build, bundle, tests, coverage. Must be green before any PR.

## Layout

- `src/tools/public-catalog.ts` — the tool catalog. Every tool: strict Zod validator + matching JSON schema, `requiredScopes`, `riskLevel`, `executionPlane`.
- `src/mcp/server.ts` — registry + MCP server assembly.
- `src/index.ts` — stdio entrypoint. `src/worker.ts` — dormant Cloudflare path; do not build or deploy it.
- Shared primitives (registry, auth, HTTP client, results) come from the `platui-mcp-core` package, cloned as a sibling directory and built before installing here.

## Rules

- 100% coverage is enforced on `src/tools/**` — new branches need tests.
- Public tools only call PlatUI HTTP APIs. Never add shell execution, filesystem access outside the credential cache, raw cloud-service access, or internal/staff tooling here — that lives in a separate private repo.
- Never commit secrets, tokens, or personal absolute paths.
- PR-only workflow; no direct pushes to main.
