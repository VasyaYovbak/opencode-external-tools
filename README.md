# OpenCode External Tools

**Let OpenCode use tools that live in another application, without an MCP server
or changes to the agent backend.** Tested with OpenCode **v2.0.22**.

## Why this plugin exists

An application such as **OpenWebUI** can have its own tool environment: tools
created in the UI, application-specific functions, credentials, and execution
context. Those tools already work inside the application, but they may not be
exposed through MCP or any standalone service. An external agent cannot simply
connect to that environment and start using them.

This plugin bridges that gap. Your application selects the tools available for a
request or session and sends their **names, descriptions, and input schemas** to
OpenCode. The agent sees ordinary named tools and can call them. Your application
receives each call, runs the tool in its existing environment, and returns the
result so the agent can continue.

The tool implementations stay outside OpenCode. Users can create or change tools
in your UI without rebuilding or modifying the agent backend. You do not need to
turn every tool into an MCP server or maintain an OpenCode fork.

Useful hosts include OpenWebUI, n8n, a Python application, or any service that
already knows how to execute its own tools.

## How it works

```text
Your application selects and registers tool definitions
    → OpenCode presents the named tools to the model
    → The model calls a tool
    → The plugin emits a requested event and waits
    → Your application executes the tool externally
    → Your application returns the result through HTTP RPC
    → OpenCode passes the result to the model and continues
```

**Scope:** registration is session-scoped. To select tools for a particular
request, register the desired set before submitting its prompt, then unregister
it after the request finishes if it is no longer needed. For independently scoped
or concurrent requests, use separate sessions. The plugin does **not** add an
`externalTools` field to OpenCode's native prompt API.

**Host integration is required:** this is a bridge, not an automatic OpenWebUI
connector. Your application must register tool definitions, consume calls, invoke
its existing tool executor, and return results. Installing the plugin alone does
not discover or execute tools from another application's UI.

## Installation

Add the following entry to `plugins` in your **existing** project
`opencode.json(c)` or global `~/.config/opencode/opencode.json(c)`. Preserve your
other settings and plugin entries:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:VasyaYovbak/opencode-external-tools#v0.1.1",
      "options": { "timeoutMs": 120000 }
    }
  ]
}
```

OpenCode downloads the GitHub package and installs its dependencies automatically.
Prebuilt files in `dist/` are included in Git: users do not need to clone the
repository, install TypeScript, or run `npm run build:plugin`. On first startup,
allow the background package installation to finish. The tag selects a release;
for a strict pin, use a full commit hash instead of `v0.1.1`.

`timeoutMs` is the maximum time to wait for an external response. It defaults to
120 seconds and accepts integers from 1 to 3600000 milliseconds.

### Local development

```sh
git clone https://github.com/VasyaYovbak/opencode-external-tools.git
cd opencode-external-tools
npm ci
npm run build:plugin
npm run typecheck
npm test
```

For local development, replace `package` with the absolute path to this directory.
After changing `src/`, run `npm run build:plugin` and reload the OpenCode
configuration. Before a release, commit the updated `dist/` alongside the source.
The script is deliberately named `build:plugin`, not `build`: otherwise npm
triggers unnecessary Git dependency preparation and installs development
dependencies even though the package is already built.
The root `index.js` is required by v2's local directory loader. It loads compiled
JavaScript from `dist/` without runtime TypeScript loading.

## API contract

RPC ID: `external_tools`. All methods are available through:

```text
POST /api/rpc/external_tools/{method}
Content-Type: application/json

{"input": ...}
```

HTTP responses use `{"output": ...}`; `resolve` and `unregister` return
`{"output": true}`. Use your server's authentication. For a managed local service,
clients can use `Service.discover()` and `Service.headers()`; see the example.

**Important:** RPC runs at the location where the plugin is loaded. Pass
`location[directory]` as a query parameter, or `{ location: { directory } }` as
the TypeScript client's second method argument. It must match the session's
location.

### 1. Register tools

First create a session through OpenCode's native v2 API. Then call `register`:

```json
{
  "input": {
    "sessionID": "ses_...",
    "tools": [
      {
        "name": "get_weather",
        "description": "Return current weather for a city",
        "inputSchema": {
          "type": "object",
          "properties": { "city": { "type": "string" } },
          "required": ["city"],
          "additionalProperties": false
        }
      }
    ]
  }
}
```

`register` **replaces** the session's tool set; it does not append to the previous
set. An invalid registration leaves the previous set unchanged. Schemas are
compiled into Effect validators before registration. The root schema must have
`type: "object"`.

Effect supports a subset of JSON Schema, not the full specification. In
particular, `pattern` and `patternProperties` are rejected by default because
regular expression evaluation can take unbounded time. Validate critical
constraints again in your external executor; do not rely on unsupported `format`
values or other JSON Schema extensions.

Different sessions may use the same tool name with different schemas. The model
sees your tool names, such as `get_weather`, rather than a generic wrapper.
Internal IDs are isolated, and tools are exposed directly without Code Mode.
Duplicate names within a set and collisions with native tools, including `read`
and `execute`, are not allowed. Child sessions do not inherit external tool sets.

### 2. Receive a call

Subscribe to `rpc.external_tools.requested` **before** submitting the prompt:

```ts
import { ExternalTools } from "opencode-external-tools/rpc"

