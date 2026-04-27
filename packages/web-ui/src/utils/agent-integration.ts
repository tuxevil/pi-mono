import type { Model } from "@mariozechner/pi-ai";
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
	let settings: AgentSettings | null = null;
	let models: AgentModels | null = null;

	try {
		const settingsRes = await fetch("/api/agent/settings");
		if (settingsRes.ok) {
			settings = await settingsRes.json();
		}
	} catch (err) {
		console.error("Failed to fetch agent settings:", err);
	}

	try {
		const modelsRes = await fetch("/api/agent/models");
		if (modelsRes.ok) {
			models = await modelsRes.json();
		}
	} catch (err) {
		console.error("Failed to fetch agent models:", err);
	}

	return { settings, models };
}

/**
 * Synchronize agent configuration with AppStorage.
 */
export async function syncAgentConfig(storage: AppStorage): Promise<void> {
	const { settings, models } = await fetchAgentConfig();

	if (settings?.enabledModels) {
		await storage.settings.set("enabledModels", settings.enabledModels);
	}

	if (models?.providers) {
		for (const [providerName, config] of Object.entries(models.providers)) {
			if (!config.models || config.models.length === 0) continue;

			// Check if we already have this as a custom provider
			const existing = await storage.customProviders.getAll();
			let provider = existing.find((p) => p.name === providerName);

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
			}

			// Merge models
			const newModels: Model<any>[] = config.models.map((m) => ({
				...m,
				id: m.id,
				name: m.name || m.id,
				api: (config.api as any) || "openai-completions",
				provider: providerName,
				baseUrl: config.baseUrl || "",
				reasoning: m.reasoning ?? false,
				input: m.input ?? ["text"],
				cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: m.contextWindow ?? 8192,
				maxTokens: m.maxTokens ?? 4096,
			}));

			provider.models = newModels;
			await storage.customProviders.set(provider);
		}
	}
}
