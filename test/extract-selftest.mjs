// Self-test for the automatic extraction layer, run against the built `dist/`.
//
// The Cordis seams and both external dependencies (the ReMe transport and the
// LLM) are faked, so every branch that decides whether memory gets written —
// confidence, dedup, credentials, circuit breaker, rate limit, bad-material
// abandonment — is exercised deterministically.
//
//   node test/extract-selftest.mjs

import assert from 'node:assert/strict'
import { resolveConfig } from '../dist/config.js'
import {
  candidateHasSecret,
  entryFromEvent,
  extractionTrigger,
  maxCandidateSimilarity,
  parseCandidates,
  registerAutoExtract,
  renderTranscript,
  textSimilarity,
} from '../dist/extract.js'

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

// --------------------------------------------------------------- fake harness

function createBus() {
  const listeners = new Map()
  return {
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
    },
    count(event) {
      return (listeners.get(event) ?? []).length
    },
    async fire(event, ...args) {
      for (const listener of [...(listeners.get(event) ?? [])]) await listener(...args)
    },
  }
}

function createCtx(options = {}) {
  const bus = createBus()
  const registered = []
  return {
    registered,
    on: bus.on,
    fire: bus.fire,
    count: bus.count,
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    get(service) {
      if (service === 'llm') return options.llm
      if (service === 'agentDefaultModel') {
        return { currentSelection: () => options.selection ?? { provider: 'p', model: 'm' } }
      }
      return undefined
    },
  }
}

