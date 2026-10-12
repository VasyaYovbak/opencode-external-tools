import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'

const root = await mkdtemp('/tmp/opencode/external-tools-smoke-')
const plugin = process.env.OPENCODE_TEST_PLUGIN ?? fileURLToPath(new URL('../', import.meta.url))
const codemode = process.env.OPENCODE_TEST_CODEMODE === 'true'
let receivedResult = false
let advertised = false
let invalidInputSent = false
let validationErrorReplayed = false
let nativeSearch
let emptySearch
let nativePath
let nativeResult = false
const uiEmbeds = ['<!doctype html><html><body>TOOL-EMBED-ONLY</body></html>']
let uiMetadataLeaked = false
let uiSuccessMetadata = false
let uiReport
const model = createServer(async (req, res) => {
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    uiMetadataLeaked ||= JSON.stringify(body).includes('TOOL-EMBED-ONLY')
    assert(!JSON.stringify(body).includes('PRIVATE_OTHER_SCHEMA'), 'Another session\'s schema leaked into model context')
    const recent = body.messages.slice(body.messages.findLastIndex(message => message.role === 'user'))
    const nativePrompt = String(recent[0]?.content)
    const native = nativePrompt.includes('NATIVE_SEARCH') || nativePrompt.includes('NATIVE_CALL') || nativePrompt.includes('NATIVE_STALE') || nativePrompt.includes('EMPTY_SEARCH')
    const nativeOutput = recent.find(message => message.role === 'tool')
    if (nativeOutput) {
      if (nativePrompt.includes('NATIVE_SEARCH')) nativeSearch = JSON.parse(nativeOutput.content)
      if (nativePrompt.includes('EMPTY_SEARCH')) emptySearch = JSON.parse(nativeOutput.content)
      if (nativePrompt.includes('NATIVE_CALL')) nativeResult = String(nativeOutput.content).includes('Native Kyiv: sunny')
    }
    if (nativePrompt.includes('NATIVE_STALE') && !nativeOutput)
      await rpc('unregister', { sessionID: req.headers['x-opencode-session-id'] })
    const tool = body.tools?.find((tool) => tool.function?.name === 'get_weather')
    if (codemode) assert(!tool, 'Code Mode must not publish external tools\' full schemas directly')
    if (tool) {
      advertised = true
      assert.equal(tool.function.parameters.properties.city.type, 'string')
      assert.equal(tool.function.parameters.properties.count.type, 'integer')
      assert(!body.tools.some((tool) => tool.function?.name.startsWith('ext_')))
    }
    const done = body.messages.some((message) => message.role === 'tool' && String(message.content).includes('Kyiv: sunny'))
    if (body.messages.some((message) => message.role === 'tool' && String(message.content).includes('Invalid arguments')))
      validationErrorReplayed = true
    if (done) receivedResult = true
    const argumentsText = invalidInputSent ? '{"city":"Kyiv","count":5,"skip":0}' : '{"city":"Kyiv","count":1.5}'
    if (tool && !done) invalidInputSent = true
    const message = native && !nativeOutput
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'native_call', type: 'function', function: { name: 'execute', arguments: JSON.stringify({ code: nativePrompt.includes('NATIVE_CALL') || nativePrompt.includes('NATIVE_STALE') ? `return await ${nativePath}({city:"Kyiv",count:5,skip:0})` : 'return search({namespace:"external",limit:100})' }) } }] }
      : native ? { role: 'assistant', content: 'Native check completed.' } : tool && !done
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'model_call_1', type: 'function', function: { name: 'get_weather', arguments: argumentsText } }] }
      : { role: 'assistant', content: 'External tool completed.' }
    const finish = message.tool_calls ? 'tool_calls' : 'stop'
    const common = { id: 'chatcmpl-test', created: Math.floor(Date.now()/1000), model: 'test' }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const delta = message.tool_calls
        ? { role: 'assistant', tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) }
        : message
      res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }))
    }
  } catch (error) { res.writeHead(500); res.end(String(error)) }
})
model.listen(0, '127.0.0.1')
await once(model, 'listening')
const reservation = createServer()
reservation.listen(0, '127.0.0.1')
await once(reservation, 'listening')
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const base = `http://127.0.0.1:${port}`
const config = {
  plugins: [{ package: plugin, options: { timeoutMs: 120000, ...(codemode ? {} : { codemode: false }) } }],
  model: 'bridge-test/test',
  compaction: {auto:false, keep:{tokens:0}},
  agents: { build: { steps: 3 } },
  providers: { 'bridge-test': {
    name: 'Bridge test', env: ['BRIDGE_TEST_API_KEY'],
    package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: `http://127.0.0.1:${model.address().port}/v1` },
    models: { test: { name: 'Test', capabilities: { tools: true }, limit: { context: 32000, output: 1024 } } },
  } },
}
await mkdir(`${root}/config`, { recursive: true })
await writeFile(`${root}/opencode.json`, JSON.stringify(config))
const child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--log-level', 'debug'], {
  cwd: root,
  env: {
    PATH: process.env.PATH, HOME: root, USERPROFILE: root, BRIDGE_TEST_API_KEY: 'test',
    OPENCODE_PASSWORD: 'external-tools-smoke-password',
    OPENCODE_CONFIG_DIR: `${root}/config`, OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DB: `${root}/opencode.db`, OPENCODE_TEST_HOME: root,
    OPENCODE_DISABLE_FILEWATCHER: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true',
    XDG_CONFIG_HOME: `${root}/xdg-config`, XDG_DATA_HOME: `${root}/data`,
    XDG_CACHE_HOME: `${root}/cache`, XDG_STATE_HOME: `${root}/state`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
child.stdout.on('data', (chunk) => { logs += chunk })
child.stderr.on('data', (chunk) => { logs += chunk })
const exit = once(child, 'exit')
const eventsController = new AbortController()
let listening = Promise.resolve()
async function api(path, input, method = input === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from('opencode:external-tools-smoke-password').toString('base64')}` },
    body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(120000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status}: ${text}`)
  return text ? JSON.parse(text) : undefined
}
const rpc = (method, input) => api(`/api/rpc/external_tools/${method}?location%5Bdirectory%5D=${encodeURIComponent(root)}`, { input })
try {
  const deadline = Date.now() + 60000
  while (true) {
    if (child.exitCode !== null) throw new Error('OpenCode exited early')
    try { await api('/api/info'); break } catch (error) { if (Date.now() > deadline) throw error; await delay(100) }
  }
  const { data: session } = await api('/api/session', { location: { directory: root }, title: 'External tool test' })
  // Missing Git packages install in the background on first boot.
  const pluginDeadline = Date.now() + 120000
  while (true) {
    try { await rpc('pending', { sessionID: session.id }); break }
    catch (error) {
      if (!String(error).includes('rpc.unavailable') || Date.now() >= pluginDeadline) throw error
      await delay(250)
    }
  }
  const inputSchema = { type: 'object', properties: { city: { type: 'string' }, count: { type: 'integer', default: 5 }, skip: { type: 'integer', default: 0 } }, required: ['city'], additionalProperties: false }
  await api(`/api/session/${session.id}`, { permissions: [{ action: 'weather_hidden', resource: '*', effect: 'deny' }] }, 'PATCH')
  const registered = await rpc('register', { sessionID: session.id, tools: [{ name: 'get_weather', description: 'Weather', inputSchema }, { name: 'weather_hidden', description: 'Denied weather', inputSchema }] })
  assert.deepEqual(registered.output.tools, ['get_weather', 'weather_hidden'])
  const { data: other } = await api('/api/session', { location: { directory: root }, title: 'Isolation test' })
  await rpc('register', { sessionID: other.id, tools: [{ name: 'get_weather', description: 'PRIVATE_OTHER_SCHEMA', inputSchema: {
    type: 'object', properties: { id: { type: 'number' } }, required: ['id'],
  } }] })
  let requestedCount = 0
  let acceptEvent, rejectEvent
  const requestedEvent = new Promise((resolve, reject) => { acceptEvent = resolve; rejectEvent = reject })
  void requestedEvent.catch(() => {})
  const eventResponse = await fetch(`${base}/api/event`, {
    headers: { authorization: `Basic ${Buffer.from('opencode:external-tools-smoke-password').toString('base64')}` },
    signal: AbortSignal.any([eventsController.signal, AbortSignal.timeout(30000)]),
  })
  assert(eventResponse.ok, 'SSE subscription failed')
  listening = (async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of eventResponse.body) {
      buffer += decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n')
      let end
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        const event = JSON.parse(data)
        if (event.type === 'session.tool.success' && event.data.sessionID === session.id && event.data.metadata?.embeds?.[0] === uiEmbeds[0]) uiSuccessMetadata = true
        if (event.type === 'rpc.external_tools.requested' && event.data.sessionID === session.id) {
          requestedCount++
          acceptEvent(event)
        }
      }
    }
    rejectEvent(new Error('SSE stream ended before the requested event'))
  })().catch((error) => { if (!eventsController.signal.aborted) rejectEvent(error) })
  if (!codemode) {
  await api(`/api/session/${session.id}/prompt`, { text: 'Call get_weather for Kyiv.' })
  let call
  for (let attempt = 0; attempt < 100; attempt++) {
    call = (await rpc('pending', { sessionID: session.id })).output.calls[0]
    if (call) break
    await delay(100)
  }
  assert(call, 'No external call; model/alias/executor integration failed')
  assert.equal(call.tool, 'get_weather')
  assert.deepEqual(call.arguments, { city: 'Kyiv', count: 5, skip: 0 })
  const event = await requestedEvent
  assert.equal(event.location.directory, root)
  assert.deepEqual(event.data, call, 'SSE and pending must describe the same call')
  assert.deepEqual((await rpc('pending', { sessionID: other.id })).output.calls, [])
  await assert.rejects(rpc('resolve', { sessionID: other.id, callID: call.callID, result: { output: 'wrong session' } }), /not_found/)
  await rpc('resolve', { sessionID: session.id, callID: call.callID, result: { output: 'Kyiv: sunny', metadata: { source: 'smoke', embeds: uiEmbeds } } })
  await assert.rejects(rpc('resolve', { sessionID: session.id, callID: call.callID, result: { output: 'duplicate' } }), /not_found/)
  await api(`/api/experimental/session/${session.id}/wait`, {})
  assert(advertised, 'Model did not see the public tool name')
  assert(receivedResult, 'Model did not receive the external tool result')
  assert(validationErrorReplayed, 'Invalid tool arguments must be rejected before external dispatch')
  assert.equal(requestedCount, 1, 'Only the valid tool input may reach the external executor')
  assert.deepEqual((await rpc('pending', { sessionID: session.id })).output.calls, [])
  const transcript = (await api(`/api/session/${session.id}/message?limit=100&order=asc`)).data
  const uiTool = transcript.flatMap(message => message.content ?? []).find(content => content.type === 'tool' && content.state.metadata?.embeds)
  assert.deepEqual(uiTool?.state.metadata.embeds, uiEmbeds, 'Tool UI metadata was not durably persisted')
  assert(uiSuccessMetadata, 'Live success event lost Tool UI metadata')
  assert(!uiMetadataLeaked, 'UI metadata was included in provider/model context')
  const {data: importedInfo} = await api('/api/session', {location:{directory:root}, title:'UI metadata import test'})
  await api(`/api/session/${importedInfo.id}`, undefined, 'DELETE')
  await api('/api/experimental/session/import', {info:importedInfo, location:{directory:root}, messages:transcript.map(message => ({...message, id:'msg_'+crypto.randomUUID().replaceAll('-','')}))})
  const imported = (await api(`/api/session/${importedInfo.id}/message?limit=100&order=asc`)).data
  assert.deepEqual(imported.flatMap(message => message.content ?? []).find(content => content.type === 'tool' && content.state.metadata?.embeds)?.state, uiTool.state, 'Tool UI/provider state changed during native branch import')
  console.log('OK: Tool UI metadata survives SSE, durable transcript and native import; provider receives context only, not HTML')
  uiReport = {
    suite:'tool-embeds-backend', run_id:randomUUID(), backend_version:(await api('/api/info')).version,
    scope:'real isolated backend/plugin + fake provider; no Pipe/WebUI/browser runtime', status:'PASS', cost_usd:0,
    plugin_source_hash:createHash('sha256').update(await readFile(new URL('../src/index.ts',import.meta.url))).digest('hex'),
    checks:['success SSE includes HTML metadata','native transcript retains metadata','native import retains complete tool state','provider receives output only, not UI HTML','wrong-session/duplicate resolution rejected'],
  }
  }
  if (codemode) {
  await api(`/api/session/${session.id}/prompt`, { text: 'NATIVE_SEARCH' })
  await api(`/api/experimental/session/${session.id}/wait`, {})
  assert.equal(nativeSearch?.items.length, 1, 'Native search must expose only this session\'s non-denied external tool')
  assert.equal(nativeSearch.items[0].description, 'Weather')
  assert(nativeSearch.items[0].signature.includes('city: string'), 'Native search lost this session\'s schema')
  nativePath = nativeSearch.items[0].path
  await api(`/api/session/${session.id}/prompt`, { text: 'NATIVE_CALL' })
  let nativeCall
  for (let attempt = 0; attempt < 100; attempt++) {
    nativeCall = (await rpc('pending', { sessionID: session.id })).output.calls[0]
    if (nativeCall) break
    await delay(100)
  }
  assert.equal(nativeCall?.tool, 'get_weather', 'Native execute did not dispatch the discovered tool')
  assert.deepEqual(nativeCall.arguments, { city: 'Kyiv', count: 5, skip: 0 })
  await rpc('resolve', { sessionID: session.id, callID: nativeCall.callID, result: { output: 'Native Kyiv: sunny', metadata: { embeds: uiEmbeds } } })
  await api(`/api/experimental/session/${session.id}/wait`, {})
  assert(nativeResult, 'Native execute lost the external result')
  const nativeTranscript = (await api(`/api/session/${session.id}/message?limit=100&order=asc`)).data
  const nativeTool = nativeTranscript.flatMap(message => message.content ?? []).find(content => content.type === 'tool' && content.name === 'execute' && content.state.metadata?.embeds)
  assert.deepEqual(nativeTool?.state.metadata.embeds, uiEmbeds, 'Native execute dropped child UI embeds before durable projection')
  assert(uiSuccessMetadata, 'Native execute success event lost child UI embeds')
  assert(!uiMetadataLeaked, 'Child UI HTML leaked to model context')
  const scopedSession = (await api(`/api/session/${session.id}`)).data
  assert(scopedSession.permissions.some(rule => rule.action === 'weather_hidden' && rule.effect === 'deny'), 'Registration overwrote user permissions')
  const { data: empty } = await api('/api/session', { location: { directory: root }, parentID: session.id, permissions: scopedSession.permissions, title: 'Inherited permission isolation' })
  await api(`/api/session/${empty.id}/prompt`, { text: 'EMPTY_SEARCH' })
  await api(`/api/experimental/session/${empty.id}/wait`, {})
  assert.deepEqual(emptySearch?.items, [], 'A child/unregistered session inherited external tools in native search')
  await api(`/api/session/${session.id}/prompt`, { text: 'NATIVE_STALE' })
  await api(`/api/experimental/session/${session.id}/wait`, {})
  assert.equal(requestedCount, 1, 'Unregister during a native model request dispatched an external call')
  assert.deepEqual((await rpc('pending', { sessionID: session.id })).output.calls, [])
  console.log('OK: native search → individual session-scoped tool → native execute → external resolution; public denies and inherited-session isolation preserved')
  }
  await rpc('unregister', { sessionID: session.id })
  await rpc('unregister', { sessionID: other.id })
  await api(`/api/session/${session.id}/compact`, {})
  await api(`/api/experimental/session/${session.id}/wait`, {})
  assert(!uiMetadataLeaked, 'Manual compaction included UI HTML in provider context')
  uiReport?.checks.push('manual compaction keeps UI metadata out of provider context')
  console.log(`OK: real OpenCode ${(await api('/api/info')).version}, ${codemode ? 'native Code Mode' : 'direct tools'}; isolated local fake provider, no paid API`)
} catch (error) {
  console.error(logs)
  console.error(await readFile(`${root}/data/opencode/log/opencode.log`, 'utf8').catch(() => 'No server log'))
  throw error
}
finally {
  eventsController.abort()
  await listening
  child.kill('SIGTERM')
  const force = setTimeout(() => child.kill('SIGKILL'), 3000)
  await exit
  clearTimeout(force)
  model.closeAllConnections()
  await new Promise((resolve) => model.close(resolve))
  await rm(root, { recursive: true, force: true })
}
if (uiReport && process.env.OPENCODE_UI_REPORT) {
  await writeFile(process.env.OPENCODE_UI_REPORT,JSON.stringify({...uiReport,cleanup:'owned backend/provider stopped; disposable config/database/workspace removed'},null,2)+'\n')
  console.log('Report:',process.env.OPENCODE_UI_REPORT)
}
