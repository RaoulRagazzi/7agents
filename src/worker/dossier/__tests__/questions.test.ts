import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { planQuestions, semanticKey, shouldRelease } from "../ambassador.ts";
import type { QuestionDraft } from "../ambassador.ts";
import { nextState, QUESTION_STATES } from "../questions.ts";
import type { QuestionEvent } from "../questions.ts";
import type { CantinaDossier } from "../repository.ts";
import { openDossier } from "../repository.ts";
import type { Finding } from "../sentinel.ts";
import type { Scope } from "../types.ts";
import { PROV_DOC } from "./fixtures.ts";
import { SqliteDatabase, fixedClock, sequentialIds } from "./sqlite-adapter.ts";

const annata: Scope = { type: "annata", ref: "w1:2021" };
const sede: Scope = { type: "sede", ref: "s1" };

let db: SqliteDatabase;
let uno: CantinaDossier;
let due: CantinaDossier;

function draft(scope: Scope, factKey: string, blocking = true): QuestionDraft {
	return {
		semanticKey: semanticKey(scope, factKey),
		topic: "referenza:w1",
		audience: "enologo",
		scope,
		factKey,
		issueIds: ["i1"],
		reasons: ["motivo"],
		blocking,
	};
}

beforeEach(async () => {
	db = new SqliteDatabase();
	db.addCantina("c_uno", "Cantina Uno");
	db.addCantina("c_due", "Cantina Due");
	uno = await openDossier(db, "c_uno", { clock: fixedClock(), ids: sequentialIds("_u") });
	due = await openDossier(db, "c_due", { clock: fixedClock(), ids: sequentialIds("_d") });
});

describe("macchina a stati della domanda", () => {
	const EVENTS: QuestionEvent[] = ["rilascia", "rispondi", "scadi", "riapri", "escala"];

	test("il percorso previsto", () => {
		assert.equal(nextState("bozza", "rilascia"), "inviata");
		assert.equal(nextState("inviata", "rispondi"), "risposta");
		assert.equal(nextState("inviata", "scadi"), "scaduta");
		assert.equal(nextState("scaduta", "riapri"), "bozza");
	});

	test("gli stati terminali non accettano eventi", () => {
		for (const state of ["risposta", "escalata"] as const) {
			for (const event of EVENTS) {
				assert.equal(nextState(state, event), null, `${state} + ${event}`);
			}
		}
	});

	test("non si salta un passo", () => {
		assert.equal(nextState("bozza", "rispondi"), null, "non si risponde a una bozza");
		assert.equal(nextState("bozza", "scadi"), null, "una bozza non scade: non è partita");
		assert.equal(nextState("bozza", "riapri"), null);
		assert.equal(nextState("inviata", "rilascia"), null, "non si rilascia due volte");
		assert.equal(nextState("scaduta", "rispondi"), null);
	});

	test("si può escalare da ogni stato non terminale", () => {
		for (const state of ["bozza", "inviata", "scaduta"] as const) {
			assert.equal(nextState(state, "escala"), "escalata", state);
		}
	});

	test("nessuna transizione porta fuori dagli stati dichiarati", () => {
		for (const state of QUESTION_STATES) {
			for (const event of EVENTS) {
				const next = nextState(state, event);
				if (next !== null) {
					assert.ok(QUESTION_STATES.includes(next), `${state} + ${event} → ${next}`);
				}
			}
		}
	});
});

