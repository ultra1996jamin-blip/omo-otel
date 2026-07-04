import type { Span } from "@opentelemetry/api"

/**
 * Maps an in-flight delegated task id to its open Span so an async completion
 * point (e.g. a background task's after-hook) can end the span it did not create.
 */
export class DelegateSpanRegistry {
  private readonly spans = new Map<string, Span>()

  set(taskId: string, span: Span): void {
    this.spans.set(taskId, span)
  }

  get(taskId: string): Span | undefined {
    return this.spans.get(taskId)
  }

  delete(taskId: string): void {
    this.spans.delete(taskId)
  }

  size(): number {
    return this.spans.size
  }
}
