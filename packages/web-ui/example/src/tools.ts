import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";

function createRemoteTool(name: string, description: string, parameters: any): AgentTool<any, any> {
	return {
		name,
		label: name,
		description,
		parameters,
		execute: async (toolCallId: string, params: any) => {
			const resp = await fetch("/api/tools/execute", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ toolCallId, toolName: name, params, cwd: "/root/pi-mono" }),
			});
			if (!resp.ok) {
				const err = await resp.json().catch(() => ({}));
				throw new Error(err.error || `HTTP ${resp.status} - Tool execution failed`);
			}
			return await resp.json();
		},
	};
}

export const remoteBashTool = createRemoteTool(
	"bash",
	"Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
	Type.Object({
		command: Type.String({ description: "Bash command to execute" }),
		timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	}),
);

export const remoteReadTool = createRemoteTool(
	"read",
	"Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
	Type.Object({
		path: Type.String({ description: "Path to the file or directory to read" }),
		offset: Type.Optional(Type.Number({ description: "Line offset for pagination (0-indexed). Defaults to 0." })),
		limit: Type.Optional(Type.Number({ description: "Number of lines to read. Defaults to 2000." })),
	}),
);

export const remoteWriteTool = createRemoteTool(
	"write",
	"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
	Type.Object({
		path: Type.String({ description: "Path to the file to write" }),
		content: Type.String({ description: "Content to write to the file" }),
	}),
);

export const remoteEditTool = createRemoteTool(
	"edit",
	"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
	Type.Object({
		path: Type.String({ description: "Path to the file to edit" }),
		edits: Type.Array(
			Type.Object({
				oldText: Type.String({
					description: "The exact text to replace. Must match exactly including whitespace.",
				}),
				newText: Type.String({ description: "The text to replace it with." }),
			}),
			{ description: "List of edits to apply to the file." },
		),
	}),
);