describe("apertura", () => {
	const MAX = 2;

	test("una domanda nuova nasce bozza al primo ciclo", async () => {
		const out = await uno.questions.open(draft(annata, "gradazione_alcolica"), "it", "Quanto?");
		assert.equal(out.action, "creata");
		assert.ok(out.action === "creata");

		const q = await uno.questions.get(out.questionId);
		assert.ok(q);
		assert.equal(q.state, "bozza");
		assert.equal(q.cycle, 1);
		assert.equal(q.blocking, true);
		assert.deepEqual(q.scope, annata);
		assert.equal(q.factKey, "gradazione_alcolica");
		assert.equal(q.lang, "it");
		assert.equal(q.body, "Quanto?");
	});

	test("la stessa domanda non si apre due volte", async () => {
		const d = draft(annata, "gradazione_alcolica");
		assert.equal((await uno.questions.open(d, "it", "A")).action, "creata");

		const second = await uno.questions.open(d, "it", "B");
		assert.equal(second.action, "saltata");
		assert.match(second.action === "saltata" ? second.reason : "", /già in stato/);
		assert.equal((await uno.questions.list()).length, 1);
	});

	test("il secondo ciclo aggiorna la riga esistente, non ne crea una seconda", async () => {
		const d = draft(annata, "gradazione_alcolica");
		const first = await uno.questions.open(d, "it", "Prima formulazione");
		assert.ok(first.action === "creata");

		await uno.questions.release(10);
		await uno.questions.expire(0);
		assert.equal((await uno.questions.get(first.questionId))!.state, "scaduta");

		const second = await uno.questions.open(d, "it", "Seconda formulazione");
		assert.equal(second.action, "riaperta");
		assert.ok(second.action === "riaperta");
		assert.equal(second.questionId, first.questionId, "deve essere la stessa domanda");
		assert.equal(second.cycle, 2);

		const all = await uno.questions.list();
		assert.equal(all.length, 1, "una domanda ha un'identità, non due incarnazioni");
		assert.equal(all[0]!.cycle, 2);
		assert.equal(all[0]!.state, "bozza");
		assert.equal(all[0]!.body, "Seconda formulazione");
		assert.equal(all[0]!.sentAt, undefined, "il nuovo ciclo non è ancora partito");
	});

	test("dopo due cicli senza esito si escala", async () => {
		const d = draft(annata, "gradazione_alcolica");
		const first = await uno.questions.open(d, "it", "A");
		assert.ok(first.action === "creata");

		// primo ciclo
		await uno.questions.release(10);
		await uno.questions.expire(0);
		// secondo ciclo
		assert.equal((await uno.questions.open(d, "it", "B")).action, "riaperta");
		await uno.questions.release(10);
		await uno.questions.expire(0);

		// terzo tentativo: non si chiede una terza volta
		const third = await uno.questions.open(d, "it", "C");
		assert.equal(third.action, "escalation");

		const q = await uno.questions.get(first.questionId);
		assert.equal(q!.state, "escalata");
		assert.equal(q!.cycle, MAX, "il contatore non supera il limite");
	});
});

describe("rilascio", () => {
	beforeEach(async () => {
		// cinque domande, due bloccanti
		await uno.questions.open(draft(annata, "a", false), "it", "A");
		await uno.questions.open(draft(annata, "b", true), "it", "B");
		await uno.questions.open(draft(annata, "c", false), "it", "C");
		await uno.questions.open(draft(annata, "d", true), "it", "D");
		await uno.questions.open(draft(annata, "e", false), "it", "E");
	});

	test("rilascia le bloccanti per prime", async () => {
		const released = await uno.questions.release(2);
		assert.equal(released.length, 2);
		assert.ok(released.every((q) => q.blocking), "le bloccanti devono partire prima");
	});

	test("ciò che resta in bozza parte col lotto seguente", async () => {
		await uno.questions.release(2);
		assert.equal((await uno.questions.list({ state: "bozza" })).length, 3);
		assert.equal((await uno.questions.list({ state: "inviata" })).length, 2);

		const second = await uno.questions.release(10);
		assert.equal(second.length, 3);
		assert.equal((await uno.questions.list({ state: "bozza" })).length, 0);
	});

	test("un limite nullo o negativo non rilascia nulla", async () => {
		assert.deepEqual(await uno.questions.release(0), []);
		assert.deepEqual(await uno.questions.release(-1), []);
		assert.equal((await uno.questions.list({ state: "bozza" })).length, 5);
	});

	test("rilasciare due volte non rilascia la stessa domanda", async () => {
		const first = await uno.questions.release(5);
		const second = await uno.questions.release(5);
		assert.equal(first.length, 5);
		assert.deepEqual(second, []);
	});

	test("lo stato per la decisione riflette le bozze pendenti", async () => {
		const prima = await uno.questions.releaseState();
		assert.equal(prima.pending, 5);
		assert.ok(prima.oldestDraftAt !== undefined);

		await uno.questions.release(5);
		const dopo = await uno.questions.releaseState();
		assert.equal(dopo.pending, 0);
		assert.equal(dopo.oldestDraftAt, undefined);
	});

	test("la politica e lo stato decidono insieme quante partono", async () => {
		const state = await uno.questions.releaseState();
		const decision = shouldRelease(
			{ soglia: 5, finestraMs: 1_000, maxPerLotto: 3 },
			{ ...state, now: 0, gateBlocked: false },
		);
		assert.equal(decision.release, true);
		const released = await uno.questions.release(decision.release ? decision.limit : 0);
		assert.equal(released.length, 3);
	});
});

