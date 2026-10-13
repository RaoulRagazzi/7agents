/**
 * La porta verso l'archivio degli oggetti.
 *
 * Gli originali sono immutabili e indirizzati per contenuto: la deduplica che
 * il Documentalista deve fare è una conseguenza della chiave, non un algoritmo.
 *
 * Un `R2Bucket` si adatta a questa porta con poche righe; la porta esiste
 * perché l'ingestione si prova senza un bucket.
 */

export interface ObjectStore {
	put(key: string, body: Uint8Array, meta?: Record<string, string>): Promise<void>;
	head(key: string): Promise<{ readonly size: number } | null>;
	get(key: string): Promise<Uint8Array | null>;
}

/** Impronta esadecimale del contenuto: è l'identità dell'originale. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const buffer = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
	const digest = await crypto.subtle.digest("SHA-256", buffer);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * La chiave dell'oggetto include la cantina **e** l'impronta.
 *
 * La cantina nel percorso non è decorativa: rende visibile un accesso fuori
 * confine in un elenco di oggetti, e impedisce che due cantine condividano
 * fisicamente lo stesso originale pur avendone caricato lo stesso contenuto.
 */
export function objectKey(cantinaId: string, sha256: string): string {
	return `cantina/${cantinaId}/originali/${sha256}`;
}

/** Archivio in memoria per i test. */
export class MemoryObjectStore implements ObjectStore {
	readonly #objects = new Map<string, Uint8Array>();
	readonly meta = new Map<string, Record<string, string>>();
	puts = 0;

	put(key: string, body: Uint8Array, meta?: Record<string, string>): Promise<void> {
		this.puts += 1;
		this.#objects.set(key, body);
		if (meta !== undefined) this.meta.set(key, meta);
		return Promise.resolve();
	}

	head(key: string): Promise<{ size: number } | null> {
		const found = this.#objects.get(key);
		return Promise.resolve(found === undefined ? null : { size: found.byteLength });
	}

	get(key: string): Promise<Uint8Array | null> {
		return Promise.resolve(this.#objects.get(key) ?? null);
	}

	get size(): number {
		return this.#objects.size;
	}
}
