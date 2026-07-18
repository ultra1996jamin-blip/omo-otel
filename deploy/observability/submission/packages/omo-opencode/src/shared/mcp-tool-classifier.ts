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

// OpenCode sanitizes server names when building the flat tool name — a server
// configured as "sds confluence" registers tools as "sds_confluence_<tool>"
// (observed live: span hook.sds_confluence_getPageByID never classified as
// MCP because the raw configured name "sds confluence_" was prefix-matched
// against the sanitized tool name). Match on the sanitized form of both sides.
function sanitizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_")
}

/**
 * Returns the MCP server name a tool call belongs to (in OpenCode's sanitized
 * tool-prefix form, e.g. "sds_confluence" for a server configured as
 * "sds confluence"), or undefined for a built-in tool. Picks the LONGEST
 * matching server-name prefix so a short server name (e.g. "grep") can't
 * shadow a longer one that also matches (e.g. "grep_app") when both happen
 * to be configured.
 */
export function getMcpServerNameForTool(toolName: string): string | undefined {
  const sanitizedTool = sanitizeForMatch(toolName)
  let best: string | undefined
  for (const name of knownMcpServerNames) {
    const sanitized = sanitizeForMatch(name)
    if (sanitizedTool.startsWith(`${sanitized}_`) && (best === undefined || sanitized.length > best.length)) {
      best = sanitized
    }
  }
  return best
}

/** @internal test-only */
export function __resetKnownMcpServerNamesForTesting(): void {
  knownMcpServerNames.clear()
}