/** An LLM whose stream yields `responder(options)` as one text delta. */
function createLlm(responder) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      const answer = responder(options)
      return (async function* generate() {
        if (answer === null) {
          yield { type: 'finish', reason: { kind: 'error' } }
          return
        }
        if (answer instanceof Error) throw answer
        yield { type: 'text-delta', index: 0, text: answer }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

function createClient(options = {}) {
  const calls = { nodeSearch: [], write: [], reindex: 0 }
  return {
    calls,
    async nodeSearch(query) {
      calls.nodeSearch.push(query)
      if (options.nodeSearchThrows === true) throw new Error('dedup endpoint down')
      return { query, hits: options.hits ?? [] }
    },
    async write(file) {
      calls.write.push(file)
      return { path: file.path, message: 'ok', reindexed: true, reindexMessage: undefined }
    },
    async reindex() {
      calls.reindex += 1
      const indexed = options.reindexSequence ?? [1]
      return { message: 'reindexed', indexed: indexed[Math.min(calls.reindex - 1, indexed.length - 1)], scope: 'bm25' }
    },
  }
}

const CANDIDATE = {
  name: 'Memory插件偏好',
  description: '用户偏好使用 pnpm 而不是 npm',
  content: '用户偏好在该仓库使用 pnpm，而不是 npm。',
  tags: ['pnpm', '偏好'],
  kind: 'preference',
  confidence: 0.9,
}

const BASE = {
  extractEveryTurns: 2,
  // Deliberately small so a single short exchange triggers by size; the
  // turn-count path is covered by its own test with a large floor.
  extractMinChars: 5,
  extractConfidence: 0.6,
  extractMaxWrites: 3,
  dedupeThreshold: 0.6,
  dedupeCircuitThreshold: 2,
  dedupeCircuitCooldownMs: 60_000,
  writeRateLimitPerHour: 30,
  extractBadRetryMax: 2,
  extractTimeoutMs: 2_000,
}

function userMessage(text, kind = 'user') {
  return { id: `u:${text}`, role: 'user', source: { kind }, content: [{ type: 'text', text }] }
}

function assistantMessage(text) {
  return { id: `a:${text}`, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] }
}

/** Buffer one user+assistant exchange and close the turn. */
async function exchange(ctx, sessionId, user, assistant = '收到。') {
  await ctx.fire('session/event', { id: sessionId }, { type: 'user/message', data: userMessage(user) })
  await ctx.fire('session/event', { id: sessionId }, { type: 'assistant/message', data: { message: assistantMessage(assistant) } })
  await ctx.fire('agent/turn-stopping', { agent: { id: sessionId }, turn: 1 })
}

// ------------------------------------------------------------- pure functions

console.log('\nentryFromEvent')
await test('reads a real user message', () => {
  const entry = entryFromEvent({ type: 'user/message', data: userMessage('记住这个偏好') })
  assert.equal(entry?.role, 'user')
  assert.equal(entry?.text, '记住这个偏好')
})

await test('reads an assistant message from its wrapper', () => {
  const entry = entryFromEvent({ type: 'assistant/message', data: { message: assistantMessage('好的') } })
  assert.equal(entry?.role, 'assistant')
  assert.equal(entry?.text, '好的')
})

await test('ignores runtime-context snapshots', () => {
  assert.equal(entryFromEvent({ type: 'user/message', data: userMessage('注入的召回片段', 'system-prompt') }), undefined)
})

await test('ignores non-message roles and events', () => {
  assert.equal(entryFromEvent({ type: 'tool/result', data: { message: { role: 'tool', content: [] } } }), undefined)
  assert.equal(entryFromEvent({ type: 'step/start', data: { turn: 1, step: 1 } }), undefined)
  assert.equal(entryFromEvent(undefined), undefined)
})

console.log('\nrenderTranscript')
await test('renders both roles with tags', () => {
  const text = renderTranscript([
    { id: '1', role: 'user', text: '问题' },
    { id: '2', role: 'assistant', text: '回答' },
  ])
  assert.equal(text, '[user] 问题\n\n[assistant] 回答')
})

console.log('\nextractionTrigger')
const config = resolveConfig(BASE)

await test('stays silent with nothing buffered', () => {
  assert.equal(extractionTrigger({ pendingChars: 10, pendingEntries: 0, userTurns: 9, idleMs: 1e9 }, config), undefined)
})

await test('triggers on turn count', () => {
  assert.equal(extractionTrigger({ pendingChars: 10, pendingEntries: 1, userTurns: 2, idleMs: 0 }, config), 'turns')
})

await test('triggers on buffered size', () => {
  assert.equal(extractionTrigger({ pendingChars: 500, pendingEntries: 1, userTurns: 1, idleMs: 0 }, config), 'chars')
})

await test('triggers on idle', () => {
  // Below the size floor, so only idleness can fire.
  assert.equal(extractionTrigger({ pendingChars: 2, pendingEntries: 1, userTurns: 1, idleMs: 120_000 }, config), 'idle')
})

await test('keeps buffering otherwise', () => {
  assert.equal(extractionTrigger({ pendingChars: 2, pendingEntries: 1, userTurns: 1, idleMs: 1_000 }, config), undefined)
})

console.log('\ntextSimilarity')
await test('identical strings score 1', () => {
  assert.equal(textSimilarity('Memory插件偏好', 'Memory插件偏好'), 1)
})

await test('ignores case, punctuation and spacing', () => {
  assert.equal(textSimilarity('Use PNPM!', 'use pnpm'), 1)
})

await test('near-duplicate CJK titles score high', () => {
  const score = textSimilarity('dsh-reme 插件：安装与配置', 'dsh-reme 插件安装')
  assert.ok(score >= 0.6, `expected >= 0.6, got ${score}`)
})

await test('unrelated strings score low', () => {
  const score = textSimilarity('用户偏好 pnpm', '季度营收预测模型')
  assert.ok(score < 0.2, `expected < 0.2, got ${score}`)
})

await test('empty input scores 0', () => {
  assert.equal(textSimilarity('', 'anything'), 0)
})

await test('maxCandidateSimilarity takes the best of name and description', () => {
  const score = maxCandidateSimilarity(
    { name: '完全无关的标题', description: '用户偏好使用 pnpm 而不是 npm' },
    [{ name: 'something else', description: '用户偏好使用 pnpm 而不是 npm' }],
  )
  assert.equal(score, 1)
})

console.log('\nparseCandidates')
await test('parses a plain array', () => {
  const parsed = parseCandidates(JSON.stringify([CANDIDATE]))
  assert.equal(parsed?.length, 1)
  assert.equal(parsed?.[0].kind, 'preference')
})

await test('parses through a markdown fence and prose', () => {
  const raw = `好的，这是结果：\n\`\`\`json\n${JSON.stringify([CANDIDATE])}\n\`\`\`\n希望有帮助。`
  assert.equal(parseCandidates(raw)?.length, 1)
})

await test('treats an empty array as a valid answer', () => {
  assert.deepEqual(parseCandidates('[]'), [])
})

await test('recovers complete objects from a reply cut off mid-array', () => {
  // No closing brace or bracket: the reply was cut off by the token budget.
  const truncated = `[${JSON.stringify(CANDIDATE)}, {"name": "第二`
  const parsed = parseCandidates(truncated)
  assert.equal(parsed?.length, 1)
  assert.equal(parsed?.[0].name, CANDIDATE.name)
})

await test('recovers nothing when no object is complete', () => {
  assert.equal(parseCandidates('[{"name": "只有一半'), undefined)
})

await test('returns undefined when nothing is parseable', () => {
  assert.equal(parseCandidates('我无法完成这个请求。'), undefined)
  assert.equal(parseCandidates(''), undefined)
  assert.equal(parseCandidates('{"name":"not an array"}'), undefined)
})

await test('drops entries with an unknown kind or a missing field', () => {
  const raw = JSON.stringify([
    CANDIDATE,
    { ...CANDIDATE, kind: 'gossip' },
    { ...CANDIDATE, name: '' },
    { ...CANDIDATE, content: '   ' },
  ])
  assert.equal(parseCandidates(raw)?.length, 1)
})

await test('clamps confidence and defaults the description', () => {
  const raw = JSON.stringify([{ ...CANDIDATE, confidence: 7, description: '  ' }])
  const [entry] = parseCandidates(raw) ?? []
  assert.equal(entry.confidence, 1)
  assert.equal(entry.description, CANDIDATE.name)
})

await test('filters non-string tags', () => {
  const raw = JSON.stringify([{ ...CANDIDATE, tags: ['ok', 42, '', 'fine'] }])
  assert.deepEqual(parseCandidates(raw)?.[0].tags, ['ok', 'fine'])
})

console.log('\ncandidateHasSecret')
await test('flags credential-shaped content', () => {
  assert.equal(candidateHasSecret({ ...CANDIDATE, content: 'token: sk-abcdefghijklmnopqrstuvwx' }), true)
  assert.equal(candidateHasSecret(CANDIDATE), false)
})

// ------------------------------------------------------------------- wiring

console.log('\nregisterAutoExtract')

await test('writes an extracted candidate and reindexes', async () => {
  const client = createClient()
  const ctx = createCtx({ llm: createLlm(() => JSON.stringify([CANDIDATE])) })
  const handle = registerAutoExtract(ctx, client, config)

  await exchange(ctx, 's1', '请记住：这个仓库用 pnpm')
  await handle.whenIdle()

  assert.equal(client.calls.write.length, 1)
  assert.equal(client.calls.write[0].metadata.memory_kind, 'preference')
  assert.deepEqual(client.calls.write[0].metadata.memory_tags, CANDIDATE.tags)
  assert.equal(client.calls.reindex, 1)
  const [session] = handle.snapshot().sessions
  assert.equal(session.written, 1)
  assert.equal(session.candidates, 1)
  assert.equal(session.lastTrigger, 'chars')
})

await test('paces extraction by turn count when the buffer stays small', async () => {
  const client = createClient()
  const paced = resolveConfig({ ...BASE, extractMinChars: 10_000, extractEveryTurns: 2 })
  const ctx = createCtx({ llm: createLlm(() => JSON.stringify([CANDIDATE])) })
  const handle = registerAutoExtract(ctx, client, paced)

  await exchange(ctx, 'p1', '第一轮')
  await handle.whenIdle()
  assert.equal(client.calls.write.length, 0, 'one turn is not enough')

  await exchange(ctx, 'p1', '第二轮')
  await handle.whenIdle()
  assert.equal(client.calls.write.length, 1)
  assert.equal(handle.snapshot().sessions[0].lastTrigger, 'turns')
})

await test('does not write below the confidence floor', async () => {
  const client = createClient()
  const low = { ...CANDIDATE, confidence: 0.2 }
  const ctx = createCtx({ llm: createLlm(() => JSON.stringify([low])) })
  const handle = registerAutoExtract(ctx, client, config)

  await exchange(ctx, 's2', '也许吧，随便')
  await handle.whenIdle()

  assert.equal(client.calls.write.length, 0)
  assert.equal(handle.snapshot().sessions[0].skippedLowConfidence, 1)
})

await test('does not write a duplicate that ReMe already knows', async () => {
  const client = createClient({ hits: [{ path: 'digest/x.md', name: 'Memory插件偏好', description: '用户偏好使用 pnpm 而不是 npm' }] })
  const ctx = createCtx({ llm: createLlm(() => JSON.stringify([CANDIDATE])) })
  const handle = registerAutoExtract(ctx, client, config)

  await exchange(ctx, 's3', '请记住：这个仓库用 pnpm')
  await handle.whenIdle()

  assert.equal(client.calls.write.length, 0)
  assert.equal(handle.snapshot().sessions[0].skippedDuplicate, 1)
})

await test('writes when the existing nodes are unrelated', async () => {
  const client = createClient({ hits: [{ path: 'digest/y.md', name: '季度营收预测', description: '完全不同的主题' }] })
  const ctx = createCtx({ llm: createLlm(() => JSON.stringify([CANDIDATE])) })
  const handle = registerAutoExtract(ctx, client, config)

  await exchange(ctx, 's4', '请记住：这个仓库用 pnpm')
  await handle.whenIdle()

  assert.equal(client.calls.write.length, 1)
})

await test('drops a candidate carrying a credential', async () => {
  const client = createClient()
  const leaky = { ...CANDIDATE, content: 'API key is sk-abcdefghijklmnopqrstuvwx' }
  const ctx = createCtx({ llm: createLlm(() => JSON.stringify([leaky])) })
  const handle = registerAutoExtract(ctx, client, config)

  await exchange(ctx, 's5', '这是我的密钥')
  await handle.whenIdle()

  assert.equal(client.calls.write.length, 0)
  assert.equal(handle.snapshot().sessions[0].skippedSecret, 1)
})

await test('fails closed when dedup is unavailable, then trips the circuit', async () => {
  const client = createClient({ nodeSearchThrows: true })
  const ctx = createCtx({ llm: createLlm(() => JSON.stringify([CANDIDATE])) })
  const handle = registerAutoExtract(ctx, client, config)

  await exchange(ctx, 's6', '请记住：第一条')
  await handle.whenIdle()
  assert.equal(client.calls.write.length, 0, 'without a dedup answer, writing risks a duplicate')
  assert.equal(handle.snapshot().circuitOpen, false, 'one failure is not yet a pattern')

  await exchange(ctx, 's6', '请记住：第二条')
  await handle.whenIdle()
  assert.equal(handle.snapshot().circuitOpen, true)
  assert.equal(handle.snapshot().sessions[0].dedupeFailures, 2)
})

await test('never blocks the turn: turn-stopping returns without awaiting the model', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const client = createClient()
  const llm = createLlm(() => JSON.stringify([CANDIDATE]))
  const slow = {
    calls: llm.calls,
    stream(options) {
      const inner = llm.stream(options)
      return (async function* delayed() {
        await gate
        yield* inner
      })()
    },
  }
  const ctx = createCtx({ llm: slow })
  const handle = registerAutoExtract(ctx, client, config)

  await ctx.fire('session/event', { id: 's7' }, { type: 'user/message', data: userMessage('请记住：慢一点') })
  await ctx.fire('session/event', { id: 's7' }, { type: 'assistant/message', data: { message: assistantMessage('好') } })
  // This must resolve while the model call is still pending.
  await ctx.fire('agent/turn-stopping', { agent: { id: 's7' }, turn: 1 })
  assert.equal(client.calls.write.length, 0)

  release()
  await handle.whenIdle()
  assert.equal(client.calls.write.length, 1)
})

