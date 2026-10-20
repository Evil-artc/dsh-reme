/**
 * Automatic extraction: turn a conversation into durable long-term memory.
 *
 * The recall layer (`./auto.ts`) only reads memory; this layer is the writer.
 * It buffers a session's transcript, and at a natural boundary asks the session's
 * own model to distil durable facts out of it, deduplicates them against what
 * ReMe already holds, and writes what survives.
 *
 * ## Why the boundaries are where they are
 *
 * - **Buffer from `session/event`.** Unlike the recall query, the transcript has
 *   no ordering deadline: the durable feed is exactly the right source, and it
 *   is the only place assistant output is observable at all.
 * - **Trigger from `agent/turn-stopping`, never block on it.** The event is
 *   serial and the loop awaits it, so a synchronous LLM call there would add its
 *   latency to the end of every turn. It starts work and returns.
 * - **Flush once from `agent/disposed`, on a separate budget.** The agent's own
 *   abort signal cannot gate the final flush — it is already aborting.
 *
 * ## What keeps the memory store usable
 *
 * Extraction is the only path that can *pollute* long-term memory, so every
 * step is biased towards writing less:
 *
 * - a strict system prompt that names the five admissible kinds and the
 *   exclusions explicitly, and states that `[]` is a normal answer;
 * - a `confidence` floor;
 * - a local similarity check against `/node_search` candidates before writing,
 *   because ReMe's own score was measured to be non-discriminative;
 * - a circuit breaker so a broken dedup lookup stops writes instead of
 *   silently degrading into duplicate writes;
 * - a per-session hourly write cap;
 * - a code-level credential filter, applied to both the model's output and any
 *   text that reaches a note.
 *
 * @module dsh-reme/extract
 */
import type { ReMeClient } from './client.js';
import { type ResolvedConfig } from './config.js';
import { type AutoRecallHandle } from './auto.js';
import type { HarnessContext } from './harness.js';
/** Admission kinds the extractor accepts; anything else is discarded. */
export declare const EXTRACT_KINDS: readonly ["preference", "decision", "fact", "convention", "environment"];
export type ExtractKind = (typeof EXTRACT_KINDS)[number];
/** One candidate note proposed by the model. */
export interface ExtractCandidate {
    name: string;
    description: string;
    content: string;
    tags: string[];
    kind: ExtractKind;
    confidence: number;
}
/** Per-session extraction counters. */
export interface ExtractStats {
    extractions: number;
    candidates: number;
    written: number;
    skippedLowConfidence: number;
    skippedDuplicate: number;
    skippedSecret: number;
    skippedRateLimit: number;
    skippedInvalid: number;
    parseFailures: number;
    llmFailures: number;
    dedupeFailures: number;
    writeFailures: number;
    abandonedBuffers: number;
    circuitOpen: number;
    /** Replies the model ended on `max-tokens`; salvage may still have parsed them. */
    truncatedReplies: number;
    pendingChars: number;
    pendingEntries: number;
    lastTrigger?: string;
    lastError?: string;
    lastWrittenPath?: string;
    /** Characters of text the last model call produced, whatever it said. */
    lastReplyChars?: number;
    /** Head of the last raw model reply — the only way to see a parse failure. */
    lastReplyPreview?: string;
}
/** The extraction section of the diagnostic snapshot. */
export interface ExtractStatusSnapshot {
    trackedSessions: number;
    autoExtract: boolean;
    /** Whether the model route needed for extraction is resolvable right now. */
    modelRoute: string | null;
    /** Whether `ctx.get('llm')` resolves; a missing service disables every write. */
    llmAvailable: boolean;
    /** Output token budget in force, so a patch override is visible. */
    maxTokens: number;
    circuitOpen: boolean;
    sessions: Array<{
        sessionId: string;
    } & ExtractStats>;
}
/** Handle returned by {@link registerAutoExtract}. */
export interface AutoExtractHandle {
    dispose(): void;
    snapshot(): ExtractStatusSnapshot;
    /**
     * Resolve once no extraction run is in flight.
     *
     * Runs are started fire-and-forget from serial/emit listeners, so this is the
     * only way to observe their completion — used by tests and by an orderly
     * shutdown that wants the last write to land.
     */
    whenIdle(): Promise<void>;
}
interface SessionEventLike {
    readonly type?: string;
    readonly data?: unknown;
}
interface TranscriptEntry {
    id: string;
    role: 'user' | 'assistant';
    text: string;
}
/** The extraction system prompt; overridable through `extractPrompt`. */
export declare const EXTRACT_SYSTEM_PROMPT: string;
/**
 * Read one transcript entry out of a committed session event.
 *
 * Only genuine turns qualify. Runtime context is projected into model history as
 * **user-role** snapshots carrying a different `source.kind`; feeding those to
 * the extractor would let injected memory be re-extracted as if the user had
 * said it.
 */
export declare function entryFromEvent(event: SessionEventLike | undefined): TranscriptEntry | undefined;
/** Render the pending transcript the way the extractor sees it. */
export declare function renderTranscript(entries: readonly TranscriptEntry[]): string;
/**
 * Decide whether a completed turn should trigger extraction.
 *
 * @returns the trigger name, or `undefined` to keep buffering.
 */
export declare function extractionTrigger(input: {
    pendingChars: number;
    pendingEntries: number;
    userTurns: number;
    idleMs: number;
}, config: ResolvedConfig): string | undefined;
/**
 * Character-bigram Jaccard similarity, script-agnostic.
 *
 * Whitespace tokenisation is useless for Chinese, so this compares the set of
 * adjacent character pairs after stripping case and punctuation. Identical
 * strings score 1; unrelated strings score near 0.
 */
export declare function textSimilarity(a: string, b: string): number;
/** The highest local similarity between a candidate and existing nodes. */
export declare function maxCandidateSimilarity(candidate: Pick<ExtractCandidate, 'name' | 'description'>, hits: readonly {
    name: string;
    description: string;
}[]): number;
/**
 * Parse the model's reply into valid candidates.
 *
 * Tolerant on framing (fences, prose around the array) and on truncation: a
 * reply cut off by the token budget still yields every complete leading object.
 * Strict on shape otherwise — a reply that cannot be read as an array at all is
 * a *failure* (worth retrying), while an array whose entries are all unusable is
 * a *success* with nothing to write.
 *
 * @returns the accepted candidates, or `undefined` when the reply was unreadable.
 */
export declare function parseCandidates(raw: string): ExtractCandidate[] | undefined;
/** Whether any part of a candidate carries a credential shape. */
export declare function candidateHasSecret(candidate: ExtractCandidate): boolean;
/**
 * Register the automatic extraction layer.
 *
 * @param ctx - the plugin's Cordis context.
 * @param client - the ReMe transport.
 * @param config - resolved plugin configuration.
 * @param recall - the recall handle, so a write can invalidate its per-turn memo.
 * @returns a handle, or `undefined` when automatic extraction is disabled.
 */
export declare function registerAutoExtract(ctx: HarnessContext, client: ReMeClient, config: ResolvedConfig, recall?: AutoRecallHandle): AutoExtractHandle | undefined;
export {};
