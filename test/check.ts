import assert from "node:assert/strict"
import { Plugin } from "@opencode/plugin"
import type { Info, ToolEditor } from "@opencode/plugin/promise/tool"
import type { RpcHandlers } from "@opencode/plugin/promise/rpc"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { JsonSchema, Schema, SchemaRepresentation } from "effect"
import plugin from "../src/index.js"
import { ExternalTools, type Call, type ToolDefinition } from "../src/rpc.js"

// One offline contract check: exercise the plugin itself with a minimal host, not a second bridge implementation.
const registry = new Map<string, Info & { id: string }>()
let transform: (editor: ToolEditor) => void
let hook: (event: SessionContext) => void
let rpc: RpcHandlers<typeof ExternalTools>
let emitFailure = false
let reloadFailure = false
const events: Call[] = []
let emitted: (() => void) | undefined
const location = { directory: "/test" }
const native = { name: "read", description: "Native", input: {}, execute: async () => ({ content: "native" }) }
const reload = async () => {
  if (reloadFailure) { reloadFailure = false; throw new Error("reload failed") }
  registry.clear()
  registry.set("read", { ...native, id: "read" })
  transform?.({
    add: (tool: Info) => { registry.set(tool.name, { ...tool, id: tool.name }) },
    list: () => [...registry.values()],
    get: (id: string) => registry.get(id),
    namespace: () => {},
    update: () => {},
    remove: (id: string) => { registry.delete(id) },
  } as ToolEditor)
}
const registration = { dispose: async () => {} }
const cleanup = await plugin.setup({
  options: { timeoutMs: 50 },
  location,
  session: {
    get: async ({ sessionID }: { sessionID: string }) => {
      if (sessionID === "ses_missing") throw { _tag: "SessionNotFoundError" }
      return { location: sessionID === "ses_elsewhere" ? { directory: "/elsewhere" } : location }
    },
    hook: async (_name: string, callback: typeof hook) => { hook = callback; return registration },
  },
  tool: {
    list: async () => [...registry.values()],
    reload,
    transform: async (callback: typeof transform) => { transform = callback; await reload(); return registration },
  },
  rpc: {
    register: async (_definition: unknown, handlers: typeof rpc) => {
      rpc = handlers
      return { ...registration, events: { emit: async (_name: string, call: Call) => {
        if (emitFailure) throw new Error("event bus failed")
        events.push(structuredClone(call))
        emitted?.()
      } } }
    },
  },
} as unknown as Plugin.Context)
const rpcContext = {
  signal: new AbortController().signal,
  error: (code: string, message: string) => Object.assign(new Error(message), { code }),
}
const codecs = new Map(Object.entries(ExternalTools.methods).map(([name, method]) => [name, {
  input: Schema.make<Schema.Codec<unknown>>(SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(method.input)).ast),
  output: Schema.make<Schema.Codec<unknown>>(SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(method.output)).ast),
}]))
async function callRpc(method: keyof typeof ExternalTools.methods, input: unknown) {
  const codec = codecs.get(method)!
  const output = await rpc[method](Schema.decodeUnknownSync(codec.input)(input), rpcContext as never)
  return Schema.decodeUnknownSync(codec.output)(output)
}
const tools: ToolDefinition[] = [{
  name: "get_weather",
  description: "Weather",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
}]
const toolsB: ToolDefinition[] = [{ ...tools[0], inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } }]
await callRpc("register", { sessionID: "ses_a", tools })
await callRpc("register", { sessionID: "ses_b", tools: toolsB })

function snapshot(sessionID: string) {
  const definitions = Object.fromEntries([...registry].map(([id, tool]) => [id, { description: tool.description, input: {} }]))
  const original = new Map(Object.entries(definitions).map(([id, definition]) => [definition, registry.get(id)!]))
  const event = { sessionID, tools: definitions } as unknown as SessionContext
  hook(event)
  return { event, executor: original.get(event.tools.get_weather) }
}
const a = snapshot("ses_a")
const b = snapshot("ses_b")
assert.deepEqual(Object.keys(a.event.tools).sort(), ["get_weather", "read"])
assert.deepEqual(Object.keys(snapshot("ses_other").event.tools), ["read"])
assert.notEqual(a.executor!.id, b.executor!.id)
assert.deepEqual(Schema.decodeUnknownSync(a.executor!.input as Schema.Codec<unknown>)({ city: "Kyiv" }), { city: "Kyiv" })
assert.throws(() => Schema.decodeUnknownSync(a.executor!.input as Schema.Codec<unknown>)({ city: 42 }))
assert.throws(() => Schema.decodeUnknownSync(a.executor!.input as Schema.Codec<unknown>)({ city: "Kyiv", extra: true }))

