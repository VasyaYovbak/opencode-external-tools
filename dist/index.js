import { Plugin } from "@opencode/plugin";
import { JsonSchema, Schema, SchemaRepresentation } from "effect";
import { resolve } from "node:path";
import { ExternalTools } from "./rpc.js";
class BridgeError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export default Plugin.define({
    id: "external-tools",
    async setup(ctx) {
        const timeoutMs = ctx.options.timeoutMs ?? 120_000;
        if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000)
            throw new Error("external-tools: timeoutMs must be an integer between 1 and 3600000");
        // baza: catalogs and pending calls are process-local; durable restart recovery needs a persisted queue and replay protocol.
        const catalogs = new Map();
        const pending = new Map();
        const prefix = `ext_${crypto.randomUUID().replaceAll("-", "")}_`;
        let closed = false;
        let updates = Promise.resolve();
        async function reply(context, operation) {
            try {
                if (closed)
                    throw new BridgeError("conflict", "Plugin is unloading");
                return await operation();
            }
            catch (error) {
                if (error instanceof BridgeError)
                    throw context.error(error.code, error.message, {});
                throw error;
            }
        }
        // Serialize registry mutations, including their rollback, across asynchronous reloads.
        function update(operation) {
            const next = updates.then(() => {
                if (closed)
                    throw new BridgeError("conflict", "Plugin is unloading");
                return operation();
            });
            updates = next.then(() => { }, () => { });
            return next;
        }
        async function requireSession(sessionID) {
            const session = await ctx.session.get({ sessionID }).catch((error) => {
                if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "SessionNotFoundError")
                    throw new BridgeError("not_found", "Session not found");
                throw error;
            });
            if (resolve(session.location.directory) !== resolve(ctx.location.directory))
                throw new BridgeError("invalid_request", "RPC location must match the session location");
        }
        async function replace(sessionID, tools) {
            const previous = catalogs.get(sessionID);
            if (tools)
                catalogs.set(sessionID, tools);
            else
                catalogs.delete(sessionID);
            try {
                await ctx.tool.reload();
            }
            catch (error) {
                if (previous)
                    catalogs.set(sessionID, previous);
                else
                    catalogs.delete(sessionID);
                await ctx.tool.reload();
                throw error;
            }
        }
        const rpc = await ctx.rpc.register(ExternalTools, {
            register: (input, context) => reply(context, () => update(async () => {
                const { sessionID, tools } = input;
                await requireSession(sessionID);
                // baza: bounded catalogs, 64 tools/session; add configurable limits/pagination for larger inventories.
                if (tools.length > 0 && !catalogs.has(sessionID) && catalogs.size >= 128)
                    throw new BridgeError("conflict", "Too many registered sessions; unregister unused sessions");
                if (tools.length > 64)
                    throw new BridgeError("invalid_request", "At most 64 tools per session");
                const native = new Set((await ctx.tool.list()).filter((tool) => !tool.id.startsWith(prefix)).map((tool) => tool.id));
                const names = new Set();
                const generation = crypto.randomUUID().replaceAll("-", "");
                const registered = tools.map((tool, index) => {
                    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(tool.name) || tool.name === "execute" || native.has(tool.name))
                        throw new BridgeError("invalid_request", `Reserved or invalid tool name: ${tool.name}`);
                    if (names.has(tool.name))
                        throw new BridgeError("invalid_request", `Duplicate tool name: ${tool.name}`);
                    names.add(tool.name);
                    // Compile eagerly: the host otherwise tolerates some unparseable JSON Schemas without validating input.
                    try {
                        const schema = structuredClone(tool.inputSchema);
                        if (schema.type !== "object")
                            throw new Error('inputSchema.type must be "object"');
                        const document = typeof schema.$schema === "string" && schema.$schema.includes("draft-07") || "definitions" in schema
                            ? JsonSchema.fromSchemaDraft07(schema)
                            : JsonSchema.fromSchemaDraft2020_12(schema);
                        const codec = Schema.make(SchemaRepresentation.fromJsonSchemaDocument(document).ast)
                            .annotate({ parseOptions: { onExcessProperty: "error" } });
                        return { ...tool, inputSchema: schema, input: codec, id: `${prefix}${generation}_${index}` };
                    }
                    catch (error) {
                        throw new BridgeError("invalid_request", `Invalid schema for ${tool.name}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                });
                await replace(sessionID, registered.length ? registered : undefined);
                return { sessionID, tools: registered.map((tool) => tool.name) };
            })),
            unregister: (input, context) => reply(context, () => update(async () => {
                const { sessionID } = input;
                await requireSession(sessionID);
                await replace(sessionID);
                for (const entry of pending.values())
                    if (entry.call.sessionID === sessionID)
                        entry.settle(undefined, new Error("External tools unregistered"));
                return true;
            })),
            pending: (input, context) => reply(context, async () => {
                const { sessionID } = input;
                await requireSession(sessionID);
                return { calls: structuredClone([...pending.values()].filter((entry) => entry.call.sessionID === sessionID).map((entry) => entry.call)) };
            }),
            resolve: (input, context) => reply(context, async () => {
                const { sessionID, callID, result, error } = input;
                await requireSession(sessionID);
                if ((result === undefined) === (error === undefined))
                    throw new BridgeError("invalid_request", "Provide exactly one of result or error");
                const entry = pending.get(callID);
                if (!entry || entry.call.sessionID !== sessionID)
                    throw new BridgeError("not_found", "Call is no longer pending in this session");
                if (Date.now() >= entry.call.expiresAt) {
                    entry.settle(undefined, new Error("External tool timed out"));
                    throw new BridgeError("not_found", "Call has expired");
                }
                entry.settle(result, error === undefined ? undefined : new Error(error));
                return true;
            }),
        });
        await ctx.tool.transform((editor) => {
            for (const [sessionID, catalog] of catalogs)
                for (const tool of catalog) {
                    editor.add({
                        name: tool.id,
                        description: tool.description,
                        input: tool.input,
                        options: { codemode: false, permission: tool.name },
                        execute: async (input, context) => {
                            await requireSession(context.sessionID);
                            if (closed || context.sessionID !== sessionID || catalogs.get(sessionID) !== catalog)
                                throw new Error("External tool is not registered for this session/request");
                            if (context.signal.aborted)
                                throw new Error("External tool call cancelled");
                            // baza: bounded process-local queue; add backpressure or a durable worker queue beyond 256 concurrent calls.
                            if (pending.size >= 256)
                                throw new Error("Too many pending external tool calls");
                            const createdAt = Date.now();
                            const call = {
                                sessionID,
                                messageID: context.messageID,
                                callID: crypto.randomUUID(),
                                toolCallID: context.id,
                                tool: tool.name,
                                arguments: structuredClone(input),
                                createdAt,
                                expiresAt: createdAt + timeoutMs,
                            };
                            const result = await new Promise((accept, reject) => {
                                const abort = () => settle(undefined, new Error("External tool call cancelled"));
                                const timer = setTimeout(() => settle(undefined, new Error(`External tool timed out after ${timeoutMs}ms`)), timeoutMs);
                                function settle(result, error) {
                                    if (!pending.delete(call.callID))
                                        return;
                                    clearTimeout(timer);
                                    context.signal.removeEventListener("abort", abort);
                                    if (error)
                                        reject(error);
                                    else
                                        accept(result);
                                }
                                pending.set(call.callID, { call, settle });
                                context.signal.addEventListener("abort", abort, { once: true });
                                if (context.signal.aborted)
                                    abort();
                                else
                                    void rpc.events.emit("requested", { ...call }).catch((error) => settle(undefined, error instanceof Error ? error : new Error(String(error))));
                            });
                            return {
                                content: result.output,
                                metadata: { ...result.metadata, title: result.title ?? tool.name, externalTool: tool.name, externalCallID: call.callID },
                            };
                        },
                    });
                }
        });
        await ctx.session.hook("context", (event) => {
            const catalog = catalogs.get(event.sessionID);
            const allowed = new Map(catalog?.map((tool) => [tool.id, tool.name]));
            for (const [id, definition] of Object.entries(event.tools)) {
                if (!id.startsWith(prefix))
                    continue;
                delete event.tools[id];
                const name = allowed.get(id);
                if (name === undefined)
                    continue;
                if (Object.hasOwn(event.tools, name))
                    throw new Error(`External tool conflicts with another tool: ${name}`);
                // Preserve object identity: OpenCode maps this public alias back to the captured executor.
                event.tools[name] = definition;
            }
        });
        return async () => {
            closed = true;
            for (const entry of pending.values())
                entry.settle(undefined, new Error("External tools plugin unloaded"));
            await updates;
            catalogs.clear();
        };
    },
});
