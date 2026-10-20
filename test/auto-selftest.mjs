// Self-test for the automatic recall layer, run against the built `dist/`.
//
// No DSH process is involved: the Cordis seams (event registrar, per-agent
// scoped context, tools registry) are faked and the ReMe transport is a stub,
// so this exercises the real shipped module — listener wiring, query source,
// memoisation, timeout degradation, ownership assertion and teardown —
// deterministically.
//
//   node test/auto-selftest.mjs

import assert from 'node:assert/strict'
import {
  recallSkipReason,
  registerAutoRecall,
  renderRecall,
  textOfMessage,
  userTextFromEvent,
} from '../dist/auto.js'
import { resolveConfig } from '../dist/config.js'

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

/** A minimal Cordis event bus: `on` plus a helper that awaits listeners in order. */
function createBus() {
  const listeners = new Map()
  return {
    listeners,
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
      const results = []
      for (const listener of [...(listeners.get(event) ?? [])]) results.push(await listener(...args))
      return results
    },
  }
}

function createCtx(options = {}) {
  const bus = createBus()
  const registered = []
  const logs = []
  return {
    registered,
    logs,
    on: bus.on,
    fire: bus.fire,
    count: bus.count,
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    logger: {
      info: (...args) => logs.push(['info', args.join(' ')]),
      warn: (...args) => logs.push(['warn', args.join(' ')]),
      debug: (...args) => logs.push(['debug', args.join(' ')]),
    },
    get(service) {
      if (service !== 'agents') return undefined
      return { list: () => options.liveAgents ?? [] }
    },
  }
}

function createAgent(id, withScopedContext = true) {
  const bus = createBus()
  const agent = { id, bus }
  if (withScopedContext) agent.ctx = { on: bus.on, fire: bus.fire, count: bus.count }
  return agent
}

const HITS = {
  query: 'q',
  counts: { hybrid: 2, vector: 0, keyword: 2, returned: 2 },
  linkExpansion: {},
  hits: [
    { path: 'digest/a.md', start_line: 1, end_line: 3, score: 4.2, text: 'alpha memory body' },
    { path: 'digest/b.md', start_line: 5, end_line: 6, score: 3.1, text: 'beta memory body' },
  ],
}

function createClient(behavior) {
  const calls = []
  return {
    calls,
    async search(query, options, signal) {
      calls.push({ query, options })
      return behavior(query, options, signal)
    },
  }
}

const ok = () => structuredClone(HITS)

function userMessage(text, kind = 'user') {
  return { role: 'user', source: { kind }, content: [{ type: 'text', text }] }
}

const QUESTION = '这个插件的安装方式是怎样的'

/**
 * Deliver one user input the way the loop does: `inbox.claim()` emits this
 * immediately before `systemPrompt.assemble()`. That ordering is why the recall
 * layer reads its query here and not from `session/event`, whose accepted-user
 * append lands after `pre-step`.
 */
async function say(ctx, agentOrId, text, kind = 'user') {
  const agent = typeof agentOrId === 'string' ? { id: agentOrId } : agentOrId
  await ctx.fire('agent/inbox/claimed', { agent, message: userMessage(text, kind), turn: 1 })
}

/** Fire the assembly waterfall the way the loop does, and return its result. */
async function assembleOn(agent, assembly = { contexts: [] }) {
  const results = await agent.bus.fire(
    'system-prompt/assemble',
    assembly,
    { scope: agent, agent },
    async () => assembly,
  )
  // A waterfall with no listener left passes the value through unchanged.
  return results.length > 0 ? results.at(-1) : assembly
}

// ---------------------------------------------------------------- pure helpers

console.log('\nrecallSkipReason')
const config = resolveConfig({ debugStatusTool: true, recallTimeoutMs: 60 })

await test('rejects acknowledgements', () => {
  assert.equal(recallSkipReason('好的', config), 'small-talk')
  assert.equal(recallSkipReason('ok', config), 'small-talk')
  assert.equal(recallSkipReason('继续', config), 'small-talk')
})