describe("risposte", () => {
	let questionId: string;

	beforeEach(async () => {
		const out = await uno.questions.open(
			draft(annata, "gradazione_alcolica"),
			"it",
			"Quale gradazione?",
		);
		assert.ok(out.action === "creata");
		questionId = out.questionId;
		await uno.questions.release(10);
	});

	test("una risposta di merito torna allo specialista", async () => {
		const out = await uno.questions.recordAnswer(questionId, {
			kind: "testo",
			content: "12,5 %vol",
			respondent: "enologo",
		});
		assert.ok(out.ok);
		assert.equal(out.consequence.kind, "instrada_allo_specialista");
		assert.equal(out.consequence.approvazioneMeccanica, false);
		assert.equal((await uno.questions.get(questionId))!.state, "risposta");
	});

	test("«non disponibile» ha l'approvazione meccanica e porta ambito e chiave", async () => {
		const out = await uno.questions.recordAnswer(questionId, {
			kind: "non_disponibile",
			respondent: "titolare",
		});
		assert.ok(out.ok);
		assert.equal(out.consequence.kind, "proponi_non_disponibile");
		assert.equal(out.consequence.approvazioneMeccanica, true);
		assert.ok(out.consequence.kind === "proponi_non_disponibile");
		assert.deepEqual(out.consequence.scope, annata);
		assert.equal(out.consequence.factKey, "gradazione_alcolica");
	});

	test("una risposta con documento richiede il documento", async () => {
		const senza = await uno.questions.recordAnswer(questionId, {
			kind: "documento",
			respondent: "titolare",
		});
		assert.equal(senza.ok, false);
		assert.match(!senza.ok ? senza.reason : "", /richiede un documento/);

		// la domanda non deve essere passata a «risposta»
		assert.equal((await uno.questions.get(questionId))!.state, "inviata");
	});

	test("non si risponde due volte alla stessa domanda", async () => {
		assert.ok((await uno.questions.recordAnswer(questionId, { kind: "testo", content: "x", respondent: "r" })).ok);
		const second = await uno.questions.recordAnswer(questionId, {
			kind: "testo",
			content: "y",
			respondent: "r",
		});
		assert.equal(second.ok, false);
		assert.match(!second.ok ? second.reason : "", /non accetta risposte/);
	});

	test("non si risponde a una bozza non ancora partita", async () => {
		const out = await uno.questions.open(draft(annata, "altro"), "it", "?");
		assert.ok(out.action === "creata");
		const r = await uno.questions.recordAnswer(out.questionId, {
			kind: "testo",
			content: "x",
			respondent: "r",
		});
		assert.equal(r.ok, false);
	});

	test("una risposta tardiva dopo la scadenza è accettata", async () => {
		await uno.questions.expire(0);
		assert.equal((await uno.questions.get(questionId))!.state, "scaduta");

		// la scadenza apre un secondo ciclo, non chiude la domanda: la risposta
		// arriva quando la domanda è di nuovo inviata
		await uno.questions.open(draft(annata, "gradazione_alcolica"), "it", "Ripropongo");
		await uno.questions.release(10);

		const r = await uno.questions.recordAnswer(questionId, {
			kind: "testo",
			content: "12,5 %vol",
			respondent: "enologo",
		});
		assert.ok(r.ok, "la risposta tardiva deve essere accettabile");
	});

	test("una domanda inesistente non si risponde", async () => {
		const r = await uno.questions.recordAnswer("q_mai_esistita", {
			kind: "testo",
			content: "x",
			respondent: "r",
		});
		assert.equal(r.ok, false);
		assert.match(!r.ok ? r.reason : "", /non presente in questa cantina/);
	});
});

