import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { getAgent } from "../agents.ts";
import type { CantinaDossier } from "../repository.ts";
import { CorruptDossierError, openDossier } from "../repository.ts";
import type { FactDraft } from "../admission.ts";
import type { Provenance } from "../types.ts";
import type { SqlBoundStatement } from "../sql.ts";
import { SqliteDatabase, fixedClock, sequentialIds } from "./sqlite-adapter.ts";

const specialista = getAgent("specialista_bianchi_spumanti_passiti")!;
const anagrafica = getAgent("anagrafica")!;
const sentinella = getAgent("sentinella")!;

let db: SqliteDatabase;
let dossier: CantinaDossier;

function draft(overrides: Partial<FactDraft> = {}): FactDraft {
	return {
		cantinaId: "c1",
		scope: { type: "annata", ref: "w1:2021" },
		key: "gradazione_alcolica",
		value: { kind: "numero", value: 13.5, unit: "%vol" },
		visibility: "pubblico",
		provenance: [{ kind: "documento", documentId: "d1", page: 4 }],
		state: "proposto",
		...overrides,
	};
}

beforeEach(async () => {
	db = new SqliteDatabase();
	db.addCantina("c1", "Cantina Uno");
	db.addDocument("d1", "c1", "sha_1");
	dossier = await openDossier(db, "c1", {
		clock: fixedClock(),
		ids: sequentialIds(),
	});
});

describe("proposta di un fatto", () => {
	test("una proposta ammessa diventa una riga con versione 1", async () => {
		const out = await dossier.proposeFact(specialista, draft());
		assert.ok(out.ok);

		const [fact] = await dossier.listFacts();
		assert.ok(fact);
		assert.equal(fact.id, out.factId);
		assert.equal(fact.version, 1);
		assert.equal(fact.state, "proposto");
		assert.equal(fact.agent, "specialista_bianchi_spumanti_passiti");
		assert.equal(fact.promptVersion, specialista.promptVersion);
		assert.deepEqual(fact.value, { kind: "numero", value: 13.5, unit: "%vol" });
	});

	test("una scrittura fuori ambito è respinta e registrata", async () => {
		const out = await dossier.proposeFact(anagrafica, draft());
		assert.equal(out.ok, false);
		assert.equal(!out.ok && out.code, "AMBITO_NON_CONCESSO");

		assert.equal((await dossier.listFacts()).length, 0, "la riga non deve esistere");

		const rejections = await dossier.listRejections();
		assert.equal(rejections.length, 1);
		assert.equal(rejections[0]!.code, "AMBITO_NON_CONCESSO");
		assert.equal(rejections[0]!.agent, "anagrafica");
	});

	test("un agente senza lo strumento è respinto e registrato", async () => {
		const out = await dossier.proposeFact(sentinella, draft());
		assert.equal(!out.ok && out.code, "STRUMENTO_ASSENTE");
		assert.equal((await dossier.listRejections()).length, 1);
	});

	test("il vincolo del fatto vivo diventa un esito tipizzato, non un'eccezione", async () => {
		assert.ok((await dossier.proposeFact(specialista, draft())).ok);

		const second = await dossier.proposeFact(specialista, draft());
		assert.equal(second.ok, false);
		assert.equal(!second.ok && second.code, "CHIAVE_GIA_VIVA");

		const rejections = await dossier.listRejections();
		assert.equal(rejections[0]!.code, "CHIAVE_GIA_VIVA");
	});

	test("la stessa chiave in un'annata diversa convive", async () => {
		assert.ok((await dossier.proposeFact(specialista, draft())).ok);
		const other = await dossier.proposeFact(
			specialista,
			draft({ scope: { type: "annata", ref: "w1:2022" } }),
		);
		assert.ok(other.ok);
		assert.equal((await dossier.listFacts()).length, 2);
	});
});