await test('abandons a buffer that keeps failing to parse', async () => {
  const client = createClient()
  const ctx = createCtx({ llm: createLlm(() => 'not json at all') })
  const handle = registerAutoExtract(ctx, client, config)

  await exchange(ctx, 's8', '第一轮内容')
  await handle.whenIdle()
  assert.equal(handle.snapshot().sessions[0].parseFailures, 1)
  assert.equal(handle.snapshot().sessions[0].pendingEntries, 2)

  await exchange(ctx, 's8', '第二轮内容')
  await handle.whenIdle()
  const [session] = handle.snapshot().sessions
  assert.equal(session.abandonedBuffers, 1)
  assert.equal(session.pendingEntries, 0, 'the buffer is dropped, not retried forever')
})

await test('records the raw reply so a parse failure is diagnosable', async () => {
  const client = createClient()
  const ctx = createCtx({ llm: createLlm(() => '抱歉，这个我无法完成。') })
  const handle = registerAutoExtract(ctx, client, config)

  await exchange(ctx, 's18', '第一轮内容')
  await handle.whenIdle()

  const [session] = handle.snapshot().sessions
  assert.equal(session.parseFailures, 1)
  assert.equal(session.lastReplyChars, '抱歉，这个我无法完成。'.length)
  assert.match(session.lastReplyPreview, /抱歉/)
})

