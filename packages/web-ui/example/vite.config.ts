import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		tailwindcss(),
		{
			name: "agent-proxy",
			configureServer(server) {
				server.middlewares.use((req, res, next) => {
					if (req.url === "/api/agent/settings") {
						const path = join(homedir(), ".pi", "agent", "settings.json");
						if (existsSync(path)) {
							res.setHeader("Content-Type", "application/json");
							res.end(readFileSync(path));
						} else {
							res.statusCode = 404;
							res.end(JSON.stringify({ error: "settings.json not found" }));
						}
						return;
					}
					if (req.url === "/api/agent/models") {
						const path = join(homedir(), ".pi", "agent", "models.json");
						if (existsSync(path)) {
							res.setHeader("Content-Type", "application/json");
							res.end(readFileSync(path));
						} else {
							res.statusCode = 404;
							res.end(JSON.stringify({ error: "models.json not found" }));
						}
						return;
					}
					next();
				});
			},
		},
	],
});