const bridge = client.rpc(ExternalTools)
for await (const event of bridge.events.subscribe("requested")) {
  console.log(event.location, event.data)
}
```

`event.data`:

```json
{
  "sessionID": "ses_...",
  "messageID": "msg_...",
  "callID": "a-unique-bridge-uuid",
  "toolCallID": "provider-tool-call-id",
  "tool": "get_weather",
  "arguments": { "city": "Kyiv" },
  "createdAt": 1790000000000,
  "expiresAt": 1790000120000
}
```

Filter by location and `sessionID`: event subscriptions include events from
multiple locations. `callID` is the unique **bridge** ID to send back in `resolve`.
`toolCallID` is the model's informational tool-call ID and may be reused.

### 3. Return a result

Call `resolve`:

```json
{
  "input": {
    "sessionID": "ses_...",
    "callID": "a-unique-bridge-uuid",
    "result": {
      "output": "Kyiv: sunny, 22°C",
      "title": "Weather",
      "metadata": { "source": "n8n" }
    }
  }
}
```

Or return an error:

```json
{"input":{"sessionID":"ses_...","callID":"...","error":"Service unavailable"}}
```

Provide exactly one of `result` or `error`. `output` is the text sent to the model;
use `JSON.stringify(...)` for a JSON result. `title` and `metadata` are optional.
Duplicate, expired, or wrong-session responses receive `not_found`.

### Reconnection and cleanup

- `pending({ sessionID })` returns `{ calls: [...] }` for that session only.
- `unregister({ sessionID })` removes the tool set and cancels its pending calls.
- Replacing a set does not cancel calls already dispatched. Complete them using
  their existing `callID`.
- Session interruption, timeout, and plugin unload end the wait and remove
  pending calls.

RPC events are **live-only**, with no replay. After reconnecting, subscribe again
and fetch `pending`; you can also poll this method periodically. An event and
`pending` may describe the same call. Deduplicate by `callID` **before performing
side effects**.

## Client example

From a local development checkout, with the plugin installed at the target
location:

```sh
OPENCODE_DIRECTORY=/absolute/path/to/project bun run demo
```

The example uses an already-running local service, or an explicitly selected
server:

```sh
OPENCODE_URL=http://127.0.0.1:4096 \
OPENCODE_DIRECTORY=/absolute/path/to/project \
OPENCODE_AUTHORIZATION='Bearer ...' bun run demo
```

Use your server's configured authentication; do not copy tokens into the plugin
configuration. The demo returns **fictional weather** and is not a weather
service.

## Tests

```sh
npm run typecheck
npm test
npm run test:integration
# Run the same integration test with a GitHub package and a fresh cache:
OPENCODE_TEST_PLUGIN=github:VasyaYovbak/opencode-external-tools#v0.1.1 npm run test:integration
```

The integration tests require an installed `opencode` v2.0.22. They start a
separate server with isolated configuration, data, and database under
`/tmp/opencode`, plus a local fake model. They exercise the real flow: argument
validation → tool call → SSE and pending → HTTP resolution → model continuation.
They also check two sessions with the same tool name and different schemas, and
reject duplicate and wrong-session responses. No paid APIs or changes to your
main OpenCode service or configuration are involved.

## Limits and security

- This bridge is for **trusted clients of one OpenCode service**, not a
  multi-tenant access-control boundary. A client with service API access can
  manage external tools for its sessions. Do not expose an unauthenticated
  server or log secrets from tool arguments.
- Registering tools authorizes forwarding their arguments to an external
  executor. The plugin does not execute shell commands or code from tool
  descriptions. Your application executes the tools.
- `options.permission` uses the public tool name for OpenCode's native filtering
  of wholly denied tools. **The plugin does not create `ask` permission
  requests.** The external executor must enforce resource-specific checks and
  obtain approval for dangerous operations before performing side effects.
- State is process-local. Re-register tool sets after a server restart or plugin
  reload. Completing calls from before a restart is not supported.
- Delivery is not exactly-once. For payments, publishing, and similar operations,
  store the `callID` as an idempotency key in the external system. An OpenCode
  timeout does not stop the external operation.
- Limits per location: 128 registered sessions, 64 tools per session, and 256
  pending calls. Call `unregister` when a session no longer needs its tools.
- Tested API contract: OpenCode 2.0.22. This is not a v1 plugin.

References: [Plugins](https://opencode.ai/v2/docs/build/plugins),
[RPC](https://opencode.ai/v2/docs/build/plugins/rpc),
[Client](https://opencode.ai/v2/docs/build/client).