await test('rejects inputs below the length floor', () => {
  assert.equal(recallSkipReason('abc', config), 'too-short')
})

await test('accepts a short CJK question', () => {
  // The floor is four characters because CJK packs this much meaning into them;
  // a floor of eight silently skipped most real messages.
  assert.equal(recallSkipReason('进行二期', config), undefined)
  assert.equal(recallSkipReason('降到4测试', config), undefined)
  // Acknowledgements stay out through the explicit patterns, not the floor.
  assert.equal(recallSkipReason('好的', config), 'small-talk')
})

await test('rejects punctuation-only input', () => {
  assert.equal(recallSkipReason('.........  ', config), 'no-content')
})

await test('accepts a real question', () => {
  assert.equal(recallSkipReason(QUESTION, config), undefined)
})

console.log('\ntextOfMessage / userTextFromEvent')
await test('reads a real user message', () => {
  assert.equal(textOfMessage(userMessage('remember this')), 'remember this')
})

await test('ignores runtime-context snapshots (feedback-loop guard)', () => {
  assert.equal(textOfMessage(userMessage('injected recall', 'system-prompt')), undefined)
})

await test('ignores non-text blocks', () => {
  assert.equal(textOfMessage({ role: 'user', content: [{ type: 'image', attachment: {} }] }), undefined)
})

await test('reads only user/message events', () => {
  assert.equal(userTextFromEvent({ type: 'user/message', data: userMessage('hello there') }), 'hello there')
  assert.equal(userTextFromEvent({ type: 'assistant/message', data: { message: userMessage('x') } }), undefined)
  assert.equal(userTextFromEvent(undefined), undefined)
})

console.log('\nrenderRecall')
await test('renders hits with the untrusted-data frame', () => {
  const text = renderRecall(ok(), config)
  assert.match(text, /引用数据/)
  assert.match(text, /digest\/a\.md:1-3/)
  assert.match(text, /共 2 条/)
})

await test('dedupes repeated paths', () => {
  const result = structuredClone(HITS)
  result.hits = [result.hits[0], { ...result.hits[0], score: 1 }]
  const text = renderRecall(result, config)
  assert.equal(text.match(/digest\/a\.md/g).length, 1)
})

await test('drops credential-shaped passages', () => {
  const result = structuredClone(HITS)
  result.hits = [{ path: 'digest/x.md', start_line: 1, end_line: 1, score: 1, text: 'key sk-abcdefghijklmnopqrstuvwx' }]
  assert.equal(renderRecall(result, config), undefined)
})

await test('returns undefined without hits', () => {
  assert.equal(renderRecall({ ...structuredClone(HITS), hits: [] }, config), undefined)
})

await test('respects recallMaxChars', () => {
  const tight = resolveConfig({ recallMaxChars: 40 })
  const result = structuredClone(HITS)
  result.hits = [{ path: 'd.md', start_line: 1, end_line: 1, score: 1, text: 'x'.repeat(500) }]
  const text = renderRecall(result, tight)
  assert.ok(text.length < 500, `expected clipped output, got ${text.length} chars`)
})

// ------------------------------------------------------------ the live wiring

console.log('\nregisterAutoRecall')

await test('sweeps agents that already exist when the plugin loads', () => {
  const agent = createAgent('sess-live')
  const ctx = createCtx({ liveAgents: [agent] })
  registerAutoRecall(ctx, createClient(ok), config)
  assert.equal(agent.bus.count('system-prompt/assemble'), 1)
})

await test('registers for agents created later', async () => {
  const ctx = createCtx()
  registerAutoRecall(ctx, createClient(ok), config)
  const agent = createAgent('sess-new')
  await ctx.fire('agent/created', { agent })
  assert.equal(agent.bus.count('system-prompt/assemble'), 1)
})

