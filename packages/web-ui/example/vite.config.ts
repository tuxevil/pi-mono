import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
								delete requestHeaders["origin"];
								delete requestHeaders["referer"];
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
