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
/** An invalid model-generated argument list; mirrors the harness `ToolArgsError`. */
export class ToolArgsError extends Error {
    name = 'ToolArgsError';
    code = 'INVALID_ARGS';
    violations;
    constructor(violations) {
        super(`invalid arguments: ${violations.join('; ')}`);
        this.violations = violations;
    }
}
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'];
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function authorError(message) {
    throw new Error(`defineTool: ${message}`);
}
function assertAuthorKeys(node, path, allowed) {
    for (const key of Object.keys(node)) {
        if (!allowed.includes(key)) {
            authorError(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/items/enum/const + ${ANNOTATION_KEYS.join('/')})`);
        }
    }
}
function copyAnnotations(input, node) {
    if (typeof input.description === 'string')
        node.description = input.description;
    if (typeof input.title === 'string')
        node.title = input.title;
    if (Object.hasOwn(input, 'default'))
        node.default = input.default;
    if (Array.isArray(input.examples))
        node.examples = [...input.examples];
}
function scalarList(input, path) {
    if (!Array.isArray(input) || input.length === 0)
        authorError(`${path}.enum must be a non-empty array of scalar values`);
    return input.map((entry) => {
        if (entry !== null && typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
            authorError(`${path}.enum must contain only scalar values`);
        }
        return entry;
    });
}
/**
 * Compile one author value schema into the enforced raw JSON Schema subset.
 * @param input - the author node.
 * @param path - diagnostic path, e.g. `parameters.query`.
 * @param allowRequired - whether this node sits in a property map position.
 */
function compileValue(input, path, allowRequired) {
    if (!isPlainObject(input))
        authorError(`${path} must be a value schema object`);
    const authorKeys = [...ANNOTATION_KEYS, ...(allowRequired ? ['required'] : [])];
    if (Object.hasOwn(input, 'oneOf')) {
        assertAuthorKeys(input, path, [...authorKeys, 'oneOf']);
        if (Object.hasOwn(input, 'type'))
            authorError(`${path} cannot declare both type and oneOf`);
        if (!Array.isArray(input.oneOf))
            authorError(`${path}.oneOf must be an array of at least two value schemas`);
        if (input.oneOf.length < 2)
            authorError(`${path}.oneOf must be an array of at least two value schemas`);
        const node = {};
        copyAnnotations(input, node);
        node.oneOf = input.oneOf.map((branch, index) => compileValue(branch, `${path}.oneOf[${index}]`, false));
        return node;
    }
    const type = Object.hasOwn(input, 'type') ? input.type : undefined;
    const node = {};
    switch (type) {
        case 'json':
            assertAuthorKeys(input, path, [...authorKeys, 'type']);
            copyAnnotations(input, node);
            return node;
        case 'object': {
            assertAuthorKeys(input, path, [...authorKeys, 'type', 'properties', 'additionalProperties']);
            if (typeof input.additionalProperties !== 'boolean') {
                authorError(`${path}.additionalProperties must be explicitly true or false`);
            }
            node.type = 'object';
            copyAnnotations(input, node);
            node.additionalProperties = input.additionalProperties;
            if (Object.hasOwn(input, 'properties')) {
                if (!isPlainObject(input.properties))
                    authorError(`${path}.properties must be an object of value schemas`);
                const properties = {};
                const required = [];
                for (const [key, property] of Object.entries(input.properties)) {
                    if (isPlainObject(property) && Object.hasOwn(property, 'required')) {
                        if (property.required !== true)
                            authorError(`${path}.properties.${key}.required must be true when present`);
                        required.push(key);
                    }
                    properties[key] = compileValue(property, `${path}.properties.${key}`, true);
                }
                node.properties = properties;
                if (required.length > 0)
                    node.required = required;
            }
            return node;
        }
        case 'array':
            assertAuthorKeys(input, path, [...authorKeys, 'type', 'items']);
            node.type = 'array';
            copyAnnotations(input, node);
            if (Object.hasOwn(input, 'items'))
                node.items = compileValue(input.items, `${path}.items`, false);
            return node;
        case 'string':
        case 'number':
        case 'integer':
        case 'boolean':
        case 'null': {
            assertAuthorKeys(input, path, [...authorKeys, 'type', 'enum', 'const']);
            node.type = type;
            copyAnnotations(input, node);
            if (Object.hasOwn(input, 'enum'))
                node.enum = scalarList(input.enum, path);
            if (Object.hasOwn(input, 'const'))
                node.const = input.const;
            return node;
        }
        default:
            authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`);
    }
}
/**
 * Compile a parameter map into an object-rooted raw schema.
 *
 * The root is closed (`additionalProperties: false`), so a hallucinated
 * argument name is reported instead of being silently dropped.
 */
