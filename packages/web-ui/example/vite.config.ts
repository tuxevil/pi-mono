import tailwindcss from "@tailwindcss/vite";
import fs from "fs";
import path from "path";
import { defineConfig } from "vite";

export default defineConfig({
	resolve: {
		alias: {
			"@mariozechner/pi-web-ui": path.resolve(__dirname, "../src/index.ts"),
			"@mariozechner/pi-ai": path.resolve(__dirname, "../../ai/src/index.ts"),
			"@mariozechner/pi-agent-core": path.resolve(__dirname, "../../agent/src/index.ts"),
		},
	},
	plugins: [
		tailwindcss(),
		{
			name: "sessions-api",
			configureServer(server) {
				const getFilesRecursive = (dir: string): string[] => {
					if (!fs.existsSync(dir)) return [];
					let results: string[] = [];
					const list = fs.readdirSync(dir);
					list.forEach((file) => {
						file = path.join(dir, file);
						const stat = fs.statSync(file);
						if (stat?.isDirectory()) {
							results = results.concat(getFilesRecursive(file));
						} else if (file.endsWith(".json") || file.endsWith(".jsonl")) {
							if (!file.endsWith(".metadata.json")) {
								results.push(file);
							}
						}
					});
					return results;
				};

				const parseSession = (filePath: string) => {
					const content = fs.readFileSync(filePath, "utf-8");
					if (filePath.endsWith(".jsonl")) {
						const lines = content.trim().split("\n");
						const messages: any[] = [];
						let id = "";
						let title = "";
						let model: any = null;
						const lastModified = fs.statSync(filePath).mtime.toISOString();

						for (const line of lines) {
							if (!line.trim()) continue;
							try {
								const entry = JSON.parse(line);
								if (entry.type === "session") {
									id = entry.id;
								} else if (entry.type === "message") {
									messages.push(entry.message);
									if (!title && entry.message.role === "user") {
										const text =
											typeof entry.message.content === "string"
												? entry.message.content
												: entry.message.content.find((c: any) => c.type === "text")?.text || "";
										title = text.substring(0, 50);
									}
									if (entry.message.role === "assistant" && entry.message.model) {
										model = { provider: entry.message.provider, modelId: entry.message.model };
									}
								} else if (entry.type === "model_change") {
									model = { provider: entry.provider, modelId: entry.modelId };
								}
							} catch (_e) {}
						}
						return { id, title: title || id, messages, model, lastModified };
					} else {
						return JSON.parse(content);
					}
				};

				server.middlewares.use(async (req, res, next) => {
					if (!req.url?.startsWith("/api/sessions")) {
						return next();
					}

					const url = new URL(req.url, `http://${req.headers.host}`);
					const agentName = url.searchParams.get("agent");
					if (!agentName) {
						res.statusCode = 400;
						return res.end("Missing agent parameter");
					}

					const globalSessionsPath = path.join("/root/.pi/agent/sessions", `--root-agentes-${agentName}--`);
					const localSessionsPath = path.join("/root/agentes", agentName, ".pi/sessions");
					const sessionsPath = fs.existsSync(globalSessionsPath) ? globalSessionsPath : localSessionsPath;

					if (req.method === "GET" && url.pathname === "/api/sessions") {
						try {
							const allFiles = getFilesRecursive(sessionsPath);
							const sessions = allFiles
								.map((f) => {
									try {
										const s = parseSession(f);
										return {
											id: s.id,
											title: s.title || s.id,
											lastModified: s.lastModified || fs.statSync(f).mtime.toISOString(),
										};
									} catch (_e) {
										return null;
									}
								})
								.filter(Boolean) as any[];

							sessions.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

							res.setHeader("Content-Type", "application/json");
							return res.end(JSON.stringify(sessions));
						} catch (err) {
							res.statusCode = 500;
							return res.end(String(err));
						}
					}

					const match = url.pathname.match(/\/api\/sessions\/([^/]+)/);
					if (req.method === "GET" && match) {
						const id = match[1];
						const allFiles = getFilesRecursive(sessionsPath);
						const file = allFiles.find((f) => {
							try {
								return parseSession(f).id === id;
							} catch (_e) {
								return false;
							}
						});

						if (!file) {
							res.statusCode = 404;
							return res.end("Session not found");
						}
						res.setHeader("Content-Type", "application/json");
						return res.end(JSON.stringify(parseSession(file)));
					}

					if (req.method === "POST" && match) {
						const id = match[1];
						let body = "";
						req.on("data", (chunk) => {
							body += chunk;
						});
						req.on("end", () => {
							try {
								const filePath = path.join(sessionsPath, `${id}.json`);
								if (!fs.existsSync(sessionsPath)) {
									fs.mkdirSync(sessionsPath, { recursive: true });
								}
								fs.writeFileSync(filePath, body, "utf-8");
								res.statusCode = 200;
								res.end("OK");
							} catch (_err) {
								res.statusCode = 500;
								res.end(String(_err));
							}
						});
						return;
					}
					next();
				});

				const extensionCache = new Map<string, any>();

				server.middlewares.use(async (req, res, next) => {
					if (req.url?.startsWith("/api/tools") && req.method === "GET") {
						const url = new URL(req.url, `http://${req.headers.host}`);
						const agentName = url.searchParams.get("agent");
						if (!agentName) {
							res.statusCode = 400;
							return res.end("Missing agent parameter");
						}

						try {
							const settingsPath = path.join("/root/agentes", agentName, ".pi/settings.json");
							let packages: string[] = [];
							if (fs.existsSync(settingsPath)) {
								const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
								packages = settings.packages || [];
							}

							const codingAgentPath = path.resolve(__dirname, "../../coding-agent/dist/index.js");
							const { discoverAndLoadExtensions } = await import(codingAgentPath);

							const agentDir = path.join("/root/agentes", agentName);
							const dotPiDir = path.join(agentDir, ".pi");
							const loadResult = await discoverAndLoadExtensions(packages, agentDir, dotPiDir);

							extensionCache.set(agentName, loadResult);

							const tools: any[] = [];
							// Base tools (hardcoded in UI for now, but server knows them)
							// Actually, let's just return ALL tools discovered
							for (const ext of loadResult.extensions) {
								for (const [name, tool] of ext.tools) {
									tools.push({
										name,
										description: tool.definition.description,
										parameters: tool.definition.parameters,
									});
								}
							}

							res.setHeader("Content-Type", "application/json");
							return res.end(JSON.stringify(tools));
						} catch (err) {
							console.error("[Tools API] Error:", err);
							res.statusCode = 500;
							return res.end(String(err));
						}
					}

					if (req.url?.startsWith("/api/tools/execute") && req.method === "POST") {
						const url = new URL(req.url!, `http://${req.headers.host}`);
						const agentName = url.searchParams.get("agent");

						let body = "";
						req.on("data", (chunk) => {
							body += chunk;
						});
						req.on("end", async () => {
							try {
								console.log(`[Tool Executor] Received body: ${body}`);
								const { toolCallId, toolName, args, cwd } = JSON.parse(body);
								console.log(`[Tool Executor] Executing ${toolName} for agent ${agentName} in ${cwd}`);
								const actualCwd = cwd || process.cwd();

								const codingAgentPath = path.resolve(__dirname, "../../coding-agent/dist/index.js");
								const { createAllTools } = await import(codingAgentPath);
								const baseTools = createAllTools(actualCwd);

								let tool = (baseTools as any)[toolName];

								if (!tool && agentName) {
									let loadResult = extensionCache.get(agentName);
									if (!loadResult) {
										const { discoverAndLoadExtensions } = await import(codingAgentPath);
										const settingsPath = path.join("/root/agentes", agentName, ".pi/settings.json");
										let packages: string[] = [];
										if (fs.existsSync(settingsPath)) {
											const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
											packages = settings.packages || [];
										}
										const agentDir = path.join("/root/agentes", agentName);
										const dotPiDir = path.join(agentDir, ".pi");
										loadResult = await discoverAndLoadExtensions(packages, agentDir, dotPiDir);
										extensionCache.set(agentName, loadResult);
									}

									for (const ext of loadResult.extensions) {
										const extTool = ext.tools.get(toolName);
										if (extTool) {
											tool = extTool.definition;
											break;
										}
									}
								}

								if (!tool) {
									res.statusCode = 404;
									res.end(JSON.stringify({ error: `Tool ${toolName} not found` }));
									return;
								}

								// Provide a minimal mock context for tools
								const mockCtx = {
									ui: {
										setStatus: () => {},
										notify: () => {},
									},
									cwd: actualCwd,
								};

								console.log(`[Tool Executor] Executing ${toolName} with args:`, JSON.stringify(args));
								const result = await tool.execute(toolCallId || "remote", args, undefined, undefined, mockCtx);
								console.log(`[Tool Executor] Execution success for ${toolName}`);
								res.end(JSON.stringify({ result }));
							} catch (err: any) {
								console.error("[Tool Executor] Fatal error during execution:", err.stack || err.message);
								res.statusCode = 500;
								res.end(JSON.stringify({ error: err.message, stack: err.stack }));
							}
						});
						return;
					}
					next();
				});

				server.middlewares.use(async (req, res, next) => {
					if (req.url !== "/api/ai/stream" || req.method !== "POST") {
						return next();
					}

					let body = "";
					req.on("data", (chunk) => {
						body += chunk;
					});
					req.on("end", async () => {
						try {
							const { model, context, options } = JSON.parse(body);
							console.log(`[AI Proxy] Request for model: ${model.provider}/${model.id}`);
							console.log(`[AI Proxy] Context type: ${typeof context}, isArray: ${Array.isArray(context)}`);
							if (context)
								console.log(`[AI Proxy] Context preview: ${JSON.stringify(context).substring(0, 100)}`);

							const { registerBuiltInApiProviders, stream } = await import("@mariozechner/pi-ai");
							registerBuiltInApiProviders();

							const modelsJsonPath = "/root/.pi/agent/models.json";
							if (fs.existsSync(modelsJsonPath)) {
								const modelsJson = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
								const providerConfig = modelsJson.providers?.[model.provider];
								if (providerConfig?.baseUrl) {
									model.baseUrl = providerConfig.baseUrl.replace("localhost", "127.0.0.1");
								}
								if (providerConfig?.apiKey) {
									options.apiKey = providerConfig.apiKey;
								}
							}
							console.log(`[AI Proxy] Final model baseUrl: ${model.baseUrl}`);

							// Ensure context messages are robust and wrapped in a Context object
							const messagesArray = Array.isArray(context) ? context : (context as any)?.messages || [];
							const safeMessages = messagesArray.map((msg: any) => ({
								...msg,
								content: Array.isArray(msg.content)
									? msg.content
									: typeof msg.content === "string"
										? [{ type: "text", text: msg.content }]
										: [],
							}));

							const piAiContext: any = {
								messages: safeMessages,
								systemPrompt: (context as any)?.systemPrompt,
								tools: (context as any)?.tools,
							};

							res.setHeader("Content-Type", "text/event-stream");
							res.setHeader("Cache-Control", "no-cache");
							res.setHeader("Connection", "keep-alive");

							const { signal: _signal, ...restOptions } = options;
							const optionsWithDummyKey = {
								...restOptions,
								apiKey: JSON.stringify({ token: "dummy", projectId: "dummy" }),
							};

							const eventStream = stream(model, piAiContext, optionsWithDummyKey);
							for await (const event of eventStream) {
								if (event.type === "error") {
									console.error("[AI Proxy] Stream event error:", JSON.stringify(event.error));
								}
								res.write(`data: ${JSON.stringify(event)}\n\n`);
							}
							res.end();
						} catch (err: any) {
							console.error("[AI Proxy] Fatal error:", err.stack || err.message);
							res.statusCode = 500;
							res.end(JSON.stringify({ error: err.message, stack: err.stack }));
						}
					});
				});

				server.middlewares.use(async (req, res, next) => {
					if (req.url === "/agentes.json") {
						try {
							const agentsDir = "/root/agentes";
							const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
							const agents = entries
								.filter((e) => e.isDirectory() && !e.name.startsWith("_") && e.name !== "briefs")
								.map((e) => e.name);
							res.setHeader("Content-Type", "application/json");
							return res.end(JSON.stringify(agents));
						} catch (err) {
							res.statusCode = 500;
							return res.end(String(err));
						}
					}

					if (req.url?.startsWith("/agentes/")) {
						const filePath = path.join("/root", req.url);
						if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
							const ext = path.extname(filePath).toLowerCase();
							const contentType =
								ext === ".json" ? "application/json" : ext === ".md" ? "text/markdown" : "text/plain";
							res.setHeader("Content-Type", contentType);
							return res.end(fs.readFileSync(filePath));
						}
					}
					next();
				});

				server.middlewares.use(async (req, res, next) => {
					if (req.url !== "/api/settings") {
						return next();
					}
					try {
						const settingsPath = "/root/.pi/agent/settings.json";
						if (fs.existsSync(settingsPath)) {
							res.setHeader("Content-Type", "application/json");
							return res.end(fs.readFileSync(settingsPath, "utf-8"));
						}
						res.statusCode = 404;
						res.end("Settings not found");
					} catch (err) {
						res.statusCode = 500;
						res.end(String(err));
					}
				});
			},
		},
	],
});
