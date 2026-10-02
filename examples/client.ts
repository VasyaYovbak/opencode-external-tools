import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { ExternalTools, type Call } from "../src/rpc.js"

const endpoint = process.env.OPENCODE_URL ? undefined : await Service.discover()
if (!process.env.OPENCODE_URL && !endpoint) throw new Error("Start OpenCode first, or set OPENCODE_URL")
const client = OpenCode.make({
  baseUrl: process.env.OPENCODE_URL ?? endpoint!.url,
  headers: process.env.OPENCODE_URL
    ? process.env.OPENCODE_AUTHORIZATION ? { authorization: process.env.OPENCODE_AUTHORIZATION } : undefined
    : Service.headers(endpoint!),
})
const location = { directory: process.env.OPENCODE_DIRECTORY ?? process.cwd() }
const bridge = client.rpc(ExternalTools)
const session = await client.session.create({ location, title: "External tools demo" })
console.log("sessionID:", session.id)
const controller = new AbortController()
const seen = new Set<string>()
let workerError: unknown

async function handle(call: Call) {
  if (call.sessionID !== session.id || seen.has(call.callID)) return
  seen.add(call.callID)
  // Demo only. A real executor must authorize the operation and validate arguments before side effects.
  if (call.tool !== "get_weather" && call.tool !== "echo_message") throw new Error(`Unexpected tool: ${call.tool}`)
  const result = call.tool === "get_weather"
    ? { output: `Demo weather in ${call.arguments.city}: sunny, 22°C`, metadata: { demo: true } }
    : { output: String(call.arguments.text) }
  await bridge.resolve({ sessionID: session.id, callID: call.callID, result }, { location })
  console.log("resolved:", call.tool, call.callID)
}

// Consume the iterator before prompting. Poll pending too: events are live-only, not a reliable queue.
const listening = (async () => {
  for await (const event of bridge.events.subscribe("requested", { signal: controller.signal })) {
    if (event.location.directory === location.directory) await handle(event.data as unknown as Call)
  }
})().catch((error) => { workerError = error; controller.abort() })
let polling = Promise.resolve()
const timer = setInterval(() => {
  polling = polling.then(async () => {
    const { calls } = await bridge.pending({ sessionID: session.id }, { location }) as { calls: Call[] }
    for (const call of calls) await handle(call)
  }).catch((error) => { workerError = error; controller.abort() })
}, 1000)
try {
  await bridge.register({ sessionID: session.id, tools: [
    { name: "get_weather", description: "Get demo weather for a city", inputSchema: {
      type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false,
    } },
    { name: "echo_message", description: "Echo a message", inputSchema: {
      type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false,
    } },
  ] }, { location })
  await client.session.prompt({ sessionID: session.id, text: "Call get_weather for Kyiv and echo_message with 'hello from an external executor', then summarize the results." })
  await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]) })
  if (workerError) throw workerError
  console.log(JSON.stringify(await client.session.context({ sessionID: session.id }), null, 2))
} finally {
  clearInterval(timer)
  controller.abort()
  await Promise.allSettled([listening, polling])
  await bridge.unregister({ sessionID: session.id }, { location })
}
