import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { CantinaDossier } from "../repository.ts";
import { openDossier } from "../repository.ts";
import { MemoryObjectStore, objectKey, sha256Hex } from "../storage.ts";
import type { PageText } from "../ingest.ts";
import { SqliteDatabase, fixedClock, sequentialIds } from "./sqlite-adapter.ts";

const encode = (s: string) => new TextEncoder().encode(s);

const SCHEDA = `Soave Classico DOC 2021. Gradazione dodici virgola cinque per cento in volume.
Affinamento in acciaio per sei mesi, poi tre mesi in bottiglia prima della vendita.
Il vigneto si trova a trecento metri di altitudine, con esposizione a sud-est.`;

let db: SqliteDatabase;
let store: MemoryObjectStore;
let uno: CantinaDossier;
let due: CantinaDossier;

beforeEach(async () => {
	db = new SqliteDatabase();
	db.addCantina("c_uno", "Cantina Uno");
	db.addCantina("c_due", "Cantina Due");
	store = new MemoryObjectStore();
	uno = await openDossier(db, "c_uno", { clock: fixedClock(), ids: sequentialIds("_u") });
	due = await openDossier(db, "c_due", { clock: fixedClock(), ids: sequentialIds("_d") });
});

function ingest(dossier: CantinaDossier, filename: string, text = SCHEDA) {
	return dossier.archive.ingest(store, {
		bytes: encode(text),
		filename,
		mime: "application/pdf",
		uploadedBy: "produttore",
	});
}

describe("acquisizione", () => {
	test("un materiale nuovo entra nell'archivio e nell'oggetto", async () => {
		const out = await ingest(uno, "scheda-tecnica-soave.pdf");
		assert.equal(out.status, "nuovo");
		assert.ok(out.status === "nuovo");

		assert.equal(out.key, objectKey("c_uno", out.sha256));
		assert.deepEqual(await store.head(out.key), { size: encode(SCHEDA).byteLength });

		const record = await uno.archive.get(out.documentId);
		assert.ok(record);
		assert.equal(record.status, "caricato");
		assert.equal(record.filename, "scheda-tecnica-soave.pdf");
		assert.equal(record.sizeBytes, encode(SCHEDA).byteLength);
		assert.equal(record.documentClass, "scheda_tecnica");
	});

	test("lo stesso contenuto caricato due volte non genera due fonti", async () => {
		const first = await ingest(uno, "scheda.pdf");
		const second = await ingest(uno, "copia-della-scheda.pdf");

		assert.equal(first.status, "nuovo");
		assert.equal(second.status, "duplicato");
		assert.ok(first.status === "nuovo" && second.status === "duplicato");
		assert.equal(second.documentId, first.documentId);

		assert.equal((await uno.archive.list()).length, 1);
		assert.equal(store.puts, 1, "l'originale non deve essere riscritto");
	});

	test("un contenuto diverso con lo stesso nome è una fonte distinta", async () => {
		const a = await ingest(uno, "scheda.pdf", SCHEDA);
		const b = await ingest(uno, "scheda.pdf", `${SCHEDA} Annata 2022.`);
		assert.equal(a.status, "nuovo");
		assert.equal(b.status, "nuovo");
		assert.equal((await uno.archive.list()).length, 2);
	});

	test("una classe incerta viene segnalata come da confermare", async () => {
		const out = await ingest(uno, "documento.pdf");
		assert.ok(out.status === "nuovo");
		assert.equal(out.proposal.documentClass, "ignoto");
		assert.equal(out.needsConfirmation, true);
	});

	test("una classe riconosciuta non richiede conferma", async () => {
		const out = await ingest(uno, "listino-prezzi.pdf");
		assert.ok(out.status === "nuovo");
		assert.equal(out.needsConfirmation, false);
	});
});

