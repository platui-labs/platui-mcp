# Contributing to platui-mcp

## Workflow

- **PR-only.** No direct pushes to `main`. Open a pull request from a feature branch and get it
  reviewed before merging.
- Run **`npm run verify`** before opening or updating a PR. It runs lint, format check, build,
  bundle, the full test suite, and coverage.
- **100% coverage is enforced on `src/tools/**`** (statements, branches, functions, and lines) via
  `vitest.config.ts`. New tool code must ship with tests that keep it at 100%.

## Dev setup

This package depends on [`platui-labs/platui-mcp-core`](https://github.com/platui-labs/platui-mcp-core)
via a `file:../platui-mcp-core` sibling dependency. Clone and build it next to this repo first:

```sh
git clone git@github.com:platui-labs/platui-mcp-core.git ../platui-mcp-core
cd ../platui-mcp-core && npm ci && npm run build
cd ../platui-mcp && npm install
npm run verify
```

## Environment overrides (team-only)

Customers run with zero configuration: production endpoints are baked into `src/runtime.ts` and
sign-in happens through the browser. The following env vars override those defaults for internal
development and testing. They are intentionally NOT documented in the README or on npm.

| Env                          | Meaning                                                                                        |
| :--------------------------- | :--------------------------------------------------------------------------------------------- |
| `PLATUI_PUBLIC_API_BASE_URL` | API base URL. Team testing: `https://timon.sandbox.platui.com` (`npm run start:sandbox`).      |
| `PLATUI_APP_BASE_URL`        | Web app origin for the `platui_login` URL (e.g. a preview deployment).                         |
| `PLATUI_MCP_ACCESS_TOKEN`    | Inject a bearer token directly, bypassing the browser login (scripting/CI).                    |
| `PLATUI_MCP_SCOPES`          | Restrict the local tool catalog's scopes (defaults to `*`; real authorization is server-side). |

There is no separate build per environment.

## Rules

- **Never commit secrets, tokens, or personal paths.** No bearer tokens, no API keys, no
  `/Users/yourname/...` paths in code, tests, docs, or fixtures.
- `src/worker.ts` and `wrangler.toml` are a **dormant, future Cloudflare Worker path**. Do not
  build, deploy, or delete them; leave them untouched unless you are explicitly reviving that path.
