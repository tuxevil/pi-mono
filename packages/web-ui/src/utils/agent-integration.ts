import { getModels, getProviders, type Model } from "@mariozechner/pi-ai";
import type { AppStorage } from "../storage/app-storage.js";

export interface AgentSettings {
	enabledModels?: string[];
	[key: string]: any;
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
export async function fetchAgentConfig(): Promise<{ settings: AgentSettings | null; models: AgentModels | null }> {
	try {
		const settingsResp = await fetch("/api/agent/settings");
		const settings = settingsResp.ok ? await settingsResp.json() : null;

		const modelsResp = await fetch("/api/agent/models");
		const models = modelsResp.ok ? await modelsResp.json() : { providers: {} };

		return { settings, models };
	} catch (_err) {
		return { settings: null, models: null };
	}
}

/**
 * Synchronize agent configuration with AppStorage.
 */
export async function syncAgentConfig(storage: AppStorage): Promise<void> {
	const { settings, models } = await fetchAgentConfig();

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
				const id =
					typeof crypto.randomUUID === "function"
						? crypto.randomUUID()
						: Math.random().toString(36).substring(2) + Date.now().toString(36);
				provider = {
					id,
					name: providerName,
					type: (config.api as any) || "openai-completions",
					baseUrl: config.baseUrl || "",
					models: [],
				};
			} else {
				// Update existing provider's base URL
				provider.baseUrl = config.baseUrl || provider.baseUrl;
			}

			if (!provider.models) provider.models = [];

			// If it's a known provider, we might want to override its built-in models
			if (knownProviders.includes(providerName as any) && config.baseUrl) {
				const builtInModels = getModels(providerName as any);
				for (const builtIn of builtInModels) {
					// Check if already in provider.models
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
}