describe("isolamento dell'archivio", () => {
	test("lo stesso contenuto in due cantine resta separato", async () => {
		const a = await ingest(uno, "scheda.pdf");
		const b = await ingest(due, "scheda.pdf");

		assert.equal(a.status, "nuovo");
		assert.equal(b.status, "nuovo", "la seconda cantina non deve vedere un duplicato");
		assert.ok(a.status === "nuovo" && b.status === "nuovo");
		assert.equal(a.sha256, b.sha256, "stesso contenuto, stessa impronta");
		assert.notEqual(a.key, b.key, "chiavi d'oggetto distinte per cantina");
		assert.equal(store.size, 2);
	});

	test("un documento di un'altra cantina non è raggiungibile per id", async () => {
		const out = await ingest(due, "scheda.pdf");
		assert.ok(out.status === "nuovo");

		assert.equal(await uno.archive.get(out.documentId), null);
		assert.deepEqual(await uno.archive.listChunks(out.documentId), []);
	});

	test("ciascun archivio elenca soltanto i propri materiali", async () => {
		await ingest(uno, "a.pdf", "primo contenuto, abbastanza lungo per essere una fonte reale.");
		await ingest(uno, "b.pdf", "secondo contenuto, anch'esso di lunghezza sufficiente.");
		await ingest(due, "c.pdf", "terzo contenuto, che appartiene all'altra cantina.");

		assert.equal((await uno.archive.list()).length, 2);
		assert.equal((await due.archive.list()).length, 1);
	});

	test("registrare un'estrazione su un documento altrui è un errore", async () => {
		const out = await ingest(due, "scheda.pdf");
		assert.ok(out.status === "nuovo");
		await assert.rejects(
			() => uno.archive.recordExtraction(out.documentId, [{ page: 1, text: SCHEDA }]),
			/non presente in questo archivio/,
		);
	});
});

describe("estrazione", () => {
	test("un testo leggibile viene segmentato e il documento passa a estratto", async () => {
		const out = await ingest(uno, "scheda.pdf");
		assert.ok(out.status === "nuovo");

		const pages: PageText[] = [
			{ page: 1, text: SCHEDA },
			{ page: 2, text: `${SCHEDA}\n\nSeconda pagina con altro testo utile.` },
		];
		const result = await uno.archive.recordExtraction(out.documentId, pages, {
			maxChars: 120,
			overlapChars: 20,
		});

		assert.equal(result.status, "estratto");
		assert.ok(result.chunks > 2);

		const record = await uno.archive.get(out.documentId);
		assert.equal(record!.status, "estratto");
		assert.equal(record!.pages, 2);

		// gli offset conservati nel database tornano al passaggio esatto
		for (const chunk of await uno.archive.listChunks(out.documentId)) {
			const page = pages.find((p) => p.page === chunk.page)!;
			assert.equal(page.text.slice(chunk.charStart, chunk.charEnd), chunk.text);
		}
	});

	test("un testo illeggibile non viene segmentato: nessun frammento inquina l'indice", async () => {
		const out = await ingest(uno, "scansione.pdf");
		assert.ok(out.status === "nuovo");

		const result = await uno.archive.recordExtraction(out.documentId, [
			{ page: 1, text: "~|#@^¬ł€¶•ªº–≠«∑€®†¥øπ å∫ç∂´ƒ©˙∆˚¬…æ Ω≈ç√∫˜µ≤≥÷ ~|#@^" },
		]);

		assert.equal(result.status, "illeggibile");
		assert.equal(result.chunks, 0);
		assert.match(result.reason ?? "", /non alfabetico/);

		const record = await uno.archive.get(out.documentId);
		assert.equal(record!.status, "illeggibile");
		assert.ok(record!.illegibleReason);
		assert.deepEqual(await uno.archive.listChunks(out.documentId), []);
	});

	test("un documento illeggibile si recupera con una nuova estrazione riuscita", async () => {
		const out = await ingest(uno, "scansione.pdf");
		assert.ok(out.status === "nuovo");

		await uno.archive.recordExtraction(out.documentId, [{ page: 1, text: "~|#@^¬ł" }]);
		assert.equal((await uno.archive.get(out.documentId))!.status, "illeggibile");

		await uno.archive.recordExtraction(out.documentId, [{ page: 1, text: SCHEDA }]);
		const record = await uno.archive.get(out.documentId);
		assert.equal(record!.status, "estratto");
		assert.equal(record!.illegibleReason, undefined, "il motivo deve essere azzerato");
	});

	test("l'elenco si può filtrare per stato", async () => {
		const buono = await ingest(uno, "scheda.pdf", SCHEDA);
		const cattivo = await ingest(uno, "scansione.pdf", "~|#@^¬ł€¶•ªº–≠«∑");
		assert.ok(buono.status === "nuovo" && cattivo.status === "nuovo");

		await uno.archive.recordExtraction(buono.documentId, [{ page: 1, text: SCHEDA }]);
		await uno.archive.recordExtraction(cattivo.documentId, [{ page: 1, text: "~|#@^¬ł" }]);

		assert.equal((await uno.archive.list({ status: "estratto" })).length, 1);
		assert.equal((await uno.archive.list({ status: "illeggibile" })).length, 1);
	});
});