await test('injects recall into the assembled prompt', async () => {
  const agent = createAgent('sess-1')
  const client = createClient(ok)
  const ctx = createCtx({ liveAgents: [agent] })
  registerAutoRecall(ctx, client, config)

  await say(ctx, 'sess-1', QUESTION)
  const result = await assembleOn(agent)

  assert.equal(client.calls.length, 1)
  assert.equal(result.contexts.length, 1)
  assert.equal(result.contexts[0].name, 'reme-recall')
  assert.match(result.contexts[0].text, /alpha memory body/)
  assert.match(result.contexts[0].text, /引用数据/)
})

await test('searches once per query across many steps of one turn', async () => {
  const agent = createAgent('sess-2')
  const client = createClient(ok)
  const ctx = createCtx({ liveAgents: [agent] })
  const handle = registerAutoRecall(ctx, client, config)

  await say(ctx, 'sess-2', QUESTION)
  await assembleOn(agent, { contexts: [] })
  await assembleOn(agent, { contexts: [] })
  await assembleOn(agent, { contexts: [] })

  assert.equal(client.calls.length, 1, 'memo should collapse repeated steps into one search')
  const [entry] = handle.snapshot().agents
  assert.equal(entry.memoHits, 2)
  assert.equal(entry.searches, 1)
  assert.equal(entry.injected, 3)
})

await test('searches again when the user says something new', async () => {
  const agent = createAgent('sess-3')
  const client = createClient(ok)
  const ctx = createCtx({ liveAgents: [agent] })
  registerAutoRecall(ctx, client, config)

  await say(ctx, 'sess-3', '第一个真正的问题内容')
  await assembleOn(agent)
  await say(ctx, 'sess-3', '第二个完全不同的问题')
  await assembleOn(agent)

  assert.equal(client.calls.length, 2)
  assert.equal(client.calls[0].query, '第一个真正的问题内容')
  assert.equal(client.calls[1].query, '第二个完全不同的问题')
})

await test('never searches for small talk', async () => {
  const agent = createAgent('sess-4')
  const client = createClient(ok)
  const ctx = createCtx({ liveAgents: [agent] })
  const handle = registerAutoRecall(ctx, client, config)

  await say(ctx, 'sess-4', '好的')
  const result = await assembleOn(agent)

  assert.equal(client.calls.length, 0)
  assert.equal(result.contexts.length, 0)
  assert.equal(handle.snapshot().agents[0].skipped['small-talk'], 1)
})

await test('degrades silently when ReMe is unreachable', async () => {
  const agent = createAgent('sess-5')
  const client = createClient(() => {
    throw new Error('ECONNREFUSED')
  })
  const ctx = createCtx({ liveAgents: [agent] })
  const handle = registerAutoRecall(ctx, client, config)

  await say(ctx, 'sess-5', QUESTION)
  const result = await assembleOn(agent)

  assert.deepEqual(result.contexts, [])
  assert.equal(handle.snapshot().agents[0].failures, 1)
})

await test('gives up at recallTimeoutMs instead of hanging the prompt', async () => {
  const agent = createAgent('sess-6')
  const client = createClient((_q, _o, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }))
  const ctx = createCtx({ liveAgents: [agent] })
  const handle = registerAutoRecall(ctx, client, config)

  // `AbortSignal.timeout` uses an unref'd timer, so a bare test process would
  // exit before the budget ever fires. A ref'd timer keeps the loop alive, the
  // way a real host process always does.
  const keepAlive = setTimeout(() => {}, 5_000)
  try {
    await say(ctx, 'sess-6', QUESTION)
    const started = Date.now()
    const result = await assembleOn(agent)
    const elapsed = Date.now() - started

    assert.deepEqual(result.contexts, [])
    assert.equal(handle.snapshot().agents[0].timeouts, 1)
    assert.ok(elapsed < 1000, `expected the ${config.recallTimeoutMs}ms budget to cut the call, took ${elapsed}ms`)
  } finally {
    clearTimeout(keepAlive)
  }
})

