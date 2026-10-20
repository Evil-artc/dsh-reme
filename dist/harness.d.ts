/**
 * The slice of the DeepSeek Harness tool contract this plugin is built
 * against, plus a local `defineTool`.
 *
 * Why a local `defineTool` instead of `import { defineTool } from
 * '@deepseek-ai/dsh-tools'`:
 *
 * 1. A profile plugin is module-isolated from DSH internals. The profile
 *    resolver only hands a plugin the packages its own profile declares
 *    (`dsh.profile.bundles` / `dependencies`), so importing a harness-internal
 *    specifier would either fail to resolve at boot or, worse, load a *second*
 *    copy of `dsh-tools` whose registry is not the one the agent loop
 *    dispatches through. Tools registered into that private registry would
 *    never reach the model.
 * 2. `ctx.tools.register()` accepts a plain definition object. `defineTool`
 *    is a pure compile-and-wrap helper: it compiles the author schema spec
 *    into the enforced raw JSON Schema subset, validates arguments before the
 *    body runs, and forwards the optional presentation hooks. Reproducing
 *    that here yields a definition indistinguishable to the registry, with no
 *    module-resolution risk and no startup cost.
 *
 * The shapes below mirror `@deepseek-ai/dsh-tools` at dsh 0.2.0-rc.2
 * (`src/schema.ts`, `src/types.ts`).
 *
 * @module dsh-reme/harness
 */
/** The enforced raw JSON Schema subset the tool wire format accepts. */
export interface JsonSchemaNode {
    type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
    properties?: Record<string, JsonSchemaNode>;
    required?: string[];
    additionalProperties?: boolean;
    items?: JsonSchemaNode;
    oneOf?: JsonSchemaNode[];
    enum?: (string | number | boolean | null)[];
    const?: string | number | boolean | null;
    description?: string;
    title?: string;
    default?: unknown;
    examples?: unknown[];
}
/** Annotations accepted on every author node. */
type Annotations = {
    description?: string;
    title?: string;
    default?: unknown;
    examples?: unknown[];
};
/**
 * An author value schema: one of the JSON types, or the author-only `json`
 * node (annotation-only at the wire level), or an exact-one `oneOf`.
 */
export type ValueSchemaSpec = ({
    type: 'string';
    enum?: string[];
    const?: string;
} & Annotations) | ({
    type: 'number';
    enum?: number[];
    const?: number;
} & Annotations) | ({
    type: 'integer';
    enum?: number[];
    const?: number;
} & Annotations) | ({
    type: 'boolean';
    enum?: boolean[];
    const?: boolean;
} & Annotations) | ({
    type: 'null';
} & Annotations) | ({
    type: 'json';
} & Annotations) | ({
    type: 'array';
    items?: ValueSchemaSpec;
} & Annotations) | ({
    type: 'object';
    /** `additionalProperties` must be stated explicitly, as the real DSL requires. */
    additionalProperties: boolean;
    properties?: Record<string, ValueSchemaSpec>;
} & Annotations) | ({
    oneOf: ValueSchemaSpec[];
} & Annotations);
/**
 * Parameter maps add author-level `required` to a value schema. `required` may
 * only be the literal `true`; absence means optional.
 */