describe("collegamenti proposti", () => {
	test("un'associazione incerta resta incerta, con la sua fiducia", async () => {
		const out = await ingest(uno, "scheda.pdf");
		assert.ok(out.status === "nuovo");

		const written = await uno.archive.proposeLinks(out.documentId, [
			{ scope: { type: "vino", ref: "soave_classico" }, confidence: 0.9 },
			{ scope: { type: "annata", ref: "soave_classico:2021" }, confidence: 0.4 },
		]);
		assert.equal(written, 2);

		const links = await uno.archive.listLinks(out.documentId);
		assert.equal(links.length, 2);
		assert.ok(links.every((l) => l.state === "proposto"), "nessun collegamento è confermato");
		assert.deepEqual(
			links.map((l) => l.confidence).sort(),
			[0.4, 0.9],
		);
	});

	test("lo stesso collegamento proposto due volte non è un errore", async () => {
		const out = await ingest(uno, "scheda.pdf");
		assert.ok(out.status === "nuovo");
		const link = { scope: { type: "vino", ref: "soave" } as const, confidence: 0.8 };

		assert.equal(await uno.archive.proposeLinks(out.documentId, [link]), 1);
		assert.equal(await uno.archive.proposeLinks(out.documentId, [link]), 0);
		assert.equal((await uno.archive.listLinks(out.documentId)).length, 1);
	});

	test("i collegamenti di un documento altrui non sono visibili né scrivibili", async () => {
		const out = await ingest(due, "scheda.pdf");
		assert.ok(out.status === "nuovo");
		await due.archive.proposeLinks(out.documentId, [
			{ scope: { type: "vino", ref: "soave" }, confidence: 0.9 },
		]);

		assert.deepEqual(await uno.archive.listLinks(out.documentId), []);
		assert.equal(
			await uno.archive.proposeLinks(out.documentId, [
				{ scope: { type: "vino", ref: "altro" }, confidence: 0.9 },
			]),
			0,
		);
		assert.equal((await due.archive.listLinks(out.documentId)).length, 1);
	});
});

describe("dall'archivio al kernel", () => {
	test("i blocchi documento vengono dall'archivio della cantina", async () => {
		const out = await ingest(uno, "scheda.pdf");
		assert.ok(out.status === "nuovo");
		await uno.archive.recordExtraction(out.documentId, [{ page: 1, text: SCHEDA }]);

		const blocks = await uno.archive.asModelDocuments(store, [out.documentId]);
		assert.equal(blocks.length, 1);
		assert.equal(blocks[0]!.documentId, out.documentId);
		// il titolo è l'identificativo: è così che la citazione torna al documento
		assert.equal(blocks[0]!.title, out.documentId);
		assert.equal(blocks[0]!.citations, true);
		assert.match(blocks[0]!.text, /Soave Classico/);
	});

	test("un documento illeggibile non diventa una fonte per il modello", async () => {
		const out = await ingest(uno, "scansione.pdf");
		assert.ok(out.status === "nuovo");
		await uno.archive.recordExtraction(out.documentId, [{ page: 1, text: "~|#@^¬ł" }]);

		assert.deepEqual(await uno.archive.asModelDocuments(store, [out.documentId]), []);
	});

	test("un documento di un'altra cantina non può entrare in una richiesta", async () => {
		const mio = await ingest(uno, "mio.pdf", SCHEDA);
		const altrui = await ingest(due, "altrui.pdf", `${SCHEDA} Altra cantina.`);
		assert.ok(mio.status === "nuovo" && altrui.status === "nuovo");
		await uno.archive.recordExtraction(mio.documentId, [{ page: 1, text: SCHEDA }]);
		await due.archive.recordExtraction(altrui.documentId, [{ page: 1, text: SCHEDA }]);

		const blocks = await uno.archive.asModelDocuments(store, [
			mio.documentId,
			altrui.documentId,
		]);
		assert.equal(blocks.length, 1);
		assert.equal(blocks[0]!.documentId, mio.documentId);
	});

	test("senza frammenti ricade sull'originale dall'archivio", async () => {
		const out = await ingest(uno, "scheda.pdf");
		assert.ok(out.status === "nuovo");
		// nessuna estrazione registrata
		const blocks = await uno.archive.asModelDocuments(store, [out.documentId]);
		assert.equal(blocks.length, 1);
		assert.match(blocks[0]!.text, /Soave Classico/);
	});

	test("l'impronta resta verificabile dall'oggetto conservato", async () => {
		const out = await ingest(uno, "scheda.pdf");
		assert.ok(out.status === "nuovo");

		const bytes = await store.get(out.key);
		assert.ok(bytes);
		assert.equal(await sha256Hex(bytes), out.sha256);
	});
});
