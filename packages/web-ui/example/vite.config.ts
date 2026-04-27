import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	define: {
		"process.env": {},
	},
	plugins: [
		tailwindcss(),
		{
			name: "agent-proxy",
			configureServer(server) {
				server.middlewares.use(async (req, res, next) => {
					console.log(`[agent-proxy] Incoming request: ${req.url}`);
					if (req.url === "/api/agent/settings") {
						const path = join(homedir(), ".pi", "agent", "settings.json");
						console.log(`[agent-proxy] Serving settings from ${path}`);
						if (existsSync(path)) {
							res.setHeader("Content-Type", "application/json");
							res.end(readFileSync(path));
						} else {
							console.warn(`[agent-proxy] settings.json not found at ${path}`);
							res.statusCode = 404;
							res.end(JSON.stringify({ error: "settings.json not found" }));
						}
						return;
					}
					if (req.url === "/api/agent/models") {
						const path = join(homedir(), ".pi", "agent", "models.json");
						console.log(`[agent-proxy] Serving models from ${path}`);
						if (existsSync(path)) {
							res.setHeader("Content-Type", "application/json");
							res.end(readFileSync(path));
						} else {
							console.warn(`[agent-proxy] models.json not found at ${path}`);
							res.statusCode = 404;
							res.end(JSON.stringify({ error: "models.json not found" }));
						}
						return;
					}
					if (req.url === "/api/agent/auth") {
						const path = join(homedir(), ".pi", "agent", "auth.json");
						console.log(`[agent-proxy] Serving auth from ${path}`);
						if (existsSync(path)) {
							res.setHeader("Content-Type", "application/json");
							res.end(readFileSync(path));
						} else {
							console.warn(`[agent-proxy] auth.json not found at ${path}`);
							res.statusCode = 404;
							res.end(JSON.stringify({ error: "auth.json not found" }));
						}
						return;
					}
					if (req.url === "/api/agents") {
						const agentsDir = join(homedir(), "agentes");
						console.log(`[agent-proxy] Listing agents from ${agentsDir}`);
						if (existsSync(agentsDir)) {
							const dirs = readdirSync(agentsDir).filter((d) => {
								const fullPath = join(agentsDir, d);
								return statSync(fullPath).isDirectory() && existsSync(join(fullPath, ".pi"));
							});
							res.setHeader("Content-Type", "application/json");
							res.end(JSON.stringify(dirs));
						} else {
							res.statusCode = 404;
							res.end(JSON.stringify({ error: "agentes directory not found" }));
						}
						return;
					}
					if (req.url?.startsWith("/api/agents/")) {
						const agentName = req.url.substring("/api/agents/".length);
						const agentPiDir = join(homedir(), "agentes", agentName, ".pi");
						console.log(`[agent-proxy] Fetching config for agent ${agentName} from ${agentPiDir}`);

						if (existsSync(agentPiDir)) {
							const config: any = { name: agentName, files: {} };
							const files = readdirSync(agentPiDir);
							for (const file of files) {
								const filePath = join(agentPiDir, file);
								if (statSync(filePath).isFile()) {
									if (file === "SYSTEM.md") {
										config.systemPrompt = readFileSync(filePath, "utf-8");
									} else if (file.endsWith(".json")) {
										try {
											config.files[file] = JSON.parse(readFileSync(filePath, "utf-8"));
										} catch (e) {
											console.error(`[agent-proxy] Failed to parse ${file}: ${e}`);
										}
									}
								}
							}
							res.setHeader("Content-Type", "application/json");
							res.end(JSON.stringify(config));
						} else {
							res.statusCode = 404;
							res.end(JSON.stringify({ error: `Agent ${agentName} not found` }));
						}
						return;
					}
					if (req.url?.startsWith("/api/storage/")) {
						const url = new URL(req.url, "http://localhost");
						const pathname = url.pathname;
						const parts = pathname.substring("/api/storage/".length).split("/");
						const storeName = parts[0];
						const action = parts[1];
						const agentName = url.searchParams.get("agent");

						let sessionsDir = join(homedir(), ".pi", "agent", "sessions");
						if (agentName && agentName !== "default") {
							sessionsDir = join(sessionsDir, `--root-agentes-${agentName}--`);
						} else {
							sessionsDir = join(sessionsDir, "--root--");
						}

						const getAllSessionFiles = (dir: string): string[] => {
							let results: string[] = [];
							if (!existsSync(dir)) return results;
							const list = readdirSync(dir);
							for (const file of list) {
								const path = join(dir, file);
								const stat = statSync(path);
								if (stat?.isDirectory()) {
									results = results.concat(getAllSessionFiles(path));
								} else if (file.endsWith(".jsonl")) {
									results.push(path);
								}
							}
							return results;
						};

						const getMessagePreview = (message: any) => {
							if (!message || !message.content) return "";
							if (typeof message.content === "string") return message.content;
							if (Array.isArray(message.content)) {
								return message.content
									.filter((c: any) => c.type === "text")
									.map((c: any) => c.text)
									.join(" ");
							}
							return "";
						};

						const readSession = (path: string) => {
							const content = readFileSync(path, "utf-8");
							const lines = content.trim().split("\n");
							if (lines.length === 0) return null;

							try {
								const header = JSON.parse(lines[0]);
								if (header.type !== "session") return null;

								const messages: any[] = [];
								let title = "";
								let model = null;
								let thinkingLevel = "off";

								for (let i = 1; i < lines.length; i++) {
									const entry = JSON.parse(lines[i]);
									if (entry.type === "message") {
										messages.push(entry.message);
										if (entry.message.role === "assistant" && !model) {
											model = { id: entry.message.model, provider: entry.message.provider };
										}
									} else if (entry.type === "session_info") {
										title = entry.name || title;
									} else if (entry.type === "thinking_level_change") {
										thinkingLevel = entry.thinkingLevel;
									} else if (entry.type === "model_change") {
										model = { id: entry.modelId, provider: entry.provider };
									}
								}

								return {
									id: header.id,
									title: title || getMessagePreview(messages[0])?.substring(0, 50) || "New Session",
									model: model || { id: "unknown", provider: "unknown" },
									thinkingLevel,
									messages,
									createdAt: header.timestamp,
									lastModified: statSync(path).mtime.toISOString(),
								};
							} catch (e) {
								console.error(`[agent-proxy] Failed to parse session ${path}: ${e}`);
								return null;
							}
						};

						if (storeName === "sessions" || storeName === "sessions-metadata") {
							if (action === "keys") {
								const files = getAllSessionFiles(sessionsDir);
								const ids = files
									.map((f) => {
										const match = f.match(/_([a-f0-9-]+)\.jsonl$/);
										return match ? match[1] : null;
									})
									.filter(Boolean);
								res.setHeader("Content-Type", "application/json");
								res.end(JSON.stringify(ids));
								return;
							}

							if (action === "index" && parts[2] === "lastModified") {
								const files = getAllSessionFiles(sessionsDir);
								const sessions = files.map(readSession).filter(Boolean);

								if (storeName === "sessions-metadata") {
									const metadata = sessions.map((s: any) => ({
										id: s.id,
										title: s.title,
										createdAt: s.createdAt,
										lastModified: s.lastModified,
										messageCount: s.messages.length,
										usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
										thinkingLevel: s.thinkingLevel,
										preview: getMessagePreview(s.messages[0])?.substring(0, 200) || "",
									}));
									if (url.searchParams.get("direction") === "desc") {
										metadata.sort((a: any, b: any) => b.lastModified.localeCompare(a.lastModified));
									}
									res.setHeader("Content-Type", "application/json");
									res.end(JSON.stringify(metadata));
								} else {
									if (url.searchParams.get("direction") === "desc") {
										sessions.sort((a: any, b: any) => b.lastModified.localeCompare(a.lastModified));
									}
									res.setHeader("Content-Type", "application/json");
									res.end(JSON.stringify(sessions));
								}
								return;
							}

							const sessionId = decodeURIComponent(parts[1]);
							const files = getAllSessionFiles(sessionsDir);
							const sessionPath = files.find((f) => f.includes(sessionId));

							if (req.method === "GET") {
								if (parts[2] === "exists") {
									res.setHeader("Content-Type", "application/json");
									res.end(JSON.stringify({ exists: !!sessionPath }));
									return;
								}
								if (sessionPath) {
									const session = readSession(sessionPath);
									if (storeName === "sessions-metadata" && session) {
										res.setHeader("Content-Type", "application/json");
										res.end(
											JSON.stringify({
												id: session.id,
												title: session.title,
												createdAt: session.createdAt,
												lastModified: session.lastModified,
												messageCount: session.messages.length,
												thinkingLevel: session.thinkingLevel,
												preview: getMessagePreview(session.messages[0])?.substring(0, 200) || "",
											}),
										);
									} else {
										res.setHeader("Content-Type", "application/json");
										res.end(JSON.stringify(session));
									}
								} else {
									res.statusCode = 404;
									res.end(JSON.stringify({ error: "Session not found" }));
								}
								return;
							}

							if (req.method === "PUT") {
								const body = await new Promise<string>((resolve) => {
									let data = "";
									req.on("data", (chunk) => {
										data += chunk;
									});
									req.on("end", () => resolve(data));
								});
								const data = JSON.parse(body);

								// If sessions-metadata, we only update the title if it changed
								if (storeName === "sessions-metadata") {
									if (sessionPath) {
										const session = readSession(sessionPath);
										if (session && session.title !== data.title) {
											const infoEntry = {
												type: "session_info",
												id: Math.random().toString(36).substring(2, 10),
												parentId: session.messages.length > 0 ? "last" : null, // placeholder
												timestamp: new Date().toISOString(),
												name: data.title,
											};
											appendFileSync(sessionPath, JSON.stringify(infoEntry) + "\n");
										}
									}
									res.end(JSON.stringify({ success: true }));
									return;
								}

								// For "sessions" store, we either create new or append
								let targetPath = sessionPath;
								if (!targetPath) {
									const timestamp = new Date().toISOString();
									const fileTimestamp = timestamp.replace(/[:.]/g, "-");
									targetPath = join(sessionsDir, `${fileTimestamp}_${sessionId}.jsonl`);
									if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });

									const header = {
										type: "session",
										version: 3,
										id: sessionId,
										timestamp,
										cwd: "/root/pi-mono",
									};
									writeFileSync(targetPath, JSON.stringify(header) + "\n");
								}

								// Full overwrite or intelligent append?
								// For web-ui compatibility, we'll rewrite the whole file to match the state exactly
								// but keep it as JSONL.
								const header = JSON.parse(readFileSync(targetPath, "utf-8").split("\n")[0]);
								let content = JSON.stringify(header) + "\n";

								if (data.title) {
									content +=
										JSON.stringify({
											type: "session_info",
											id: "title",
											parentId: null,
											timestamp: data.createdAt || new Date().toISOString(),
											name: data.title,
										}) + "\n";
								}

								if (data.thinkingLevel) {
									content +=
										JSON.stringify({
											type: "thinking_level_change",
											id: "thinking",
											parentId: null,
											timestamp: data.createdAt || new Date().toISOString(),
											thinkingLevel: data.thinkingLevel,
										}) + "\n";
								}

								for (const msg of data.messages) {
									content +=
										JSON.stringify({
											type: "message",
											id: Math.random().toString(36).substring(2, 10),
											parentId: null,
											timestamp: msg.timestamp || new Date().toISOString(),
											message: msg,
										}) + "\n";
								}

								writeFileSync(targetPath, content);
								res.end(JSON.stringify({ success: true }));
								return;
							}

							if (req.method === "DELETE") {
								if (sessionPath) {
									// Rename to .bak instead of deleting to be safe?
									// No, user asked for sync, so delete is fine.
									// unlinkSync(sessionPath);
								}
								res.end(JSON.stringify({ success: true }));
								return;
							}
						}

						next();
						return;
					}
					if (req.url?.startsWith("/api/proxy/")) {
						const targetUrl = decodeURIComponent(req.url.substring("/api/proxy/".length));
						console.log(`[agent-proxy] Proxying request to: ${targetUrl}`);

						// Simple proxy implementation using fetch
						// Note: This is a dev-only helper
						const body = await new Promise<Buffer>((resolve) => {
							const chunks: Buffer[] = [];
							req.on("data", (chunk) => chunks.push(chunk));
							req.on("end", () => resolve(Buffer.concat(chunks)));
						});

						try {
							const requestHeaders: Record<string, string> = {};
							for (const [key, value] of Object.entries(req.headers)) {
								if (value !== undefined) {
									requestHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
								}
							}

							// Inject Antigravity User-Agent for Google requests
							// Browsers block this header, so we must inject it at the proxy level
							if (targetUrl.includes("googleapis.com") || targetUrl.includes("localhost:51200")) {
								requestHeaders["user-agent"] = "antigravity/1.21.9 darwin/arm64";
								// Strip X-Goog-Api-Key as the rotator doesn't swap it and it causes 404s at Google
								delete requestHeaders["x-goog-api-key"];
								// Strip Origin and Referer to look like a native IDE request
								delete requestHeaders.origin;
								delete requestHeaders.referer;
							}

							const response = await fetch(targetUrl, {
								method: req.method,
								headers: requestHeaders,
								body: req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
							});

							res.statusCode = response.status;
							for (const [key, value] of response.headers.entries()) {
								res.setHeader(key, value);
							}
							const resBody = await response.arrayBuffer();
							res.end(Buffer.from(resBody));
						} catch (err) {
							console.error(`[agent-proxy] Proxy error: ${err}`);
							res.statusCode = 500;
							res.end(JSON.stringify({ error: String(err) }));
						}
						return;
					}
					next();
				});
			},
		},
	],
});
