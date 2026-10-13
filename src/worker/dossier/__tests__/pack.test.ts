import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildContentPack, vectorizeNamespace, VISIBILITA_PER_DESTINAZIONE } from "../pack.ts";
import type { Fact, Visibility } from "../types.ts";
import { fact } from "./fixtures.ts";

const VISIBILITA: readonly Visibility[] = ["pubblico", "commerciale", "interno", "riservato"];

describe("pacchetto per il Sommelier", () => {
	test("accoglie solo i fatti approvati e pubblici", () => {
		const facts: Fact[] = [
			fact("cantina", "c1", "storia", { visibility: "pubblico" }),
			fact("cantina", "c1", "listino", { visibility: "commerciale" }),
			fact("cantina", "c1", "note_interne", { visibility: "interno" }),
			fact("sede", "s1", "sede_legale", { visibility: "riservato" }),
			fact("vino", "w1", "bozza", { visibility: "pubblico", state: "proposto" }),
		];

		const pack = buildContentPack("c1", "sommelier", facts);

		assert.equal(pack.entries.length, 1);
		assert.equal(pack.entries[0]!.key, "storia");
		assert.equal(pack.excluded.visibilitaNegata, 3);
		assert.equal(pack.excluded.nonApprovati, 1);
	});

	test("nessun fatto riservato raggiunge mai un pacchetto, per nessuna destinazione", () => {
		const riservato = fact("sede", "s1", "partita_iva", { visibility: "riservato" });
		const interno = fact("cantina", "c1", "note", { visibility: "interno" });

		for (const destination of Object.keys(
			VISIBILITA_PER_DESTINAZIONE,
		) as (keyof typeof VISIBILITA_PER_DESTINAZIONE)[]) {
			const pack = buildContentPack("c1", destination, [riservato, interno]);
			assert.equal(pack.entries.length, 0, `${destination} ha accolto dati non pubblici`);
			assert.equal(pack.excluded.visibilitaNegata, 2);
		}
	});

	test("nessuna destinazione ammette 'riservato' o 'interno' nella propria tabella", () => {
		for (const [destination, ammesse] of Object.entries(VISIBILITA_PER_DESTINAZIONE)) {
			assert.ok(!ammesse.includes("riservato"), `${destination} ammette riservato`);
			assert.ok(!ammesse.includes("interno"), `${destination} ammette interno`);
		}
	});

	test("il Sommelier è la destinazione più restrittiva", () => {
		const sommelier = VISIBILITA_PER_DESTINAZIONE.sommelier;
		for (const [destination, ammesse] of Object.entries(VISIBILITA_PER_DESTINAZIONE)) {
			if (destination === "sommelier") continue;
			assert.ok(
				sommelier.every((v) => ammesse.includes(v)),
				`sommelier ammette qualcosa che ${destination} non ammette`,
			);
		}
		assert.deepEqual([...sommelier], ["pubblico"]);
	});

	test("un dato dichiarato non disponibile non diventa contenuto", () => {
		const facts = [
			fact("cantina", "c1", "premi", { value: { kind: "non_disponibile" } }),
			fact("cantina", "c1", "storia"),
		];
		const pack = buildContentPack("c1", "sommelier", facts);
		assert.equal(pack.entries.length, 1);
		assert.equal(pack.excluded.senzaValore, 1);
	});

	test("scarta i fatti di un'altra cantina anche se glieli si passa", () => {
		const mio = fact("cantina", "c1", "storia");
		const altrui = { ...fact("cantina", "c2", "storia"), cantinaId: "c2" };
		const pack = buildContentPack("c1", "sommelier", [mio, altrui]);
		assert.equal(pack.entries.length, 1);
		assert.equal(pack.excluded.altraCantina, 1);
	});

	test("lo spazio dei nomi è quello della cantina", () => {
		const pack = buildContentPack("c1", "sommelier", []);
		assert.equal(pack.namespace, vectorizeNamespace("c1"));
		assert.equal(pack.namespace, "cantina:c1");
	});

	test("porta le versioni dei fatti usati: entrano nella chiave d'operazione", () => {
		const facts = [
			fact("cantina", "c1", "storia", { version: 3 }),
			fact("vino", "w1", "denominazione", { version: 1 }),
		];
		const pack = buildContentPack("c1", "sommelier", facts);
		assert.deepEqual(
			[...pack.factVersions].sort((a, b) => (a.factId < b.factId ? -1 : 1)),
			[
				{ factId: "cantina:c1:storia", version: 3 },
				{ factId: "vino:w1:denominazione", version: 1 },
			],
		);
	});

	test("è deterministico: l'ordine d'ingresso non cambia il pacchetto", () => {
		const facts = [
			fact("vino", "w1", "denominazione"),
			fact("cantina", "c1", "storia"),
			fact("annata", "w1:2021", "gradazione"),
		];
		const a = buildContentPack("c1", "sommelier", facts);
		const b = buildContentPack("c1", "sommelier", [...facts].reverse());
		assert.deepEqual(a.entries, b.entries);
		assert.deepEqual(a.factVersions, b.factVersions);
	});

	test("un pacchetto vuoto non è un errore, e lo dichiara nei conteggi", () => {
		const pack = buildContentPack("c1", "sommelier", []);
		assert.deepEqual(pack.entries, []);
		assert.deepEqual(pack.excluded, {
			nonApprovati: 0,
			visibilitaNegata: 0,
			altraCantina: 0,
			senzaValore: 0,
		});
	});

	test("ogni fatto scartato è contato in esattamente una categoria", () => {
		// un fatto per ciascuna combinazione stato × visibilità
		const facts: Fact[] = [];
		for (const visibility of VISIBILITA) {
			for (const state of ["proposto", "approvato", "superato"] as const) {
				facts.push(
					fact("cantina", "c1", `k_${visibility}_${state}`, { visibility, state }),
				);
			}
		}
		const pack = buildContentPack("c1", "sommelier", facts);
		const scartati =
			pack.excluded.nonApprovati +
			pack.excluded.visibilitaNegata +
			pack.excluded.altraCantina +
			pack.excluded.senzaValore;
		assert.equal(scartati + pack.entries.length, facts.length);
		// solo (pubblico, approvato) passa
		assert.equal(pack.entries.length, 1);
	});
});
