/**
 * Isolamento fra cantine — criterio di completamento della Tranche 2.
 *
 * Due onboarding contemporanei con dati deliberatamente simili: stesse
 * denominazioni, stesse annate, nomi di vino quasi uguali, la stessa impronta
 * di documento. Nessun fatto, nessuna citazione, nessun frammento recuperato
 * deve passare da una cantina all'altra.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { getAgent } from "../agents.ts";
import { buildContentPack, vectorizeNamespace } from "../pack.ts";
import type { CantinaDossier } from "../repository.ts";
import { openDossier } from "../repository.ts";
import type { FactDraft } from "../admission.ts";
import {
	SqliteDatabase,
	fixedClock,
	sequentialIds,
} from "./sqlite-adapter.ts";

const specialista = getAgent("specialista_bianchi_spumanti_passiti")!;
const anagrafica = getAgent("anagrafica")!;

let db: SqliteDatabase;
let uno: CantinaDossier;
let due: CantinaDossier;

/** Lo stesso vino, la stessa annata, in due cantine diverse. */
function gradazione(docId: string, value: number): FactDraft {
	return {
		cantinaId: "ignorato",
		scope: { type: "annata", ref: "soave_classico:2021" },
		key: "gradazione_alcolica",
		value: { kind: "numero", value, unit: "%vol" },
		visibility: "pubblico",
		provenance: [{ kind: "documento", documentId: docId, page: 4 }],
		state: "proposto",
	};
}

beforeEach(async () => {
	db = new SqliteDatabase();
	db.addCantina("c_uno", "Cantina Uno");
	db.addCantina("c_due", "Cantina Due");
	// la stessa impronta in due cantine: ammessa, e deve restare separata
	db.addDocument("d_uno", "c_uno", "impronta_condivisa");
	db.addDocument("d_due", "c_due", "impronta_condivisa");

	uno = await openDossier(db, "c_uno", {
		clock: fixedClock(),
		ids: sequentialIds("_u"),
	});
	due = await openDossier(db, "c_due", {
		clock: fixedClock(),
		ids: sequentialIds("_d"),
	});
});

describe("apertura del fascicolo", () => {
	test("una cantina inesistente è un errore, non un fascicolo vuoto", async () => {
		await assert.rejects(() => openDossier(db, "c_fantasma"), /non presente/);
	});

	test("il fascicolo conosce la propria cantina e non la riceve più", () => {
		assert.equal(uno.cantinaId, "c_uno");
		assert.equal(due.cantinaId, "c_due");
	});
});

describe("isolamento in lettura", () => {
	beforeEach(async () => {
		assert.equal((await uno.proposeFact(specialista, gradazione("d_uno", 12.5))).ok, true);
		assert.equal((await due.proposeFact(specialista, gradazione("d_due", 14))).ok, true);
	});

	test("ciascun fascicolo vede soltanto i propri fatti", async () => {
		const funo = await uno.listFacts();
		const fdue = await due.listFacts();

		assert.equal(funo.length, 1);
		assert.equal(fdue.length, 1);
		assert.ok(funo.every((f) => f.cantinaId === "c_uno"));
		assert.ok(fdue.every((f) => f.cantinaId === "c_due"));
	});

	test("la stessa chiave nello stesso ambito dà valori diversi per cantina", async () => {
		const scope = { type: "annata", ref: "soave_classico:2021" } as const;
		const a = await uno.getLiveFact(scope, "gradazione_alcolica");
		const b = await due.getLiveFact(scope, "gradazione_alcolica");

		assert.ok(a && b);
		assert.deepEqual(a.value, { kind: "numero", value: 12.5, unit: "%vol" });
		assert.deepEqual(b.value, { kind: "numero", value: 14, unit: "%vol" });
		assert.notEqual(a.id, b.id);
	});

	test("il vincolo di unicità è per cantina, non globale", async () => {
		// due fatti vivi sulla stessa (ambito, chiave) in cantine diverse convivono
		const rows = db.raw<{ n: number }>(
			`SELECT count(*) n FROM fact WHERE scope_ref='soave_classico:2021'
			   AND key='gradazione_alcolica' AND state='proposto'`,
		);
		assert.equal(rows[0]!.n, 2);
	});

	test("la citazione di un fatto punta al documento della propria cantina", async () => {
		const [a] = await uno.listFacts();
		const [b] = await due.listFacts();
		assert.ok(a && b);

		const pa = a.provenance[0];
		const pb = b.provenance[0];
		assert.equal(pa.kind, "documento");
		assert.equal(pb.kind, "documento");
		assert.equal(pa.kind === "documento" && pa.documentId, "d_uno");
		assert.equal(pb.kind === "documento" && pb.documentId, "d_due");
	});
});

