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
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchemaNode
  oneOf?: JsonSchemaNode[]
  enum?: (string | number | boolean | null)[]
  const?: string | number | boolean | null
  description?: string
  title?: string
  default?: unknown
  examples?: unknown[]
}

/** Annotations accepted on every author node. */
type Annotations = {
  description?: string
  title?: string
  default?: unknown
  examples?: unknown[]
}

/**
 * An author value schema: one of the JSON types, or the author-only `json`
 * node (annotation-only at the wire level), or an exact-one `oneOf`.
 */
export type ValueSchemaSpec =
  | ({ type: 'string'; enum?: string[]; const?: string } & Annotations)
  | ({ type: 'number'; enum?: number[]; const?: number } & Annotations)
  | ({ type: 'integer'; enum?: number[]; const?: number } & Annotations)
  | ({ type: 'boolean'; enum?: boolean[]; const?: boolean } & Annotations)
  | ({ type: 'null' } & Annotations)
  | ({ type: 'json' } & Annotations)
  | ({ type: 'array'; items?: ValueSchemaSpec } & Annotations)
  | ({
      type: 'object'
      /** `additionalProperties` must be stated explicitly, as the real DSL requires. */
      additionalProperties: boolean
      properties?: Record<string, ValueSchemaSpec>
    } & Annotations)
  | ({ oneOf: ValueSchemaSpec[] } & Annotations)

/**
 * Parameter maps add author-level `required` to a value schema. `required` may
 * only be the literal `true`; absence means optional.
 */
export type ParameterSchemaSpec = Record<string, ValueSchemaSpec & { required?: true }>

/** Model-facing text block. */
export interface TextContentBlock {
  type: 'text'
  text: string
}

/** Execution context handed to a tool body by the registry. */
export interface ToolRunContext {
  readonly signal: AbortSignal
}

/** Options accepted by {@link defineTool}. */
export interface DefineToolOptions<Args, Value> {
  name: string
  description: string
  parameters: ParameterSchemaSpec
  output: {
    schema: ValueSchemaSpec
    render(args: Args, value: Value): TextContentBlock[]
    presentationMeta?(args: Args, value: Value): unknown
  }
  execute(args: Args, exec: ToolRunContext): Promise<Value> | Value
  timeoutMs?: number
  isConcurrencySafe?(args: Args): boolean
  deferLoading?: boolean
  projectContent?(exec: ToolRunContext, value: Value): unknown
  finalizeContent?(exec: ToolRunContext, value: Value): unknown
  presentCall?(args: Args): unknown
  presentResult?(args: Args, value: Value): unknown
}
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchemaNode
  readonly output: {
    readonly schema: JsonSchemaNode
    render(args: unknown, value: unknown): TextContentBlock[]
    presentationMeta?(args: unknown, value: unknown): unknown
  }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  readonly timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  readonly deferLoading?: boolean
  projectContent?(exec: ToolRunContext, value: unknown): unknown
  finalizeContent?(exec: ToolRunContext, value: unknown): unknown
  presentCall?(args: unknown): unknown
  presentResult?(args: unknown, value: unknown): unknown
}

/** The `ctx.tools` service seam. */
export interface ToolRegistry {
  register(definition: ToolDefinition): () => void
}

/** A minimal structured logger; the harness logger satisfies it. */
export interface LoggerLike {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  /** Present on the harness logger; optional so a bare logger still satisfies this. */
  debug?(...args: unknown[]): void
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
export type EventListener<P extends unknown[] = unknown[]> = (...args: P) => unknown

export interface EventRegistrar {
  /**
   * Register one listener. The payload tuple is supplied by the caller because
   * every event has its own shape; `P` keeps that shape checked at the call
   * site instead of widening it to `any`.
   */
  on<P extends unknown[]>(event: string, listener: EventListener<P>): () => void
}

/**
 * The slice of a Cordis context this plugin uses to register listeners.
 *
 * A scoped context is handed to `agent/created` and to `session` handlers as
 * `this`; the concrete agent additionally exposes the same context as
 * `agent.ctx`. Both are accepted where a registration target is needed.
 */
export interface ScopedContextLike extends EventRegistrar {}

/** The slice of the Cordis context this plugin injects. */
export interface HarnessContext extends EventRegistrar {
  readonly tools: ToolRegistry
  readonly logger?: LoggerLike
  /**
   * Optional service lookup. Used to reach services the plugin does not hard-
   * depend on, so a missing one degrades instead of failing the load.
   */
  get?<T>(service: string): T | undefined
}

/** An invalid model-generated argument list; mirrors the harness `ToolArgsError`. */
export class ToolArgsError extends Error {
  override readonly name = 'ToolArgsError'
  readonly code = 'INVALID_ARGS'
  readonly violations: string[]