await test('a failed search is not retried on the next step of the same turn', async () => {
  const agent = createAgent('sess-7')
  const client = createClient(() => {
    throw new Error('ECONNREFUSED')
  })
  const ctx = createCtx({ liveAgents: [agent] })
  registerAutoRecall(ctx, client, config)

  await say(ctx, 'sess-7', QUESTION)
  await assembleOn(agent)
  await assembleOn(agent)

  assert.equal(client.calls.length, 1, 'a memoized failure must not be re-attempted every step')
})

await test('asserts ownership when no scoped context is available', async () => {
  const agent = createAgent('sess-global', false)
  const other = createAgent('sess-other')
  const client = createClient(ok)
  const ctx = createCtx({ liveAgents: [agent] })
  registerAutoRecall(ctx, client, config)

  await say(ctx, 'sess-global', QUESTION)

  const foreign = await ctx.fire(
    'system-prompt/assemble',
    { contexts: [] },
    { scope: other, agent: other },
    async () => ({ contexts: [] }),
  )
  assert.equal(foreign.at(-1).contexts.length, 0, 'a global listener must ignore foreign assemblies')

  const own = await ctx.fire(
    'system-prompt/assemble',
    { contexts: [] },
    { scope: agent, agent },
    async () => ({ contexts: [] }),
  )
  assert.equal(own.at(-1).contexts.length, 1, 'a global listener must still serve its own agent')
})

await test('two agents never share state', async () => {
  const a = createAgent('sess-a')
  const b = createAgent('sess-b')
  const client = createClient(ok)
  const ctx = createCtx({ liveAgents: [a, b] })
  registerAutoRecall(ctx, client, config)

  await say(ctx, 'sess-a', '这是 A 会话提出的问题')
  await say(ctx, 'sess-b', '这是 B 会话提出的问题')
  await assembleOn(a)
  await assembleOn(b)

  assert.equal(client.calls[0].query, '这是 A 会话提出的问题')
  assert.equal(client.calls[1].query, '这是 B 会话提出的问题')
  assert.equal(ctx.count('agent/inbox/claimed'), 1, 'one global claim listener')
  assert.equal(ctx.count('session/event'), 1, 'one global transcript listener')
})

await test('never queries with its own injected recall', async () => {
  const agent = createAgent('sess-8')
  const client = createClient(ok)
  const ctx = createCtx({ liveAgents: [agent] })
  registerAutoRecall(ctx, client, config)

  await say(ctx, 'sess-8', '真正的问题内容在这里')
  await assembleOn(agent)

  // The loop records injected contexts as user-role snapshots. Such a snapshot
  // must never be read back as the next query.
  await say(ctx, 'sess-8', '以下是长期记忆片段', 'system-prompt')
  await assembleOn(agent)

  assert.equal(client.calls.length, 1, 'the injected snapshot must not become the next query')
})

await test('the durable transcript feed is not a query source', async () => {
  const agent = createAgent('sess-10')
  const client = createClient(ok)
  const ctx = createCtx({ liveAgents: [agent] })
  registerAutoRecall(ctx, client, config)

  // Only `agent/inbox/claimed` may set the query: `session/event` arrives a
  // step after the assembly that needs it.
  await ctx.fire(
    'session/event',
    { id: 'sess-10' },
    { type: 'user/message', data: userMessage('这条不该被当成 query') },
  )
  const result = await assembleOn(agent)

  assert.equal(client.calls.length, 0)
  assert.equal(result.contexts.length, 0)
})

await test('stops injecting after dispose', async () => {
  const agent = createAgent('sess-9')
  const ctx = createCtx({ liveAgents: [agent] })
  const handle = registerAutoRecall(ctx, createClient(ok), config)

  await say(ctx, 'sess-9', QUESTION)
  assert.equal((await assembleOn(agent)).contexts.length, 1)

  handle.dispose()
  assert.equal((await assembleOn(agent)).contexts.length, 0)
  assert.equal(ctx.count('agent/inbox/claimed'), 0)
  assert.equal(ctx.count('session/event'), 0)
  assert.equal(ctx.count('agent/created'), 0)
  assert.equal(agent.bus.count('system-prompt/assemble'), 0, 'per-agent listener must be withdrawn')
})