await test('counts an LLM transport failure as retryable, not parsed', async () => {
  const client = createClient()
  const ctx = createCtx({ llm: createLlm(() => null) })
  const handle = registerAutoExtract(ctx, client, config)

  await exchange(ctx, 's9', '第一轮内容')
  await handle.whenIdle()

  const [session] = handle.snapshot().sessions
  assert.equal(session.llmFailures, 1)
  assert.equal(session.parseFailures, 0)
})

await test('does nothing without a resolvable model route', async () => {
  const client = createClient()
  const ctx = createCtx({ llm: createLlm(() => JSON.stringify([CANDIDATE])), selection: {} })
  const handle = registerAutoExtract(ctx, client, config)

  await exchange(ctx, 's10', '请记住：这个仓库用 pnpm')
  await handle.whenIdle()

  assert.equal(client.calls.write.length, 0)
  assert.equal(handle.snapshot().sessions[0].llmFailures, 1)
  assert.equal(handle.snapshot().modelRoute, null)
})

await test('respects the per-session hourly write cap', async () => {
  const client = createClient()
  const capped = resolveConfig({ ...BASE, writeRateLimitPerHour: 1 })
  const ctx = createCtx({ llm: createLlm(() => JSON.stringify([CANDIDATE])) })
  const handle = registerAutoExtract(ctx, client, capped)

  // Same session: the cap is per session, so the second turn must not write.
  await exchange(ctx, 's11', '请记住：第一条偏好')
  await handle.whenIdle()
  await exchange(ctx, 's11', '请记住：第二条偏好')
  await handle.whenIdle()

  assert.equal(client.calls.write.length, 1)
  assert.equal(handle.snapshot().sessions[0].skippedRateLimit, 1)
})

