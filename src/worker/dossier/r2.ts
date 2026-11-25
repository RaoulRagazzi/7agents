/**
 * L'adattatore R2 per la porta degli oggetti.
 *
 * L'archivio degli originali parla con `ObjectStore`, non con R2: è ciò che
 * permette di provarlo con un'implementazione in memoria. Questo file è l'unico
 * che conosce il bucket, ed è sottile per scelta — un adattatore che contenga
 * logica è un posto dove quella logica non viene provata.
 *
 * ## Perché non basta il tipo strutturale
 *
 * `R2Bucket` non soddisfa `ObjectStore` da sé: `get` restituisce un oggetto con
 * il corpo da leggere, non i byte, e `put` accetta più tipi di quelli che la
 * porta dichiara. L'adattatore fa quelle due conversioni e nient'altro.
 */

import type { ObjectStore } from "./storage.ts";

/** La parte di `R2Bucket` che serve: dichiararla rende il contratto esplicito. */
export interface R2Like {
	put(
		key: string,
		value: ArrayBuffer | ArrayBufferView,
		options?: { customMetadata?: Record<string, string> },
	): Promise<unknown>;
	head(key: string): Promise<{ size: number } | null>;
	get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
	delete(key: string): Promise<void>;
}

export class R2ObjectStore implements ObjectStore {
	readonly #bucket: R2Like;

	constructor(bucket: R2Like) {
		this.#bucket = bucket;
	}

	async put(
		key: string,
		body: Uint8Array,
		meta?: Record<string, string>,
	): Promise<void> {
		// una vista su un buffer più grande va ritagliata: R2 scriverebbe il
		// buffer intero, e l'impronta non corrisponderebbe più al contenuto
		const bytes = exactBytes(body);
		await this.#bucket.put(key, bytes, meta === undefined ? undefined : { customMetadata: meta });
	}

	async head(key: string): Promise<{ size: number } | null> {
		const found = await this.#bucket.head(key);
		return found === null ? null : { size: found.size };
	}

	async get(key: string): Promise<Uint8Array | null> {
		const object = await this.#bucket.get(key);
		if (object === null) return null;
		return new Uint8Array(await object.arrayBuffer());
	}
}

/**
 * I byte esatti della vista, copiati solo quando serve.
 *
 * `new Uint8Array(buffer, offset, length)` condivide la memoria: passarlo a R2
 * farebbe scrivere tutto il buffer sottostante, non la fetta. La copia avviene
 * soltanto quando la vista non coincide col buffer.
 */
function exactBytes(view: Uint8Array): ArrayBuffer {
	if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
		return view.buffer as ArrayBuffer;
	}
	return view.slice().buffer as ArrayBuffer;
}
