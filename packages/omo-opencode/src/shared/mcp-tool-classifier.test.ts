import { afterEach, describe, expect, test } from "bun:test"
import {
  __resetKnownMcpServerNamesForTesting,
  getMcpServerNameForTool,
  setKnownMcpServerNames,
} from "./mcp-tool-classifier"

describe("mcp-tool-classifier", () => {
  afterEach(() => {
    __resetKnownMcpServerNamesForTesting()
  })

  test("returns undefined when no server names are known", () => {
    expect(getMcpServerNameForTool("context7_resolve-library-id")).toBeUndefined()
  })

  test("matches a tool name against a known server prefix", () => {
    setKnownMcpServerNames(["context7", "websearch", "grep_app"])

    expect(getMcpServerNameForTool("context7_resolve-library-id")).toBe("context7")
    expect(getMcpServerNameForTool("websearch_web_search_exa")).toBe("websearch")
    expect(getMcpServerNameForTool("grep_app_searchGitHub")).toBe("grep_app")
  })

  test("returns undefined for a built-in tool that shares no server prefix", () => {
    setKnownMcpServerNames(["context7", "websearch"])

    expect(getMcpServerNameForTool("grep")).toBeUndefined()
    expect(getMcpServerNameForTool("background_output")).toBeUndefined()
  })

  test("prefers the longest matching server prefix to avoid a short name shadowing a longer one", () => {
    // given — both "grep" and "grep_app" are configured; "grep_app_searchGitHub"
    // starts with both "grep_" and "grep_app_", but only "grep_app" is the
    // real owning server.
    setKnownMcpServerNames(["grep", "grep_app"])

    expect(getMcpServerNameForTool("grep_app_searchGitHub")).toBe("grep_app")
  })
})