  constructor(violations: string[]) {
    super(`invalid arguments: ${violations.join('; ')}`)
    this.violations = violations
  }
}

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function authorError(message: string): never {
  throw new Error(`defineTool: ${message}`)
}

function assertAuthorKeys(node: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) {
      authorError(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/items/enum/const + ${ANNOTATION_KEYS.join('/')})`)
    }
  }
}

function copyAnnotations(input: Record<string, unknown>, node: JsonSchemaNode): void {
  if (typeof input.description === 'string') node.description = input.description
  if (typeof input.title === 'string') node.title = input.title
  if (Object.hasOwn(input, 'default')) node.default = input.default
  if (Array.isArray(input.examples)) node.examples = [...input.examples]
}

function scalarList(input: unknown, path: string): (string | number | boolean | null)[] {
  if (!Array.isArray(input) || input.length === 0) authorError(`${path}.enum must be a non-empty array of scalar values`)
  return input.map((entry: unknown) => {
    if (entry !== null && typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
      authorError(`${path}.enum must contain only scalar values`)
    }
    return entry as string | number | boolean | null
  })
}

/**
 * Compile one author value schema into the enforced raw JSON Schema subset.
 * @param input - the author node.
 * @param path - diagnostic path, e.g. `parameters.query`.
 * @param allowRequired - whether this node sits in a property map position.
 */
function compileValue(input: unknown, path: string, allowRequired: boolean): JsonSchemaNode {
  if (!isPlainObject(input)) authorError(`${path} must be a value schema object`)
  const authorKeys = [...ANNOTATION_KEYS, ...(allowRequired ? ['required'] : [])]

  if (Object.hasOwn(input, 'oneOf')) {
    assertAuthorKeys(input, path, [...authorKeys, 'oneOf'])
    if (Object.hasOwn(input, 'type')) authorError(`${path} cannot declare both type and oneOf`)
    if (!Array.isArray(input.oneOf)) authorError(`${path}.oneOf must be an array of at least two value schemas`)
    if (input.oneOf.length < 2) authorError(`${path}.oneOf must be an array of at least two value schemas`)
    const node: JsonSchemaNode = {}
    copyAnnotations(input, node)
    node.oneOf = input.oneOf.map((branch: unknown, index: number) => compileValue(branch, `${path}.oneOf[${index}]`, false))
    return node
  }

  const type = Object.hasOwn(input, 'type') ? input.type : undefined
  const node: JsonSchemaNode = {}

  switch (type) {
    case 'json':
      assertAuthorKeys(input, path, [...authorKeys, 'type'])
      copyAnnotations(input, node)
      return node
    case 'object': {
      assertAuthorKeys(input, path, [...authorKeys, 'type', 'properties', 'additionalProperties'])
      if (typeof input.additionalProperties !== 'boolean') {
        authorError(`${path}.additionalProperties must be explicitly true or false`)
      }
      node.type = 'object'
      copyAnnotations(input, node)
      node.additionalProperties = input.additionalProperties
      if (Object.hasOwn(input, 'properties')) {
        if (!isPlainObject(input.properties)) authorError(`${path}.properties must be an object of value schemas`)
        const properties: Record<string, JsonSchemaNode> = {}
        const required: string[] = []
        for (const [key, property] of Object.entries(input.properties)) {
          if (isPlainObject(property) && Object.hasOwn(property, 'required')) {
            if (property.required !== true) authorError(`${path}.properties.${key}.required must be true when present`)
            required.push(key)
          }
          properties[key] = compileValue(property, `${path}.properties.${key}`, true)
        }
        node.properties = properties
        if (required.length > 0) node.required = required
      }
      return node
    }
    case 'array':
      assertAuthorKeys(input, path, [...authorKeys, 'type', 'items'])
      node.type = 'array'
      copyAnnotations(input, node)
      if (Object.hasOwn(input, 'items')) node.items = compileValue(input.items, `${path}.items`, false)
      return node
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null': {
      assertAuthorKeys(input, path, [...authorKeys, 'type', 'enum', 'const'])
      node.type = type
      copyAnnotations(input, node)
      if (Object.hasOwn(input, 'enum')) node.enum = scalarList(input.enum, path)
      if (Object.hasOwn(input, 'const')) node.const = input.const as JsonSchemaNode['const']
      return node
    }
    default:
      authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`)
  }
}

/**
 * Compile a parameter map into an object-rooted raw schema.
 *
 * The root is closed (`additionalProperties: false`), so a hallucinated
 * argument name is reported instead of being silently dropped.
 */
