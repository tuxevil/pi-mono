import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import "../../src/app.css";
import { Agent, type AgentMessage } from "@mariozechner/pi-agent-core";
import {
	createAssistantMessageEventStream,
	getModel,
	getModels,
	getProviders,
	registerApiProvider,
	registerModel,
} from "@mariozechner/pi-ai";
import {
	type AgentState,
	ApiKeyPromptDialog,
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	createJavaScriptReplTool,
	IndexedDBStorageBackend,
	ModelSelector,
	// PersistentStorageDialog, // TODO: Fix - currently broken
	ProviderKeysStore,
	ProvidersModelsTab,
	ProxyTab,
	SessionListDialog,
	SessionsStore,
	SettingsDialog,
	SettingsStore,
	setAppStorage,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { Bell, History, Plus, Settings } from "lucide";
import "./app.css";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import type { StorageBackend, StorageTransaction } from "@mariozechner/pi-web-ui";
import { createSystemNotification, customConvertToLlm, registerCustomMessageRenderers } from "./custom-messages.js";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

class RemoteStorageBackend implements StorageBackend {
	constructor(private agentName: string) {}

	async get<T = unknown>(storeName: string, key: string): Promise<T | null> {
		if (storeName === "sessions") {
			const response = await fetch(`/api/sessions/${key}?agent=${this.agentName}`);
			if (response.ok) return (await response.json()) as T;
		}
		if (storeName === "sessions-metadata") {
			const sessions = await this.getAllFromIndex<any>("sessions-metadata", "lastModified", "desc");
			return (sessions.find((s) => s.id === key) as T) || null;
		}
		return null;
	}

	async getAll<T = unknown>(storeName: string): Promise<T[]> {
		if (storeName === "sessions-metadata") {
			const response = await fetch(`/api/sessions?agent=${this.agentName}`);
			if (response.ok) return (await response.json()) as T[];
		}
		return [];
	}

	async set<T = unknown>(storeName: string, key: string, value: T): Promise<void> {
		if (storeName === "sessions") {
			await fetch(`/api/sessions/${key}?agent=${this.agentName}`, {
				method: "POST",
				body: JSON.stringify(value),
			});
		}
	}

	async delete(_storeName: string, _key: string): Promise<void> {
		// Not essential for now
	}

	async keys(_storeName: string, _prefix?: string): Promise<string[]> {
		return [];
	}

	async getAllFromIndex<T = unknown>(
		storeName: string,
		_indexName: string,
		_direction?: "asc" | "desc",
	): Promise<T[]> {
		return this.getAll<T>(storeName);
	}

	async clear(_storeName: string): Promise<void> {}

	async has(storeName: string, key: string): Promise<boolean> {
		return (await this.get(storeName, key)) !== null;
	}

	async transaction<T>(
		_storeNames: string[],
		_mode: "readonly" | "readwrite",
		operation: (tx: StorageTransaction) => Promise<T>,
	): Promise<T> {
		const tx: StorageTransaction = {
			get: (s, k) => this.get(s, k),
			set: (s, k, v) => this.set(s, k, v),
			delete: (s, k) => this.delete(s, k),
		};
		return operation(tx);
	}

	async getQuotaInfo() {
		return { usage: 0, quota: 0, percent: 0 };
	}

	async requestPersistence() {
		return true;
	}
}

// Register custom message renderers
registerCustomMessageRenderers();

// Create stores
const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

// Gather configs
const configs = [
	settings.getConfig(),
	SessionsStore.getMetadataConfig(),
	providerKeys.getConfig(),
	customProviders.getConfig(),
	sessions.getConfig(),
];

// Create backend
const backend = new IndexedDBStorageBackend({
	dbName: "pi-web-ui-example",
	version: 2, // Incremented for custom-providers store
	stores: configs,
});

// Wire backend to stores
settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);

// Create and set app storage
const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage);

let currentSessionId: string | undefined;
let currentTitle = "";
let isEditingTitle = false;
let agent: Agent;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;
let availableAgents: string[] = [];
let selectedAgent = "";
let globalSettings: any = null;
let currentAgentName: string = "";
let agentTools: any[] = [];

