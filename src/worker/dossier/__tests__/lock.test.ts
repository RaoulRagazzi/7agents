import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { SerialQueue } from "../lock.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("coda seriale", () => {
	test("esegue una operazione alla volta", async () => {
		const q = new SerialQueue();
		let attive = 0;
		let massimo = 0;

		await Promise.all(
			Array.from({ length: 20 }, () =>
				q.run(async () => {
					attive += 1;
					massimo = Math.max(massimo, attive);
					await sleep(2);
					attive -= 1;
				}),
			),
		);

		assert.equal(massimo, 1, `fino a ${massimo} operazioni contemporanee`);
	});

	test("rispetta l'ordine di arrivo", async () => {
		const q = new SerialQueue();
		const ordine: number[] = [];

		await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				q.run(async () => {
					// le prime attendono più delle ultime: senza serializzazione
					// l'ordine si invertirebbe
					await sleep(10 - i);
					ordine.push(i);
				}),
			),
		);

		assert.deepEqual(ordine, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	test("un fallimento non blocca la coda", async () => {
		const q = new SerialQueue();
		const eseguite: string[] = [];

		const prima = q.run(async () => {
			eseguite.push("prima");
			throw new Error("guasto");
		});
		const seconda = q.run(async () => {
			eseguite.push("seconda");
			return "ok";
		});

		await assert.rejects(() => prima, /guasto/);
		assert.equal(await seconda, "ok");
		assert.deepEqual(eseguite, ["prima", "seconda"]);
	});

	test("il rifiuto non si propaga alle operazioni successive", async () => {
		const q = new SerialQueue();
		q.run(() => Promise.reject(new Error("x"))).catch(() => undefined);

		// dieci operazioni dopo un rifiuto: tutte devono riuscire
		const esiti = await Promise.all(
			Array.from({ length: 10 }, (_, i) => q.run(() => Promise.resolve(i))),
		);
		assert.deepEqual(esiti, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	test("il valore di ritorno arriva a chi ha accodato", async () => {
		const q = new SerialQueue();
		const esiti = await Promise.all([
			q.run(async () => "a"),
			q.run(async () => 2),
			q.run(async () => ({ c: true })),
		]);
		assert.deepEqual(esiti, ["a", 2, { c: true }]);
	});

	test("la sequenza leggi-scrivi non si interfoglia", async () => {
		// è il caso che la coda esiste per proteggere: senza di essa due
		// operazioni leggono la stessa versione e scrivono la stessa successiva
		const q = new SerialQueue();
		let versione = 0;
		const scritte: number[] = [];

		await Promise.all(
			Array.from({ length: 15 }, () =>
				q.run(async () => {
					const letta = versione;
					await sleep(1); // qui, senza coda, entrerebbe un'altra operazione
					versione = letta + 1;
					scritte.push(versione);
				}),
			),
		);

		assert.deepEqual(scritte, Array.from({ length: 15 }, (_, i) => i + 1));
		assert.equal(new Set(scritte).size, 15, "nessuna versione duplicata");
	});

	test("le statistiche riflettono coda e attesa", async () => {
		let t = 0;
		const q = new SerialQueue({ now: () => (t += 10) });

		assert.deepEqual(q.stats, { completate: 0, inCoda: 0, attesaMassimaMs: 0 });

		const lavori = Array.from({ length: 5 }, () => q.run(async () => sleep(1)));
		assert.equal(q.stats.inCoda, 5, "le cinque operazioni sono in coda");

		await Promise.all(lavori);
		assert.equal(q.stats.completate, 5);
		assert.equal(q.stats.inCoda, 0);
		assert.ok(q.stats.attesaMassimaMs > 0, "un'attesa è stata osservata");
	});

	test("svuotare una coda vuota è immediato e non è un errore", async () => {
		const q = new SerialQueue();
		await q.drain();
		assert.deepEqual(q.stats, { completate: 0, inCoda: 0, attesaMassimaMs: 0 });
	});

	test("drain attende anche le operazioni che falliscono", async () => {
		const q = new SerialQueue();
		q.run(() => Promise.reject(new Error("x"))).catch(() => undefined);
		q.run(async () => sleep(5)).catch(() => undefined);
		await q.drain();
		assert.equal(q.stats.inCoda, 0);
	});
});
