import { getModels, getProviders, type Model } from "@mariozechner/pi-ai";
import type { AppStorage } from "../storage/app-storage.js";
import { generateUUID } from "./uuid.js";

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
export async function fetchAgentConfig(): Promise<{
	settings: AgentSettings | null;
	models: AgentModels | null;
	auth: any | null;
}> {
	console.log("[agent-integration] Fetching agent config...");
	try {
		const settingsResp = await fetch("/api/agent/settings");
		const settings = settingsResp.ok ? await settingsResp.json() : null;
		console.log("[agent-integration] Settings fetched:", settings ? "success" : "failed");

		const modelsResp = await fetch("/api/agent/models");
		const models = modelsResp.ok ? await modelsResp.json() : { providers: {} };
		console.log("[agent-integration] Models fetched:", models ? "success" : "failed");

		const authResp = await fetch("/api/agent/auth");
		const auth = authResp.ok ? await authResp.json() : null;
		console.log("[agent-integration] Auth fetched:", auth ? "success" : "failed");

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
		console.log("[agent-integration] Syncing providers from models.json:", Object.keys(models.providers));
		const knownProviders = getProviders();
		const existingProviders = await storage.customProviders.getAll();
		for (const [providerName, config] of Object.entries(models.providers)) {
			let provider = existingProviders.find((p) => p.name === providerName);

			if (!provider) {
				console.log(`[agent-integration] Creating new custom provider: ${providerName}`);
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
					console.log(`[agent-integration] Updating baseUrl for ${providerName}: ${config.baseUrl}`);
					provider.baseUrl = config.baseUrl;
				}
			}

			if (!provider.models) provider.models = [];

			// If it's a known provider, we might want to override its built-in models
			if (knownProviders.includes(providerName as any) && config.baseUrl) {
				console.log(`[agent-integration] Overriding built-in models for known provider: ${providerName}`);
				const builtInModels = getModels(providerName as any);
				for (const builtIn of builtInModels) {
					// Check if already in provider.models
					const existingModel = provider.models.find((m) => m.id === builtIn.id);
					if (existingModel) {
						console.log(
							`[agent-integration] Updating baseUrl for built-in model ${builtIn.id}: ${config.baseUrl}`,
						);
						existingModel.baseUrl = config.baseUrl;
					} else {
						console.log(
							`[agent-integration] Adding built-in model ${builtIn.id} with baseUrl: ${config.baseUrl}`,
						);
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
		console.log("[agent-integration] Syncing auth from auth.json:", Object.keys(auth));
		for (const [providerName, cred] of Object.entries(auth)) {
			const credData = cred as any;
			if (credData.type === "api_key") {
				console.log(`[agent-integration] Syncing API key for ${providerName}`);
				await storage.providerKeys.set(providerName, credData.key);
			} else if (credData.type === "oauth") {
				if (providerName === "google-antigravity" || providerName === "google-gemini-cli") {
					const key = JSON.stringify({ token: credData.access, projectId: credData.projectId || "proxy-managed" });
					console.log(`[agent-integration] Syncing OAuth key for ${providerName}`);
					await storage.providerKeys.set(providerName, key);
				} else {
					// Other OAuth providers just use the access token
					console.log(`[agent-integration] Syncing OAuth access token for ${providerName}`);
					await storage.providerKeys.set(providerName, credData.access);
				}
			}
		}
	}

	// Enable proxy by default if not set, as we are likely using a local rotator/proxy
	const proxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
	if (proxyEnabled === undefined || proxyEnabled === null) {
		console.log("[agent-integration] Enabling CORS proxy by default");
		await storage.settings.set("proxy.enabled", true);
		await storage.settings.set("proxy.url", "/api/proxy/");
	}
}