const generateTitle = (messages: AgentMessage[]): string => {
	const firstUserMsg = messages.find((m) => m.role === "user" || m.role === "user-with-attachments");
	if (!firstUserMsg || (firstUserMsg.role !== "user" && firstUserMsg.role !== "user-with-attachments")) return "";

	let text = "";
	const content = firstUserMsg.content;

	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = content.filter((c: any) => c.type === "text");
		text = textBlocks.map((c: any) => c.text || "").join(" ");
	}

	text = text.trim();
	if (!text) return "";

	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) {
		return text.substring(0, sentenceEnd + 1);
	}
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
};

const shouldSaveSession = (messages: AgentMessage[]): boolean => {
	const hasUserMsg = messages.some((m: any) => m.role === "user" || m.role === "user-with-attachments");
	const hasAssistantMsg = messages.some((m: any) => m.role === "assistant");
	return hasUserMsg && hasAssistantMsg;
};

const saveSession = async () => {
	if (!storage.sessions || !currentSessionId || !agent || !currentTitle) return;

	const state = agent.state;
	if (!shouldSaveSession(state.messages)) return;

	try {
		// Create session data
		const sessionData = {
			...state.model, // Ensure model info is in the session file for CLI compatibility
			id: currentSessionId,
			title: currentTitle,
			model: state.model!,
			thinkingLevel: state.thinkingLevel,
			messages: state.messages,
			createdAt: new Date().toISOString(),
			lastModified: new Date().toISOString(),
		};

		// Create session metadata
		const metadata = {
			id: currentSessionId,
			title: currentTitle,
			createdAt: sessionData.createdAt,
			lastModified: sessionData.lastModified,
			messageCount: state.messages.length,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			modelId: state.model?.id || null,
			thinkingLevel: state.thinkingLevel,
			preview: generateTitle(state.messages),
		};

		await storage.sessions.save(sessionData, metadata);
	} catch (err) {
		console.error("Failed to save session:", err);
	}
};

const getAgentConfig = () => ({
	onModelSelect: () => {
		console.log("Model selector requested. globalSettings:", globalSettings);
		console.log("Enabled models:", globalSettings?.enabledModels);
		(ModelSelector as any).open(
			agent.state.model,
			(model: any) => {
				console.log("Model selected:", model);
				agent.state.model = model;
			},
			undefined,
			globalSettings?.enabledModels,
		);
	},
	onApiKeyRequired: async (provider: string) => {
		const proxiedProviders = [
			"anthropic",
			"openai",
			"mistral",
			"google",
			"google-antigravity",
			"ollama",
			"amazon-bedrock",
			"kimi-coding",
			"minimax",
			"minimax-cn",
			"cerebras",
			"groq",
			"fireworks",
			"xai",
			"zai",
			"huggingface",
			"github-copilot",
			"openrouter",
		];
		if (proxiedProviders.includes(provider)) {
			return true;
		}
		return await ApiKeyPromptDialog.prompt(provider);
	},
	toolsFactory: (_agent: any, _agentInterface: any, _artifactsPanel: any, runtimeProvidersFactory: any) => {
		const createRemoteTool = (name: string, description: string, parameters: any): any => {
			return {
				name,
				description,
				parameters,
				execute: async (_toolCallId: string, args: any, signal?: AbortSignal) => {
					console.log(`[Remote Tool] Executing ${name} for agent ${currentAgentName} with args:`, args);
					const response = await fetch(`/api/tools/execute?agent=${currentAgentName}`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ toolCallId: _toolCallId, toolName: name, args, cwd: "/root/pi-mono" }), // Default CWD
						signal,
					});
					const data = await response.json();
					if (data.error) {
						return `Error: ${data.error}`;
					}
					return data.result;
				},
			};
		};

		const replTool = createJavaScriptReplTool();
		replTool.runtimeProvidersFactory = runtimeProvidersFactory;

		return [
			replTool,
			createRemoteTool("bash", "Run a bash command in the project directory", {
				type: "object",
				properties: {
					command: { type: "string", description: "The command to run" },
				},
				required: ["command"],
			}),
			createRemoteTool("read", "Read the content of a file", {
				type: "object",
				properties: {
					path: { type: "string", description: "The path to the file" },
					startLine: { type: "number", description: "Optional start line" },
					endLine: { type: "number", description: "Optional end line" },
				},
				required: ["path"],
			}),
			createRemoteTool("write", "Write content to a file", {
				type: "object",
				properties: {
					path: { type: "string", description: "The path to the file" },
					content: { type: "string", description: "The content to write" },
				},
				required: ["path", "content"],
			}),
			createRemoteTool("ls", "List files in a directory", {
				type: "object",
				properties: {
					path: { type: "string", description: "The path to the directory" },
				},
				required: ["path"],
			}),
			createRemoteTool("grep", "Search for a pattern in files", {
				type: "object",
				properties: {
					query: { type: "string", description: "The search query" },
					path: { type: "string", description: "The path to search in" },
				},
				required: ["query", "path"],
			}),
			createRemoteTool("find", "Find files in a directory", {
				type: "object",
				properties: {
					path: { type: "string", description: "The path to the directory" },
				},
				required: ["path"],
			}),
			createRemoteTool(
				"edit",
				"Edit a file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file.",
				{
					type: "object",
					properties: {
						path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
						edits: {
							type: "array",
							items: {
								type: "object",
								properties: {
									oldText: { type: "string", description: "Exact text for one targeted replacement." },
									newText: { type: "string", description: "Replacement text for this targeted edit." },
								},
								required: ["oldText", "newText"],
							},
							description: "One or more targeted replacements.",
						},
					},
					required: ["path", "edits"],
				},
			),
			...agentTools.map((t: any) => createRemoteTool(t.name, t.description, t.parameters)),
		];
	},
});

