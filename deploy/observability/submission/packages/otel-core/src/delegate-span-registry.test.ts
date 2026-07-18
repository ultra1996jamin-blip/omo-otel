import { describe, expect, test } from "bun:test"
import type { Span } from "@opentelemetry/api"

import { DelegateSpanRegistry } from "./delegate-span-registry"

function fakeSpan(id: string): Span {
  return { __id: id } as unknown as Span
}

describe("DelegateSpanRegistry", () => {
  test("stores and retrieves a span by task id", () => {
    // given
    const registry = new DelegateSpanRegistry()
    const span = fakeSpan("a")

    // when
    registry.set("task-1", span)

    // then
    expect(registry.get("task-1")).toBe(span)
    expect(registry.size()).toBe(1)
  })

  test("returns undefined for an unknown task id", () => {
    // given
    const registry = new DelegateSpanRegistry()

    // when / then
    expect(registry.get("missing")).toBeUndefined()
  })

  test("deletes a span so it is no longer retrievable", () => {
    // given
    const registry = new DelegateSpanRegistry()
    registry.set("task-1", fakeSpan("a"))

    // when
    registry.delete("task-1")

    // then
    expect(registry.get("task-1")).toBeUndefined()
    expect(registry.size()).toBe(0)
  })
})