await test('never distils a transcript with no user contribution', async () => {
  const client = createClient()
  const ctx = createCtx({ llm: createLlm(() => JSON.stringify([CANDIDATE])) })
  const handle = registerAutoExtract(ctx, client, config)

  // Assistant output alone can accumulate after a reload; it must not become a
  // memory the user never asserted.
  await ctx.fire('session/event', { id: 's17' }, { type: 'assistant/message', data: { message: assistantMessage('我建议把构建脚本改成 tsx，并且我会记住这一点。') } })
  await ctx.fire('agent/turn-stopping', { agent: { id: 's17' }, turn: 1 })
  await handle.whenIdle()

  assert.equal(client.calls.write.length, 0)
  assert.equal(client.calls.nodeSearch.length, 0)

  // Once the user says something, the same buffer becomes extractable.
  await ctx.fire('session/event', { id: 's17' }, { type: 'user/message', data: userMessage('这条才是我说的') })
  await ctx.fire('agent/turn-stopping', { agent: { id: 's17' }, turn: 2 })
  await handle.whenIdle()
  assert.equal(client.calls.write.length, 1)
})

await test('caps how many notes one run may write', async () => {
  const many = [
    CANDIDATE,
    { ...CANDIDATE, name: '偏好二', description: '第二条偏好', content: '第二条偏好内容。' },
    { ...CANDIDATE, name: '偏好三', description: '第三条偏好', content: '第三条偏好内容。' },
    { ...CANDIDATE, name: '偏好四', description: '第四条偏好', content: '第四条偏好内容。' },
  ]
  const client = createClient()
  const capped = resolveConfig({ ...BASE, extractMaxWrites: 2 })
  const ctx = createCtx({ llm: createLlm(() => JSON.stringify(many)) })
  const handle = registerAutoExtract(ctx, client, capped)

  await exchange(ctx, 's13', '请记住这四条偏好')
  await handle.whenIdle()

  assert.equal(client.calls.write.length, 2)
})

