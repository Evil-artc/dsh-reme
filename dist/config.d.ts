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
export declare const DEFAULT_BASE_URL = "http://127.0.0.1:2333";
/** Endpoint path for hybrid workspace search. */
export declare const DEFAULT_SEARCH_PATH = "/search";
/** Endpoint path for writing a workspace Markdown file. */
export declare const DEFAULT_WRITE_PATH = "/write";
/** Endpoint path that rebuilds the file store so a fresh write becomes searchable. */
export declare const DEFAULT_REINDEX_PATH = "/reindex";
/** Endpoint path that recalls existing digest nodes similar to a candidate (dedup). */
export declare const DEFAULT_NODE_SEARCH_PATH = "/node_search";
/**
 * Index scope passed to `/reindex` after a write. Defaults to `bm25`: that is
 * the index `reme_search` actually queries, and rebuilding `all` trips on ReMe's
 * tag index when it is unavailable (see `reindexScope` docs).
 */
export declare const DEFAULT_REINDEX_SCOPE = "bm25";
/** Per-request timeout; also the default tool body timeout. */
export declare const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
/** Default number of search hits. */
export declare const DEFAULT_SEARCH_LIMIT = 8;
/** Hard cap on search hits per call. */
export declare const MAX_SEARCH_LIMIT = 50;
/** Characters of chunk text retained per search hit. */
export declare const DEFAULT_MAX_CHUNK_CHARS = 1200;
/** Character budget for one `reme_write` part when content is split. */
export declare const DEFAULT_WRITE_CHUNK_CHARS = 6000;
/** Passages injected into one model request by the automatic recall layer. */
export declare const DEFAULT_RECALL_LIMIT = 4;
/** Total characters of recalled text injected into one model request. */
export declare const DEFAULT_RECALL_MAX_CHARS = 1500;
/** Recalled passages scoring below this are dropped before injection. */
export declare const DEFAULT_RECALL_MIN_SCORE = 0.3;
/**
 * Hard ceiling on the recall search. The search sits on the prompt-assembly
 * path, so this is the maximum latency automatic recall may ever add; on
 * timeout the request proceeds without recall.
 */
export declare const DEFAULT_RECALL_TIMEOUT_MS = 400;
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
export declare const DEFAULT_RECALL_MIN_QUERY_CHARS = 4;
/**
 * Inputs matching any of these (case-insensitive, anchored) never trigger a
 * recall search: acknowledgements and continuations carry no retrievable
 * intent, so searching them only costs latency.
 */
export declare const DEFAULT_RECALL_SKIP_PATTERNS: readonly string[];
/** Whether the read-only `reme_memory_status` diagnostic tool is registered. */
export declare const DEFAULT_DEBUG_STATUS_TOOL = false;
/** Turn durable conversation into long-term memory without being asked. */
export declare const DEFAULT_AUTO_EXTRACT = true;
/** User turns between automatic extractions. */
export declare const DEFAULT_EXTRACT_EVERY_TURNS = 4;
/** Buffered characters that force an extraction early. */
export declare const DEFAULT_EXTRACT_MIN_CHARS = 800;
/** Minimum `confidence` an extracted candidate must report to be written. */
export declare const DEFAULT_EXTRACT_CONFIDENCE = 0.6;
/** Maximum notes one extraction may write. */
export declare const DEFAULT_EXTRACT_MAX_WRITES = 3;
/**
 * Local similarity (character-bigram Jaccard over name + description) above
 * which a candidate counts as already remembered.
 *
 * This is a *local* measure on purpose: `/node_search` was measured to return
 * one constant score for every lexical hit, so its number cannot be
 * thresholded. See `ReMeNodeHit`.
 */
export declare const DEFAULT_DEDUPE_THRESHOLD = 0.6;
/** Consecutive dedup-lookup failures that trip the circuit breaker. */
export declare const DEFAULT_DEDUPE_CIRCUIT_THRESHOLD = 3;
/** How long a tripped dedup circuit stays open. */
export declare const DEFAULT_DEDUPE_CIRCUIT_COOLDOWN_MS = 60000;
/** Maximum notes one session may write per hour. */
export declare const DEFAULT_WRITE_RATE_LIMIT_PER_HOUR = 30;
/** Consecutive extraction failures after which one buffer is abandoned. */
export declare const DEFAULT_EXTRACT_BAD_RETRY_MAX = 2;
/** Hard ceiling on one extraction model call. */
export declare const DEFAULT_EXTRACT_TIMEOUT_MS = 20000;
/**
 * Output token budget for one extraction call.
 *
 * Deliberately generous: the extraction model reasons before answering, and a
 * reasoning trace shares this budget with the JSON it finally emits. A budget
 * sized only for the JSON truncates the array mid-object, which then reads as a
 * parse failure.
 */