function execute(tool: Info, sessionID: string, input: object = { city: "Kyiv" }, signal = new AbortController().signal) {
  return tool.execute(input, { sessionID, messageID: "msg_test", id: "model_call_reused", signal, progress: async () => {} } as never)
}
async function requested(tool: Info, sessionID: string, signal?: AbortSignal) {
  const ready = new Promise<void>((resolve) => { emitted = resolve })
  const result = execute(tool, sessionID, undefined, signal)
  // Attach a rejection handler immediately; cancellation must never become an unhandled rejection.
  void result.catch(() => {})
  await ready
  emitted = undefined
  return { call: events.at(-1)!, result }
}

const first = await requested(a.executor!, "ses_a")
assert.equal(first.call.tool, "get_weather")
assert.deepEqual(first.call.arguments, { city: "Kyiv" })
assert.equal(first.call.toolCallID, "model_call_reused")
assert.deepEqual(await callRpc("pending", { sessionID: "ses_b" }), { calls: [] })
assert.deepEqual(await callRpc("pending", { sessionID: "ses_a" }), { calls: [first.call] })
await assert.rejects(callRpc("resolve", { sessionID: "ses_b", callID: first.call.callID, result: { output: "wrong" } }), { code: "not_found" })
await callRpc("resolve", { sessionID: "ses_a", callID: first.call.callID, result: { output: "Sunny", title: "Weather", metadata: { city: "Kyiv" } } })
assert.deepEqual(await first.result, { content: "Sunny", metadata: { city: "Kyiv", title: "Weather", externalTool: "get_weather", externalCallID: first.call.callID } })
await assert.rejects(callRpc("resolve", { sessionID: "ses_a", callID: first.call.callID, result: { output: "duplicate" } }), { code: "not_found" })
await assert.rejects(execute(a.executor!, "ses_b"), /not registered/)

await assert.rejects(callRpc("register", { sessionID: "ses_a", tools: [tools[0], tools[0]] }), { code: "invalid_request" })
await assert.rejects(callRpc("register", { sessionID: "ses_a", tools: [{ ...tools[0], name: "read" }] }), { code: "invalid_request" })
await assert.rejects(callRpc("register", { sessionID: "ses_a", tools: [{ ...tools[0], inputSchema: { type: "string" } }] }), { code: "invalid_request" })
await assert.rejects(callRpc("register", { sessionID: "ses_elsewhere", tools }), { code: "invalid_request" })
await assert.rejects(callRpc("pending", { sessionID: "ses_missing" }), { code: "not_found" })
assert.equal(snapshot("ses_a").executor!.id, a.executor!.id, "failed registration must preserve the previous catalog")
reloadFailure = true
await assert.rejects(callRpc("register", { sessionID: "ses_a", tools: toolsB }), /reload failed/)
assert.equal(snapshot("ses_a").executor!.id, a.executor!.id, "failed reload must restore the previous catalog")

const cancelled = new AbortController()
const second = await requested(a.executor!, "ses_a", cancelled.signal)
assert.notEqual(first.call.callID, second.call.callID, "model call IDs can be reused")
cancelled.abort()
await assert.rejects(second.result, /cancelled/)
assert.deepEqual(await callRpc("pending", { sessionID: "ses_a" }), { calls: [] })
const timeout = await requested(a.executor!, "ses_a")
await assert.rejects(timeout.result, /timed out/)
assert.deepEqual(await callRpc("pending", { sessionID: "ses_a" }), { calls: [] })

const failed = await requested(a.executor!, "ses_a")
await callRpc("resolve", { sessionID: "ses_a", callID: failed.call.callID, error: "Remote executor failed" })
await assert.rejects(failed.result, /Remote executor failed/)
emitFailure = true
await assert.rejects(execute(a.executor!, "ses_a"), /event bus failed/)
assert.deepEqual(await callRpc("pending", { sessionID: "ses_a" }), { calls: [] })
emitFailure = false

await callRpc("register", { sessionID: "ses_a", tools: toolsB })
await assert.rejects(execute(a.executor!, "ses_a"), /not registered/)
const active = await requested(snapshot("ses_a").executor!, "ses_a")
await callRpc("unregister", { sessionID: "ses_a" })
await assert.rejects(active.result, /unregistered/)
assert.deepEqual(Object.keys(snapshot("ses_a").event.tools), ["read"])

const unloading = await requested(b.executor!, "ses_b")
await cleanup?.()
await assert.rejects(unloading.result, /unloaded/)
await assert.rejects(callRpc("pending", { sessionID: "ses_b" }), { code: "conflict" })
console.log("OK: isolation, aliases, rollback, pending recovery, result/error, cancellation, timeout, unregister and unload")