await test('retries reindex while ReMe reports zero indexed', async () => {
  const client = createClient({ reindexSequence: [0, 0, 1] })
  const ctx = createCtx({ llm: createLlm(() => JSON.stringify([CANDIDATE])) })
  const handle = registerAutoExtract(ctx, client, config)

  await exchange(ctx, 's14', '请记住：这个仓库用 pnpm')
  await handle.whenIdle()

  assert.equal(client.calls.reindex, 3, 'two backoff retries after the first zero')
})

await test('invalidates memoized recalls after a successful write', async () => {
  let invalidations = 0
  const recall = { dispose: () => {}, snapshot: () => ({}), invalidateMemos: () => { invalidations += 1 } }
  const client = createClient()
  const ctx = createCtx({ llm: createLlm(() => JSON.stringify([CANDIDATE])) })
  const handle = registerAutoExtract(ctx, client, config, recall)

  await exchange(ctx, 's15', '请记住：这个仓库用 pnpm')
  await handle.whenIdle()

  assert.equal(invalidations, 1)
})

await test('does nothing when autoExtract is off', () => {
  const off = resolveConfig({ autoExtract: false })
  const ctx = createCtx({ llm: createLlm(() => '[]') })
  const handle = registerAutoExtract(ctx, createClient(), off)
  assert.equal(handle, undefined)
  assert.equal(ctx.count('session/event'), 0)
})

await test('withdraws every listener on dispose', async () => {
  const ctx = createCtx({ llm: createLlm(() => '[]') })
  const handle = registerAutoExtract(ctx, createClient(), config)
  assert.equal(ctx.count('session/event'), 1)
  assert.equal(ctx.count('agent/turn-stopping'), 1)
  assert.equal(ctx.count('agent/disposed'), 1)

  handle.dispose()
  assert.equal(ctx.count('session/event'), 0)
  assert.equal(ctx.count('agent/turn-stopping'), 0)
  assert.equal(ctx.count('agent/disposed'), 0)
})

await test('flushes on dispose of an agent', async () => {
  const client = createClient()
  const ctx = createCtx({ llm: createLlm(() => JSON.stringify([CANDIDATE])) })
  const handle = registerAutoExtract(ctx, client, config)

  // Buffer without reaching a trigger, then dispose the agent.
  await ctx.fire('session/event', { id: 's16' }, { type: 'user/message', data: userMessage('一个还没到触发点的短句') })
  await ctx.fire('agent/disposed', { agent: { id: 's16' } })
  await handle.whenIdle()

  assert.equal(client.calls.write.length, 1)
  assert.equal(handle.snapshot().trackedSessions, 0)
})

// ---------------------------------------------------------------------- report

console.log(`\n${passed} passed, ${failures.length} failed`)
for (const { name, error } of failures) console.log(`\nFAILED: ${name}\n${error.stack}`)
process.exit(failures.length === 0 ? 0 : 1)