export declare const DEFAULT_EXTRACT_MAX_TOKENS = 4000;
/** Buffered transcript entries kept per session. */
export declare const TRANSCRIPT_MAX_ENTRIES = 40;
/** Buffered transcript characters kept per session. */
export declare const TRANSCRIPT_MAX_CHARS = 12000;
/** Characters of one transcript entry considered for extraction. */
export declare const TRANSCRIPT_ENTRY_MAX_CHARS = 2000;
/** User-supplied configuration, as written in a Cordis patch row. */
export interface Config {
    /** ReMe origin, e.g. `http://127.0.0.1:2333`. `/api` suffixes are folded in. */
    baseUrl?: string;
    /** Search endpoint path. Defaults to `/search`. */
    searchPath?: string;
    /** Write endpoint path. Defaults to `/write`. */
    writePath?: string;
    /** Reindex endpoint path, used after a write. Defaults to `/reindex`. */
    reindexPath?: string;
    /** Node-recall endpoint path used for dedup. Defaults to `/node_search`. */
    nodeSearchPath?: string;
    /**
     * Which ReMe index `/reindex` rebuilds after a write: `all`, `bm25`,
     * `embedding`, or `tag`. Defaults to `bm25`, the index `reme_search` reads.
     * Set `all` once ReMe's tag index is healthy, or if you want embedding and
     * tags refreshed too.
     */
    reindexScope?: string;
    /** Request timeout in milliseconds. */
    requestTimeoutMs?: number;
    /** Default result count when the model does not ask for one. */
    defaultLimit?: number;
    /** Characters of chunk text retained per search hit. */
    maxChunkChars?: number;
    /** Character budget for one part when a write is split. */
    writeChunkChars?: number;
    /** Run the reindex endpoint after a successful write so it is searchable. */
    reindexAfterWrite?: boolean;
    /** Write into `digest/` (the long-term memory directory) when no path is given. */
    defaultDigestDir?: string;
    /** Tool-name prefix, so two instances can serve two deployments. */
    toolPrefix?: string;
    /** Inject related memory into each model request without being asked. */
    autoRecall?: boolean;
    /** Passages injected per request. */
    recallLimit?: number;
    /** Total characters of recalled text injected per request. */
    recallMaxChars?: number;
    /** Drop recalled passages scoring below this. */
    recallMinScore?: number;
    /** Hard ceiling, in milliseconds, on one automatic recall search. */
    recallTimeoutMs?: number;
    /** Inputs shorter than this never trigger a recall search. */
    recallMinQueryChars?: number;
    /** Anchored, case-insensitive patterns whose matching inputs never trigger a recall search. */
    recallSkipPatterns?: readonly string[];
    /** Register the read-only `reme_memory_status` diagnostic tool. */
    debugStatusTool?: boolean;
    /** Turn conversation into long-term memory automatically. */
    autoExtract?: boolean;
    /** User turns between automatic extractions. */
    extractEveryTurns?: number;
    /** Buffered characters that force an extraction early. */
    extractMinChars?: number;
    /** Minimum confidence an extracted candidate must report. */
    extractConfidence?: number;
    /** Maximum notes one extraction may write. */
    extractMaxWrites?: number;
    /** Local similarity above which a candidate is treated as already remembered. */
    dedupeThreshold?: number;
    /** Consecutive dedup-lookup failures that trip the circuit breaker. */
    dedupeCircuitThreshold?: number;
    /** How long a tripped dedup circuit stays open, in milliseconds. */
    dedupeCircuitCooldownMs?: number;
    /** Maximum notes one session may write per hour. */
    writeRateLimitPerHour?: number;
    /** Model override for extraction; defaults to the session default model. */
    extractModel?: string;
    /** System-prompt override for extraction (advanced). */
    extractPrompt?: string;
    /** Hard ceiling on one extraction model call, in milliseconds. */
    extractTimeoutMs?: number;
    /** Output token budget for one extraction call. */
    extractMaxTokens?: number;
    /** Consecutive extraction failures after which one buffer is abandoned. */
    extractBadRetryMax?: number;
}
/** Configuration after defaults and validation. */
export interface ResolvedConfig {
    baseUrl: string;
    searchPath: string;
    writePath: string;
    reindexPath: string;
    nodeSearchPath: string;
    reindexScope: string;
    requestTimeoutMs: number;
    defaultLimit: number;
    maxChunkChars: number;
    writeChunkChars: number;
    reindexAfterWrite: boolean;
    defaultDigestDir: string;
    toolPrefix: string;
    autoRecall: boolean;
    recallLimit: number;
    recallMaxChars: number;
    recallMinScore: number;
    recallTimeoutMs: number;
    recallMinQueryChars: number;
    recallSkipPatterns: readonly RegExp[];
    debugStatusTool: boolean;
    autoExtract: boolean;
    extractEveryTurns: number;
    extractMinChars: number;
    extractConfidence: number;
    extractMaxWrites: number;
    dedupeThreshold: number;
    dedupeCircuitThreshold: number;
    dedupeCircuitCooldownMs: number;
    writeRateLimitPerHour: number;
    extractModel: string | undefined;
    extractPrompt: string | undefined;
    extractTimeoutMs: number;
    extractMaxTokens: number;
    extractBadRetryMax: number;
}
/** Thrown when a patch row configures this plugin in a way it cannot serve. */
export declare class ConfigError extends Error {
    readonly name = "ConfigError";
    readonly violations: string[];
    constructor(violations: string[]);
}
/**
 * Normalize a ReMe address to an origin.
 *
 * A trailing `/api`, `/api/`, or `/` is folded into the origin so both the
 * documented `http://127.0.0.1:2333/api` form and the bare origin work, while
 * `searchPath` stays the single place that decides the route.
 */
export declare function normalizeBaseUrl(raw: string): string;
/** Environment overrides, read as plain strings. */
export type EnvLike = Record<string, string | undefined>;
/**
 * Apply defaults and reject an unusable row while the plugin loads, so a typo
 * surfaces at boot rather than inside the first tool call the model makes.
 * @param raw - the `config` value from the Cordis row.
 * @param env - environment overrides; defaults to `process.env`.
 */
export declare function resolveConfig(raw?: Config, env?: EnvLike): ResolvedConfig;
