/**
 * The read-only diagnostic tool for the automatic memory layer.
 *
 * It lives in its own module because it is the one place that knows about both
 * halves — recall and extraction — while neither half needs to know about the
 * other. Keeping it here also keeps `index.ts` a wiring file rather than a
 * rendering one.
 *
 * @module dsh-reme/status
 */
import { defineTool } from './harness.js';
function recallSection(recall) {
    const { counters } = recall;
    const lines = [
        `recall: timeout=${recall.timeoutMs}ms agents=${recall.trackedAgents}`,
        `  rules: minQueryChars=${recall.rules.minQueryChars} limit=${recall.rules.limit}`
            + ` minScore=${recall.rules.minScore} maxChars=${recall.rules.maxChars}`,
        `  feed: sessionEvents=${counters.sessionEvents} userMessages=${counters.userMessageEvents}`
            + ` | inboxClaimed=${counters.inboxClaimed} userTexts=${counters.userTexts}`
            + ` | agent/created=${counters.agentCreatedEvents} agentsSwept=${counters.agentsSwept}`,
        // Process-wide, so a one-shot subagent stays observable after disposal.
        `  all-time: searches=${counters.searches} injected=${counters.injected}`
            + ` skipped=${JSON.stringify(counters.skippedByReason)}`,
        `  lastQuery: ${counters.lastQueryChars ?? '-'}ch ${JSON.stringify(counters.lastQueryPreview ?? null)}`,
    ];
    for (const agent of recall.agents) {
        lines.push(`  - ${agent.agentId}: assemblies=${agent.assemblies} injected=${agent.injected}`
            + ` memoHits=${agent.memoHits} searches=${agent.searches} failures=${agent.failures}`
            + ` timeouts=${agent.timeouts} lastLatency=${agent.lastLatencyMs}ms`
            + ` lastInjectedChars=${agent.lastInjectedChars}`, `    skipped=${JSON.stringify(agent.skipped)} lastSkip=${agent.lastSkipReason ?? '-'}`, `    lastUserText=${JSON.stringify(agent.lastUserTextPreview ?? null)}`);
    }
    return lines.join('\n');
}
function extractSection(extract) {
    const lines = [
        `extract: sessions=${extract.trackedSessions} model=${extract.modelRoute ?? 'unresolved'}`
            + ` llm=${extract.llmAvailable ? 'ok' : 'missing'} maxTokens=${extract.maxTokens}`
            + ` dedupeCircuit=${extract.circuitOpen ? 'OPEN' : 'closed'}`,
    ];
    for (const session of extract.sessions) {
        lines.push(`  - ${session.sessionId}: runs=${session.extractions} candidates=${session.candidates}`
            + ` written=${session.written} pending=${session.pendingEntries}/${session.pendingChars}ch`
            + ` trigger=${session.lastTrigger ?? '-'}`, `    skipped: lowConfidence=${session.skippedLowConfidence} duplicate=${session.skippedDuplicate}`
            + ` secret=${session.skippedSecret} rateLimit=${session.skippedRateLimit}`, `    failures: llm=${session.llmFailures} parse=${session.parseFailures}`
            + ` dedupe=${session.dedupeFailures} write=${session.writeFailures}`
            + ` abandoned=${session.abandonedBuffers} circuitOpen=${session.circuitOpen}`
            + ` truncated=${session.truncatedReplies}`, `    lastWritten=${session.lastWrittenPath ?? '-'} lastError=${session.lastError ?? '-'}`, `    lastReply=${session.lastReplyChars ?? '-'}ch ${JSON.stringify(session.lastReplyPreview ?? null)}`);
    }
    return lines.join('\n');
}
/**
 * Build the diagnostic tool.
 * @param config - resolved plugin configuration.
 * @param snapshot - reads both halves at call time.
 */
export function createMemoryStatusTool(config, snapshot) {
    return defineTool({
        name: `${config.toolPrefix}_memory_status`,
        description: 'Read-only diagnostic snapshot of the automatic ReMe memory layer. '
            + 'Reports the recall half (prompt assemblies, injections, memo reuse, per-agent skip reasons) '
            + 'and the extraction half (runs, candidates, written notes, dedup/secret/rate-limit skips, '
            + 'failure counters, dedup circuit state). Use it when memory is not being recalled or not being '
            + 'written automatically.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    recall: { type: 'json' },
                    extract: { type: 'json' },
                },
            },
            render: (_args, raw) => {
                const value = raw;
                const blocks = [];
                if (value.recall !== undefined)
                    blocks.push(recallSection(value.recall));
                if (value.extract !== undefined)
                    blocks.push(extractSection(value.extract));
                const text = blocks.length === 0
                    ? 'The automatic memory layer is disabled (autoRecall and autoExtract are both off).'
                    : blocks.join('\n\n');
                return [{ type: 'text', text }];
            },
        },
        isConcurrencySafe: () => true,
        timeoutMs: config.requestTimeoutMs,
        execute: () => snapshot(),
    });
}
//# sourceMappingURL=status.js.map