const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.history.replaceState({}, "", url);
};

const createAgent = async (initialState?: Partial<AgentState>) => {
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}

	const streamFn = (model: any, context: any, options: any) => {
		console.log("AGENT PROXY STREAM CALLED for model:", model.id);
		const stream = createAssistantMessageEventStream();
		let finalMessage: any = null;

		(async () => {
			try {
				const response = await fetch("/api/ai/stream", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ model, context, options }),
					signal: options?.signal,
				});

				if (!response.ok) {
					throw new Error(`AI Proxy error: ${await response.text()}`);
				}

				const reader = response.body?.getReader();
				if (!reader) throw new Error("No response body");

				const decoder = new TextDecoder();
				let buffer = "";

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";

					for (const line of lines) {
						if (!line.startsWith("data:")) continue;
						const event = JSON.parse(line.slice(5).trim());
						console.log(`[Stream Event Pushed]`, JSON.stringify(event));
						stream.push(event);
						if (event.type === "done" || event.type === "error") {
							finalMessage = event.message || (event.type === "error" ? event.error : null);
						}
					}
				}
				stream.end();
			} catch (err: any) {
				if (err.name === "AbortError") {
					finalMessage = {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: EMPTY_USAGE,
						stopReason: "aborted",
						timestamp: Date.now(),
					};
					stream.end();
					return;
				}
				console.error("Proxy stream error:", err);
				const errorEvent = {
					type: "error",
					reason: "error",
					error: {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "error",
						errorMessage: err.message,
						timestamp: Date.now(),
					},
				};
				finalMessage = errorEvent.error;
				stream.push(errorEvent as any);
				stream.end();
			}
		})();

		// Implement result() for Agent compatibility
		(stream as any).result = async () => {
			while (!finalMessage) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			return finalMessage;
		};

		return stream;
	};

	agent = new Agent({
		streamFn,
		initialState: initialState || {
			systemPrompt: `You are a helpful AI assistant with access to various tools.
Your name is Antigravity. You are a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.

Available tools:
- bash: Run shell commands
- read: Read file contents
- write: Create or overwrite files
- ls: List directory contents
- grep: Search for text patterns
- find: Find files by name
- edit: Apply smart edits to files using instructions
- JavaScript REPL: Execute JavaScript code in a sandboxed browser environment (can do calculations, get time, process data, create visualizations, etc.)
- Artifacts: Create interactive HTML, SVG, Markdown, and text artifacts

Feel free to use these tools when needed to provide accurate and helpful responses.`,
			model: getModel("anthropic", "claude-sonnet-4-5-20250929"),
			thinkingLevel: "off",
			messages: [],
			tools: [],
		},
		// Custom transformer: convert custom messages to LLM-compatible format
		convertToLlm: customConvertToLlm,
	});

	agentUnsubscribe = agent.subscribe(async (event: any) => {
		console.log(`[Main Agent Subscriber] Event: ${event.type}. isStreaming: ${agent.state.isStreaming}`);

		const messages = agent.state.messages;

		// Generate title after first successful response
		if (!currentTitle && shouldSaveSession(messages)) {
			currentTitle = await generateTitle(messages);
		}

		// Create session ID on first successful save
		if (!currentSessionId && shouldSaveSession(messages)) {
			currentSessionId = (crypto as any).randomUUID
				? crypto.randomUUID()
				: Math.random().toString(36).substring(2) + Date.now().toString(36);
			updateUrl(currentSessionId);
		}

		// Auto-save
		if (currentSessionId) {
			saveSession();
		}

		renderApp();
	});

	console.log("Available providers:", getProviders());
	const defaultProvider = "anthropic";
	console.log(`Models for ${defaultProvider}:`, getModels(defaultProvider as any));

	await chatPanel.setAgent(agent, getAgentConfig());
};

