import { resolveRuntimeOptions } from "./runtime";
import { runStdioServer } from "./mcp/server";

runStdioServer(resolveRuntimeOptions(process.env)).catch((error) => {
  console.error("Fatal: PlatUI MCP Server failed to start:", error);
  process.exit(1);
});
