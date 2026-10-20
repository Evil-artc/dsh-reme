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
/** A failure the model should see as a normal tool error, not a crash. */
export class ReMeApiError extends Error {
    name = 'ReMeApiError';
    /** HTTP status, or `undefined` when the request never completed. */
    status;
    /** ReMe's own `detail`/`answer` text, when it sent one. */
    detail;
    constructor(message, status, detail) {
        super(message);
        this.status = status;
        this.detail = detail;
    }
}
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}
function asString(value) {
    return typeof value === 'string' ? value : '';
}
function asNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function numericRecord(value) {
    const source = asRecord(value);
    const out = {};
    for (const [key, entry] of Object.entries(source)) {
        const parsed = asNumber(entry);
        if (parsed !== undefined)
            out[key] = parsed;
    }
    return out;
}
function stringList(value) {
    return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}
function linkExpansion(value) {
    const source = asRecord(value);
    const out = {};
    for (const [key, entry] of Object.entries(source)) {
        const links = asRecord(entry);
        out[key] = { outlinks: stringList(links.outlinks), inlinks: stringList(links.inlinks) };
    }
    return out;
}
/** Collect a human-readable reason from any response body ReMe may return. */
function describeBody(status, text) {
    const trimmed = text.trim();
    if (trimmed === '')
        return `ReMe returned HTTP ${status}`;
    try {
        const parsed = JSON.parse(trimmed);
        const record = asRecord(parsed);
        const detail = record.detail;
        if (typeof detail === 'string')
            return `ReMe returned HTTP ${status}: ${detail}`;
        if (Array.isArray(detail)) {
            const messages = detail
                .map((entry) => {
                const item = asRecord(entry);
                const loc = stringList(item.loc).join('.');
                const msg = asString(item.msg);
                return msg === '' ? undefined : `${loc === '' ? 'body' : loc}: ${msg}`;
            })
                .filter((entry) => entry !== undefined);
            if (messages.length > 0)
                return `ReMe rejected the request (HTTP ${status}): ${messages.join('; ')}`;
        }
        const answer = record.answer;
        if (typeof answer === 'string' && answer.trim() !== '')
            return `ReMe returned HTTP ${status}: ${answer.trim()}`;
        return `ReMe returned HTTP ${status}: ${trimmed.slice(0, 400)}`;
    }
    catch {
        return `ReMe returned HTTP ${status}: ${trimmed.slice(0, 400)}`;
    }
}
/**
 * Combine the caller's cancellation with a request deadline.
 *
 * Built from `AbortController` directly rather than `AbortSignal.any`, so the
 * transport does not depend on a newer DOM lib than the harness targets.
 *
 * The caller signal can outlive one request (an agent's signal lives for the
 * session), so every listener and timer added here is removed by
 * {@link Deadline.dispose} when the request settles — success included.
 */