describe("provenienza: andata e ritorno", () => {
	const casi: { nome: string; p: Provenance }[] = [
		{
			nome: "documento con intervallo",
			p: { kind: "documento", documentId: "d1", page: 7, charStart: 120, charEnd: 180 },
		},
		{
			nome: "dichiarazione",
			p: { kind: "dichiarazione", answerId: "a1", respondent: "enologo", receivedAt: 42 },
		},
		{
			nome: "pagina pubblica",
			p: {
				kind: "pagina_pubblica",
				url: "https://example.invalid/vini",
				retrievedAt: 99,
				snapshotKey: "r2/snap",
			},
		},
		{
			nome: "derivato",
			p: { kind: "derivato", fromFactIds: ["f1", "f2"], rule: "promozione_ambito" },
		},
		{
			nome: "inferenza del modello",
			p: { kind: "inferenza_modello", promptVersion: "x@1", runId: "run_7" },
		},
	];

	for (const { nome, p } of casi) {
		test(`${nome} si rilegge identica`, async () => {
			const out = await dossier.proposeFact(
				specialista,
				draft({ provenance: [p, { kind: "documento", documentId: "d1", page: 1 }] }),
			);
			assert.ok(out.ok);

			const [fact] = await dossier.listFacts();
			assert.ok(fact);
			const letta = fact.provenance.find((x) => x.kind === p.kind);
			assert.deepEqual(letta, p);
		});
	}

	test("più provenienze sullo stesso fatto si conservano tutte", async () => {
		const out = await dossier.proposeFact(
			specialista,
			draft({
				provenance: [
					{ kind: "documento", documentId: "d1", page: 1 },
					{ kind: "dichiarazione", answerId: "a1", respondent: "titolare", receivedAt: 5 },
					{ kind: "inferenza_modello", promptVersion: "x@1", runId: "r1" },
				],
			}),
		);
		assert.ok(out.ok);
		const [fact] = await dossier.listFacts();
		assert.equal(fact!.provenance.length, 3);
	});

	test("un fatto senza provenienza nel database è un fascicolo corrotto", async () => {
		// inserimento diretto, aggirando il repository: è precisamente il caso
		// che l'errore deve rendere visibile
		db.exec(
			`INSERT INTO fact (id,cantina_id,scope_type,scope_ref,key,value_json,state,
			                   visibility,version,agent,prompt_version,created_at)
			 VALUES ('orfano','c1','vino','w9','k','{"kind":"testo","text":"x"}','proposto',
			         'pubblico',1,'a','a@1',0)`,
		);
		await assert.rejects(() => dossier.listFacts(), CorruptDossierError);
	});
});

describe("approvazione", () => {
	test("una provenienza documentale porta all'approvato con chi e quando", async () => {
		const out = await dossier.proposeFact(specialista, draft());
		assert.ok(out.ok);

		const esito = await dossier.approve(out.factId, { approvedBy: "orchestratore" });
		assert.equal(esito.ok, true);

		const [fact] = await dossier.listFacts();
		assert.equal(fact!.state, "approvato");
		assert.equal(fact!.approvedBy, "orchestratore");
		assert.ok((fact!.approvedAt ?? 0) > 0);
	});

	test("una provenienza di sola inferenza non si approva", async () => {
		const out = await dossier.proposeFact(
			specialista,
			draft({ provenance: [{ kind: "inferenza_modello", promptVersion: "x@1", runId: "r" }] }),
		);
		assert.ok(out.ok);

		const esito = await dossier.approve(out.factId, { approvedBy: "orchestratore" });
		assert.equal(esito.ok, false);
		assert.match(esito.detail ?? "", /documentale o dichiarativa/);

		const [fact] = await dossier.listFacts();
		assert.equal(fact!.state, "proposto", "non deve essere cambiato nulla");
	});

	test("un fatto da_confermare richiede la risposta del produttore", async () => {
		const out = await dossier.proposeFact(
			specialista,
			draft({ state: "da_confermare" }),
		);
		assert.ok(out.ok);

		assert.equal((await dossier.approve(out.factId, { approvedBy: "o" })).ok, false);
		assert.equal(
			(await dossier.approve(out.factId, { approvedBy: "o", confirmationAnswerId: "a9" })).ok,
			true,
		);
	});

	test("solo i fatti approvati compaiono nella lettura per l'attivazione", async () => {
		const a = await dossier.proposeFact(specialista, draft());
		await dossier.proposeFact(specialista, draft({ scope: { type: "annata", ref: "w1:2022" } }));
		assert.ok(a.ok);
		await dossier.approve(a.factId, { approvedBy: "o" });

		const approvati = await dossier.listApprovedFacts();
		assert.equal(approvati.length, 1);
		assert.equal(approvati[0]!.id, a.factId);
	});
});

describe("nuova versione", () => {
	test("la precedente passa a superato e la nuova porta versione e supersede", async () => {
		const first = await dossier.proposeFact(specialista, draft());
		assert.ok(first.ok);
		await dossier.approve(first.factId, { approvedBy: "o" });

		const second = await dossier.supersede(
			specialista,
			first.factId,
			draft({ value: { kind: "numero", value: 13.8, unit: "%vol" } }),
		);
		assert.ok(second.ok);

		const tutti = await dossier.listFacts();
		assert.equal(tutti.length, 2);

		const vecchio = tutti.find((f) => f.id === first.factId);
		const nuovo = tutti.find((f) => f.id === second.factId);
		assert.equal(vecchio!.state, "superato");
		assert.equal(nuovo!.version, 2);
		assert.equal(nuovo!.supersedes, first.factId);
		assert.equal(nuovo!.state, "proposto");
	});

	test("la storia resta: il valore precedente è ancora leggibile", async () => {
		const first = await dossier.proposeFact(specialista, draft());
		assert.ok(first.ok);
		await dossier.supersede(
			specialista,
			first.factId,
			draft({ value: { kind: "numero", value: 13.8, unit: "%vol" } }),
		);

		const superati = await dossier.listFacts({ states: ["superato"] });
		assert.equal(superati.length, 1);
		assert.deepEqual(superati[0]!.value, { kind: "numero", value: 13.5, unit: "%vol" });
	});

	test("il fatto vivo è il nuovo, e ce n'è uno solo", async () => {
		const first = await dossier.proposeFact(specialista, draft());
		assert.ok(first.ok);
		const second = await dossier.supersede(
			specialista,
			first.factId,
			draft({ value: { kind: "numero", value: 13.8, unit: "%vol" } }),
		);
		assert.ok(second.ok);

		const vivo = await dossier.getLiveFact(
			{ type: "annata", ref: "w1:2021" },
			"gradazione_alcolica",
		);
		assert.equal(vivo!.id, second.factId);
	});

	test("una nuova versione fuori ambito è respinta e non supera nulla", async () => {
		const first = await dossier.proposeFact(specialista, draft());
		assert.ok(first.ok);

		const out = await dossier.supersede(anagrafica, first.factId, draft());
		assert.equal(out.ok, false);

		const [fact] = await dossier.listFacts();
		assert.equal(fact!.state, "proposto", "la precedente non deve essere superata");
		assert.equal((await dossier.listFacts()).length, 1);
	});
});

