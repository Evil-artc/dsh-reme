/**
 * Plugin configuration: shape, defaults, environment fallbacks, and load-time
 * validation.
 *
 * Everything here is optional with a working default, so an empty
 * `cordis.patch.yml` row still produces a usable plugin and the mount never
 * blocks on configuration.
 *
 * @module dsh-reme/config
 */
/** Default ReMe HTTP origin. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:2333';
/** Endpoint path for hybrid workspace search. */
export const DEFAULT_SEARCH_PATH = '/search';
/** Endpoint path for writing a workspace Markdown file. */
export const DEFAULT_WRITE_PATH = '/write';
/** Endpoint path that rebuilds the file store so a fresh write becomes searchable. */
export const DEFAULT_REINDEX_PATH = '/reindex';
/** Endpoint path that recalls existing digest nodes similar to a candidate (dedup). */
export const DEFAULT_NODE_SEARCH_PATH = '/node_search';
/**
 * Index scope passed to `/reindex` after a write. Defaults to `bm25`: that is
 * the index `reme_search` actually queries, and rebuilding `all` trips on ReMe's
 * tag index when it is unavailable (see `reindexScope` docs).
 */
export const DEFAULT_REINDEX_SCOPE = 'bm25';
/** Valid values for the reindex `scope` parameter, as ReMe accepts them. */
const REINDEX_SCOPES = new Set(['all', 'bm25', 'embedding', 'tag']);
/** Per-request timeout; also the default tool body timeout. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Default number of search hits. */
export const DEFAULT_SEARCH_LIMIT = 8;
/** Hard cap on search hits per call. */
export const MAX_SEARCH_LIMIT = 50;
/** Characters of chunk text retained per search hit. */
export const DEFAULT_MAX_CHUNK_CHARS = 1_200;
/** Character budget for one `reme_write` part when content is split. */
export const DEFAULT_WRITE_CHUNK_CHARS = 6_000;
/** Passages injected into one model request by the automatic recall layer. */
export const DEFAULT_RECALL_LIMIT = 4;
/** Total characters of recalled text injected into one model request. */
export const DEFAULT_RECALL_MAX_CHARS = 1_500;
/** Recalled passages scoring below this are dropped before injection. */
export const DEFAULT_RECALL_MIN_SCORE = 0.3;
/**
 * Hard ceiling on the recall search. The search sits on the prompt-assembly
 * path, so this is the maximum latency automatic recall may ever add; on
 * timeout the request proceeds without recall.
 */
export const DEFAULT_RECALL_TIMEOUT_MS = 400;
/**
 * Inputs shorter than this never trigger a recall search.
 *
 * Four, not eight: Chinese carries far more meaning per character, so real
 * questions arrive at 5-7 characters ("进行二期", "灌一批种子记忆"). The original
 * floor of eight silently skipped most of this user's messages, which is
 * invisible in production — the turn simply never recalls. Acknowledgement-
 * only inputs are already handled explicitly by `recallSkipPatterns`, so this
 * is a secondary guard, not the primary one.
 */
export const DEFAULT_RECALL_MIN_QUERY_CHARS = 4;
/**
 * Inputs matching any of these (case-insensitive, anchored) never trigger a
 * recall search: acknowledgements and continuations carry no retrievable
 * intent, so searching them only costs latency.
 */