await test('tears one agent down without touching another', async () => {
  const a = createAgent('sess-x')
  const b = createAgent('sess-y')
  const ctx = createCtx({ liveAgents: [a, b] })
  const handle = registerAutoRecall(ctx, createClient(ok), config)

  await ctx.fire('agent/disposed', { agent: a })
  assert.equal(a.bus.count('system-prompt/assemble'), 0)
  assert.equal(b.bus.count('system-prompt/assemble'), 1)
  assert.equal(handle.snapshot().trackedAgents, 1)
})

await test('does nothing when autoRecall is off', () => {
  const off = resolveConfig({ autoRecall: false })
  const ctx = createCtx({ liveAgents: [createAgent('sess-off')] })
  const handle = registerAutoRecall(ctx, createClient(ok), off)
  assert.equal(handle, undefined)
  assert.equal(ctx.count('session/event'), 0)
  assert.equal(ctx.count('agent/inbox/claimed'), 0)
})

await test('reports feed counters so a missing query is diagnosable', async () => {
  const agent = createAgent('sess-11')
  const ctx = createCtx({ liveAgents: [agent] })
  const handle = registerAutoRecall(ctx, createClient(ok), config)

  await say(ctx, 'sess-11', QUESTION)
  await ctx.fire('session/event', { id: 'sess-11' }, { type: 'assistant/message', data: { message: {} } })
  await assembleOn(agent)

  const { counters } = handle.snapshot()
  assert.equal(counters.inboxClaimed, 1)
  assert.equal(counters.userTexts, 1)
  assert.equal(counters.sessionEvents, 1)
  assert.equal(counters.agentsSwept, 1)
  assert.equal(counters.searches, 1)
  assert.equal(counters.injected, 1)
  assert.equal(handle.snapshot().agents[0].lastUserTextPreview, QUESTION)
})

await test('mirrors skip reasons process-wide for disposed agents', async () => {
  const agent = createAgent('sess-13')
  const ctx = createCtx({ liveAgents: [agent] })
  const handle = registerAutoRecall(ctx, createClient(ok), config)

  await say(ctx, 'sess-13', '好的')
  await assembleOn(agent)
  // The per-agent entry disappears with the agent; the process-wide one must not.
  await ctx.fire('agent/disposed', { agent })
  assert.equal(handle.snapshot().trackedAgents, 0)
  assert.equal(handle.snapshot().counters.skippedByReason['small-talk'], 1)
})

await test('registers no tools of its own', () => {
  const ctx = createCtx()
  const handle = registerAutoRecall(ctx, createClient(ok), config)
  // The diagnostic tool is wired by index.ts so one tool can report both halves.
  assert.deepEqual(ctx.registered, [])
  assert.equal(typeof handle.invalidateMemos, 'function')
})

await test('invalidateMemos drops the memo so the next assembly searches again', async () => {
  const agent = createAgent('sess-12')
  const client = createClient(ok)
  const ctx = createCtx({ liveAgents: [agent] })
  const handle = registerAutoRecall(ctx, client, config)

  await say(ctx, 'sess-12', QUESTION)
  await assembleOn(agent)
  assert.equal(client.calls.length, 1)

  handle.invalidateMemos()
  await assembleOn(agent)
  assert.equal(client.calls.length, 2, 'a write in ReMe must make the memoized recall stale')
})

// ---------------------------------------------------------------------- report

console.log(`\n${passed} passed, ${failures.length} failed`)
for (const { name, error } of failures) console.log(`\nFAILED: ${name}\n${error.stack}`)
process.exit(failures.length === 0 ? 0 : 1)
