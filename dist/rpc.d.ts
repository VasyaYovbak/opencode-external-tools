export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
export interface Call {
    sessionID: string;
    messageID: string;
    callID: string;
    toolCallID: string;
    tool: string;
    arguments: Record<string, unknown>;
    createdAt: number;
    expiresAt: number;
}
export interface Result {
    output: string;
    title?: string;
    metadata?: Record<string, unknown>;
}
export interface Resolution {
    sessionID: string;
    callID: string;
    result?: Result;
    error?: string;
}
export declare const ExternalTools: {
    readonly id: "external_tools";
    readonly methods: {
        readonly register: {
            readonly input: {
                readonly type: "object";
                readonly properties: {
                    readonly tools: {
                        readonly type: "array";
                        readonly maxItems: 64;
                        readonly items: {
                            readonly type: "object";
                            readonly properties: {
                                readonly name: {
                                    readonly type: "string";
                                    readonly minLength: 1;
                                    readonly maxLength: 64;
                                };
                                readonly description: {
                                    readonly type: "string";
                                    readonly minLength: 1;
                                };
                                readonly inputSchema: {
                                    readonly type: "object";
                                    readonly additionalProperties: true;
                                };
                            };
                            readonly required: readonly ["name", "description", "inputSchema"];
                            readonly additionalProperties: false;
                        };
                    };
                    readonly sessionID: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                };
                readonly required: readonly ["sessionID", "tools"];
                readonly additionalProperties: false;
            };
            readonly output: {
                readonly type: "object";
                readonly properties: {
                    readonly tools: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                    };
                    readonly sessionID: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                };
                readonly required: readonly ["sessionID", "tools"];
                readonly additionalProperties: false;
            };
            readonly errors: {
                readonly invalid_request: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                };
                readonly not_found: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                };
                readonly conflict: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                };
            };
        };
        readonly unregister: {
            readonly input: {
                readonly type: "object";
                readonly properties: {
                    sessionID: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                };
                readonly required: readonly ["sessionID"];
                readonly additionalProperties: false;
            };
            readonly output: {
                readonly type: "boolean";
            };
            readonly errors: {
                readonly invalid_request: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                };
                readonly not_found: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                };
                readonly conflict: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                };
            };
        };
        readonly pending: {
            readonly input: {
                readonly type: "object";
                readonly properties: {
                    sessionID: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                };
                readonly required: readonly ["sessionID"];
                readonly additionalProperties: false;
            };
            readonly output: {
                readonly type: "object";
                readonly properties: {
                    readonly calls: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "object";
                            readonly properties: {
                                readonly messageID: {
                                    readonly type: "string";
                                    readonly minLength: 1;
                                };
                                readonly callID: {
                                    readonly type: "string";
                                    readonly minLength: 1;
                                };
                                readonly toolCallID: {
                                    readonly type: "string";
                                    readonly minLength: 1;
                                };
                                readonly tool: {
                                    readonly type: "string";
                                    readonly minLength: 1;
                                };
                                readonly arguments: {
                                    readonly type: "object";
                                    readonly additionalProperties: true;
                                };
                                readonly createdAt: {
                                    readonly type: "number";
                                };
                                readonly expiresAt: {
                                    readonly type: "number";
                                };
                                readonly sessionID: {
                                    readonly type: "string";
                                    readonly minLength: 1;
                                };
                            };
                            readonly required: readonly ["sessionID", "messageID", "callID", "toolCallID", "tool", "arguments", "createdAt", "expiresAt"];
                            readonly additionalProperties: false;
                        };
                    };
                };
                readonly required: readonly ["calls"];
                readonly additionalProperties: false;
            };
            readonly errors: {
                readonly invalid_request: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                };
                readonly not_found: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                };
                readonly conflict: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                };
            };
        };
        readonly resolve: {
            readonly input: {
                readonly type: "object";
                readonly properties: {
                    readonly callID: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly result: {
                        readonly type: "object";
                        readonly properties: {
                            readonly output: {
                                readonly type: "string";
                            };
                            readonly title: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                            readonly metadata: {
                                readonly type: "object";
                                readonly additionalProperties: true;
                            };
                        };
                        readonly required: readonly ["output"];
                        readonly additionalProperties: false;
                    };
                    readonly error: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly sessionID: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                };
                readonly required: readonly ["sessionID", "callID"];
                readonly additionalProperties: false;
            };
            readonly output: {
                readonly type: "boolean";
            };
            readonly errors: {
                readonly invalid_request: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                };
                readonly not_found: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                };
                readonly conflict: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                };
            };
        };
    };
    readonly events: {
        readonly requested: {
            readonly schema: {
                readonly type: "object";
                readonly properties: {
                    readonly messageID: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly callID: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly toolCallID: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly tool: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly arguments: {
                        readonly type: "object";
                        readonly additionalProperties: true;
                    };
                    readonly createdAt: {
                        readonly type: "number";
                    };
                    readonly expiresAt: {
                        readonly type: "number";
                    };
                    readonly sessionID: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                };
                readonly required: readonly ["sessionID", "messageID", "callID", "toolCallID", "tool", "arguments", "createdAt", "expiresAt"];
                readonly additionalProperties: false;
            };
        };
    };
};
