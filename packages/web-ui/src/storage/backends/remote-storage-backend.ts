import type { StorageBackend, StorageTransaction } from "../types.js";

/**
 * StorageBackend implementation that proxies calls to a remote API.
 * Used to sync data with a local filesystem via a dev server proxy.
 */
export class RemoteStorageBackend implements StorageBackend {
	private baseUrl: string;

	constructor(baseUrl = "/api/storage") {
		this.baseUrl = baseUrl;
	}

	async get<T = unknown>(storeName: string, key: string): Promise<T | null> {
		try {
			const resp = await fetch(`${this.baseUrl}/${storeName}/${encodeURIComponent(key)}`);
			if (resp.status === 404) return null;
			if (!resp.ok) throw new Error(`Failed to get ${storeName}/${key}: ${resp.statusText}`);
			return await resp.json();
		} catch (err) {
			console.error(`[RemoteStorageBackend] Error getting ${storeName}/${key}:`, err);
			return null;
		}
	}

	async set<T = unknown>(storeName: string, key: string, value: T): Promise<void> {
		try {
			const resp = await fetch(`${this.baseUrl}/${storeName}/${encodeURIComponent(key)}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(value),
			});
			if (!resp.ok) throw new Error(`Failed to set ${storeName}/${key}: ${resp.statusText}`);
		} catch (err) {
			console.error(`[RemoteStorageBackend] Error setting ${storeName}/${key}:`, err);
			throw err;
		}
	}

	async delete(storeName: string, key: string): Promise<void> {
		try {
			const resp = await fetch(`${this.baseUrl}/${storeName}/${encodeURIComponent(key)}`, {
				method: "DELETE",
			});
			if (!resp.ok && resp.status !== 404)
				throw new Error(`Failed to delete ${storeName}/${key}: ${resp.statusText}`);
		} catch (err) {
			console.error(`[RemoteStorageBackend] Error deleting ${storeName}/${key}:`, err);
			throw err;
		}
	}

	async keys(storeName: string, prefix?: string): Promise<string[]> {
		try {
			const url = new URL(`${window.location.origin}${this.baseUrl}/${storeName}/keys`);
			if (prefix) url.searchParams.set("prefix", prefix);
			const resp = await fetch(url.toString());
			if (!resp.ok) throw new Error(`Failed to get keys for ${storeName}: ${resp.statusText}`);
			return await resp.json();
		} catch (err) {
			console.error(`[RemoteStorageBackend] Error getting keys for ${storeName}:`, err);
			return [];
		}
	}

	async getAllFromIndex<T = unknown>(
		storeName: string,
		indexName: string,
		direction: "asc" | "desc" = "asc",
	): Promise<T[]> {
		try {
			const url = new URL(`${window.location.origin}${this.baseUrl}/${storeName}/index/${indexName}`);
			url.searchParams.set("direction", direction);
			const resp = await fetch(url.toString());
			if (!resp.ok)
				throw new Error(`Failed to get items from index ${indexName} for ${storeName}: ${resp.statusText}`);
			return await resp.json();
		} catch (err) {
			console.error(`[RemoteStorageBackend] Error getting items from index ${indexName} for ${storeName}:`, err);
			return [];
		}
	}

	async clear(storeName: string): Promise<void> {
		try {
			const resp = await fetch(`${this.baseUrl}/${storeName}`, {
				method: "DELETE",
			});
			if (!resp.ok) throw new Error(`Failed to clear store ${storeName}: ${resp.statusText}`);
		} catch (err) {
			console.error(`[RemoteStorageBackend] Error clearing store ${storeName}:`, err);
			throw err;
		}
	}

	async has(storeName: string, key: string): Promise<boolean> {
		try {
			const resp = await fetch(`${this.baseUrl}/${storeName}/${encodeURIComponent(key)}/exists`);
			if (!resp.ok) throw new Error(`Failed to check existence for ${storeName}/${key}: ${resp.statusText}`);
			const data = await resp.json();
			return data.exists;
		} catch (err) {
			console.error(`[RemoteStorageBackend] Error checking existence for ${storeName}/${key}:`, err);
			return false;
		}
	}

	async transaction<T>(
		_storeNames: string[],
		_mode: "readonly" | "readwrite",
		operation: (tx: StorageTransaction) => Promise<T>,
	): Promise<T> {
		// Remote transactions are tricky. For now, we just implement them as a series of individual calls.
		// This is not atomic, but should suffice for the dev server proxy use case.
		const tx: StorageTransaction = {
			get: (store, key) => this.get(store, key),
			set: (store, key, value) => this.set(store, key, value),
			delete: (store, key) => this.delete(store, key),
		};
		return await operation(tx);
	}

	async getQuotaInfo(): Promise<{ usage: number; quota: number; percent: number }> {
		return { usage: 0, quota: Number.MAX_SAFE_INTEGER, percent: 0 };
	}

	async requestPersistence(): Promise<boolean> {
		return true;
	}
}
