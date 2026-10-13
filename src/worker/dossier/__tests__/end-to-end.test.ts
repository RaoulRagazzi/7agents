/**
 * La catena completa su una cantina, dal primo materiale all'attivazione
 * verificata. Non prova la bravura dei prompt — non c'è nessun modello qui —
 * prova che i pezzi compongono e che i cancelli tengono lungo il percorso.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { getAgent } from "../agents.ts";
import { openDossier } from "../repository.ts";
import type { CantinaDossier } from "../repository.ts";
import { evaluateGate } from "../gates.ts";
import { buildContentPack } from "../pack.ts";
import { applyActivationEvent, decideActivation, operationKey } from "../activation.ts";
import { planRevalidation } from "../invalidation.ts";
import { assignReference } from "../assignment.ts";
import { resolveCandidates } from "../candidates.ts";
import { runDeterministicChecks } from "../sentinel.ts";
import type { ActivationState, FactValue, Visibility } from "../types.ts";
import { SqliteDatabase, fixedClock, sequentialIds } from "./sqlite-adapter.ts";

const anagrafica = getAgent("anagrafica")!;
const identita = getAgent("identita")!;
const specialista4 = getAgent("specialista_bianchi_spumanti_passiti")!;

let db: SqliteDatabase;
let dossier: CantinaDossier;

beforeEach(async () => {
	db = new SqliteDatabase();
	db.addCantina("c1", "Tenuta di Prova");
	db.addDocument("doc_scheda", "c1", "sha_scheda");
	db.addDocument("doc_atto", "c1", "sha_atto");
	dossier = await openDossier(db, "c1", {
		clock: fixedClock(),
		ids: sequentialIds(),
	});
});

/** Propone e approva in un passo, per i fatti che hanno appoggio documentale. */
async function stabilisci(
	agent: typeof anagrafica,
	scope: { type: Parameters<typeof evaluateGate>[0] extends never ? never : string; ref: string },
	key: string,
	value: FactValue,
	visibility: Visibility = "pubblico",
): Promise<string> {
	const out = await dossier.proposeFact(agent, {
		cantinaId: "c1",
		scope: scope as never,
		key,
		value,
		visibility,
		provenance: [{ kind: "documento", documentId: "doc_scheda", page: 2 }],
		state: "proposto",
	});
	assert.ok(out.ok, `proposta ${key}: ${!out.ok ? out.detail : ""}`);
	const approved = await dossier.approve(out.factId, { approvedBy: "orchestratore" });
	assert.ok(approved.ok, `approvazione ${key}: ${approved.detail ?? ""}`);
	return out.factId;
}

const txt = (text: string): FactValue => ({ kind: "testo", text });

