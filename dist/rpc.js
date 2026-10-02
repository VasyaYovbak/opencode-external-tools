import { Rpc } from "@opencode/plugin/rpc";
const string = { type: "string", minLength: 1 };
const object = { type: "object", additionalProperties: true };
const session = { sessionID: string };
const errors = {
    invalid_request: { type: "object", additionalProperties: false },
    not_found: { type: "object", additionalProperties: false },
    conflict: { type: "object", additionalProperties: false },
};
const call = {
    type: "object",
    properties: {
        ...session,
        messageID: string,
        callID: string,
        toolCallID: string,
        tool: string,
        arguments: object,
        createdAt: { type: "number" },
        expiresAt: { type: "number" },
    },
    required: ["sessionID", "messageID", "callID", "toolCallID", "tool", "arguments", "createdAt", "expiresAt"],
    additionalProperties: false,
};
export const ExternalTools = Rpc.define({
    id: "external_tools",
    methods: {
        register: {
            input: {
                type: "object",
                properties: {
                    ...session,
                    tools: {
                        type: "array",
                        maxItems: 64,
                        items: {
                            type: "object",
                            properties: {
                                name: { type: "string", minLength: 1, maxLength: 64 },
                                description: string,
                                inputSchema: object,
                            },
                            required: ["name", "description", "inputSchema"],
                            additionalProperties: false,
                        },
                    },
                },
                required: ["sessionID", "tools"],
                additionalProperties: false,
            },
            output: {
                type: "object",
                properties: { ...session, tools: { type: "array", items: string } },
                required: ["sessionID", "tools"],
                additionalProperties: false,
            },
            errors,
        },
        unregister: {
            input: { type: "object", properties: session, required: ["sessionID"], additionalProperties: false },
            output: { type: "boolean" },
            errors,
        },
        pending: {
            input: { type: "object", properties: session, required: ["sessionID"], additionalProperties: false },
            output: {
                type: "object",
                properties: { calls: { type: "array", items: call } },
                required: ["calls"],
                additionalProperties: false,
            },
            errors,
        },
        resolve: {
            input: {
                type: "object",
                properties: {
                    ...session,
                    callID: string,
                    result: {
                        type: "object",
                        properties: { output: { type: "string" }, title: string, metadata: object },
                        required: ["output"],
                        additionalProperties: false,
                    },
                    error: string,
                },
                required: ["sessionID", "callID"],
                additionalProperties: false,
            },
            output: { type: "boolean" },
            errors,
        },
    },
    events: { requested: { schema: call } },
});
