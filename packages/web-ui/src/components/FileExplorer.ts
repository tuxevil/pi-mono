import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
	ArrowUp,
	Download,
	File,
	FileCode,
	FileImage,
	FileJson,
	FileText,
	Folder,
	FolderPlus,
	RefreshCw,
	Upload,
	X,
} from "lucide";
import { i18n } from "../utils/i18n.js";

interface FileItem {
	name: string;
	isDirectory: boolean;
	size: number;
	mtime: string;
}

@customElement("pi-file-explorer")
export class FileExplorer extends LitElement {
	@state() private currentPath = ".";
	@state() private items: FileItem[] = [];
	@state() private loading = false;
	@state() private error: string | null = null;
	/** Inline folder-name input state */
	@state() private creatingFolder = false;
	@state() private newFolderName = "";
	@state() private folderError: string | null = null;

	createRenderRoot() {
		return this;
	}

	override connectedCallback() {
		super.connectedCallback();
		this.loadFiles();
	}

	async loadFiles() {
		this.loading = true;
		this.error = null;
		try {
			const resp = await fetch(`/api/files/list?path=${encodeURIComponent(this.currentPath)}`);
			if (resp.ok) {
				const data = await resp.json();
				this.items = data.sort((a: FileItem, b: FileItem) => {
					if (a.isDirectory && !b.isDirectory) return -1;
					if (!a.isDirectory && b.isDirectory) return 1;
					return a.name.localeCompare(b.name);
				});
			} else {
				this.error = i18n("Failed to load files");
			}
		} catch (err) {
			this.error = String(err);
		} finally {
			this.loading = false;
		}
	}

	private navigateTo(name: string) {
		if (name === "..") {
			const parts = this.currentPath.split("/");
			parts.pop();
			this.currentPath = parts.join("/") || ".";
		} else {
			this.currentPath = this.currentPath === "." ? name : `${this.currentPath}/${name}`;
		}
		this.loadFiles();
	}

	private async downloadFile(name: string) {
		const path = this.currentPath === "." ? name : `${this.currentPath}/${name}`;
		window.open(`/api/files/download?path=${encodeURIComponent(path)}`, "_blank");
	}