function deadline(caller, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort(new Error(`ReMe request exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    // Node returns a Timeout handle here; browsers return a number. Only Node's
    // form can be unref'd, and only Node's needs to be.
    const handle = timer;
    handle.unref?.();
    const forward = () => controller.abort(caller.reason);
    let settled = false;
    const dispose = () => {
        if (settled)
            return;
        settled = true;
        clearTimeout(timer);
        caller.removeEventListener('abort', forward);
    };
    if (caller.aborted)
        forward();
    else
        caller.addEventListener('abort', forward, { once: true });
    // A timeout or a caller abort settles the request too.
    controller.signal.addEventListener('abort', dispose, { once: true });
    return { signal: controller.signal, dispose };
}
/**
 * Join an origin and a route, avoiding a doubled slash.
 * @param baseUrl - normalized origin, possibly with a sub-path.
 * @param path - route beginning with `/`.
 */
function joinUrl(baseUrl, path) {
    const base = baseUrl.replace(/\/+$/, '');
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}
/**
 * Candidate routes for one logical endpoint. A deployment may serve the bare
 * route (`/search`) or an `/api`-prefixed one (`/api/search`); the requested
 * order follows the configured path, so a deliberate override always wins.
 */
function routeCandidates(configured) {
    const normalized = configured.startsWith('/') ? configured : `/${configured}`;
    if (normalized.startsWith('/api/')) {
        const bare = normalized.slice('/api'.length);
        return [normalized, bare];
    }
    return [normalized, `/api${normalized}`];
}
/**
 * The ReMe transport. One instance per configured deployment; the resolved
 * route for each endpoint is remembered after the first successful call, so a
 * fallback costs at most one extra request per process.
 */
export class ReMeClient {
    #config;
    #routes = new Map();
    constructor(config) {
        this.#config = config;
    }
    /** The origin this client talks to. */
    get baseUrl() {
        return this.#config.baseUrl;
    }
    /** The route most recently proven to work, or the configured one. */
    routeFor(endpoint, configured) {
        return this.#routes.get(endpoint) ?? configured;
    }
    /**
     * POST one endpoint, falling back to the alternative `/api` route when the
     * server answers `404` (a missing route) rather than a validation error.
     * @param endpoint - cache key for the resolved route.
     * @param configured - configured route path.
     * @param payload - JSON request body.
     * @param signal - caller cancellation.
     * @returns the parsed response envelope.
     */
    async post(endpoint, configured, payload, signal) {
        const cached = this.#routes.get(endpoint);
        const candidates = cached === undefined ? routeCandidates(configured) : [cached];
        let lastError;
        for (const route of candidates) {
            const url = joinUrl(this.#config.baseUrl, route);
            const budget = deadline(signal, this.#config.requestTimeoutMs);
            try {
                let response;
                try {
                    response = await fetch(url, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json', accept: 'application/json' },
                        body: JSON.stringify(payload),
                        signal: budget.signal,
                    });
                }
                catch (error) {
                    if (signal.aborted)
                        throw error;
                    const cause = error.cause;
                    const code = cause?.code;
                    const hint = code === 'ECONNREFUSED'
                        ? ` - is ReMe running at ${this.#config.baseUrl}?`
                        : code === undefined
                            ? ''
                            : ` (${code})`;
                    throw new ReMeApiError(`POST ${url} failed: ${error.message}${hint}`, undefined, code);
                }
                if (response.ok) {
                    this.#routes.set(endpoint, route);
                    const text = await response.text();
                    if (text.trim() === '')
                        return {};
                    try {
                        return asRecord(JSON.parse(text));
                    }
                    catch {
                        throw new ReMeApiError(`POST ${url} returned HTTP 200 with a non-JSON body: ${text.slice(0, 200)}`, response.status);
                    }
                }
                const body = await response.text();
                lastError = new ReMeApiError(describeBody(response.status, body), response.status, body.slice(0, 800));
                // Only a missing route is worth retrying; any other status is the answer.
                if (response.status !== 404)
                    break;
            }
            finally {
                // Detach from the caller signal and clear the deadline timer even when
                // the request succeeded; a session signal outlives many requests.
                budget.dispose();
            }
        }
        throw lastError ?? new ReMeApiError(`POST ${this.#config.baseUrl} failed with no response`);
    }
    /**
     * Hybrid workspace search (vector + BM25, RRF-fused).
     * @param query - natural-language query.
     * @param options - result count, score floor, inclusive date bounds.
     * @param signal - caller cancellation.
     */
    async search(query, options, signal) {
        const payload = { query, limit: options.limit };
        if (options.minScore !== undefined)
            payload.min_score = options.minScore;
        if (options.startDate !== undefined)
            payload.start_date = options.startDate;
        if (options.endDate !== undefined)
            payload.end_date = options.endDate;
        const envelope = await this.post('search', this.#config.searchPath, payload, signal);
        if (envelope.success === false) {
            throw new ReMeApiError(`ReMe refused the search: ${asString(envelope.answer) || 'no reason given'}`, undefined);
        }
        const metadata = asRecord(envelope.metadata);
        const rawHits = Array.isArray(metadata.results) ? metadata.results : [];
        const hits = rawHits.map((entry) => {
            const hit = asRecord(entry);
            const scores = asRecord(hit.scores);
            return {
                id: asString(hit.id),
                path: asString(hit.path),
                start_line: asNumber(hit.start_line) ?? 0,
                end_line: asNumber(hit.end_line) ?? 0,
                score: asNumber(scores.score) ?? 0,
                keyword_score: asNumber(scores.keyword),
                vector_score: asNumber(scores.vector),
                text: asString(hit.text),
            };
        });
        const rawCounts = asRecord(metadata.counts);
        return {
            query,
            answer: asString(envelope.answer),
            hits,
            counts: numericRecord(rawCounts),
            hybrid: rawCounts.hybrid === true,
            linkExpansion: linkExpansion(metadata.link_expansion),
        };
    }
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
    async nodeSearch(query, signal) {
        // ReMe answers `success: false` ("query cannot be empty") for a blank
        // query, so an empty candidate is answered locally instead of over HTTP.
        if (query.trim() === '')
            return { query, hits: [] };
        const envelope = await this.post('node_search', this.#config.nodeSearchPath, { query }, signal);
        if (envelope.success === false) {
            throw new ReMeApiError(`ReMe refused the node search: ${asString(envelope.answer) || 'no reason given'}`, undefined);
        }
        const metadata = asRecord(envelope.metadata);
        const rawHits = Array.isArray(metadata.hits) ? metadata.hits : [];
        const hits = rawHits.map((entry) => {
            const hit = asRecord(entry);
            return {
                path: asString(hit.path),
                name: asString(hit.name),
                description: asString(hit.description),
                score: asNumber(hit.score) ?? 0,
            };
        });
        return { query, hits };
    }
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
    async write(file, signal) {
        const payload = {
            path: file.path,
            name: file.name,
            description: file.description,
            content: file.content,
        };
        if (file.metadata !== undefined && Object.keys(file.metadata).length > 0) {
            payload.metadata = file.metadata;
        }
        const envelope = await this.post('write', this.#config.writePath, payload, signal);
        if (envelope.success === false) {
            throw new ReMeApiError(`ReMe refused the write: ${asString(envelope.answer) || 'no reason given'}`, undefined);
        }
        return {
            path: file.path,
            message: asString(envelope.answer),
            reindexed: false,
            reindexMessage: undefined,
        };
    }
    /**
     * Rebuild one of ReMe's search indexes from the files already on disk, so a
     * note written now becomes retrievable through {@link search}. The scope
     * (`bm25` by default, see `reindexScope`) is sent explicitly so a broken tag
     * index on the ReMe side cannot make an otherwise-good rebuild report failure.
     * @param signal - caller cancellation.
     * @returns ReMe's summary, plus the indexed count and scope when ReMe reports them.
     * @throws ReMeApiError when ReMe answers `success: false` (e.g. a tag reindex failure).
     */
    async reindex(signal) {
        const envelope = await this.post('reindex', this.#config.reindexPath, { scope: this.#config.reindexScope }, signal);
        if (envelope.success === false) {
            throw new ReMeApiError(`ReMe refused the reindex: ${asString(envelope.answer) || 'no reason given'}`, undefined);
        }
        const answer = envelope.answer;
        if (typeof answer === 'string') {
            return { message: answer === '' ? 'reindex completed' : answer, indexed: undefined, scope: undefined };
        }
        const record = asRecord(answer);
        const indexed = asNumber(record.indexed);
        const scope = asString(record.scope);
        return {
            message: indexed === undefined
                ? 'reindex completed'
                : `reindex completed (${indexed} indexed${scope === '' ? '' : `, scope ${scope}`})`,
            indexed,
            scope: scope === '' ? undefined : scope,
        };
    }
    /**
     * A cheap liveness probe used by the mount log, never on the tool path.
     * @param signal - caller cancellation.
     * @returns the component summary, or `undefined` when ReMe is unreachable.
     */
    async health(signal) {
        try {
            const envelope = await this.post('health', '/health_check', {}, signal);
            return asString(envelope.answer) || 'ok';
        }
        catch {
            return undefined;
        }
    }
}
//# sourceMappingURL=client.js.map