export function parameterSchemaSpecToJsonSchema(spec: ParameterSchemaSpec): JsonSchemaNode {
  if (!isPlainObject(spec)) authorError('parameters must be an object of value schemas')
  const properties: Record<string, JsonSchemaNode> = {}
  const required: string[] = []
  for (const [key, property] of Object.entries(spec)) {
    if (isPlainObject(property) && Object.hasOwn(property, 'required')) {
      if (property.required !== true) authorError(`parameters.${key}.required must be true when present`)
      required.push(key)
    }
    properties[key] = compileValue(property, `parameters.${key}`, true)
  }
  return {
    type: 'object',
    properties,
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
  }
}

/** Walk a value against one raw schema node, collecting path-qualified violations. */
function collectViolations(schema: JsonSchemaNode, value: unknown, path: string, out: string[]): void {
  if (schema.oneOf !== undefined) {
    const matched = schema.oneOf.filter((branch) => {
      const scratch: string[] = []
      collectViolations(branch, value, path, scratch)
      return scratch.length === 0
    }).length
    if (matched !== 1) out.push(`${path || 'arguments'} must match exactly one oneOf branch (matched ${matched})`)
    return
  }

  if (schema.type !== undefined) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    const expected = schema.type
    const matches =
      (expected === 'null' && value === null) ||
      (expected === 'array' && Array.isArray(value)) ||
      (expected === 'object' && isPlainObject(value)) ||
      (expected === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
      (expected === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
      (expected === 'string' && typeof value === 'string') ||
      (expected === 'boolean' && typeof value === 'boolean')
    if (!matches) {
      out.push(`${path || 'arguments'} must be ${expected} (received ${actual})`)
      return
    }
  }

  if (schema.enum !== undefined && !schema.enum.includes(value as string | number | boolean | null)) {
    out.push(`${path || 'arguments'} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`)
  }
  if (schema.const !== undefined && value !== schema.const) {
    out.push(`${path || 'arguments'} must equal ${JSON.stringify(schema.const)}`)
  }

  if (schema.type === 'object' && isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) out.push(`${path}${path ? '.' : ''}${key} is required`)
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}))
      for (const key of Object.keys(value)) {
        if (!known.has(key)) out.push(`${path}${path ? '.' : ''}${key} is not a known argument`)
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key) && value[key] !== undefined) {
        collectViolations(child, value[key], `${path}${path ? '.' : ''}${key}`, out)
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items !== undefined) {
    // Only the first few violations are useful; a whole-array type error is the common case.
    for (let index = 0; index < value.length && out.length < 12; index++) {
      collectViolations(schema.items, value[index], `${path}[${index}]`, out)
    }
  }
}

/** Validate model-generated arguments against a compiled parameter schema. */
export function validateArgs(schema: JsonSchemaNode, args: unknown): string[] {
  const violations: string[] = []
  collectViolations(schema, args, '', violations)
  return violations
}

/**
 * Define a tool with a compiled parameter schema and pre-dispatch argument
 * validation, mirroring the harness `defineTool`.
 * @param options - typed definition and optional presentation hooks.
 * @returns a registry-ready definition.
 */
export function defineTool<Args, Value>(options: DefineToolOptions<Args, Value>): ToolDefinition {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`)
  }
  const parameters = parameterSchemaSpecToJsonSchema(options.parameters)
  const outputSchema = compileValue(options.output.schema, 'output.schema', false)
  const {
    execute,
    isConcurrencySafe,
    presentCall,
    presentResult,
    projectContent,
    finalizeContent,
  } = options
  const { render, presentationMeta } = options.output

  const definition: ToolDefinition = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: (args, value) => render(args as Args, value as Value),
      ...(presentationMeta !== undefined
        ? { presentationMeta: (args: unknown, value: unknown) => presentationMeta(args as Args, value as Value) }
        : {}),
    },
    ...(options.deferLoading === true ? { deferLoading: true } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      const violations = validateArgs(parameters, args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      return await execute(args as Args, exec)
    },
  }

  if (projectContent !== undefined) {
    definition.projectContent = (exec, value) => projectContent(exec, value as Value)
  }
  if (finalizeContent !== undefined) {
    definition.finalizeContent = (exec, value) => finalizeContent(exec, value as Value)
  }
  if (presentCall !== undefined) {
    definition.presentCall = (args: unknown) => {
      if (validateArgs(parameters, args).length > 0) return undefined
      return presentCall(args as Args)
    }
  }
  if (presentResult !== undefined) {
    definition.presentResult = (args: unknown, value: unknown) => {
      if (validateArgs(parameters, args).length > 0) return undefined
      return presentResult(args as Args, value as Value)
    }
  }
  if (isConcurrencySafe !== undefined) {
    definition.isConcurrencySafe = (args: unknown) => {
      if (validateArgs(parameters, args).length > 0) return false
      return isConcurrencySafe(args as Args)
    }
  }

  return definition
}