	private async createFolder() {
		if (!this.creatingFolder) {
			// Show inline input instead of prompt()
			this.creatingFolder = true;
			this.newFolderName = "";
			this.folderError = null;
			return;
		}
		const name = this.newFolderName.trim();
		if (!name) {
			this.folderError = "Name cannot be empty";
			return;
		}
		const path = this.currentPath === "." ? name : `${this.currentPath}/${name}`;
		try {
			const resp = await fetch("/api/files/mkdir", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path }),
			});
			if (resp.ok) {
				this.creatingFolder = false;
				this.loadFiles();
			} else {
				const body = await resp.json().catch(() => ({}));
				this.folderError = body.error ?? i18n("Failed to create folder");
			}
		} catch (err) {
			this.folderError = String(err);
		}
	}

	private cancelCreateFolder() {
		this.creatingFolder = false;
		this.folderError = null;
		this.newFolderName = "";
	}

	private async uploadFile() {
		const input = document.createElement("input");
		input.type = "file";
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;

			this.loading = true;
			try {
				const resp = await fetch(
					`/api/files/upload?path=${encodeURIComponent(this.currentPath)}&name=${encodeURIComponent(file.name)}`,
					{
						method: "POST",
						body: await file.arrayBuffer(),
					},
				);
				if (resp.ok) {
					this.loadFiles();
				} else {
					const body = await resp.json().catch(() => ({}));
					this.error = body.error ?? i18n("Failed to upload file");
				}
			} catch (err) {
				this.error = String(err);
			} finally {
				this.loading = false;
			}
		};
		input.click();
	}

	private getFileIcon(name: string) {
		const ext = name.split(".").pop()?.toLowerCase();
		switch (ext) {
			case "ts":
			case "js":
			case "tsx":
			case "jsx":
			case "py":
			case "go":
				return icon(FileCode, "sm");
			case "md":
			case "txt":
				return icon(FileText, "sm");
			case "json":
				return icon(FileJson, "sm");
			case "png":
			case "jpg":
			case "jpeg":
			case "svg":
			case "gif":
				return icon(FileImage, "sm");
			default:
				return icon(File, "sm");
		}
	}

	render() {
		return html`
            <div class="flex flex-col h-full bg-card/50 backdrop-blur-sm border-l border-border select-none">
                <div class="flex items-center justify-between p-3 border-b border-border bg-secondary/30">
                    <h2 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                        ${icon(Folder, "xs")} ${i18n("File Explorer")}
                    </h2>
                    <div class="flex items-center gap-1">
                        ${Button({
									variant: "ghost",
									size: "sm",
									children: icon(RefreshCw, "xs"),
									onClick: () => this.loadFiles(),
									title: i18n("Refresh"),
								})}
                        ${Button({
									variant: "ghost",
									size: "sm",
									children: icon(FolderPlus, "xs"),
									onClick: () => this.createFolder(),
									title: i18n("New Folder"),
								})}
                        ${Button({
									variant: "ghost",
									size: "sm",
									children: icon(Upload, "xs"),
									onClick: () => this.uploadFile(),
									title: i18n("Upload"),
								})}
                    </div>
                </div>

                <!-- Inline new-folder input -->
                ${
							this.creatingFolder
								? html`
                    <div class="px-3 py-2 border-b border-border bg-muted/30 flex flex-col gap-1">
                        <div class="flex items-center gap-2">
                            <input
                                type="text"
                                class="flex-1 text-sm bg-background border border-border rounded px-2 py-1 outline-none focus:border-primary text-foreground"
                                placeholder=${i18n("Enter folder name:")}
                                .value=${this.newFolderName}
                                @input=${(e: Event) => {
												this.newFolderName = (e.target as HTMLInputElement).value;
											}}
                                @keydown=${(e: KeyboardEvent) => {
												if (e.key === "Enter") this.createFolder();
												if (e.key === "Escape") this.cancelCreateFolder();
											}}
                            />
                            ${Button({ variant: "ghost", size: "sm", children: icon(X, "xs"), onClick: () => this.cancelCreateFolder(), title: "Cancel" })}
                        </div>
                        ${this.folderError ? html`<span class="text-xs text-destructive">${this.folderError}</span>` : ""}
                    </div>
                `
								: ""
						}

                <!-- Path breadcrumbs -->
                <div class="px-3 py-1.5 border-b border-border bg-muted/20 text-[10px] font-mono flex items-center gap-1 overflow-hidden whitespace-nowrap">
                    <span class="text-muted-foreground">${i18n("Path")}:</span>
                    <span class="text-foreground truncate">${this.currentPath}</span>
                </div>

                <div class="flex-1 overflow-y-auto min-h-0 scrollbar-thin">
                    ${
								this.loading
									? html`
                        <div class="flex items-center justify-center p-8 text-muted-foreground animate-pulse">
                            ${icon(RefreshCw, "sm", "animate-spin mr-2")} ${i18n("Loading...")}
                        </div>
                    `
									: this.error
										? html`
                        <div class="p-4 text-destructive text-sm italic">
                            ${this.error}
                        </div>
                    `
										: html`
                        <div class="flex flex-col">
                            ${
											this.currentPath !== "."
												? html`
                                <div 
                                    class="flex items-center gap-2 px-3 py-1.5 hover:bg-accent/50 cursor-pointer group transition-colors"
                                    @click=${() => this.navigateTo("..")}
                                >
                                    <span class="text-muted-foreground group-hover:text-primary">${icon(ArrowUp, "sm")}</span>
                                    <span class="text-sm font-medium">..</span>
                                </div>
                            `
												: ""
										}
                            
                            ${this.items.map(
											(item) => html`
                                <div 
                                    class="flex items-center justify-between px-3 py-1.5 hover:bg-accent/50 cursor-pointer group transition-colors border-b border-border/10"
                                    @click=${() => (item.isDirectory ? this.navigateTo(item.name) : null)}
                                >
                                    <div class="flex items-center gap-2 min-w-0">
                                        <span class="${item.isDirectory ? "text-blue-400" : "text-muted-foreground"} group-hover:scale-110 transition-transform">
                                            ${item.isDirectory ? icon(Folder, "sm") : this.getFileIcon(item.name)}
                                        </span>
                                        <span class="text-sm truncate font-medium ${item.isDirectory ? "text-foreground" : "text-muted-foreground"} group-hover:text-foreground">
                                            ${item.name}
                                        </span>
                                    </div>
                                    <div class="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                        ${
															!item.isDirectory
																? html`
                                            ${Button({
																variant: "ghost",
																size: "sm",
																children: icon(Download, "xs"),
																onClick: (e: Event) => {
																	e.stopPropagation();
																	this.downloadFile(item.name);
																},
																title: i18n("Download"),
															})}
                                        `
																: ""
														}
                                    </div>
                                </div>
                            `,
										)}

                            ${
											this.items.length === 0
												? html`
                                <div class="p-8 text-center text-muted-foreground text-sm italic">
                                    ${i18n("Empty directory")}
                                </div>
                            `
												: ""
										}
                        </div>
                    `
							}
                </div>
            </div>
        `;
	}
}
