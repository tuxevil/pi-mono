import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { Agent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import {
	type AgentEvent,
	type AgentState,
	ApiKeyPromptDialog,
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	createJavaScriptReplTool,
	fetchAgentConfigByName,
	fetchAgentsList,
	generateUUID,
	IndexedDBStorageBackend,
	i18n,
	// PersistentStorageDialog, // TODO: Fix - currently broken
	ProviderKeysStore,
	ProvidersModelsTab,
	ProxyTab,
	RemoteStorageBackend,
	SessionsStore,
	SettingsDialog,
	SettingsStore,
	setAppStorage,
	syncAgentConfig,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { Bell, History, Plus, Settings } from "lucide";
import "./app.css";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { createSystemNotification, customConvertToLlm, registerCustomMessageRenderers } from "./custom-messages.js";

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

// Use remote backend for sessions
const remoteBackend = new RemoteStorageBackend();
sessions.setBackend(remoteBackend);

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
let selectedAgentName: string | undefined;
let currentTheme: "default" | "cyberpunk" = (localStorage.getItem("pi-theme") as any) || "default";

const toggleTheme = () => {
	currentTheme = currentTheme === "default" ? "cyberpunk" : "default";
	localStorage.setItem("pi-theme", currentTheme);
	renderApp();
};

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
			thinkingLevel: state.thinkingLevel || "off",
			preview: generateTitle(state.messages),
		};

		await storage.sessions.save(sessionData, metadata);
	} catch (err) {
		console.error("Failed to save session:", err);
	}
};

const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.history.replaceState({}, "", url);
};