export function parameterSchemaSpecToJsonSchema(spec) {
    if (!isPlainObject(spec))
        authorError('parameters must be an object of value schemas');
    const properties = {};
    const required = [];
    for (const [key, property] of Object.entries(spec)) {
        if (isPlainObject(property) && Object.hasOwn(property, 'required')) {
            if (property.required !== true)
                authorError(`parameters.${key}.required must be true when present`);
            required.push(key);
        }
        properties[key] = compileValue(property, `parameters.${key}`, true);
    }
    return {
        type: 'object',
        properties,
        additionalProperties: false,
        ...(required.length > 0 ? { required } : {}),
    };
}
/** Walk a value against one raw schema node, collecting path-qualified violations. */
function collectViolations(schema, value, path, out) {
    if (schema.oneOf !== undefined) {
        const matched = schema.oneOf.filter((branch) => {
            const scratch = [];
            collectViolations(branch, value, path, scratch);
            return scratch.length === 0;
        }).length;
        if (matched !== 1)
            out.push(`${path || 'arguments'} must match exactly one oneOf branch (matched ${matched})`);
        return;
    }
    if (schema.type !== undefined) {
        const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        const expected = schema.type;
        const matches = (expected === 'null' && value === null) ||
            (expected === 'array' && Array.isArray(value)) ||
            (expected === 'object' && isPlainObject(value)) ||
            (expected === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
            (expected === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
            (expected === 'string' && typeof value === 'string') ||
            (expected === 'boolean' && typeof value === 'boolean');
        if (!matches) {
            out.push(`${path || 'arguments'} must be ${expected} (received ${actual})`);
            return;
        }
    }
    if (schema.enum !== undefined && !schema.enum.includes(value)) {
        out.push(`${path || 'arguments'} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`);
    }
    if (schema.const !== undefined && value !== schema.const) {
        out.push(`${path || 'arguments'} must equal ${JSON.stringify(schema.const)}`);
    }
    if (schema.type === 'object' && isPlainObject(value)) {
        for (const key of schema.required ?? []) {
            if (!Object.hasOwn(value, key) || value[key] === undefined)
                out.push(`${path}${path ? '.' : ''}${key} is required`);
        }
        if (schema.additionalProperties === false) {
            const known = new Set(Object.keys(schema.properties ?? {}));
            for (const key of Object.keys(value)) {
                if (!known.has(key))
                    out.push(`${path}${path ? '.' : ''}${key} is not a known argument`);
            }
        }
        for (const [key, child] of Object.entries(schema.properties ?? {})) {
            if (Object.hasOwn(value, key) && value[key] !== undefined) {
                collectViolations(child, value[key], `${path}${path ? '.' : ''}${key}`, out);
            }
        }
    }
    if (schema.type === 'array' && Array.isArray(value) && schema.items !== undefined) {
        // Only the first few violations are useful; a whole-array type error is the common case.
        for (let index = 0; index < value.length && out.length < 12; index++) {
            collectViolations(schema.items, value[index], `${path}[${index}]`, out);
        }
    }
}
/** Validate model-generated arguments against a compiled parameter schema. */
export function validateArgs(schema, args) {
    const violations = [];
    collectViolations(schema, args, '', violations);
    return violations;
}
/**
 * Define a tool with a compiled parameter schema and pre-dispatch argument
 * validation, mirroring the harness `defineTool`.
 * @param options - typed definition and optional presentation hooks.
 * @returns a registry-ready definition.
 */
export function defineTool(options) {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
        throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
    }
    const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
    const outputSchema = compileValue(options.output.schema, 'output.schema', false);
    const { execute, isConcurrencySafe, presentCall, presentResult, projectContent, finalizeContent, } = options;
    const { render, presentationMeta } = options.output;
    const definition = {
        name: options.name,
        description: options.description,
        parameters,
        output: {
            schema: outputSchema,
            render: (args, value) => render(args, value),
            ...(presentationMeta !== undefined
                ? { presentationMeta: (args, value) => presentationMeta(args, value) }
                : {}),
        },
        ...(options.deferLoading === true ? { deferLoading: true } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        async execute(args, exec) {
            const violations = validateArgs(parameters, args);
            if (violations.length > 0)
                throw new ToolArgsError(violations);
            return await execute(args, exec);
        },
    };
    if (projectContent !== undefined) {
        definition.projectContent = (exec, value) => projectContent(exec, value);
    }
    if (finalizeContent !== undefined) {
        definition.finalizeContent = (exec, value) => finalizeContent(exec, value);
    }
    if (presentCall !== undefined) {
        definition.presentCall = (args) => {
            if (validateArgs(parameters, args).length > 0)
                return undefined;
            return presentCall(args);
        };
    }
    if (presentResult !== undefined) {
        definition.presentResult = (args, value) => {
            if (validateArgs(parameters, args).length > 0)
                return undefined;
            return presentResult(args, value);
        };
    }
    if (isConcurrencySafe !== undefined) {
        definition.isConcurrencySafe = (args) => {
            if (validateArgs(parameters, args).length > 0)
                return false;
            return isConcurrencySafe(args);
        };
    }
    return definition;
}
//# sourceMappingURL=harness.js.map