const registerProxyProviders = async () => {
	const apis: any[] = [
		"anthropic-messages",
		"openai-completions",
		"mistral-conversations",
		"openai-responses",
		"azure-openai-responses",
		"openai-codex-responses",
		"google-generative-ai",
		"google-gemini-cli",
		"google-vertex",
		"bedrock-converse-stream",
		"anthropic",
		"openai",
		"mistral",
		"google",
		"google-antigravity",
		"ollama",
		"amazon-bedrock",
		"kimi-coding",
		"minimax",
		"minimax-cn",
		"cerebras",
		"groq",
		"fireworks",
		"xai",
		"zai",
		"huggingface",
		"github-copilot",
		"openrouter",
	];

	const store = providerKeys;
	for (const api of apis) {
		console.log(`Setting PROXIED key for: ${api}`);
		await store.set(api, "PROXIED");
		const check = await store.get(api);
		console.log(`Verified key for ${api}: ${check}`);

		registerApiProvider({
			api,
			stream: (model: any, context: any, options: any) => {
				console.log("PROXIED STREAM CALLED for model:", model.id);
				const stream = createAssistantMessageEventStream();
				(async () => {
					try {
						const response = await fetch("/api/ai/stream", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ model, context, options }),
							signal: options?.signal,
						});

						if (!response.ok) {
							throw new Error(`AI Proxy error: ${await response.text()}`);
						}

						const reader = response.body?.getReader();
						if (!reader) throw new Error("No response body");

						const decoder = new TextDecoder();
						let buffer = "";

						while (true) {
							const { done, value } = await reader.read();
							if (done) break;

							buffer += decoder.decode(value, { stream: true });
							const lines = buffer.split("\n");
							buffer = lines.pop() || "";

							for (const line of lines) {
								if (!line.startsWith("data:")) continue;
								const event = JSON.parse(line.slice(5).trim());
								stream.push(event);
							}
						}
						stream.end();
					} catch (err: any) {
						if (err.name === "AbortError") {
							stream.end();
							return;
						}
						console.error("Proxy stream error:", err);
						stream.push({
							type: "error",
							reason: "error",
							error: {
								role: "assistant",
								content: [],
								api: model.api,
								provider: model.provider,
								model: model.id,
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
								stopReason: "error",
								errorMessage: err.message,
								timestamp: Date.now(),
							},
						});
						stream.end();
					}
				})();
				return stream;
			},
		} as any);
	}
};