describe("dal primo materiale al via libera del profilo", () => {
	test("il profilo si apre solo quando tutti i dati richiesti sono approvati", async () => {
		// all'inizio nessun cancello è aperto
		let gate = evaluateGate({ target: "profilo" }, await dossier.listApprovedFacts(), []);
		assert.equal(gate.open, false);
		assert.ok(!gate.open && gate.reasons.length >= 5);

		await stabilisci(anagrafica, { type: "cantina", ref: "c1" }, "ragione_sociale",
			txt("Tenuta di Prova S.r.l."));
		await stabilisci(anagrafica, { type: "sede", ref: "s1" }, "sede_legale",
			txt("Via delle Vigne 3"), "riservato");
		await stabilisci(anagrafica, { type: "cantina", ref: "c1" }, "contatto_pubblico",
			txt("info@example.invalid"));
		await stabilisci(anagrafica, { type: "marchio", ref: "m1" }, "nome_commerciale",
			txt("Tenuta di Prova"));

		// manca la storia: il cancello resta chiuso e lo dice
		gate = evaluateGate({ target: "profilo" }, await dossier.listApprovedFacts(), []);
		assert.equal(gate.open, false);
		assert.ok(!gate.open && gate.reasons.some((r) => r.includes("storia_sintesi")));

		await stabilisci(identita, { type: "cantina", ref: "c1" }, "storia_sintesi",
			txt("Fondata nel 1932, tre generazioni."));

		gate = evaluateGate({ target: "profilo" }, await dossier.listApprovedFacts(), []);
		assert.equal(gate.open, true);
	});

	test("un'anomalia bloccante sopravvenuta richiude il profilo", async () => {
		// la visibilità è parte del requisito, non un dettaglio: l'ammissione
		// respinge `sede_legale` proposta come pubblica
		for (const [agent, scope, key, value, visibility] of [
			[anagrafica, { type: "cantina", ref: "c1" }, "ragione_sociale", txt("T S.r.l."), "pubblico"],
			[anagrafica, { type: "sede", ref: "s1" }, "sede_legale", txt("Via 3"), "riservato"],
			[anagrafica, { type: "cantina", ref: "c1" }, "contatto_pubblico", txt("a@b.invalid"), "pubblico"],
			[anagrafica, { type: "marchio", ref: "m1" }, "nome_commerciale", txt("T"), "pubblico"],
			[identita, { type: "cantina", ref: "c1" }, "storia_sintesi", txt("Storia."), "pubblico"],
		] as const) {
			await stabilisci(agent, scope, key, value, visibility);
		}

		const facts = await dossier.listApprovedFacts();
		assert.equal(evaluateGate({ target: "profilo" }, facts, []).open, true);

		await dossier.openIssue({
			severity: "bloccante",
			code: "DISCREPANZA_RAGIONE_SOCIALE",
			scope: { type: "cantina", ref: "c1" },
			factKey: "ragione_sociale",
			evidence: [{ kind: "documento", documentId: "doc_atto", page: 1 }],
			targets: [{ target: "profilo" }],
			state: "aperta",
			cycle: 1,
		});

		const issues = await dossier.listOpenIssues();
		assert.equal(evaluateGate({ target: "profilo" }, facts, issues).open, false);
	});
});