export type ParameterSchemaSpec = Record<string, ValueSchemaSpec & {
    required?: true;
}>;
/** Model-facing text block. */
export interface TextContentBlock {
    type: 'text';
    text: string;
}
/** Execution context handed to a tool body by the registry. */
export interface ToolRunContext {
    readonly signal: AbortSignal;
}
/** Options accepted by {@link defineTool}. */
export interface DefineToolOptions<Args, Value> {
    name: string;
    description: string;
    parameters: ParameterSchemaSpec;
    output: {
        schema: ValueSchemaSpec;
        render(args: Args, value: Value): TextContentBlock[];
        presentationMeta?(args: Args, value: Value): unknown;
    };
    execute(args: Args, exec: ToolRunContext): Promise<Value> | Value;
    timeoutMs?: number;
    isConcurrencySafe?(args: Args): boolean;
    deferLoading?: boolean;
    projectContent?(exec: ToolRunContext, value: Value): unknown;
    finalizeContent?(exec: ToolRunContext, value: Value): unknown;
    presentCall?(args: Args): unknown;
    presentResult?(args: Args, value: Value): unknown;
}
export interface ToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonSchemaNode;
    readonly output: {
        readonly schema: JsonSchemaNode;
        render(args: unknown, value: unknown): TextContentBlock[];
        presentationMeta?(args: unknown, value: unknown): unknown;
    };
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
    readonly timeoutMs?: number;
    isConcurrencySafe?(args: unknown): boolean;
    readonly deferLoading?: boolean;
    projectContent?(exec: ToolRunContext, value: unknown): unknown;
    finalizeContent?(exec: ToolRunContext, value: unknown): unknown;
    presentCall?(args: unknown): unknown;
    presentResult?(args: unknown, value: unknown): unknown;
}
/** The `ctx.tools` service seam. */
export interface ToolRegistry {
    register(definition: ToolDefinition): () => void;
}
/** A minimal structured logger; the harness logger satisfies it. */
export interface LoggerLike {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    /** Present on the harness logger; optional so a bare logger still satisfies this. */
    debug?(...args: unknown[]): void;
}
/**
 * Registers one event listener and returns the exact Cordis effect disposer.
 *
 * Scoping is a property of the *registering context*: a listener registered
 * through a scoped context carries that scope's tag, and
 * `@deepseek-ai/dsh-scope` admits it only for events dispatched within that
 * scope (`system-prompt/assemble` is dispatched scope-filtered, see the
 * automatic-recall design notes). Registering through the plugin's own context
 * yields a global listener that receives every scope's events.
 */
export type EventListener<P extends unknown[] = unknown[]> = (...args: P) => unknown;
export interface EventRegistrar {
    /**
     * Register one listener. The payload tuple is supplied by the caller because
     * every event has its own shape; `P` keeps that shape checked at the call
     * site instead of widening it to `any`.
     */
    on<P extends unknown[]>(event: string, listener: EventListener<P>): () => void;
}
/**
 * The slice of a Cordis context this plugin uses to register listeners.
 *
 * A scoped context is handed to `agent/created` and to `session` handlers as
 * `this`; the concrete agent additionally exposes the same context as
 * `agent.ctx`. Both are accepted where a registration target is needed.
 */
export interface ScopedContextLike extends EventRegistrar {
}
/** The slice of the Cordis context this plugin injects. */
export interface HarnessContext extends EventRegistrar {
    readonly tools: ToolRegistry;
    readonly logger?: LoggerLike;
    /**
     * Optional service lookup. Used to reach services the plugin does not hard-
     * depend on, so a missing one degrades instead of failing the load.
     */
    get?<T>(service: string): T | undefined;
}
/** An invalid model-generated argument list; mirrors the harness `ToolArgsError`. */
export declare class ToolArgsError extends Error {
    readonly name = "ToolArgsError";
    readonly code = "INVALID_ARGS";
    readonly violations: string[];
    constructor(violations: string[]);
}
/**
 * Compile a parameter map into an object-rooted raw schema.
 *
 * The root is closed (`additionalProperties: false`), so a hallucinated
 * argument name is reported instead of being silently dropped.
 */
export declare function parameterSchemaSpecToJsonSchema(spec: ParameterSchemaSpec): JsonSchemaNode;
/** Validate model-generated arguments against a compiled parameter schema. */
export declare function validateArgs(schema: JsonSchemaNode, args: unknown): string[];
/**
 * Define a tool with a compiled parameter schema and pre-dispatch argument
 * validation, mirroring the harness `defineTool`.
 * @param options - typed definition and optional presentation hooks.
 * @returns a registry-ready definition.
 */
export declare function defineTool<Args, Value>(options: DefineToolOptions<Args, Value>): ToolDefinition;
export {};
