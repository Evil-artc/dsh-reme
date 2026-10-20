/**
 * Automatic recall: put related long-term memory in front of the model without
 * the model having to ask for it.
 *
 * ## Why the prompt-assembly waterfall
 *
 * `systemPrompt.context()` takes a **synchronous** `text` provider, so it cannot
 * await a search. The naive fix — prefetch on `agent/pre-step` and read the
 * result from a cache — fails twice over: the loop assembles the prompt *before*
 * it runs `agent/pre-step` (see `@deepseek-ai/dsh-agent-loop`, "the driver
 * assembles the prompt and tools, projects runtime context, and runs
 * `agent/pre-step`"), and a synchronous provider cannot identify which turn is
 * being assembled anyway.
 *
 * `system-prompt/assemble` is an **async** waterfall, so the search happens
 * inside it: no cache, no ordering dependency, no stale injection. The listener
 * appends an `AssembledContext` and returns the rewritten assembly.
 *
 * ## Why the listener is registered per agent
 *
 * `system-prompt/assemble` is dispatched scope-filtered with the assembling
 * agent as the scope key (`assembleContextFor(agent)` returns
 * `{ agent, scope: agent }`). Registering through the agent's own scoped
 * context therefore admits the listener for that agent alone.
 *
 * Agent scopes are minted with `createScope(loopCtx, this)` and carry **no**
 * parent binding — `bindScopeParent` is never called by the loop — so the
 * ancestor-reaches-descendant rule has nothing to traverse and sibling agents
 * (including subagents) can never cross-talk.
 *
 * ## Cost control
 *
 * The search sits on the prompt path, so it carries a hard timeout and degrades
 * to "no recall" silently. One turn assembles its prompt once per step, so a
 * memo keyed by query keeps a ten-step turn from issuing ten searches.
 *
 * @module dsh-reme/auto
 */
import type { ReMeClient, ReMeSearchResult } from './client.js';
import type { ResolvedConfig } from './config.js';
import { type HarnessContext, type ScopedContextLike } from './harness.js';
/** `agent/created` payload (serial event; there is no `next`). */
export interface AgentCreatedPayload {
    agent?: AgentLike;
    source?: unknown;
    signal?: AbortSignal;
}
/** `agent/disposed` payload. */
export interface AgentDisposedPayload {
    agent?: AgentLike;
}
/**
 * `agent/inbox/claimed` payload.
 *
 * This is the correct query source. The loop claims input and *then* assembles:
 *
 * ```js
 * const claimed = this.inbox.claim(target, position.turn)   // emits this event
 * const assembly = await this.loopCtx.systemPrompt.assemble(...)
 * ```
 *
 * `session/event` cannot serve this purpose: the accepted user batch is appended
 * to the durable log during reconciliation, which happens *after* `pre-step` —
 * a full step too late for the assembly that needs it.
 */
export interface InboxClaimedPayload {
    agent?: AgentLike;
    message?: unknown;
    turn?: number;
}
/**
 * The concrete agent exposes its scoped context as `agent.ctx`; the public
 * `Agent` interface declares only `id`, so both are optional here and the code
 * degrades to a global listener when the scoped context is unavailable.
 */
export interface AgentLike {
    readonly id: string;
    readonly ctx?: ScopedContextLike;
}
/** The slice of `SessionEvent` this module reads. */
export interface SessionEventLike {
    readonly type?: string;
    readonly data?: unknown;
}
/** `AssembleContext`, as the loop builds it (`{ agent, scope, signal? }`). */
export interface AssembleContextLike {
    readonly agent?: unknown;
    readonly scope?: unknown;
    readonly signal?: AbortSignal;
}
interface AssembledContextLike {
    readonly name: string;
    readonly text: string;
}
/** `PromptAssembly`, narrowed to the field this module rewrites. */
export interface PromptAssemblyLike {
    readonly contexts?: readonly AssembledContextLike[];
    readonly [key: string]: unknown;
}
/** Per-agent counters, surfaced by the diagnostic tool and the debug log. */
export interface RecallStats {
    assemblies: number;
    injected: number;
    memoHits: number;
    searches: number;
    failures: number;
    timeouts: number;
    skipped: Record<string, number>;
    lastLatencyMs: number;
    lastInjectedChars: number;
    lastQuery?: string;
    lastSkipReason?: string;
    /** Head of the last user text this agent contributed, for diagnosing an absent query. */
    lastUserTextPreview?: string;
}
/**
 * Process-wide counters.
 *
 * These survive per-agent teardown, which is what makes them useful: a
 * one-shot subagent is disposed before anyone can inspect it, so "did the
 * transcript feed ever see a user message at all" has to be answerable
 * globally.
 */
