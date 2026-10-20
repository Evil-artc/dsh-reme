/**
 * ReMe HTTP client.
 *
 * ReMe serves a `POST`-only JSON API whose routes are class methods, so the
 * OpenAPI document carries one generic envelope instead of per-route fields.
 * The request/response shapes encoded here were read from a live ReMe 0.4.1.1
 * instance (`/help`, `/openapi.json`) and verified end to end.
 *
 * @module dsh-reme/client
 */
import type { ResolvedConfig } from './config.js';
/** A failure the model should see as a normal tool error, not a crash. */
export declare class ReMeApiError extends Error {
    readonly name = "ReMeApiError";
    /** HTTP status, or `undefined` when the request never completed. */
    readonly status: number | undefined;
    /** ReMe's own `detail`/`answer` text, when it sent one. */
    readonly detail: string | undefined;
    constructor(message: string, status?: number, detail?: string);
}
/** One hybrid-search hit. */
export interface ReMeSearchHit {
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    score: number;
    keyword_score: number | undefined;
    vector_score: number | undefined;
    text: string;
}
/** The normalized `/search` result. */
export interface ReMeSearchResult {
    query: string;
    answer: string;
    hits: ReMeSearchHit[];
    counts: Record<string, number>;
    /**
     * Whether ReMe fused keyword and vector candidates for this query.
     *
     * ReMe reports this as a boolean (`metadata.counts.hybrid`), so it cannot
     * live in the numeric {@link counts} view. It is the reliable signal that a
     * search degraded to keyword-only: a live ReMe with no embedding model
     * answers `{ vector: 0, keyword: N, hybrid: false }`.
     */
    hybrid: boolean;
    linkExpansion: Record<string, {
        outlinks: string[];
        inlinks: string[];
    }>;
}
/**
 * One candidate node returned by `/node_search`.
 *
 * `score` is carried for diagnostics only. Probed against a live ReMe
 * 0.4.1.13: every lexically matching query — exact node name, a paraphrase, a
 * two-token keyword — returned the *same* score (`0.0049`), and unrelated
 * queries returned no hits at all. The endpoint is a binary gate, so a dedup
 * decision must be made by comparing `name`/`description` locally rather than
 * by thresholding this number.
 */
export interface ReMeNodeHit {
    path: string;
    name: string;
    description: string;
    score: number;
}
/** The normalized `/node_search` result. */
export interface ReMeNodeSearchResult {
    query: string;
    hits: ReMeNodeHit[];
}
/** The normalized `/write` result. */
export interface ReMeWriteResult {
    path: string;
    message: string;
    reindexed: boolean;
    reindexMessage: string | undefined;
}
/** The normalized `/reindex` result. */
export interface ReMeReindexResult {
    /** Human-readable summary of what ReMe rebuilt. */
    message: string;
    /** Number of notes indexed, when ReMe reports one. */
    indexed: number | undefined;
    /** The scope ReMe rebuilt, when it reports one. */
    scope: string | undefined;
}
/** A JSON object, as ReMe's `additionalProperties: true` envelopes allow. */
type JsonRecord = Record<string, unknown>;
/**
 * The ReMe transport. One instance per configured deployment; the resolved
 * route for each endpoint is remembered after the first successful call, so a
 * fallback costs at most one extra request per process.
 */
export declare class ReMeClient {
    #private;
    constructor(config: ResolvedConfig);
    /** The origin this client talks to. */
    get baseUrl(): string;
    /** The route most recently proven to work, or the configured one. */
    routeFor(endpoint: string, configured: string): string;
    /**
     * POST one endpoint, falling back to the alternative `/api` route when the
     * server answers `404` (a missing route) rather than a validation error.
     * @param endpoint - cache key for the resolved route.
     * @param configured - configured route path.
     * @param payload - JSON request body.
     * @param signal - caller cancellation.
     * @returns the parsed response envelope.
     */
    post(endpoint: string, configured: string, payload: JsonRecord, signal: AbortSignal): Promise<JsonRecord>;
    /**
     * Hybrid workspace search (vector + BM25, RRF-fused).
     * @param query - natural-language query.
     * @param options - result count, score floor, inclusive date bounds.
     * @param signal - caller cancellation.
     */
    search(query: string, options: {
        limit: number;
        minScore?: number;
        startDate?: string;
        endDate?: string;
    }, signal: AbortSignal): Promise<ReMeSearchResult>;
    /**
     * Recall existing digest nodes that are lexically close to a candidate
     * abstraction, for deduplication before writing.
     *
     * The route is a binary gate, not a similarity ranking: see
     * {@link ReMeNodeHit} for the measured behaviour. Callers must therefore
     * decide dedup from the returned `name`/`description`, not from `score`.
     *
     * @param query - candidate name (optionally plus description), typically one line.
     * @param signal - caller cancellation.
     */
    nodeSearch(query: string, signal: AbortSignal): Promise<ReMeNodeSearchResult>;
    /**
     * Write a Markdown file (create or overwrite) with name/description
     * frontmatter.
     * @param file - workspace-relative path, e.g. `digest/20261001-note.md`.
     * @param name - frontmatter `name`.
     * @param description - frontmatter `description`.
     * @param content - Markdown body.
     * @param metadata - extra frontmatter keys.
     * @param signal - caller cancellation.
     */
    write(file: {
        path: string;
        name: string;
        description: string;
        content: string;
        metadata?: JsonRecord;
    }, signal: AbortSignal): Promise<ReMeWriteResult>;
    /**
     * Rebuild one of ReMe's search indexes from the files already on disk, so a
     * note written now becomes retrievable through {@link search}. The scope
     * (`bm25` by default, see `reindexScope`) is sent explicitly so a broken tag
     * index on the ReMe side cannot make an otherwise-good rebuild report failure.
     * @param signal - caller cancellation.
     * @returns ReMe's summary, plus the indexed count and scope when ReMe reports them.
     * @throws ReMeApiError when ReMe answers `success: false` (e.g. a tag reindex failure).
     */
    reindex(signal: AbortSignal): Promise<ReMeReindexResult>;
    /**
     * A cheap liveness probe used by the mount log, never on the tool path.
     * @param signal - caller cancellation.
     * @returns the component summary, or `undefined` when ReMe is unreachable.
     */
    health(signal: AbortSignal): Promise<string | undefined>;
}
export {};