export const DEFAULT_RECALL_SKIP_PATTERNS = [
    '^(ok|okay|k|yes|no|yep|nope|thanks|thank you|thx|continue|go on|next)[.!~]*$',
    '^(好的|好|嗯|哦|噢|继续|可以|行|是的|不是|谢谢|多谢|收到|明白|了解|下一个)[。！!.~、]*$',
];
/** Whether the read-only `reme_memory_status` diagnostic tool is registered. */
export const DEFAULT_DEBUG_STATUS_TOOL = false;
/** Turn durable conversation into long-term memory without being asked. */
export const DEFAULT_AUTO_EXTRACT = true;
/** User turns between automatic extractions. */
export const DEFAULT_EXTRACT_EVERY_TURNS = 4;
/** Buffered characters that force an extraction early. */
export const DEFAULT_EXTRACT_MIN_CHARS = 800;
/** Minimum `confidence` an extracted candidate must report to be written. */
export const DEFAULT_EXTRACT_CONFIDENCE = 0.6;
/** Maximum notes one extraction may write. */
export const DEFAULT_EXTRACT_MAX_WRITES = 3;
/**
 * Local similarity (character-bigram Jaccard over name + description) above
 * which a candidate counts as already remembered.
 *
 * This is a *local* measure on purpose: `/node_search` was measured to return
 * one constant score for every lexical hit, so its number cannot be
 * thresholded. See `ReMeNodeHit`.
 */
export const DEFAULT_DEDUPE_THRESHOLD = 0.6;
/** Consecutive dedup-lookup failures that trip the circuit breaker. */
export const DEFAULT_DEDUPE_CIRCUIT_THRESHOLD = 3;
/** How long a tripped dedup circuit stays open. */
export const DEFAULT_DEDUPE_CIRCUIT_COOLDOWN_MS = 60_000;
/** Maximum notes one session may write per hour. */
export const DEFAULT_WRITE_RATE_LIMIT_PER_HOUR = 30;
/** Consecutive extraction failures after which one buffer is abandoned. */
export const DEFAULT_EXTRACT_BAD_RETRY_MAX = 2;
/** Hard ceiling on one extraction model call. */
export const DEFAULT_EXTRACT_TIMEOUT_MS = 20_000;
/**
 * Output token budget for one extraction call.
 *
 * Deliberately generous: the extraction model reasons before answering, and a
 * reasoning trace shares this budget with the JSON it finally emits. A budget
 * sized only for the JSON truncates the array mid-object, which then reads as a
 * parse failure.
 */