export interface RecallCounters {
    /** Every `session/event` the feed delivered (phase 2's transcript source). */
    sessionEvents: number;
    /** Those whose type was `user/message`. */
    userMessageEvents: number;
    /** `agent/inbox/claimed` announcements — the input the loop is about to assemble for. */
    inboxClaimed: number;
    /** Claimed inputs that yielded usable text — the query the recall layer would use. */
    userTexts: number;
    /** `agent/created` announcements received. */
    agentCreatedEvents: number;
    /** Agents found already live by the load-time sweep. */
    agentsSwept: number;
    /** Recall searches actually issued. */
    searches: number;
    /** Assemblies that received recalled context. */
    injected: number;
    /** Why recall was skipped, across every agent that has ever existed. */
    skippedByReason: Record<string, number>;
    /**
     * Head of the last claimed query text, process-wide.
     *
     * A one-shot agent is disposed before its per-agent numbers can be read, so
     * without this a wrong or truncated claimed message is undiagnosable.
     */
    lastQueryPreview?: string;
    /** Length of that text, which is what the length floor actually sees. */
    lastQueryChars?: number;
}
/** The thresholds actually in force, surfaced so a patch override is visible. */
export interface RecallRules {
    minQueryChars: number;
    limit: number;
    minScore: number;
    maxChars: number;
    timeoutMs: number;
}
/** A JSON-safe status snapshot for the diagnostic tool. */
export interface RecallStatusSnapshot {
    trackedAgents: number;
    autoRecall: boolean;
    timeoutMs: number;
    /**
     * The effective rule values.
     *
     * Reported because a key in the bundle patch overrides the code default: a
     * stale `recallMinQueryChars` in `cordis.patch.yml` once made an edited
     * default silently ineffective.
     */
    rules: RecallRules;
    counters: RecallCounters;
    agents: Array<{
        agentId: string;
    } & RecallStats>;
}
/** Handle returned by {@link registerAutoRecall}. */
export interface AutoRecallHandle {
    /** Every disposer registered by the recall layer; idempotent. */
    dispose(): void;
    /** Current counters, for diagnostics and tests. */
    snapshot(): RecallStatusSnapshot;
    /** Drop memoized recalls so the next assembly searches again after a write. */
    invalidateMemos(): void;
}
/**
 * Extract the text of a real user message.
 *
 * Runtime context is projected into model history as **user-role** snapshots
 * carrying a different `source.kind`. Those must never become a recall query:
 * the recalled text this module injects is itself one of them, so accepting
 * them would feed the injection back into its own next search.
 */
export declare function textOfMessage(message: unknown): string | undefined;
/** Read the user text out of one committed session event, if it carries any. */
export declare function userTextFromEvent(event: SessionEventLike | undefined): string | undefined;
/**
 * Why an input must not be searched for.
 *
 * Patterns are tested before the length floor so an acknowledgement is
 * reported as `small-talk` rather than the less informative `too-short`; the
 * decision is the same either way, but the counter is what a reader sees when
 * asking why recall did not fire.
 *
 * @returns a stable reason key, or `undefined` when the input is worth a search.
 */
export declare function recallSkipReason(query: string, config: ResolvedConfig): string | undefined;
/** Whether any unambiguous credential shape appears in `value`. */
export declare function hasSecretShape(value: string): boolean;
/**
 * Render search hits as the injected, explicitly-quoted block.
 * @returns the block, or `undefined` when nothing survived filtering.
 */
export declare function renderRecall(result: ReMeSearchResult, config: ResolvedConfig): string | undefined;
interface SearchOutcome {
    recall?: string;
    timedOut: boolean;
    error?: string;
    latencyMs: number;
}
/**
 * Search within a hard latency budget.
 *
 * The budget signal is kept aside so a timeout is distinguishable from a
 * transport failure; both degrade to "no recall", but only one is worth a
 * counter bump.
 */
export declare function searchWithBudget(client: ReMeClient, config: ResolvedConfig, query: string, signals: readonly (AbortSignal | undefined)[]): Promise<SearchOutcome>;
/**
 * Register the automatic recall layer.
 *
 * Registration is synchronous, so `apply()` stays non-blocking; the first
 * network call happens on the first assembled prompt.
 *
 * @param ctx - the plugin's Cordis context.
 * @param client - the ReMe transport.
 * @param config - resolved plugin configuration.
 * @returns a handle, or `undefined` when automatic recall is disabled.
 */
export declare function registerAutoRecall(ctx: HarnessContext, client: ReMeClient, config: ResolvedConfig): AutoRecallHandle | undefined;
export {};