describe("una referenza, dall'assegnazione all'attivazione verificata", () => {
	test("il percorso completo", async () => {
		// 1. la tipologia determina il responsabile, prima dell'estrazione
		const assignee = assignReference({ colour: "bianco", style: "spumante" });
		assert.equal(assignee, specialista4.id);

		// 2. le fonti contraddittorie si risolvono prima di proporre
		const resolution = resolveCandidates("gradazione_alcolica", [
			{
				id: "c_listino",
				level: "documento",
				value: { kind: "numero", value: 12.5, unit: "%vol" },
				provenance: { kind: "documento", documentId: "doc_scheda", page: 9 },
			},
			{
				id: "c_atto",
				level: "documento_ufficiale",
				value: { kind: "numero", value: 12.5, unit: "%vol" },
				provenance: { kind: "documento", documentId: "doc_atto", page: 2 },
			},
		]);
		assert.equal(resolution.outcome, "concorde");

		// 3. lo specialista propone, l'orchestrazione approva
		await stabilisci(specialista4, { type: "vino", ref: "w1" }, "denominazione",
			txt("Franciacorta D.O.C.G."));
		await stabilisci(specialista4, { type: "vino", ref: "w1" }, "tipologia", txt("spumante"));
		await stabilisci(specialista4, { type: "vino", ref: "w1" }, "vitigni",
			{ kind: "elenco", items: ["Chardonnay", "Pinot nero"] });
		const gradId = await stabilisci(
			specialista4,
			{ type: "annata", ref: "w1:2021" },
			"gradazione_alcolica",
			{ kind: "numero", value: 12.5, unit: "%vol" },
		);

		// 4. il cancello della referenza si apre
		let facts = await dossier.listApprovedFacts();
		assert.equal(evaluateGate({ target: "referenza", ref: "w1" }, facts, []).open, true);

		// 5. il pacchetto esclude il riservato e porta le versioni
		await stabilisci(anagrafica, { type: "sede", ref: "s1" }, "partita_iva",
			txt("IT00000000000"), "riservato");
		facts = await dossier.listApprovedFacts();
		const pack = buildContentPack("c1", "sommelier", facts);
		assert.equal(pack.excluded.visibilitaNegata, 1);
		assert.ok(
			!pack.entries.some((e) => e.key === "partita_iva"),
			"la partita IVA non deve entrare nel pacchetto del Sommelier",
		);

		// 6. l'operazione di attivazione, idempotente
		const key1 = await operationKey("c1", { target: "referenza", ref: "w1" }, pack.factVersions);
		assert.deepEqual(decideActivation(undefined, 3), { action: "prepara" });

		// 7. i quattro stati, fino alla verifica per rilettura
		let state: ActivationState = "preparato";
		for (const event of ["salva_riuscito", "pubblica_riuscito", "verifica_coincide"] as const) {
			const t = applyActivationEvent(state, event);
			assert.ok(t);
			state = t.state;
		}
		assert.equal(state, "verificato");

		// 8. ritentare la stessa operazione non fa nulla
		assert.equal(
			decideActivation({ operationKey: key1, state, attempts: 1 }, 3).action,
			"salta",
		);

		// 9. una nuova versione della gradazione cambia la chiave e rimette in
		//    riesame solo ciò che dipende
		const second = await dossier.supersede(specialista4, gradId, {
			cantinaId: "c1",
			scope: { type: "annata", ref: "w1:2021" },
			key: "gradazione_alcolica",
			value: { kind: "numero", value: 12.8, unit: "%vol" },
			visibility: "pubblico",
			provenance: [{ kind: "dichiarazione", answerId: "a1", respondent: "enologo", receivedAt: 50 }],
			state: "proposto",
		});
		assert.ok(second.ok);

		const plan = planRevalidation(
			gradId,
			2,
			[{ derivedFactId: "par_commerciale", sourceFactId: gradId, rule: "narrazione" }],
			[
				{ id: "t_grad_en", factId: gradId, lang: "en", sourceVersion: 1, state: "approvata" },
				{ id: "t_storia_en", factId: "altro", lang: "en", sourceVersion: 1, state: "approvata" },
			],
			pack.factVersions.map((f) => ({ opId: "op_ref_w1", factId: f.factId, factVersion: f.version })),
		);
		assert.deepEqual(plan.factsToReview, ["par_commerciale"]);
		assert.deepEqual(plan.translationsStale, ["t_grad_en"]);
		assert.deepEqual(plan.operationsReexecutable, ["op_ref_w1"]);

		// 10. la nuova versione è solo proposta: il cancello si richiude finché
		//     non è approvata, perché la gradazione approvata non c'è più
		facts = await dossier.listApprovedFacts();
		const after = evaluateGate({ target: "referenza", ref: "w1" }, facts, []);
		assert.equal(after.open, false);
		assert.ok(!after.open && after.reasons.some((r) => r.includes("gradazione_alcolica")));

		// 11. approvata la nuova versione, la chiave d'operazione è diversa
		await dossier.approve(second.factId, { approvedBy: "orchestratore" });
		facts = await dossier.listApprovedFacts();
		assert.equal(evaluateGate({ target: "referenza", ref: "w1" }, facts, []).open, true);

		const pack2 = buildContentPack("c1", "sommelier", facts);
		const key2 = await operationKey("c1", { target: "referenza", ref: "w1" }, pack2.factVersions);
		assert.notEqual(key1, key2, "l'aggiornamento deve essere distinguibile dalla creazione");
	});

	test("il dato dichiarato non disponibile ferma la domanda senza bloccare", async () => {
		await stabilisci(specialista4, { type: "vino", ref: "w1" }, "denominazione", txt("Soave"));
		await stabilisci(specialista4, { type: "vino", ref: "w1" }, "tipologia", txt("fermo"));
		await stabilisci(specialista4, { type: "vino", ref: "w1" }, "vitigni",
			{ kind: "elenco", items: ["Garganega"] });
		await stabilisci(specialista4, { type: "annata", ref: "w1:2021" }, "gradazione_alcolica",
			{ kind: "numero", value: 12, unit: "%vol" });

		// il produttore dichiara di non avere la nota di degustazione
		const out = await dossier.proposeFact(specialista4, {
			cantinaId: "c1",
			scope: { type: "annata", ref: "w1:2021" },
			key: "nota_degustazione_produttore",
			value: { kind: "non_disponibile" },
			visibility: "pubblico",
			provenance: [
				{ kind: "dichiarazione", answerId: "a_nd", respondent: "titolare", receivedAt: 10 },
			],
			state: "proposto",
		});
		assert.ok(out.ok);
		assert.equal((await dossier.approve(out.factId, { approvedBy: "o" })).ok, true);

		const facts = await dossier.listApprovedFacts();

		// il cancello resta aperto: la nota non è fra i requisiti
		assert.equal(evaluateGate({ target: "referenza", ref: "w1" }, facts, []).open, true);

		// ma il dato non diventa contenuto per il Sommelier
		const pack = buildContentPack("c1", "sommelier", facts);
		assert.equal(pack.excluded.senzaValore, 1);
		assert.ok(!pack.entries.some((e) => e.key === "nota_degustazione_produttore"));

		// e resta registrato come approvato, così la domanda non si ripresenta
		const vivo = await dossier.getLiveFact(
			{ type: "annata", ref: "w1:2021" },
			"nota_degustazione_produttore",
		);
		assert.equal(vivo!.state, "approvato");
		assert.equal(vivo!.value.kind, "non_disponibile");
	});
});