describe("atomicità della nuova versione", () => {
	test("la transazione del driver viene usata quando c'è", async () => {
		let batches = 0;
		// delega, non clone: `SqliteDatabase` ha campi privati che un clone per
		// prototipo non porta con sé
		const spy = {
			prepare: (sql: string) => db.prepare(sql),
			batch: (statements: SqlBoundStatement[]) => {
				batches += 1;
				return db.batch(statements);
			},
		};

		const spied = await openDossier(spy, "c1", {
			clock: fixedClock(),
			ids: sequentialIds("_s"),
		});
		const first = await spied.proposeFact(specialista, draft());
		assert.ok(first.ok);
		const before = batches;

		const second = await spied.supersede(
			specialista,
			first.factId,
			draft({ value: { kind: "numero", value: 13.8, unit: "%vol" } }),
		);
		assert.ok(second.ok);
		assert.ok(batches > before, "supersede non ha usato la transazione");
	});

	test("se una scrittura della transazione fallisce, nessuna resta applicata", async () => {
		const first = await dossier.proposeFact(specialista, draft());
		assert.ok(first.ok);

		// una provenienza documentale senza pagina viola il CHECK dello schema:
		// l'inserimento della fonte è l'ultima istruzione della transazione,
		// quindi il superamento e il nuovo fatto sono già stati scritti
		const invalida = { kind: "documento", documentId: "d1", page: null } as unknown as Provenance;

		await assert.rejects(() =>
			dossier.supersede(
				specialista,
				first.factId,
				draft({
					value: { kind: "numero", value: 13.8, unit: "%vol" },
					provenance: [invalida],
				}),
			),
		);

		// il fascicolo è come prima: una sola riga, ancora viva, versione 1
		const tutti = await dossier.listFacts();
		assert.equal(tutti.length, 1, "il nuovo fatto non deve essere rimasto");
		assert.equal(tutti[0]!.id, first.factId);
		assert.equal(tutti[0]!.state, "proposto", "il precedente non deve essere superato");
		assert.equal(tutti[0]!.version, 1);

		// e la chiave è ancora servita da un fatto vivo
		const vivo = await dossier.getLiveFact(
			{ type: "annata", ref: "w1:2021" },
			"gradazione_alcolica",
		);
		assert.equal(vivo!.id, first.factId);
	});

	test("senza transazione il repository scrive comunque, in sequenza", async () => {
		// un driver che non offre batch: il comportamento degradato è definito
		const senzaBatch = {
			prepare: (sql: string) => db.prepare(sql),
		};
		const d = await openDossier(senzaBatch, "c1", {
			clock: fixedClock(),
			ids: sequentialIds("_nb"),
		});

		const out = await d.proposeFact(specialista, draft());
		assert.ok(out.ok);
		const [fact] = await d.listFacts();
		assert.equal(fact!.provenance.length, 1);
	});
});

describe("filtri di lettura", () => {
	beforeEach(async () => {
		await dossier.proposeFact(specialista, draft());
		await dossier.proposeFact(
			specialista,
			draft({ scope: { type: "vino", ref: "w1" }, key: "denominazione",
			        value: { kind: "testo", text: "Soave Classico" } }),
		);
		await dossier.proposeFact(
			anagrafica,
			draft({ scope: { type: "sede", ref: "s1" }, key: "sede_legale",
			        value: { kind: "testo", text: "Via Roma 1" }, visibility: "riservato" }),
		);
	});

	test("filtra per tipo di ambito", async () => {
		assert.equal((await dossier.listFacts({ scopeType: "vino" })).length, 1);
		assert.equal((await dossier.listFacts({ scopeType: "sede" })).length, 1);
		assert.equal((await dossier.listFacts({ scopeType: "territorio" })).length, 0);
	});

	test("filtra per visibilità", async () => {
		const pubblici = await dossier.listFacts({ visibilities: ["pubblico"] });
		assert.equal(pubblici.length, 2);
		const riservati = await dossier.listFacts({ visibilities: ["riservato"] });
		assert.equal(riservati.length, 1);
		assert.equal(riservati[0]!.key, "sede_legale");
	});

	test("filtra per riferimento d'ambito", async () => {
		assert.equal((await dossier.listFacts({ scopeRef: "w1:2021" })).length, 1);
	});
});
