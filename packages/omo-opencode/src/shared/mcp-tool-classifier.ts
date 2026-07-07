// OpenCode's tool.execute.before hook only gives us a flat tool name string
// (e.g. "context7_resolve-library-id") — nothing distinguishing "came from
// an MCP server" from "a built-in tool". MCP-provided tools are registered
// as `${serverName}_${toolName}` (see mcp-config-handler.ts's merged server
// map), so the only reliable way to tell them apart is to remember the set
// of configured server names and prefix-match against it.
const knownMcpServerNames = new Set<string>()

export function setKnownMcpServerNames(names: Iterable<string>): void {
  knownMcpServerNames.clear()
  for (const name of names) {
    if (name) knownMcpServerNames.add(name)
  }
}

/**
 * Returns the MCP server name a tool call belongs to, or undefined for a
 * built-in tool. Picks the LONGEST matching server-name prefix so a short
 * server name (e.g. "grep") can't shadow a longer one that also matches
 * (e.g. "grep_app") when both happen to be configured.
 */
export function getMcpServerNameForTool(toolName: string): string | undefined {
  let best: string | undefined
  for (const name of knownMcpServerNames) {
    if (toolName.startsWith(`${name}_`) && (best === undefined || name.length > best.length)) {
      best = name
    }
  }
  return best
}

/** @internal test-only */
export function __resetKnownMcpServerNamesForTesting(): void {
  knownMcpServerNames.clear()
}
