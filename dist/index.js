import { Plugin } from "@opencode/plugin";
import { JsonSchema, Schema, SchemaRepresentation } from "effect";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
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
        const codemode = ctx.options.codemode ?? true;
        if (typeof codemode !== "boolean")
            throw new Error("external-tools: codemode must be a boolean");
        // baza: catalogs and pending calls are process-local; durable restart recovery needs a persisted queue and replay protocol.
        const catalogs = new Map();
        const pending = new Map();
        const ui = new Map();
        const prefix = `ext_${crypto.randomUUID().replaceAll("-", "")}_`;
        const permissionPrefix = "external_tools_session_";
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
            return session;
        }
        async function scopePermissions(sessionID, agentID) {
            if (!codemode)
                return new Set();
            // baza: native updates replace full rulesets; serialize client policy edits until Core offers scoped/CAS updates.
            const { data: agents } = await ctx.agent.list();
            const session = await requireSession(sessionID);
            const permissions = (session.permissions ?? []).filter((rule) => !rule.action.startsWith(permissionPrefix));
            const selected = agentID ?? session.agent;
            const agent = selected ? agents.find((agent) => agent.id === selected) : agents[0];
            const rules = [...(agent?.permissions ?? [{ action: "*", resource: "*", effect: "deny" }]), ...permissions];
            const scoped = [
                ...permissions,
                { action: `${permissionPrefix}*`, resource: "*", effect: "deny" },
                ...(catalogs.get(sessionID) ?? []).map((tool) => {
                    // Match Core's whole-tool filtering, but retain the public-name permission policy.
                    const rule = rules.findLast((rule) => {
                        const pattern = rule.action.replaceAll("\\", "/")
                            .replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".").replace(/ \.\*$/, "( .*)?");
                        return new RegExp(`^${pattern}$`, process.platform === "win32" ? "si" : "s").test(tool.name);
                    });
                    return { action: tool.permission, resource: rule?.resource ?? "*", effect: rule?.effect ?? "allow" };
                }),
            ];
            if (JSON.stringify(scoped) !== JSON.stringify(session.permissions))
                await ctx.session.update({ sessionID, permissions: scoped });
            return new Set(scoped.filter((rule) => rule.action.startsWith(permissionPrefix) && rule.effect === "deny" && rule.resource === "*").map((rule) => rule.action));
        }
        async function replace(sessionID, tools) {
            const previous = catalogs.get(sessionID);
            if (tools)
                catalogs.set(sessionID, tools);
            else
                catalogs.delete(sessionID);
            try {
                await ctx.tool.reload();
                await scopePermissions(sessionID);
            }
            catch (error) {
                if (previous)
                    catalogs.set(sessionID, previous);
                else
                    catalogs.delete(sessionID);
                await ctx.tool.reload();
                await scopePermissions(sessionID);
                throw error;
            }
        }
        // Native snapshot filtering runs before Code Mode catalog construction, unlike the context hook.
        if (codemode)
            await ctx.agent.transform((editor) => {
                for (const agent of editor.list())
                    editor.update(String(agent.id), (agent) => {
                        agent.permissions.push({ action: `${permissionPrefix}*`, resource: "*", effect: "deny" });
                    });
            });
        const rpc = await ctx.rpc.register(ExternalTools, {
            register: (input, context) => reply(context, () => update(async () => {
                const { sessionID, tools } = input;
                await requireSession(sessionID);
                // baza: bounded catalogs, 64 tools/session; add configurable limits/pagination for larger inventories.
                if (tools.length > 0 && !catalogs.has(sessionID) && catalogs.size >= 128)
                    throw new BridgeError("conflict", "Too many registered sessions; unregister unused sessions");
                if (tools.length > 64)
                    throw new BridgeError("invalid_request", "At most 64 tools per session");
                const native = new Set((await ctx.tool.list()).filter((tool) => !tool.id.startsWith(prefix) && !tool.options?.permission?.startsWith(permissionPrefix)).map((tool) => tool.id));
                const names = new Set();
                const generation = crypto.randomUUID().replaceAll("-", "");
                const namespace = `external.s_${createHash("sha256").update(sessionID).digest("hex").slice(0, 32)}`;
                const registered = tools.map((tool, index) => {
                    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(tool.name) || tool.name.startsWith(permissionPrefix) || tool.name === "execute" || native.has(tool.name) || native.has(`${namespace.replaceAll(".", "_")}_${tool.name}`))
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
                        return { ...tool, inputSchema: schema, input: codec, id: `${prefix}${generation}_${index}`, namespace, permission: `${permissionPrefix}${namespace.slice("external.".length)}_${tool.name}` };
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
            if (codemode)
                editor.namespace({ name: "external", description: "External tools registered for this session" });
            for (const [sessionID, catalog] of catalogs)
                for (const tool of catalog) {
                    // Host and plugin can load different Effect instances; validate locally through the portable boundary.
                    const input = { "~standard": {
                            ...Schema.toStandardSchemaV1(tool.input)["~standard"],
                            jsonSchema: { input: () => tool.inputSchema, output: () => tool.inputSchema },
                        } };
                    editor.add({
                        name: codemode ? tool.name : tool.id,
                        description: tool.description,
                        input,
                        options: codemode
                            ? { namespace: tool.namespace, codemode: true, permission: tool.permission }
                            : { codemode: false, permission: tool.name },
                        execute: async (input, context) => {
                            await requireSession(context.sessionID);
                            const denied = codemode && context.sessionID === sessionID
                                ? await update(() => scopePermissions(context.sessionID, context.agent)) : undefined;
                            // Recheck after the policy await: registration may have changed while this invocation waited.
                            if (closed || context.sessionID !== sessionID || catalogs.get(sessionID) !== catalog)
                                throw new Error("External tool is not registered for this session/request");
                            if (denied?.has(tool.permission))
                                throw new Error(`External tool is denied: ${tool.name}`);
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
        if (codemode) {
            // Code Mode keeps nested content but drops nested metadata. Attach only UI embeds
            // to the outer execute result, not to the text returned to the model.
            await ctx.tool.hook("execute.before", (event) => {
                if (event.tool !== "execute" || !catalogs.has(event.sessionID))
                    return;
                const key = JSON.stringify([event.sessionID, event.messageID, event.id]);
                const previous = ui.get(key);
                if (previous)
                    clearTimeout(previous.timer);
                // baza: interrupted execute may skip execute.after; expire after an hour until Core forwards child metadata itself.
                const timer = setTimeout(() => ui.delete(key), 3_600_000);
                timer.unref();
                ui.set(key, { embeds: [], timer });
            });
            await ctx.tool.hook("execute.after", (event) => {
                const key = JSON.stringify([event.sessionID, event.messageID, event.id]);
                const entry = ui.get(key);
                if (!entry)
                    return;
                if (event.tool === "execute") {
                    clearTimeout(entry.timer);
                    ui.delete(key);
                    if (event.status !== "completed" || !entry.embeds.length)
                        return;
                    const existing = event.result.metadata?.embeds;
                    const embeds = Array.isArray(existing) && existing.every((item) => typeof item === "string") ? existing : [];
                    event.result = { ...event.result, metadata: { ...event.result.metadata, embeds: [...embeds, ...entry.embeds.filter((item) => !embeds.includes(item))] } };
                    return;
                }
                if (event.status !== "completed")
                    return;
                const embeds = event.result.metadata?.embeds;
                if (!Array.isArray(embeds) || !embeds.every((item) => typeof item === "string"))
                    return;
                if (!catalogs.get(event.sessionID)?.some((tool) => event.tool === `${tool.namespace.replaceAll(".", "_")}_${tool.name}` && event.result.metadata?.externalTool === tool.name))
                    return;
                entry.embeds.push(...embeds);
            });
        }
        // Child sessions inherit native permissions, not external catalogs; strip inherited grants before selection.
        if (codemode)
            await ctx.session.hook("prompt", async (event) => { await update(() => scopePermissions(event.sessionID)); });
        await ctx.session.hook("context", (event) => {
            if (codemode)
                return update(async () => { await scopePermissions(event.sessionID, event.agent); });
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
            for (const entry of ui.values())
                clearTimeout(entry.timer);
            ui.clear();
            await updates;
            catalogs.clear();
        };
    },
});
