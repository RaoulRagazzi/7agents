import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { R2ObjectStore } from "../r2.ts";
import type { R2Like } from "../r2.ts";
import { sha256Hex } from "../storage.ts";

/** Un bucket finto che registra esattamente i byte ricevuti. */
class FakeBucket implements R2Like {
	readonly scritti = new Map<string, Uint8Array>();
	readonly meta = new Map<string, Record<string, string>>();

	put(
		key: string,
		value: ArrayBuffer | ArrayBufferView,
		options?: { customMetadata?: Record<string, string> },
	): Promise<unknown> {
		const bytes =
			value instanceof ArrayBuffer
				? new Uint8Array(value)
				: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		// copia: il bucket non deve condividere memoria col chiamante
		this.scritti.set(key, new Uint8Array(bytes));
		if (options?.customMetadata !== undefined) this.meta.set(key, options.customMetadata);
		return Promise.resolve(undefined);
	}

	head(key: string): Promise<{ size: number } | null> {
		const found = this.scritti.get(key);
		return Promise.resolve(found === undefined ? null : { size: found.byteLength });
	}

	get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
		const found = this.scritti.get(key);
		if (found === undefined) return Promise.resolve(null);
		return Promise.resolve({
			arrayBuffer: () => Promise.resolve(found.slice().buffer as ArrayBuffer),
		});
	}

	delete(key: string): Promise<void> {
		this.scritti.delete(key);
		return Promise.resolve();
	}
}

const encode = (s: string) => new TextEncoder().encode(s);

describe("adattatore R2", () => {
	test("andata e ritorno dei byte", async () => {
		const bucket = new FakeBucket();
		const store = new R2ObjectStore(bucket);

		await store.put("k", encode("contenuto"));
		assert.deepEqual(await store.head("k"), { size: 9 });
		assert.deepEqual(await store.get("k"), encode("contenuto"));
	});

	test("un oggetto assente dà null, non un errore", async () => {
		const store = new R2ObjectStore(new FakeBucket());
		assert.equal(await store.head("mai"), null);
		assert.equal(await store.get("mai"), null);
	});

	test("i metadati arrivano al bucket", async () => {
		const bucket = new FakeBucket();
		await new R2ObjectStore(bucket).put("k", encode("x"), { cantina: "c1" });
		assert.deepEqual(bucket.meta.get("k"), { cantina: "c1" });
	});

	test("senza metadati non si passa un oggetto vuoto", async () => {
		const bucket = new FakeBucket();
		await new R2ObjectStore(bucket).put("k", encode("x"));
		assert.equal(bucket.meta.has("k"), false);
	});

	test("una vista su un buffer più grande scrive solo la propria fetta", async () => {
		// il punto sottile: `new Uint8Array(buffer, offset, length)` condivide la
		// memoria. Senza ritaglio R2 scriverebbe il buffer intero, e l'impronta
		// del contenuto non corrisponderebbe più a ciò che è stato scritto
		const grande = new Uint8Array(100);
		grande.fill(0xff);
		const fetta = new Uint8Array(grande.buffer, 10, 5);
		fetta.set([1, 2, 3, 4, 5]);

		const bucket = new FakeBucket();
		await new R2ObjectStore(bucket).put("k", fetta);

		const scritto = bucket.scritti.get("k")!;
		assert.equal(scritto.byteLength, 5, `scritti ${scritto.byteLength} byte invece di 5`);
		assert.deepEqual([...scritto], [1, 2, 3, 4, 5]);
	});

	test("l'impronta del contenuto resta verificabile dopo il giro", async () => {
		// è la conseguenza che conta: la deduplica si regge sull'impronta
		const grande = new Uint8Array(64).fill(0xaa);
		const fetta = new Uint8Array(grande.buffer, 8, 16);
		fetta.set(encode("sedici caratteri"));

		const attesa = await sha256Hex(fetta);
		const bucket = new FakeBucket();
		const store = new R2ObjectStore(bucket);
		await store.put("k", fetta);

		const riletto = (await store.get("k"))!;
		assert.equal(await sha256Hex(riletto), attesa);
	});

	test("una vista che coincide col buffer non viene copiata inutilmente", async () => {
		const esatta = encode("esatta");
		const bucket = new FakeBucket();
		await new R2ObjectStore(bucket).put("k", esatta);
		assert.deepEqual([...bucket.scritti.get("k")!], [...esatta]);
	});

	test("un contenuto vuoto si conserva come vuoto", async () => {
		const bucket = new FakeBucket();
		const store = new R2ObjectStore(bucket);
		await store.put("k", new Uint8Array(0));
		assert.deepEqual(await store.head("k"), { size: 0 });
		assert.deepEqual(await store.get("k"), new Uint8Array(0));
	});
});