export const DEFAULT_EXTRACT_MAX_TOKENS = 4_000;
/** Buffered transcript entries kept per session. */
export const TRANSCRIPT_MAX_ENTRIES = 40;
/** Buffered transcript characters kept per session. */
export const TRANSCRIPT_MAX_CHARS = 12_000;
/** Characters of one transcript entry considered for extraction. */
export const TRANSCRIPT_ENTRY_MAX_CHARS = 2_000;
/** Thrown when a patch row configures this plugin in a way it cannot serve. */
export class ConfigError extends Error {
    name = 'ConfigError';
    violations;
    constructor(violations) {
        super(`dsh-reme: invalid configuration: ${violations.join('; ')}`);
        this.violations = violations;
    }
}
function positiveInt(value, field, violations) {
    if (value === undefined || value === null || value === '')
        return undefined;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
        violations.push(`${field} must be a positive integer`);
        return undefined;
    }
    return parsed;
}
/** A finite number >= 0, used for timeouts and score thresholds. */
function nonNegativeNumber(value, field, violations) {
    if (value === undefined || value === null || value === '')
        return undefined;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        violations.push(`${field} must be a finite number >= 0`);
        return undefined;
    }
    return parsed;
}
function booleanValue(value, field, violations) {
    if (value === undefined || value === null || value === '')
        return undefined;
    if (typeof value === 'boolean')
        return value;
    if (value === 'true' || value === '1')
        return true;
    if (value === 'false' || value === '0')
        return false;
    violations.push(`${field} must be a boolean`);
    return undefined;
}
/** An optional non-empty string, trimmed; an empty value means "unset". */
function optionalText(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}
function pathValue(value, field, violations) {
    if (value === undefined || value === null || value === '')
        return undefined;
    if (typeof value !== 'string') {
        violations.push(`${field} must be a string`);
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
/**
 * Compile anchored skip patterns. A malformed pattern is a configuration error
 * rather than a silently ignored rule, so a typo cannot disable small-talk
 * filtering without notice.
 */
function patternList(value, field, violations, fallback) {
    const source = value === undefined || value === null || value === '' ? fallback : value;
    if (!Array.isArray(source)) {
        violations.push(`${field} must be an array of regular expression strings`);
        return compilePatterns(fallback);
    }
    const compiled = [];
    for (const [index, entry] of source.entries()) {
        if (typeof entry !== 'string') {
            violations.push(`${field}[${index}] must be a string`);
            continue;
        }
        try {
            compiled.push(new RegExp(entry, 'i'));
        }
        catch (error) {
            violations.push(`${field}[${index}] is not a valid regular expression: ${error.message}`);
        }
    }
    return compiled;
}
function compilePatterns(source) {
    return source.map((entry) => new RegExp(entry, 'i'));
}
/**
 * Normalize a ReMe address to an origin.
 *
 * A trailing `/api`, `/api/`, or `/` is folded into the origin so both the
 * documented `http://127.0.0.1:2333/api` form and the bare origin work, while
 * `searchPath` stays the single place that decides the route.
 */
export function normalizeBaseUrl(raw) {
    const trimmed = raw.trim();
    if (trimmed === '')
        throw new ConfigError(['baseUrl must not be empty']);
    let url;
    try {
        url = new URL(trimmed);
    }
    catch {
        throw new ConfigError([`baseUrl "${raw}" is not a valid absolute URL`]);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new ConfigError([`baseUrl must use http or https, received "${url.protocol}"`]);
    }
    let pathname = url.pathname.replace(/\/+$/, '');
    if (pathname === '/api')
        pathname = '';
    return `${url.origin}${pathname}`;
}
/**
 * Apply defaults and reject an unusable row while the plugin loads, so a typo
 * surfaces at boot rather than inside the first tool call the model makes.
 * @param raw - the `config` value from the Cordis row.
 * @param env - environment overrides; defaults to `process.env`.
 */
export function resolveConfig(raw, env = process.env) {
    const config = raw ?? {};
    const violations = [];
    const baseUrlSource = config.baseUrl ?? env.REME_BASE_URL ?? env.REME_API_BASE ?? DEFAULT_BASE_URL;
    const baseUrl = normalizeBaseUrl(baseUrlSource);
    const searchPath = pathValue(config.searchPath, 'searchPath', violations) ??
        pathValue(env.REME_SEARCH_PATH, 'REME_SEARCH_PATH', violations) ??
        DEFAULT_SEARCH_PATH;
    const writePath = pathValue(config.writePath, 'writePath', violations) ??
        pathValue(env.REME_WRITE_PATH, 'REME_WRITE_PATH', violations) ??
        DEFAULT_WRITE_PATH;
    const reindexPath = pathValue(config.reindexPath, 'reindexPath', violations) ??
        pathValue(env.REME_REINDEX_PATH, 'REME_REINDEX_PATH', violations) ??
        DEFAULT_REINDEX_PATH;
    const nodeSearchPath = pathValue(config.nodeSearchPath, 'nodeSearchPath', violations) ??
        pathValue(env.REME_NODE_SEARCH_PATH, 'REME_NODE_SEARCH_PATH', violations) ??
        DEFAULT_NODE_SEARCH_PATH;
    const reindexScopeRaw = (config.reindexScope ?? env.REME_REINDEX_SCOPE ?? DEFAULT_REINDEX_SCOPE)
        .trim()
        .toLowerCase();
    const reindexScope = REINDEX_SCOPES.has(reindexScopeRaw) ? reindexScopeRaw : DEFAULT_REINDEX_SCOPE;
    if (!REINDEX_SCOPES.has(reindexScopeRaw)) {
        violations.push(`reindexScope must be one of: all, bm25, embedding, tag`);
    }
    const requestTimeoutMs = positiveInt(config.requestTimeoutMs, 'requestTimeoutMs', violations) ??
        positiveInt(env.REME_REQUEST_TIMEOUT_MS, 'REME_REQUEST_TIMEOUT_MS', violations) ??
        DEFAULT_REQUEST_TIMEOUT_MS;
    const defaultLimit = positiveInt(config.defaultLimit, 'defaultLimit', violations) ??
        positiveInt(env.REME_SEARCH_LIMIT, 'REME_SEARCH_LIMIT', violations) ??
        DEFAULT_SEARCH_LIMIT;
    const maxChunkChars = positiveInt(config.maxChunkChars, 'maxChunkChars', violations) ?? DEFAULT_MAX_CHUNK_CHARS;
    const writeChunkChars = positiveInt(config.writeChunkChars, 'writeChunkChars', violations) ?? DEFAULT_WRITE_CHUNK_CHARS;
    const reindexAfterWrite = booleanValue(config.reindexAfterWrite, 'reindexAfterWrite', violations) ??
        booleanValue(env.REME_REINDEX_AFTER_WRITE, 'REME_REINDEX_AFTER_WRITE', violations) ??
        true;
    const digestSource = config.defaultDigestDir ?? env.REME_DIGEST_DIR ?? 'digest';
    const defaultDigestDir = typeof digestSource === 'string' && digestSource.trim() !== ''
        ? digestSource.trim().replace(/^\/+|\/+$/g, '')
        : 'digest';
    const toolPrefix = (config.toolPrefix ?? env.REME_TOOL_PREFIX ?? 'reme').trim() || 'reme';
    const autoRecall = booleanValue(config.autoRecall, 'autoRecall', violations) ??
        booleanValue(env.REME_AUTO_RECALL, 'REME_AUTO_RECALL', violations) ??
        true;
    const recallLimit = positiveInt(config.recallLimit, 'recallLimit', violations) ??
        positiveInt(env.REME_RECALL_LIMIT, 'REME_RECALL_LIMIT', violations) ??
        DEFAULT_RECALL_LIMIT;
    const recallMaxChars = positiveInt(config.recallMaxChars, 'recallMaxChars', violations) ?? DEFAULT_RECALL_MAX_CHARS;
    const recallMinScore = nonNegativeNumber(config.recallMinScore, 'recallMinScore', violations) ?? DEFAULT_RECALL_MIN_SCORE;
    const recallTimeoutMs = positiveInt(config.recallTimeoutMs, 'recallTimeoutMs', violations) ??
        positiveInt(env.REME_RECALL_TIMEOUT_MS, 'REME_RECALL_TIMEOUT_MS', violations) ??
        DEFAULT_RECALL_TIMEOUT_MS;
    const recallMinQueryChars = positiveInt(config.recallMinQueryChars, 'recallMinQueryChars', violations) ??
        DEFAULT_RECALL_MIN_QUERY_CHARS;
    const recallSkipPatterns = patternList(config.recallSkipPatterns, 'recallSkipPatterns', violations, DEFAULT_RECALL_SKIP_PATTERNS);
    const debugStatusTool = booleanValue(config.debugStatusTool, 'debugStatusTool', violations) ??
        booleanValue(env.REME_DEBUG_STATUS_TOOL, 'REME_DEBUG_STATUS_TOOL', violations) ??
        DEFAULT_DEBUG_STATUS_TOOL;
    const autoExtract = booleanValue(config.autoExtract, 'autoExtract', violations) ??
        booleanValue(env.REME_AUTO_EXTRACT, 'REME_AUTO_EXTRACT', violations) ??
        DEFAULT_AUTO_EXTRACT;
    const extractEveryTurns = positiveInt(config.extractEveryTurns, 'extractEveryTurns', violations) ??
        positiveInt(env.REME_EXTRACT_EVERY_TURNS, 'REME_EXTRACT_EVERY_TURNS', violations) ??
        DEFAULT_EXTRACT_EVERY_TURNS;
    const extractMinChars = positiveInt(config.extractMinChars, 'extractMinChars', violations) ?? DEFAULT_EXTRACT_MIN_CHARS;
    const extractConfidence = nonNegativeNumber(config.extractConfidence, 'extractConfidence', violations) ??
        DEFAULT_EXTRACT_CONFIDENCE;
    const extractMaxWrites = positiveInt(config.extractMaxWrites, 'extractMaxWrites', violations) ?? DEFAULT_EXTRACT_MAX_WRITES;
    const dedupeThreshold = nonNegativeNumber(config.dedupeThreshold, 'dedupeThreshold', violations) ?? DEFAULT_DEDUPE_THRESHOLD;
    const dedupeCircuitThreshold = positiveInt(config.dedupeCircuitThreshold, 'dedupeCircuitThreshold', violations) ??
        DEFAULT_DEDUPE_CIRCUIT_THRESHOLD;
    const dedupeCircuitCooldownMs = positiveInt(config.dedupeCircuitCooldownMs, 'dedupeCircuitCooldownMs', violations) ??
        DEFAULT_DEDUPE_CIRCUIT_COOLDOWN_MS;
    const writeRateLimitPerHour = positiveInt(config.writeRateLimitPerHour, 'writeRateLimitPerHour', violations) ??
        DEFAULT_WRITE_RATE_LIMIT_PER_HOUR;
    const extractTimeoutMs = positiveInt(config.extractTimeoutMs, 'extractTimeoutMs', violations) ?? DEFAULT_EXTRACT_TIMEOUT_MS;
    const extractMaxTokens = positiveInt(config.extractMaxTokens, 'extractMaxTokens', violations) ?? DEFAULT_EXTRACT_MAX_TOKENS;
    const extractBadRetryMax = positiveInt(config.extractBadRetryMax, 'extractBadRetryMax', violations) ?? DEFAULT_EXTRACT_BAD_RETRY_MAX;
    const extractModel = optionalText(config.extractModel ?? env.REME_EXTRACT_MODEL);
    const extractPrompt = optionalText(config.extractPrompt);
    if (extractConfidence > 1)
        violations.push('extractConfidence must be at most 1');
    if (dedupeThreshold > 1)
        violations.push('dedupeThreshold must be at most 1');
    if (defaultLimit > MAX_SEARCH_LIMIT) {
        violations.push(`defaultLimit must be at most ${MAX_SEARCH_LIMIT}`);
    }
    if (recallLimit > MAX_SEARCH_LIMIT) {
        violations.push(`recallLimit must be at most ${MAX_SEARCH_LIMIT}`);
    }
    if (recallMinScore > 1) {
        violations.push('recallMinScore must be at most 1');
    }
    if (violations.length > 0)
        throw new ConfigError(violations);
    return {
        baseUrl,
        searchPath,
        writePath,
        reindexPath,
        nodeSearchPath,
        reindexScope,
        requestTimeoutMs,
        defaultLimit: Math.min(defaultLimit, MAX_SEARCH_LIMIT),
        maxChunkChars,
        writeChunkChars,
        reindexAfterWrite,
        defaultDigestDir,
        toolPrefix,
        autoRecall,
        recallLimit: Math.min(recallLimit, MAX_SEARCH_LIMIT),
        recallMaxChars,
        recallMinScore,
        recallTimeoutMs,
        recallMinQueryChars,
        recallSkipPatterns,
        debugStatusTool,
        autoExtract,
        extractEveryTurns,
        extractMinChars,
        extractConfidence,
        extractMaxWrites,
        dedupeThreshold,
        dedupeCircuitThreshold,
        dedupeCircuitCooldownMs,
        writeRateLimitPerHour,
        extractModel,
        extractPrompt,
        extractTimeoutMs,
        extractMaxTokens,
        extractBadRetryMax,
    };
}
//# sourceMappingURL=config.js.map