describe("isolamento in scrittura", () => {
	test("il cantinaId dichiarato dall'agente viene ignorato", async () => {
		// un agente che dichiarasse la cantina sbagliata non la raggiunge
		const draft = { ...gradazione("d_due", 14), cantinaId: "c_due" };
		const out = await uno.proposeFact(specialista, draft);
		assert.equal(out.ok, true);

		assert.equal((await due.listFacts()).length, 0, "la scrittura è finita in c_due");
		assert.equal((await uno.listFacts()).length, 1);
	});

	test("un fatto di un'altra cantina non si approva per id", async () => {
		const out = await due.proposeFact(specialista, gradazione("d_due", 14));
		assert.ok(out.ok);

		const esito = await uno.approve(out.factId, { approvedBy: "orchestratore" });
		assert.equal(esito.ok, false);
		assert.match(esito.detail ?? "", /non presente in questo fascicolo/);

		// e il fatto resta non approvato
		const [f] = await due.listFacts();
		assert.equal(f!.state, "proposto");
	});

	test("un fatto di un'altra cantina non si supera per id", async () => {
		const out = await due.proposeFact(specialista, gradazione("d_due", 14));
		assert.ok(out.ok);

		const esito = await uno.supersede(specialista, out.factId, gradazione("d_uno", 13));
		assert.equal(esito.ok, false);

		const [f] = await due.listFacts();
		assert.equal(f!.version, 1);
		assert.equal(f!.state, "proposto");
	});

	test("i rifiuti d'ammissione restano nella propria cantina", async () => {
		// l'Anagrafica non può scrivere in ambito annata
		const out = await uno.proposeFact(anagrafica, gradazione("d_uno", 12.5));
		assert.equal(out.ok, false);
		assert.equal(!out.ok && out.code, "AMBITO_NON_CONCESSO");

		assert.equal((await uno.listRejections()).length, 1);
		assert.equal((await due.listRejections()).length, 0);
	});

	test("le anomalie restano nella propria cantina", async () => {
		await uno.openIssue({
			severity: "bloccante",
			code: "DENOMINAZIONE_ASSENTE",
			scope: { type: "vino", ref: "soave_classico" },
			evidence: [],
			targets: [{ target: "referenza", ref: "soave_classico" }],
			state: "aperta",
			cycle: 1,
		});

		assert.equal((await uno.listOpenIssues()).length, 1);
		assert.equal((await due.listOpenIssues()).length, 0);
	});
});

describe("isolamento nel recupero", () => {
	test("lo spazio dei nomi di Vectorize è per cantina", () => {
		assert.equal(vectorizeNamespace("c_uno"), "cantina:c_uno");
		assert.notEqual(vectorizeNamespace("c_uno"), vectorizeNamespace("c_due"));
	});

	test("un pacchetto scarta i fatti di un'altra cantina anche se glieli si passa", async () => {
		await uno.proposeFact(specialista, gradazione("d_uno", 12.5));
		await due.proposeFact(specialista, gradazione("d_due", 14));

		const tutti = [...(await uno.listFacts()), ...(await due.listFacts())];
		const pack = buildContentPack("c_uno", "sommelier", tutti);

		assert.equal(pack.excluded.altraCantina, 1);
		assert.ok(pack.entries.every((e) => e.factId.endsWith("_u_1")));
		assert.equal(pack.namespace, "cantina:c_uno");
	});
});

describe("onboarding contemporanei", () => {
	test("due cantine con catalogo quasi identico non si contaminano", async () => {
		const vini = ["soave_classico", "soave_classico_riserva", "recioto_di_soave"];

		// le due cantine inseriscono gli stessi vini, le stesse annate, valori diversi
		for (const [i, vino] of vini.entries()) {
			for (const [dossier, doc, base] of [
				[uno, "d_uno", 12],
				[due, "d_due", 14],
			] as const) {
				const out = await dossier.proposeFact(specialista, {
					cantinaId: "ignorato",
					scope: { type: "annata", ref: `${vino}:2021` },
					key: "gradazione_alcolica",
					value: { kind: "numero", value: base + i * 0.5, unit: "%vol" },
					visibility: "pubblico",
					provenance: [{ kind: "documento", documentId: doc, page: i + 1 }],
					state: "proposto",
				});
				assert.ok(out.ok, `inserimento ${vino} in ${dossier.cantinaId}`);
			}
		}

		const funo = await uno.listFacts();
		const fdue = await due.listFacts();

		assert.equal(funo.length, 3);
		assert.equal(fdue.length, 3);

		// nessun valore di una cantina compare nell'altra
		const valoriUno = funo.map((f) =>
			f.value.kind === "numero" ? f.value.value : NaN,
		);
		const valoriDue = fdue.map((f) =>
			f.value.kind === "numero" ? f.value.value : NaN,
		);
		assert.deepEqual(valoriUno.sort(), [12, 12.5, 13]);
		assert.deepEqual(valoriDue.sort(), [14, 14.5, 15]);

		// nessuna citazione attraversa il confine
		for (const f of funo) {
			const p = f.provenance[0];
			assert.equal(p.kind === "documento" && p.documentId, "d_uno");
		}
		for (const f of fdue) {
			const p = f.provenance[0];
			assert.equal(p.kind === "documento" && p.documentId, "d_due");
		}
	});

	test("nessuna riga del fascicolo è priva di cantina", () => {
		const tabelle = [
			"fact",
			"issue",
			"question",
			"translation",
			"activation_op",
			"agent_run",
			"admission_rejection",
			"gate_evaluation",
			"source_document",
			"fact_candidate",
		];
		for (const t of tabelle) {
			const rows = db.raw<{ n: number }>(
				`SELECT count(*) n FROM pragma_table_info('${t}') WHERE name='cantina_id'`,
			);
			assert.equal(rows[0]!.n, 1, `${t} non porta cantina_id`);
		}
	});
});
