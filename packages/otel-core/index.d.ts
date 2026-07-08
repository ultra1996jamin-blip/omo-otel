import type { Attributes, Context, Meter, Span, Tracer } from "@opentelemetry/api";

export type OtelExporterKind = "otlp" | "jaeger" | "file" | "console";

export declare const OTEL_EXPORTER_KINDS: readonly OtelExporterKind[];
export declare const DEFAULT_OTEL_ENABLED: false;
export declare const DEFAULT_OTEL_EXPORTER: OtelExporterKind;
export declare const DEFAULT_OTLP_ENDPOINT: string;
export declare const DEFAULT_SERVICE_NAME: string;
export declare const DEFAULT_SAMPLING_RATE: number;
export declare const DEFAULT_LOCAL_STORAGE_DIRNAME: string;
export declare const GEN_AI_SYSTEM: string;

export type OtelEnv = Readonly<Record<string, string | undefined>>;

export type OtelFileConfig = {
  readonly enabled?: boolean;
  readonly exporter_type?: OtelExporterKind;
  readonly exporters?: {
    readonly otlp?: string;
  };
  readonly sampling_rate?: number;
};

export type OtelConfig = {
  readonly enabled: boolean;
  readonly exporter: OtelExporterKind;
  readonly otlpEndpoint: string;
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly samplingRate: number;
  readonly localStoragePath: string;
};

export type ResolveOtelConfigInput = {
  readonly env?: OtelEnv;
  readonly fileConfig?: OtelFileConfig;
  readonly serviceVersion?: string;
  readonly homedir?: () => string;
};

export type OtelDiagnosticEvent =
  | "otel_init_failed"
  | "otel_export_failed"
  | "otel_shutdown_failed"
  | "otel_span_failed";

export type OtelDiagnosticInput = {
  readonly event: OtelDiagnosticEvent;
  readonly error?: unknown;
};

export type OtelDiagnostics = (input: OtelDiagnosticInput) => void;

export declare function resolveOtelConfig(input?: ResolveOtelConfigInput): OtelConfig;

export declare const GEN_AI_OPERATION_NAME: "gen_ai.operation.name";
export declare const GEN_AI_SYSTEM_ATTR: "gen_ai.system";
export declare const GEN_AI_AGENT_NAME: "gen_ai.agent.name";

export declare function resolveTracer(): Tracer;
export declare function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T> | T,
  diagnostics?: OtelDiagnostics,
  parentContext?: Context,
): Promise<T>;
export declare function startDetachedSpan(name: string, attributes: Attributes, parentContext?: Context): Span;
export declare function endSpanSafely(span: Span | undefined, attributes?: Attributes, error?: unknown): void;

export declare class DelegateSpanRegistry {
  set(taskId: string, span: Span): void;
  get(taskId: string): Span | undefined;
  delete(taskId: string): void;
  size(): number;
}

export declare const DEFAULT_SESSION_IDLE_MS: number;

export declare class SessionSpanContext {
  getContext(sessionID: string, idleMs?: number, attributes?: Attributes, startTimeMs?: number): Context;
  getOrCreateNamedRootContext(
    sessionID: string,
    rootName: string,
    idleMs?: number,
    attributes?: Attributes,
    startTimeMs?: number,
  ): { context: Context; created: boolean };
  bindRoot(sessionID: string, span: Span, idleMs?: number): void;
  hasRoot(sessionID: string): boolean;
  markPendingBind(sessionID: string): void;
  clearPendingBind(sessionID: string): void;
  waitForBind(sessionID: string, maxWaitMs: number): Promise<void>;
  getContextAwaitingPendingBind(
    sessionID: string,
    maxWaitMs?: number,
    idleMs?: number,
    attributes?: Attributes,
    startTimeMs?: number,
  ): Promise<Context>;
  release(sessionID: string): void;
  __resetForTesting(): void;
}

export declare function getPendingBindMaxWaitMs(): number;
export declare function __setPendingBindMaxWaitForTesting(maxWaitMs: number): void;
export declare function __resetPendingBindMaxWaitForTesting(): void;

export declare const sessionSpanContext: SessionSpanContext;

export type InitializeOtelInput = ResolveOtelConfigInput & {
  readonly diagnostics?: OtelDiagnostics;
};

export type OtelHandle = {
  readonly enabled: boolean;
  readonly tracer: Tracer;
  readonly meter: Meter;
  readonly shutdown: () => Promise<void>;
};

export declare function initializeOtel(input?: InitializeOtelInput): OtelHandle;
export declare function getActiveTracer(): Tracer;
export declare function getActiveMeter(): Meter;
export declare function __resetActiveTracerForTesting(): void;

export declare function recordGenAiUsage(input: {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cost?: number;
  readonly agentName?: string;
}): void;
