import { getModels, getProviders, type Model } from "@mariozechner/pi-ai";
import type { AppStorage } from "../storage/app-storage.js";
import { generateUUID } from "./uuid.js";

/** Minimum known shape of settings.json — extra keys are allowed but typed loosely. */
export interface AgentSettings {
	enabledModels?: string[];
	defaultModel?: string;
	defaultThinkingLevel?: string;
	[key: string]: unknown;
}

export interface CustomAgentConfig {
	name: string;
	systemPrompt?: string;
	files: Record<string, any>;
}

export interface AgentModels {
	providers: Record<
		string,
		{
			baseUrl?: string;
			api?: string;
			models?: Array<{
				id: string;
				name?: string;
				[key: string]: any;
			}>;
		}
	>;
}

/**
 * Fetch agent configuration from the local proxy.
 */
export async function fetchAgentConfig(): Promise<{
	settings: AgentSettings | null;
	models: AgentModels | null;
	auth: Record<string, unknown> | null;
}> {
	try {
		const settingsResp = await fetch("/api/agent/settings");
		const settings = settingsResp.ok ? await settingsResp.json() : null;

		const modelsResp = await fetch("/api/agent/models");
		const models = modelsResp.ok ? await modelsResp.json() : { providers: {} };

		const authResp = await fetch("/api/agent/auth");
		const auth = authResp.ok ? await authResp.json() : null;

		return { settings, models, auth };
	} catch (err) {
		console.error("[agent-integration] Error fetching agent config:", err);
		return { settings: null, models: null, auth: null };
	}
}

/**
 * Synchronize agent configuration with AppStorage.
 */
export async function syncAgentConfig(storage: AppStorage): Promise<void> {
	const { settings, models, auth } = await fetchAgentConfig();

	if (settings?.enabledModels) {
		await storage.settings.set("enabledModels", settings.enabledModels);
	}

	// Sync custom models and provider overrides from models.json
	if (models?.providers) {
		const knownProviders = getProviders();
		const existingProviders = await storage.customProviders.getAll();
		for (const [providerName, config] of Object.entries(models.providers)) {
			let provider = existingProviders.find((p) => p.name === providerName);

			if (!provider) {
				const id = generateUUID();
				provider = {
					id,
					name: providerName,
					type: (config.api as any) || "openai-completions",
					baseUrl: config.baseUrl || "",
					models: [],
				};
			} else {
				// Update existing provider's base URL
				if (config.baseUrl) {
					provider.baseUrl = config.baseUrl;
				}
			}

			if (!provider.models) provider.models = [];

			// If it's a known provider, override its built-in models' baseUrl
			if (knownProviders.includes(providerName as any) && config.baseUrl) {
				const builtInModels = getModels(providerName as any);
				for (const builtIn of builtInModels) {
					const existingModel = provider.models.find((m) => m.id === builtIn.id);
					if (existingModel) {
						existingModel.baseUrl = config.baseUrl;
					} else {
						provider.models.push({
							...builtIn,
							provider: providerName,
							baseUrl: config.baseUrl,
						});
					}
				}
			}

			// Handle custom models defined in config.models
			if (config.models && config.models.length > 0) {
				const builtInDefaults = knownProviders.includes(providerName as any)
					? getModels(providerName as any)[0]
					: undefined;

				for (const m of config.models) {
					const newModel: Model<any> = {
						...m,
						id: m.id,
						name: m.name || m.id,
						api: (config.api as any) || (m.api as any) || builtInDefaults?.api || "openai-completions",
						provider: providerName,
						baseUrl: config.baseUrl || provider.baseUrl || "",
						cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: m.contextWindow || 128000,
						maxTokens: m.maxTokens || 16384,
						reasoning: m.reasoning || false,
						input: m.input || ["text"],
					};

					const existingIndex = provider.models.findIndex((mod) => mod.id === m.id);
					if (existingIndex >= 0) {
						provider.models[existingIndex] = newModel;
					} else {
						provider.models.push(newModel);
					}
				}
			}

			await storage.customProviders.set(provider);
		}
	}

	// Sync auth
	if (auth) {
		for (const [providerName, cred] of Object.entries(auth)) {
			const credData = cred as Record<string, unknown>;
			if (credData.type === "api_key" && typeof credData.key === "string") {
				await storage.providerKeys.set(providerName, credData.key);
			} else if (credData.type === "oauth" && typeof credData.access === "string") {
				if (providerName === "google-antigravity" || providerName === "google-gemini-cli") {
					const key = JSON.stringify({
						token: credData.access,
						projectId: typeof credData.projectId === "string" ? credData.projectId : "proxy-managed",
					});
					await storage.providerKeys.set(providerName, key);
				} else {
					await storage.providerKeys.set(providerName, credData.access);
				}
			}
		}
	}

	// Enable proxy by default if not already configured
	const proxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
	if (proxyEnabled === undefined || proxyEnabled === null) {
		await storage.settings.set("proxy.enabled", true);
		await storage.settings.set("proxy.url", "/api/proxy/");
	}
}

/**
 * Fetch the list of available specialized agents.
 */
export async function fetchAgentsList(): Promise<string[]> {
	try {
		const resp = await fetch("/api/agents");
		if (resp.ok) {
			return await resp.json();
		}
		return [];
	} catch (err) {
		console.error("[agent-integration] Error fetching agents list:", err);
		return [];
	}
}

/**
 * Fetch configuration for a specific specialized agent.
 */
export async function fetchAgentConfigByName(name: string): Promise<CustomAgentConfig | null> {
	try {
		const resp = await fetch(`/api/agents/${name}`);
		if (resp.ok) {
			return await resp.json();
		}
		return null;
	} catch (err) {
		console.error(`[agent-integration] Error fetching config for agent ${name}:`, err);
		return null;
	}
}