const createAgent = async (initialState?: Partial<AgentState>) => {
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}

	agent = new Agent({
		initialState: initialState || {
			systemPrompt: `You are a helpful AI assistant with access to various tools.

Available tools:
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

	agentUnsubscribe = agent.subscribe((event: AgentEvent) => {
		// Re-render on any event that might change the state
		renderApp();

		if (event.type === "message_end") {
			const messages = agent.state.messages;

			// Generate title after first successful response
			if (!currentTitle && shouldSaveSession(messages)) {
				currentTitle = generateTitle(messages);
			}

			// Create session ID on first successful save
			if (!currentSessionId && shouldSaveSession(messages)) {
				currentSessionId = generateUUID();
				updateUrl(currentSessionId);
			}

			// Auto-save
			if (currentSessionId) {
				saveSession().then(() => refreshSessions());
			}

			renderApp();
		}
	});

	await chatPanel.setAgent(agent, {
		onApiKeyRequired: async (provider: string) => {
			return await ApiKeyPromptDialog.prompt(provider);
		},
		toolsFactory: (_agent, _agentInterface, _artifactsPanel, runtimeProvidersFactory) => {
			// Create javascript_repl tool with access to attachments + artifacts
			const replTool = createJavaScriptReplTool();
			replTool.runtimeProvidersFactory = runtimeProvidersFactory;
			return [replTool];
		},
	});
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
	await refreshSessions();
	return true;
};

const newSession = () => {
	const url = new URL(window.location.href);
	url.search = "";
	window.location.href = url.toString();
};

// ============================================================================
// STATE
// ============================================================================
let sessionMetadataList: any[] = [];
let isFetchingSessions = false;

// Fetch sessions for the sidebar
const refreshSessions = async () => {
	if (!storage.sessions || isFetchingSessions) return;
	isFetchingSessions = true;
	try {
		sessionMetadataList = await storage.sessions.getAllMetadata();
		renderApp();
	} finally {
		isFetchingSessions = false;
	}
};

// ============================================================================
// RENDER
// ============================================================================
const renderApp = () => {
	const app = document.getElementById("app");
	if (!app) return;

	const appHtml = html`
		<div class="app-layout ${currentTheme === "cyberpunk" ? "theme-cyberpunk" : ""}">
			<!-- Left Sidebar -->
			<div class="left-sidebar bg-card/30 backdrop-blur-md">
				<div class="sidebar-section border-b border-border/50">
					<div class="flex items-center justify-between mb-4">
						<div class="sidebar-header mb-0">
							${icon(Plus, "sm")} ${i18n("Specialized Agents")}
						</div>
						${Button({
							variant: "ghost",
							size: "sm",
							children: icon(Plus, "sm"),
							onClick: newSession,
							title: "New Session",
						})}
					</div>
					<select
						class="w-full bg-secondary/50 text-foreground text-sm rounded-lg px-3 py-2 outline-none border border-border hover:border-primary/50 transition-colors cursor-pointer"
						@change=${async (e: Event) => {
							const name = (e.target as HTMLSelectElement).value;
							if (name === "default") {
								selectedAgentName = undefined;
								await createAgent();
							} else {
								selectedAgentName = name;
								const config = await fetchAgentConfigByName(name);
								if (config) {
									const settings = config.files["settings.json"] || {};
									let model = agent.state.model;
									if (settings.defaultModel) {
										const customProviders = await storage.customProviders.getAll();
										for (const p of customProviders) {
											const found = p.models?.find((m) => m.id === settings.defaultModel);
											if (found) {
												model = found;
												break;
											}
										}
									}

									await createAgent({
										systemPrompt: config.systemPrompt,
										model: model,
										thinkingLevel: settings.defaultThinkingLevel || agent.state.thinkingLevel,
									});
								}
							}
							remoteBackend.setAgentName(selectedAgentName);
							await refreshSessions();
						}}
					>
						<option value="default" ?selected=${!selectedAgentName}>Default Agent</option>
						${availableAgents.map(
							(name) => html`
							<option value="${name}" ?selected=${selectedAgentName === name}>
								${name.charAt(0).toUpperCase() + name.slice(1)}
							</option>
						`,
						)}
					</select>
				</div>

				<div class="sidebar-header p-4 pb-2">
					${icon(History, "sm")} ${i18n("Recent Sessions")}
				</div>
				<div class="session-list-container flex-1 overflow-y-auto min-h-0 px-2 pb-4 scrollbar-thin">
					${
						sessionMetadataList.length === 0
							? html`
						<div class="px-4 py-8 text-center text-sm text-muted-foreground italic">
							${i18n("No sessions yet")}
						</div>
					`
							: sessionMetadataList.map(
									(s) => html`
						<div 
							class="session-item group relative ${s.id === currentSessionId ? "active bg-primary/10 border-primary/20" : "hover:bg-accent/40"}"
							@click=${() => loadSession(s.id)}
						>
							<div class="session-title pr-6">${s.title || "Untitled Session"}</div>
							<div class="session-meta">
								${new Date(s.lastModified).toLocaleDateString()} • ${s.messageCount} ${i18n("messages")}
							</div>
							<button 
								class="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
								@click=${async (e: Event) => {
									e.stopPropagation();
									if (confirm(i18n("Delete this session?"))) {
										await storage.sessions?.delete(s.id);
										if (s.id === currentSessionId) {
											newSession();
										} else {
											await refreshSessions();
										}
									}
								}}
							>
								${icon(Plus, "xs", "rotate-45")}
							</button>
						</div>
					`,
								)
					}
				</div>

				<!-- Settings at bottom of left sidebar -->
				<div class="p-4 border-t border-border/50 flex items-center justify-between">
					<div class="flex items-center gap-1">
						<theme-toggle></theme-toggle>
						${Button({
							variant: "ghost",
							size: "sm",
							children: icon(Settings, "sm"),
							onClick: () => SettingsDialog.open([new ProvidersModelsTab(), new ProxyTab()]),
							title: "Settings",
						})}
						${Button({
							variant: "ghost",
							size: "sm",
							children: html`<span class="text-xs font-bold">${currentTheme === "cyberpunk" ? "RETRO" : "MODERN"}</span>`,
							onClick: toggleTheme,
							title: "Toggle Retro Theme",
						})}
					</div>
					<div class="text-[10px] text-muted-foreground font-mono">v1.21.9</div>
				</div>
			</div>

			<!-- Main Content -->
			<div class="main-content relative">
				<!-- Header (Condensed) -->
				<div class="flex items-center justify-between border-b border-border shrink-0 px-4 py-2 bg-background/80 backdrop-blur-md sticky top-0 z-10 ${currentTheme === "cyberpunk" ? "header-glow" : ""}">
					<div class="flex items-center gap-2 overflow-hidden">
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
													// Save state on every update (debounce if needed)
													if (storage.sessions && currentSessionId) {
														saveSession();
													}
													currentTitle = newTitle;
												}
												isEditingTitle = false;
												renderApp();
											},
											onKeyDown: async (e: KeyboardEvent) => {
												if (e.key === "Enter") {
													const newTitle = (e.target as HTMLInputElement).value.trim();
													if (
														newTitle &&
														newTitle !== currentTitle &&
														storage.sessions &&
														currentSessionId
													) {
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
										class="px-2 py-1 text-base font-semibold text-foreground hover:bg-secondary rounded-lg transition-colors truncate max-w-md"
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
								: html`<span class="text-base font-bold bg-clip-text text-transparent bg-gradient-to-r from-primary to-orange-400">Pi Web UI</span>`
						}
					</div>
					<div class="flex items-center gap-2">
						${Button({
							variant: "ghost",
							size: "sm",
							children: icon(Bell, "sm"),
							onClick: () => {
								if (agent) {
									agent.steer(createSystemNotification("Notification system is active."));
								}
							},
							title: "Notifications",
						})}
					</div>
				</div>

				<!-- Chat Panel Container -->
				<div class="flex-1 min-h-0 relative">
					${chatPanel}
				</div>
			</div>

			<!-- Right Sidebar (File Explorer) -->
			<div class="right-sidebar w-[320px] bg-card/30 backdrop-blur-md">
				<pi-file-explorer class="flex-1"></pi-file-explorer>
			</div>
		</div>
	`;

	render(appHtml, app);
};

// ============================================================================
// INIT
// ============================================================================
async function initApp() {
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

	// Sync with local agent configuration
	try {
		await syncAgentConfig(storage);
	} catch (err) {
		console.error("Failed to sync with local agent:", err);
	}

	// Fetch available specialized agents
	try {
		availableAgents = await fetchAgentsList();
	} catch (err) {
		console.error("Failed to fetch specialized agents:", err);
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
		await createAgent();
	}

	await refreshSessions();
}

initApp();