const loadAgentConfig = async (agentName: string) => {
	if (!agentName) return;
	selectedAgent = agentName;

	try {
		const systemPromptPath = `/agentes/${agentName}/.pi/SYSTEM.md`;
		const settingsPath = `/agentes/${agentName}/.pi/settings.json`;

		const [promptResponse, settingsResponse, toolsResponse] = await Promise.all([
			fetch(systemPromptPath).then((r) => (r.ok ? r.text() : "")),
			fetch(settingsPath).then((r) => (r.ok ? r.json() : {})),
			fetch(`/api/tools?agent=${agentName}`).then((r) => (r.ok ? r.json() : [])),
		]);

		currentAgentName = agentName;
		agentTools = toolsResponse;

		const initialState: Partial<AgentState> = {
			systemPrompt: promptResponse || undefined,
			messages: [],
			tools: [],
		};

		// Switch to remote sessions for this agent
		const remoteBackend = new RemoteStorageBackend(agentName);
		const remoteSessions = new SessionsStore();
		remoteSessions.setBackend(remoteBackend);
		(storage as any).sessions = remoteSessions;

		if ((settingsResponse as any).model) {
			const { provider, model } = (settingsResponse as any).model;
			if (provider && model) {
				initialState.model = getModel(provider, model);
			}
		}

		await createAgent(initialState);
		currentTitle = `Agent: ${agentName}`;
		currentSessionId = undefined; // Start fresh session
		updateUrl("");
		renderApp();
	} catch (err) {
		console.error("Failed to load agent config:", err);
	}
};

const loadSession = async (sessionId: string): Promise<boolean> => {
	if (!storage.sessions) return false;

	const sessionData = await storage.sessions.get(sessionId);
	if (!sessionData) {
		console.error("Session not found:", sessionId);
		return false;
	}

	currentSessionId = sessionId;
	const metadata = await storage.sessions.getMetadata(sessionId);
	currentTitle = metadata?.title || "";

	await createAgent({
		model: sessionData.model,
		thinkingLevel: sessionData.thinkingLevel,
		messages: sessionData.messages,
		tools: [],
	});

	updateUrl(sessionId);
	renderApp();
	return true;
};

const newSession = () => {
	const url = new URL(window.location.href);
	url.search = "";
	window.location.href = url.toString();
};

