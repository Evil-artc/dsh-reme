/**
 * dsh-reme — ReMe long-term memory tools for DeepSeek Harness.
 *
 * Contributes two model-facing tools against a ReMe HTTP deployment:
 *
 * - `reme_search`  — `POST /search`, hybrid vector + BM25 recall over the ReMe
 *   workspace (the `digest` Markdown store plus other notes).
 * - `reme_write`   — `POST /write`, storing a durable Markdown note under the
 *   digest directory, optionally reindexing it so a later search finds it.
 *
 * …and, when `autoRecall` is on, the automatic recall layer
 * ({@link registerAutoRecall}): every prompt assembly for a live agent searches
 * ReMe with that agent's latest real user message and injects the matching
 * passages as quoted, untrusted context — so memory arrives without the model
 * having to decide to look for it.
 *
 * Design constraints this entry point honours:
 *
 * - **No runtime dependencies.** Tool definitions are plain objects compiled
 *   by the local `defineTool` (see `./harness.ts`), so nothing has to resolve a
 *   harness-internal specifier or install a package at boot.
 * - **No startup blocking.** {@link apply} is synchronous: it registers the
 *   tools and the listeners and returns. The health probe is deliberately
 *   fire-and-forget, and the recall layer's first network call happens on the
 *   first assembled prompt, so an unreachable ReMe delays a tool call or one
 *   prompt — never the harness boot.
 * - **No `settingsScope`.** Configuration comes from the Cordis patch row and
 *   environment fallbacks only.
 *
 * @module dsh-reme
 */

import { registerAutoRecall } from './auto.js'
import { ReMeClient } from './client.js'
import { resolveConfig, type Config } from './config.js'
import { registerAutoExtract } from './extract.js'
import type { HarnessContext } from './harness.js'
import { createMemoryStatusTool } from './status.js'
import { createTools } from './tools.js'

export const name = 'dsh-reme'

/**
 * Cordis waits for these services before applying this plugin.
 *
 * `systemPrompt` is injected even though the plugin only *listens* to
 * `system-prompt/assemble` rather than calling the service: declaring it keeps
 * the dependency visible and guarantees the assembly pipeline this layer hooks
 * into is present.
 */
export const inject = ['tools', 'systemPrompt']

/** How long the opportunistic mount-time health probe may take. */
const HEALTH_PROBE_MS = 3_000

export { ConfigError, normalizeBaseUrl, resolveConfig } from './config.js'
export {
  hasSecretShape,
  recallSkipReason,
  registerAutoRecall,
  renderRecall,
  searchWithBudget,
  textOfMessage,
  userTextFromEvent,
} from './auto.js'
export { ReMeApiError, ReMeClient } from './client.js'
export {
  candidateHasSecret,
  entryFromEvent,
  EXTRACT_KINDS,
  EXTRACT_SYSTEM_PROMPT,
  extractionTrigger,
  maxCandidateSimilarity,
  parseCandidates,
  registerAutoExtract,
  renderTranscript,
  textSimilarity,
} from './extract.js'
export { createMemoryStatusTool } from './status.js'
export { clip, createTools, dateStamp, resolveWritePath, slugify, splitContent } from './tools.js'
export { defineTool, parameterSchemaSpecToJsonSchema, ToolArgsError, validateArgs } from './harness.js'
export type {
  AgentCreatedPayload,
  AgentDisposedPayload,
  AgentLike,
  AssembleContextLike,
  AutoRecallHandle,
  PromptAssemblyLike,
  RecallStats,
  RecallStatusSnapshot,
  SessionEventLike,
} from './auto.js'
export type { Config, ResolvedConfig } from './config.js'
export type {
  AutoExtractHandle,
  ExtractCandidate,
  ExtractKind,
  ExtractStats,
  ExtractStatusSnapshot,
} from './extract.js'
export type { MemoryStatusSnapshot } from './status.js'
export type { ReMeSearchHit, ReMeSearchResult, ReMeWriteResult } from './client.js'
export type {
  EventListener,
  EventRegistrar,
  HarnessContext,
  ScopedContextLike,
  ToolDefinition,
  ToolRegistry,
} from './harness.js'

/**
 * Register the ReMe tools and the automatic recall layer. Each registration is
 * an effect, so unloading or reconfiguring the plugin withdraws both without a
 * restart.
 *
 * @param ctx - the Cordis context, with `ctx.tools` injected.
 * @param config - the plugin's `config` row; validated here so a typo fails the load.
 */
export function apply(ctx: HarnessContext, config?: Config): void {
  const resolved = resolveConfig(config)
  const client = new ReMeClient(resolved)
  const registered: string[] = []

  for (const definition of createTools(client, resolved)) {
    ctx.tools.register(definition)
    registered.push(definition.name)
  }

  // The automatic layer registers listeners only; it never performs I/O here,
  // so an unreachable ReMe cannot delay the mount.
  const recall = registerAutoRecall(ctx, client, resolved)
  const extract = registerAutoExtract(ctx, client, resolved, recall)

  if (resolved.debugStatusTool && (recall !== undefined || extract !== undefined)) {
    const status = createMemoryStatusTool(resolved, () => ({
      ...(recall !== undefined ? { recall: recall.snapshot() } : {}),
      ...(extract !== undefined ? { extract: extract.snapshot() } : {}),
    }))
    ctx.tools.register(status)
    registered.push(status.name)
  }

  ctx.logger?.info(`dsh-reme: registered ${registered.join(', ')} against ${resolved.baseUrl}`)

  // Fire-and-forget: report reachability in the log without ever delaying the
  // mount, and without turning an unavailable ReMe into a boot failure.
  void client
    .health(AbortSignal.timeout(HEALTH_PROBE_MS))
    .then((health) => {
      if (health === undefined) {
        ctx.logger?.warn(
          `dsh-reme: ReMe at ${resolved.baseUrl} did not answer its health probe; `
          + 'tool calls will fail until it is reachable',
        )
      } else {
        ctx.logger?.info(`dsh-reme: ReMe reachable (${health})`)
      }
    })
    .catch(() => {
      // health() already swallows transport errors; this guards the callback chain.
    })
}