describe("scadenza", () => {
	test("scadono solo le inviate, e solo oltre il tempo concesso", async () => {
		const bozza = await uno.questions.open(draft(annata, "a"), "it", "A");
		const inviata = await uno.questions.open(draft(annata, "b"), "it", "B");
		assert.ok(bozza.action === "creata" && inviata.action === "creata");

		await uno.questions.release(1); // solo «b» se bloccante, ordine per created_at

		// con un tempo concesso molto grande nulla scade
		assert.deepEqual(await uno.questions.expire(1e12), []);

		const expired = await uno.questions.expire(0);
		assert.equal(expired.length, 1, "solo quella inviata");
		assert.equal((await uno.questions.list({ state: "bozza" })).length, 1);
	});
});

describe("isolamento fra cantine", () => {
	test("la stessa chiave semantica convive in due cantine", async () => {
		const d = draft(annata, "gradazione_alcolica");
		const a = await uno.questions.open(d, "it", "A");
		const b = await due.questions.open(d, "it", "B");

		assert.equal(a.action, "creata");
		assert.equal(b.action, "creata", "la seconda cantina non deve vedere un duplicato");
		assert.equal((await uno.questions.list()).length, 1);
		assert.equal((await due.questions.list()).length, 1);
	});

	test("una domanda altrui non è leggibile né rispondibile", async () => {
		const out = await due.questions.open(draft(annata, "x"), "it", "?");
		assert.ok(out.action === "creata");
		await due.questions.release(10);

		assert.equal(await uno.questions.get(out.questionId), null);
		const r = await uno.questions.recordAnswer(out.questionId, {
			kind: "testo",
			content: "x",
			respondent: "r",
		});
		assert.equal(r.ok, false);

		// e la domanda dell'altra cantina resta intatta
		assert.equal((await due.questions.get(out.questionId))!.state, "inviata");
	});

	test("il rilascio di una cantina non tocca l'altra", async () => {
		await uno.questions.open(draft(annata, "x"), "it", "?");
		await due.questions.open(draft(annata, "x"), "it", "?");

		await uno.questions.release(10);
		assert.equal((await uno.questions.list({ state: "inviata" })).length, 1);
		assert.equal((await due.questions.list({ state: "inviata" })).length, 0);
		assert.equal((await due.questions.list({ state: "bozza" })).length, 1);
	});

	test("escalare in una cantina non escala nell'altra", async () => {
		const a = await uno.questions.open(draft(annata, "x"), "it", "?");
		const b = await due.questions.open(draft(annata, "x"), "it", "?");
		assert.ok(a.action === "creata" && b.action === "creata");

		assert.equal(await uno.questions.escalate(a.questionId), true);
		assert.equal(await uno.questions.escalate(b.questionId), false, "id di un'altra cantina");
		assert.equal((await due.questions.get(b.questionId))!.state, "bozza");
	});
});

describe("dal piano alle domande aperte", () => {
	test("il piano dell'Ambasciatore si apre senza duplicare", async () => {
		const findings: (Finding & { issueId: string })[] = [
			{
				issueId: "i1",
				severity: "bloccante",
				code: "VALORE_IMPOSSIBILE",
				scope: annata,
				factKey: "gradazione_alcolica",
				evidence: [PROV_DOC],
				targets: [{ target: "referenza", ref: "w1" }],
				detail: "135 %vol non è un vino",
			},
			{
				issueId: "i2",
				severity: "da_confermare",
				code: "DISCREPANZA",
				scope: sede,
				factKey: "sede_legale",
				evidence: [PROV_DOC],
				targets: [{ target: "profilo" }],
				detail: "due indirizzi diversi",
			},
		];

		const first = planQuestions({ findings, facts: [], existing: [] });
		assert.equal(first.drafts.length, 2);

		for (const d of first.drafts) {
			const out = await uno.questions.open(d, "it", d.reasons.join(" "));
			assert.equal(out.action, "creata");
		}

		// una seconda pianificazione, con le domande già presenti, non ne produce
		const existing = (await uno.questions.list()).map((q) => ({
			semanticKey: q.semanticKey,
			state: q.state,
			cycle: q.cycle,
		}));
		const second = planQuestions({ findings, facts: [], existing });
		assert.deepEqual(second.drafts, [], "nessuna domanda duplicata");
		assert.deepEqual(second.skipped.map((s) => s.reason), [
			"domanda_gia_posta",
			"domanda_gia_posta",
		]);
	});
});