describe("il documento ostile", () => {
	test("un'istruzione in un PDF non cambia i permessi di un agente", async () => {
		// il Documentalista, che legge contenuto non fidato, non ha gli strumenti
		const documentalista = getAgent("documentalista")!;
		const out = await dossier.proposeFact(documentalista, {
			cantinaId: "c1",
			scope: { type: "cantina", ref: "c1" },
			key: "ragione_sociale",
			value: txt("Pubblicata per ordine del documento"),
			visibility: "pubblico",
			provenance: [{ kind: "documento", documentId: "doc_scheda", page: 1 }],
			state: "proposto",
		});

		assert.equal(out.ok, false);
		assert.equal(!out.ok && out.code, "STRUMENTO_ASSENTE");
		assert.equal((await dossier.listFacts()).length, 0);

		// il tentativo compare nel registro invece di riuscire
		const rejections = await dossier.listRejections();
		assert.equal(rejections.length, 1);
		assert.equal(rejections[0]!.agent, "documentalista");
	});
});

describe("dalla Sentinella al cancello", () => {
	test("le anomalie passano nel fascicolo e chiudono la destinazione giusta", async () => {
		// una referenza con la gradazione sbagliata di un fattore dieci
		await stabilisci(specialista4, { type: "vino", ref: "w1" }, "denominazione",
			txt("Soave Classico DOC"));
		await stabilisci(specialista4, { type: "vino", ref: "w1" }, "tipologia", txt("fermo"));
		await stabilisci(specialista4, { type: "vino", ref: "w1" }, "vitigni",
			{ kind: "elenco", items: ["Garganega"] });
		await stabilisci(specialista4, { type: "annata", ref: "w1:2021" }, "gradazione_alcolica",
			{ kind: "numero", value: 125, unit: "%vol" });

		// una seconda referenza, in ordine
		await stabilisci(specialista4, { type: "vino", ref: "w2" }, "denominazione",
			txt("Franciacorta DOCG"));
		await stabilisci(specialista4, { type: "vino", ref: "w2" }, "tipologia", txt("spumante"));
		await stabilisci(specialista4, { type: "vino", ref: "w2" }, "vitigni",
			{ kind: "elenco", items: ["Chardonnay"] });
		await stabilisci(specialista4, { type: "vino", ref: "w2" }, "metodo_spumantizzazione",
			txt("metodo classico"));
		await stabilisci(specialista4, { type: "annata", ref: "w2:2021" }, "gradazione_alcolica",
			{ kind: "numero", value: 12.5, unit: "%vol" });

		const facts = await dossier.listApprovedFacts();

		// prima della Sentinella entrambi i cancelli sono aperti: il dato c'è
		assert.equal(evaluateGate({ target: "referenza", ref: "w1" }, facts, []).open, true);
		assert.equal(evaluateGate({ target: "referenza", ref: "w2" }, facts, []).open, true);

		// la Sentinella deterministica trova il valore impossibile
		const findings = runDeterministicChecks({ facts }, { currentYear: 2026 });
		assert.deepEqual(
			findings.map((x) => x.code),
			["VALORE_IMPOSSIBILE"],
		);

		const ids = await dossier.openFindings(findings);
		assert.equal(ids.length, 1);

		// le anomalie rilette conservano il motivo in chiaro
		const issues = await dossier.listOpenIssues();
		assert.equal(issues.length, 1);
		assert.equal(issues[0]!.code, "VALORE_IMPOSSIBILE");
		assert.equal(issues[0]!.factKey, "gradazione_alcolica");
		assert.match(issues[0]!.detail ?? "", /non è un vino/);
		assert.equal(issues[0]!.evidence.length, 1, "l'evidenza documentale è conservata");

		// e sospendono soltanto la referenza interessata
		assert.equal(evaluateGate({ target: "referenza", ref: "w1" }, facts, issues).open, false);
		assert.equal(evaluateGate({ target: "referenza", ref: "w2" }, facts, issues).open, true);
	});

	test("un'anomalia non bloccante non chiude nulla ma resta registrata", async () => {
		await stabilisci(specialista4, { type: "vino", ref: "w1" }, "denominazione",
			txt("Colli Inventati DOC"));
		await stabilisci(specialista4, { type: "vino", ref: "w1" }, "tipologia", txt("fermo"));
		await stabilisci(specialista4, { type: "vino", ref: "w1" }, "vitigni",
			{ kind: "elenco", items: ["Vitigno Locale"] });
		await stabilisci(specialista4, { type: "annata", ref: "w1:2021" }, "gradazione_alcolica",
			{ kind: "numero", value: 12.5, unit: "%vol" });

		const facts = await dossier.listApprovedFacts();
		const findings = runDeterministicChecks({ facts }, { currentYear: 2026 });

		assert.deepEqual(findings.map((x) => x.code), ["DENOMINAZIONE_IGNOTA"]);
		assert.equal(findings[0]!.severity, "miglioramento");

		await dossier.openFindings(findings);
		const issues = await dossier.listOpenIssues();

		assert.equal(issues.length, 1);
		assert.equal(
			evaluateGate({ target: "referenza", ref: "w1" }, facts, issues).open,
			true,
			"un miglioramento non deve bloccare l'attivazione minima",
		);
	});

	test("il profilo e le referenze si sospendono in modo indipendente", async () => {
		// un dato riservato esposto blocca il profilo, non le referenze
		const out = await dossier.proposeFact(anagrafica, {
			cantinaId: "c1",
			scope: { type: "sede", ref: "s1" },
			key: "partita_iva",
			value: txt("IT00000000000"),
			// l'ammissione impone riservato, quindi il fascicolo nasce corretto
			visibility: "riservato",
			provenance: [{ kind: "documento", documentId: "doc_atto", page: 1 }],
			state: "proposto",
		});
		assert.ok(out.ok);
		await dossier.approve(out.factId, { approvedBy: "orchestratore" });

		await stabilisci(specialista4, { type: "vino", ref: "w1" }, "denominazione",
			txt("Soave Classico"));
		await stabilisci(specialista4, { type: "vino", ref: "w1" }, "tipologia", txt("fermo"));
		await stabilisci(specialista4, { type: "vino", ref: "w1" }, "vitigni",
			{ kind: "elenco", items: ["Garganega"] });
		await stabilisci(specialista4, { type: "annata", ref: "w1:2021" }, "gradazione_alcolica",
			{ kind: "numero", value: 12.5, unit: "%vol" });

		const facts = await dossier.listApprovedFacts();
		const findings = runDeterministicChecks({ facts }, { currentYear: 2026 });

		// nessuna anomalia: l'ammissione ha già impedito l'esposizione
		assert.deepEqual(findings, [], "un fascicolo corretto non produce anomalie");
		assert.equal(evaluateGate({ target: "referenza", ref: "w1" }, facts, []).open, true);
	});
});
