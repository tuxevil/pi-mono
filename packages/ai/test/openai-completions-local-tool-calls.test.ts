import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { AssistantMessageEvent, Context, Model, OpenAICompletionsCompat } from "../src/types.js";

const compat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: true,
} satisfies Required<Omit<OpenAICompletionsCompat, "cacheControlFormat">> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

function buildModel(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "repro-model",
		name: "Repro Model",
		api: "openai-completions",
		provider: "repro-provider",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat,
	};
}

function buildContext(): Context {
	return {
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
	};
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

describe("openai-completions local tool calls parsing", () => {
	afterEach(() => {
		delete process.env.OPENAI_API_KEY;
	});

	it("parses and cleans markdown-wrapped JSON tool calls", async () => {
		const server = http.createServer(async (req, res) => {
			if (req.method !== "POST" || req.url !== "/chat/completions") {
				res.writeHead(404).end();
				return;
			}

			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});

			const chunks = [
				"I will execute a command.\n\n```json\n",
				'{\n  "tool_calls": [\n    {\n      "name": "bash",\n      "arguments": {\n        "command": "echo \\"hello\\""\n      }\n    }\n  ]\n}',
				"\n```\nAll done!",
			];

			for (const chunk of chunks) {
				res.write(
					`data: ${JSON.stringify({
						id: "chatcmpl-repro",
						object: "chat.completion.chunk",
						created: 0,
						model: "repro-model",
						choices: [{ index: 0, delta: { role: "assistant", content: chunk }, finish_reason: null }],
					})}\n\n`,
				);
			}

			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-repro",
					object: "chat.completion.chunk",
					created: 0,
					model: "repro-model",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				})}\n\n`,
			);
			res.write("data: [DONE]\n\n");
			res.end();
		});

		server.listen(0, "127.0.0.1");
		await once(server, "listening");

		try {
			const { port } = server.address() as AddressInfo;
			const stream = streamOpenAICompletions(buildModel(`http://127.0.0.1:${port}`), buildContext(), {
				apiKey: "test-key",
			});
			const events = await collectEvents(stream);
			const finalMessage = await stream.result();

			// Text should be cleaned up (no code block, just pre and post text)
			const cleanTextParts = finalMessage.content.filter((c) => c.type === "text").map((c: any) => c.text);
			expect(cleanTextParts).toContain("I will execute a command.\n\nAll done!");

			// Tool call should be successfully parsed
			const toolCalls = finalMessage.content.filter((c) => c.type === "toolCall");
			expect(toolCalls).toHaveLength(1);
			expect(toolCalls[0]).toEqual({
				type: "toolCall",
				id: expect.any(String),
				name: "bash",
				arguments: { command: 'echo "hello"' },
			});

			// Should have toolcall events in the stream
			const toolcallStartEvent = events.find((e) => e.type === "toolcall_start");
			const toolcallEndEvent = events.find((e) => e.type === "toolcall_end");
			expect(toolcallStartEvent).toBeDefined();
			expect(toolcallEndEvent).toBeDefined();
		} finally {
			server.close();
			await once(server, "close");
		}
	});

	it("parses and cleans plain raw JSON tool calls without markdown code blocks", async () => {
		const server = http.createServer(async (req, res) => {
			if (req.method !== "POST" || req.url !== "/chat/completions") {
				res.writeHead(404).end();
				return;
			}

			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});

			const chunks = [
				'{\n  "tool_calls": [\n    {\n      "name": "read",\n      "arguments": {\n        "path": "test.txt"\n      }\n    }\n  ]\n}',
			];

			for (const chunk of chunks) {
				res.write(
					`data: ${JSON.stringify({
						id: "chatcmpl-repro",
						object: "chat.completion.chunk",
						created: 0,
						model: "repro-model",
						choices: [{ index: 0, delta: { role: "assistant", content: chunk }, finish_reason: null }],
					})}\n\n`,
				);
			}

			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-repro",
					object: "chat.completion.chunk",
					created: 0,
					model: "repro-model",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				})}\n\n`,
			);
			res.write("data: [DONE]\n\n");
			res.end();
		});

		server.listen(0, "127.0.0.1");
		await once(server, "listening");

		try {
			const { port } = server.address() as AddressInfo;
			const stream = streamOpenAICompletions(buildModel(`http://127.0.0.1:${port}`), buildContext(), {
				apiKey: "test-key",
			});
			const finalMessage = await stream.result();

			// Text blocks should be empty since entire response was parsed as JSON tool_calls
			const cleanTextParts = finalMessage.content.filter((c) => c.type === "text").map((c: any) => c.text);
			expect(cleanTextParts).toHaveLength(0);

			// Tool call should be successfully parsed
			const toolCalls = finalMessage.content.filter((c) => c.type === "toolCall");
			expect(toolCalls).toHaveLength(1);
			expect(toolCalls[0]).toEqual({
				type: "toolCall",
				id: expect.any(String),
				name: "read",
				arguments: { path: "test.txt" },
			});
		} finally {
			server.close();
			await once(server, "close");
		}
	});
});