// ============================================================================
// RENDER
// ============================================================================
const renderApp = () => {
	console.log("[renderApp] Called");
	const app = document.getElementById("app");
	if (!app) return;

	const appHtml = html`
		<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-border shrink-0">
				<div class="flex items-center gap-2 px-4 py-">
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(History, "sm"),
						onClick: () => {
							SessionListDialog.open(
								async (sessionId) => {
									await loadSession(sessionId);
								},
								(deletedSessionId) => {
									// Only reload if the current session was deleted
									if (deletedSessionId === currentSessionId) {
										newSession();
									}
								},
							);
						},
						title: "Sessions",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Plus, "sm"),
						onClick: newSession,
						title: "New Session",
					})}

					<select
						class="bg-background text-foreground border border-border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
						.value=${selectedAgent}
						@change=${(e: Event) => loadAgentConfig((e.target as HTMLSelectElement).value)}
					>
						<option value="">Select Agent...</option>
						${availableAgents.map(
							(name) => html`<option value=${name} ?selected=${name === selectedAgent}>${name}</option>`,
						)}
					</select>

					${
						currentTitle
							? isEditingTitle
								? html`<div class="flex items-center gap-2">
									${Input({
										type: "text",
										value: currentTitle,
										className: "text-sm w-64",
										onChange: async (e: Event) => {
											const newTitle = (e.target as HTMLInputElement).value.trim();
											if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
												await storage.sessions.updateTitle(currentSessionId, newTitle);
												currentTitle = newTitle;
											}
											isEditingTitle = false;
											renderApp();
										},
										onKeyDown: async (e: KeyboardEvent) => {
											if (e.key === "Enter") {
												const newTitle = (e.target as HTMLInputElement).value.trim();
												if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
													await storage.sessions.updateTitle(currentSessionId, newTitle);
													currentTitle = newTitle;
												}
												isEditingTitle = false;
												renderApp();
											} else if (e.key === "Escape") {
												isEditingTitle = false;
												renderApp();
											}
										},
									})}
								</div>`
								: html`<button
									class="px-2 py-1 text-sm text-foreground hover:bg-secondary rounded transition-colors"
									@click=${() => {
										isEditingTitle = true;
										renderApp();
										requestAnimationFrame(() => {
											const input = app?.querySelector('input[type="text"]') as HTMLInputElement;
											if (input) {
												input.focus();
												input.select();
											}
										});
									}}
									title="Click to edit title"
								>
									${currentTitle}
								</button>`
							: html`<span class="text-base font-semibold text-foreground">Pi Web UI Example</span>`
					}
				</div>
				<div class="flex items-center gap-1 px-2">
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Bell, "sm"),
						onClick: () => {
							// Demo: Inject custom message (will appear on next agent run)
							if (agent) {
								agent.steer(
									createSystemNotification(
										"This is a custom message! It appears in the UI but is never sent to the LLM.",
									),
								);
							}
						},
						title: "Demo: Add Custom Notification",
					})}
					<theme-toggle></theme-toggle>
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Settings, "sm"),
						onClick: () => SettingsDialog.open([new ProvidersModelsTab(), new ProxyTab()]),
						title: "Settings",
					})}
				</div>
			</div>

			<!-- Chat Panel -->
			${chatPanel}
		</div>
	`;

	render(appHtml, app);
};

// ============================================================================
// INIT
// ============================================================================
async function initApp() {
	await registerProxyProviders();
	const app = document.getElementById("app");
	if (!app) throw new Error("App container not found");

	// Show loading
	render(
		html`
			<div class="w-full h-screen flex items-center justify-center bg-background text-foreground">
				<div class="text-muted-foreground">Loading...</div>
			</div>
		`,
		app,
	);

	// TODO: Fix PersistentStorageDialog - currently broken
	// Request persistent storage
	// if (storage.sessions) {
	// 	await PersistentStorageDialog.request();
	// }

	// Create ChatPanel
	chatPanel = new ChatPanel();

	// Load global settings and agents list
	try {
		const [settingsRes, agentsRes] = await Promise.all([fetch("/api/settings"), fetch("/agentes.json")]);

		if (settingsRes.ok) {
			globalSettings = await settingsRes.json();
			console.log("Global settings loaded:", globalSettings);

			// Register specific models from settings if they are not known
			if (globalSettings?.enabledModels) {
				for (const modelId of globalSettings.enabledModels) {
					const [provider, id] = modelId.split("/");
					if (provider && id) {
						try {
							const existing = getModel(provider as any, id);
							if (!existing) {
								registerModel({
									provider,
									id,
									api: provider === "google-antigravity" ? "google-gemini-cli" : "openai-completions",
									name: id,
									contextWindow: 128000,
									input: ["text", "image"],
								} as any);
								console.log(`Registered missing model: ${provider}/${id}`);
							}
						} catch (_e) {
							// Ignore registration errors
						}
					}
				}
			}
		}
		if (agentsRes.ok) availableAgents = await agentsRes.json();
	} catch (err) {
		console.error("Failed to load app data:", err);
	}

	// Check for session in URL
	const urlParams = new URLSearchParams(window.location.search);
	const sessionIdFromUrl = urlParams.get("session");

	if (sessionIdFromUrl) {
		const loaded = await loadSession(sessionIdFromUrl);
		if (!loaded) {
			// Session doesn't exist, redirect to new session
			newSession();
			return;
		}
	} else {
		// If no session but we have agents, load the first one if none selected
		if (availableAgents.length > 0 && !selectedAgent) {
			await loadAgentConfig(availableAgents[0]);
		} else {
			await createAgent();
		}
	}

	renderApp();
}

initApp();
