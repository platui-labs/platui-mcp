# @platui/mcp

The official MCP (Model Context Protocol) server for [PlatUI](https://platui.com) — turn Figma designs into production React and Flutter code from your AI coding agent.

## Quickstart

Requires Node.js 18+.

Add the server to your MCP client. For Claude Code, put this in `.mcp.json` at your project root:

```json
{
  "mcpServers": {
    "platui": {
      "command": "npx",
      "args": ["-y", "@platui/mcp"]
    }
  }
}
```

For Cursor, use the same `command`/`args` shape in `~/.cursor/mcp.json`.

Then sign in from your agent — no tokens to copy:

1. Call the `platui_login` tool. It returns a URL.
2. Open the URL in a browser where you're signed in to PlatUI and approve.
3. Call `platui_check_login`. Your session is cached locally (`~/.platui/credentials.json`) and reused on future launches.

## What you can do

- **Import designs** — `platui_import_figma` creates a project from a Figma URL (asks you for the project name, framework, and language; use `platui_get_available_frameworks` / `platui_get_available_languages` to discover valid options). `platui_import_figma_mcp_context` and `platui_import_figma_plugin_payload` add screens to an existing project.
- **Generate & preview** — `platui_generate_code` compiles a design to code; `platui_create_preview` / `platui_get_preview` give you a hosted preview.
- **Pull artifacts** — `platui_get_artifacts` fetches the generated code; `platui_check_job_status` tracks pipeline progress.
- **Inspect designs** — `platui_inspect_design` returns the design node tree; `platui_get_figma_screenshot` renders a frame to an image.
- **Manage projects** — list projects, add/remove/list project members, check connected apps (Figma/GitHub/Google), view your plan and usage.
- **Deploy** — trigger the web-builder pipeline and fetch its logs and artifacts.

Call `platui_get_capabilities` for the full tool catalog.

## How to think about this

PlatUI converts Figma designs into code **artifacts for your agent to build with** — not a finished app. Two ways to use it: convert a whole design into a project (import every screen into one project, generate, assemble), or extract one screen/component's generated code and let the agent adapt it into your existing codebase. Output quality mirrors design hygiene: Figma Auto Layout produces clean flex layouts, free-floating layers produce absolute positioning the agent should refactor. When generated code looks off, `platui_inspect_design` exposes the design's true structure and the artifacts remain the base to improve on.

## Configuration

None. The server ships pointed at PlatUI production and signs you in through the browser — there are no tokens to create and no environment variables to set.

App connections (Figma, GitHub, Google) are managed in the PlatUI web app, not via MCP — `platui_get_connected_apps` tells you what's connected and where to go if something isn't.

## Development

This package depends on `platui-mcp-core`, expected as a sibling checkout:

```bash
git clone https://github.com/platui-labs/platui-mcp-core.git
git clone https://github.com/platui-labs/platui-mcp.git
cd platui-mcp-core && npm ci && npm run build
cd ../platui-mcp && npm install
```

`npm run verify` runs the full gate: ESLint, Prettier check, TypeScript build, esbuild bundle, tests, and coverage (100% enforced on `src/tools/**`). See [CONTRIBUTING.md](CONTRIBUTING.md).

The published package is a single self-contained bundle (`dist/cli.js`) with zero runtime dependencies.

## License

Proprietary — see [LICENSE](LICENSE). © 2026 PlatUI.
