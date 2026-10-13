import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
	audienceFor,
	consequenceOf,
	groupDrafts,
	MAX_CICLI,
	nextCycle,
	planQuestions,
	POLITICA_PREDEFINITA,
	semanticKey,
	shouldRelease,
	topicFor,
} from "../ambassador.ts";
import type { ExistingQuestion, PlanInput, ReleasePolicy } from "../ambassador.ts";
import type { Finding } from "../sentinel.ts";
import type { Fact, FactValue, IssueSeverity, Scope } from "../types.ts";
import { fact, PROV_DOC } from "./fixtures.ts";

type IndexedFinding = Finding & { issueId: string };

let seq = 0;
function fnd(
	scope: Scope,
	factKey: string | undefined,
	severity: IssueSeverity,
	over: Partial<IndexedFinding> = {},
): IndexedFinding {
	seq += 1;
	return {
		issueId: `i${seq}`,
		severity,
		code: "CODICE",
		scope,
		factKey,
		evidence: [PROV_DOC],
		targets: [{ target: "referenza", ref: "w1" }],
		detail: `motivo ${seq}`,
		...over,
	};
}

const vino: Scope = { type: "vino", ref: "w1" };
const annata: Scope = { type: "annata", ref: "w1:2021" };
const sede: Scope = { type: "sede", ref: "s1" };

function plan(over: Partial<PlanInput> = {}): PlanInput {
	return { findings: [], facts: [], existing: [], ...over };
}

describe("interlocutore e argomento", () => {
	test("i dati fiscali vanno all'amministrazione", () => {
		for (const key of ["partita_iva", "codice_fiscale", "sede_legale", "iban", "rea"]) {
			assert.equal(audienceFor({ type: "cantina", ref: "c1" }, key), "amministrazione", key);
		}
		assert.equal(audienceFor(sede, "qualunque"), "amministrazione");
	});

	test("i dati tecnici del prodotto vanno all'enologo", () => {
		assert.equal(audienceFor(vino, "denominazione"), "enologo");
		assert.equal(audienceFor(annata, "gradazione_alcolica"), "enologo");
		assert.equal(audienceFor({ type: "lotto", ref: "w1:2021:l1" }, "sboccatura"), "enologo");
		assert.equal(audienceFor({ type: "vigneto", ref: "v1" }, "altitudine"), "enologo");
	});

	test("i contenuti narrativi vanno al marketing", () => {
		for (const key of ["nome", "storia", "storia_sintesi", "filosofia", "descrizione"]) {
			assert.equal(audienceFor({ type: "cantina", ref: "c1" }, key), "marketing", key);
		}
	});

	test("il titolare è il destinatario di riserva, non la scelta preferita", () => {
		assert.equal(audienceFor({ type: "cantina", ref: "c1" }, "chiave_ignota"), "titolare");
		assert.equal(audienceFor({ type: "marchio", ref: "m1" }, undefined), "titolare");
	});

	test("l'argomento raggruppa per referenza", () => {
		assert.equal(topicFor(vino), "referenza:w1");
		assert.equal(topicFor(annata), "referenza:w1");
		assert.equal(topicFor({ type: "lotto", ref: "w1:2021:l1" }), "referenza:w1");
		assert.equal(topicFor(sede), "anagrafica");
		assert.equal(topicFor({ type: "territorio", ref: "Soave" }), "vigneti");
	});
});

describe("chiave semantica", () => {
	test("identifica il dato, non l'anomalia", () => {
		// due anomalie diverse sullo stesso dato sono la stessa domanda
		assert.equal(
			semanticKey(annata, "gradazione_alcolica"),
			semanticKey(annata, "gradazione_alcolica"),
		);
	});

	test("distingue dati diversi e ambiti diversi", () => {
		const chiavi = new Set([
			semanticKey(annata, "gradazione_alcolica"),
			semanticKey(annata, "acidita_totale"),
			semanticKey({ type: "annata", ref: "w1:2022" }, "gradazione_alcolica"),
			semanticKey(vino, "gradazione_alcolica"),
			semanticKey(annata, undefined),
		]);
		assert.equal(chiavi.size, 5);
	});
});

describe("le domande che non si fanno", () => {
	test("se il dato è già approvato nel fascicolo, non si chiede", () => {
		const facts: Fact[] = [
			fact("annata", "w1:2021", "gradazione_alcolica", { state: "approvato" }),
		];
		const out = planQuestions(
			plan({ findings: [fnd(annata, "gradazione_alcolica", "bloccante")], facts }),
		);
		assert.deepEqual(out.drafts, []);
		assert.deepEqual(out.skipped.map((s) => s.reason), ["risposta_gia_nel_fascicolo"]);
	});

	test("se il produttore ha dichiarato il dato non disponibile, non si richiede", () => {
		const facts: Fact[] = [
			fact("annata", "w1:2021", "gradazione_alcolica", {
				state: "approvato",
				value: { kind: "non_disponibile" },
			}),
		];
		const out = planQuestions(
			plan({ findings: [fnd(annata, "gradazione_alcolica", "bloccante")], facts }),
		);
		assert.deepEqual(out.drafts, []);
		assert.deepEqual(out.skipped.map((s) => s.reason), ["dato_dichiarato_non_disponibile"]);
	});

	test("un fatto soltanto proposto NON conta come risposta", () => {
		// il dato esiste ma non è approvato: la domanda serve ancora
		const facts: Fact[] = [
			fact("annata", "w1:2021", "gradazione_alcolica", { state: "proposto" }),
		];
		const out = planQuestions(
			plan({ findings: [fnd(annata, "gradazione_alcolica", "bloccante")], facts }),
		);
		assert.equal(out.drafts.length, 1);
		assert.deepEqual(out.skipped, []);
	});

	test("un fatto superato non conta come risposta", () => {
		const facts: Fact[] = [
			fact("annata", "w1:2021", "gradazione_alcolica", { state: "superato" }),
		];
		const out = planQuestions(
			plan({ findings: [fnd(annata, "gradazione_alcolica", "bloccante")], facts }),
		);
		assert.equal(out.drafts.length, 1);
	});

	test("una domanda già posta non si ripone", () => {
		for (const state of ["bozza", "inviata", "risposta", "escalata"] as const) {
			const existing: ExistingQuestion[] = [
				{ semanticKey: semanticKey(annata, "gradazione_alcolica"), state, cycle: 1 },
			];
			const out = planQuestions(
				plan({ findings: [fnd(annata, "gradazione_alcolica", "bloccante")], existing }),
			);
			assert.deepEqual(out.drafts, [], state);
			assert.deepEqual(out.skipped.map((s) => s.reason), ["domanda_gia_posta"], state);
		}
	});

	test("una domanda scaduta si può riproporre: è il secondo ciclo", () => {
		const existing: ExistingQuestion[] = [
			{ semanticKey: semanticKey(annata, "gradazione_alcolica"), state: "scaduta", cycle: 1 },
		];
		const out = planQuestions(
			plan({ findings: [fnd(annata, "gradazione_alcolica", "bloccante")], existing }),
		);
		assert.equal(out.drafts.length, 1);
	});

	test("un miglioramento facoltativo non interrompe il produttore", () => {
		const out = planQuestions(
			plan({ findings: [fnd(annata, "gradazione_alcolica", "miglioramento")] }),
		);
		assert.deepEqual(out.drafts, []);
		assert.deepEqual(out.skipped.map((s) => s.reason), ["gravita_non_interrogabile"]);
	});

	test("un'anomalia superata non genera domande", () => {
		const out = planQuestions(plan({ findings: [fnd(annata, "x", "superato")] }));
		assert.deepEqual(out.drafts, []);
	});

	test("nessuna anomalia, nessuna domanda", () => {
		assert.deepEqual(planQuestions(plan()), { drafts: [], skipped: [] });
	});
});

describe("raggruppamento", () => {
	test("più anomalie sullo stesso dato sono una domanda sola", () => {
		const out = planQuestions(
			plan({
				findings: [
					fnd(annata, "gradazione_alcolica", "bloccante", { code: "ASSENTE" }),
					fnd(annata, "gradazione_alcolica", "da_confermare", { code: "CONTRADDITTORIO" }),
				],
			}),
		);
		assert.equal(out.drafts.length, 1);
		assert.equal(out.drafts[0]!.issueIds.length, 2);
		assert.equal(out.drafts[0]!.reasons.length, 2);
		assert.equal(out.drafts[0]!.blocking, true, "una bloccante nel gruppo rende bloccante");
	});

	test("dati diversi sono domande diverse", () => {
		const out = planQuestions(
			plan({
				findings: [
					fnd(annata, "gradazione_alcolica", "bloccante"),
					fnd(annata, "acidita_totale", "da_confermare"),
				],
			}),
		);
		assert.equal(out.drafts.length, 2);
	});

	test("il piano non dipende dall'ordine delle anomalie", () => {
		const findings = [
			fnd(annata, "gradazione_alcolica", "bloccante"),
			fnd(sede, "partita_iva", "da_confermare"),
			fnd(vino, "denominazione", "bloccante"),
		];
		const a = planQuestions(plan({ findings }));
		const b = planQuestions(plan({ findings: [...findings].reverse() }));
		assert.deepEqual(
			a.drafts.map((d) => d.semanticKey).sort(),
			b.drafts.map((d) => d.semanticKey).sort(),
		);
	});

	test("i lotti separano per argomento e interlocutore, bloccanti per primi", () => {
		const out = planQuestions(
			plan({
				findings: [
					fnd(sede, "partita_iva", "da_confermare"),
					fnd(annata, "gradazione_alcolica", "bloccante"),
					fnd(vino, "denominazione", "da_confermare"),
				],
			}),
		);
		const batches = groupDrafts(out.drafts);

		assert.equal(batches.length, 2, "referenza:w1 e anagrafica");
		assert.equal(batches[0]!.blocking, true, "il lotto bloccante viene per primo");
		assert.equal(batches[0]!.topic, "referenza:w1");
		assert.equal(batches[0]!.audience, "enologo");
		assert.equal(batches[0]!.drafts[0]!.blocking, true, "dentro il lotto, prima le bloccanti");
		assert.equal(batches[1]!.topic, "anagrafica");
	});

	test("il raggruppamento è deterministico", () => {
		const drafts = planQuestions(
			plan({
				findings: [
					fnd(annata, "a", "bloccante"),
					fnd(annata, "b", "da_confermare"),
					fnd(sede, "partita_iva", "bloccante"),
				],
			}),
		).drafts;
		assert.deepEqual(groupDrafts(drafts), groupDrafts([...drafts].reverse()));
	});
});

describe("politica di rilascio", () => {
	const policy: ReleasePolicy = { soglia: 5, finestraMs: 1_000, maxPerLotto: 3 };

	test("senza domande pendenti non si rilascia", () => {
		const d = shouldRelease(policy, { pending: 0, now: 0, gateBlocked: true });
		assert.equal(d.release, false);
	});

	test("un cancello bloccato non aspetta", () => {
		const d = shouldRelease(policy, { pending: 1, now: 0, gateBlocked: true });
		assert.equal(d.release, true);
		assert.match(d.release ? d.reason : "", /cancello/);
	});

	test("la soglia raggiunta rilascia", () => {
		assert.equal(shouldRelease(policy, { pending: 4, now: 0, gateBlocked: false }).release, false);
		assert.equal(shouldRelease(policy, { pending: 5, now: 0, gateBlocked: false }).release, true);
	});

	test("la finestra scaduta rilascia anche sotto soglia", () => {
		const prima = shouldRelease(policy, {
			pending: 1,
			oldestDraftAt: 0,
			now: 999,
			gateBlocked: false,
		});
		assert.equal(prima.release, false);

		const dopo = shouldRelease(policy, {
			pending: 1,
			oldestDraftAt: 0,
			now: 1_000,
			gateBlocked: false,
		});
		assert.equal(dopo.release, true);
		assert.match(dopo.release ? dopo.reason : "", /finestra/);
	});

	test("senza bozze datate la finestra non scade mai da sola", () => {
		const d = shouldRelease(policy, { pending: 1, now: 1e12, gateBlocked: false });
		assert.equal(d.release, false);
	});

	test("il lotto è limitato: il produttore non riceve quaranta domande", () => {
		const d = shouldRelease(policy, { pending: 40, now: 0, gateBlocked: false });
		assert.equal(d.release, true);
		assert.equal(d.release ? d.limit : 0, 3, "limitato da maxPerLotto");
	});

	test("il limite non supera le domande disponibili", () => {
		const d = shouldRelease(policy, { pending: 2, now: 0, gateBlocked: true });
		assert.equal(d.release ? d.limit : 0, 2);
	});

	test("la politica predefinita è prudente", () => {
		assert.ok(POLITICA_PREDEFINITA.maxPerLotto <= 7, "un lotto troppo grande scoraggia");
		assert.ok(POLITICA_PREDEFINITA.soglia <= POLITICA_PREDEFINITA.maxPerLotto);
		assert.ok(POLITICA_PREDEFINITA.finestraMs > 0);
	});
});

describe("conseguenze di una risposta", () => {
	test("«non disponibile» propone un fatto, con approvazione meccanica", () => {
		const c = consequenceOf("non_disponibile", annata, "gradazione_alcolica", "ans_1");
		assert.equal(c.kind, "proponi_non_disponibile");
		assert.equal(c.approvazioneMeccanica, true);
	});

	test("una risposta di merito torna allo specialista, senza approvazione automatica", () => {
		const c = consequenceOf("testo", annata, "gradazione_alcolica", "ans_1");
		assert.equal(c.kind, "instrada_allo_specialista");
		assert.equal(c.approvazioneMeccanica, false);
	});

	test("un documento rientra dal Documentalista", () => {
		const c = consequenceOf("documento", annata, "x", "ans_1", "doc_9");
		assert.equal(c.kind, "instrada_al_documentalista");
		assert.equal(c.approvazioneMeccanica, false);
		assert.equal(c.kind === "instrada_al_documentalista" && c.documentId, "doc_9");
	});

	test("solo «non disponibile» ha l'approvazione meccanica", () => {
		const kinds = ["testo", "documento", "non_disponibile"] as const;
		const meccaniche = kinds.filter(
			(k) => consequenceOf(k, annata, "x", "a", "d").approvazioneMeccanica,
		);
		assert.deepEqual(meccaniche, ["non_disponibile"]);
	});
});

describe("limite dei cicli", () => {
	test("il limite è due, come previsto dal programma", () => {
		assert.equal(MAX_CICLI, 2);
	});

	test("dal primo ciclo si passa al secondo, dal secondo si escala", () => {
		assert.equal(nextCycle(1), 2);
		assert.equal(nextCycle(2), "escalation");
		assert.equal(nextCycle(3), "escalation");
	});

	test("un contatore fuori intervallo riparte da uno invece di rompere", () => {
		assert.equal(nextCycle(0), 1);
		assert.equal(nextCycle(-5), 1);
	});
});

describe("conteggio di ciò che è stato evitato", () => {
	test("skipped rende visibile quante domande non sono partite, e perché", () => {
		const facts: Fact[] = [
			fact("annata", "w1:2021", "a", { state: "approvato" }),
			fact("annata", "w1:2021", "b", {
				state: "approvato",
				value: { kind: "non_disponibile" } as FactValue,
			}),
		];
		const existing: ExistingQuestion[] = [
			{ semanticKey: semanticKey(annata, "c"), state: "inviata", cycle: 1 },
		];
		const out = planQuestions(
			plan({
				findings: [
					fnd(annata, "a", "bloccante"),
					fnd(annata, "b", "bloccante"),
					fnd(annata, "c", "bloccante"),
					fnd(annata, "d", "miglioramento"),
					fnd(annata, "e", "bloccante"),
				],
				facts,
				existing,
			}),
		);

		assert.equal(out.drafts.length, 1, "solo «e» va chiesto");
		assert.equal(out.skipped.length, 4);
		assert.deepEqual(
			[...new Set(out.skipped.map((s) => s.reason))].sort(),
			[
				"dato_dichiarato_non_disponibile",
				"domanda_gia_posta",
				"gravita_non_interrogabile",
				"risposta_gia_nel_fascicolo",
			],
		);
	});
});

describe("proprietà: nessuna anomalia scartata in silenzio", () => {
	/**
	 * È l'invariante più importante di questo modulo. Un falso negativo qui non
	 * si vede: la domanda non parte, il produttore non viene interpellato, il
	 * cancello non si apre mai, e nessun errore compare da nessuna parte.
	 *
	 * Ogni anomalia interrogabile deve finire in `drafts` **oppure** in
	 * `skipped` con un motivo. Mai svanire.
	 */
	function makeRandom(seed: number) {
		let state = seed;
		return () => {
			state = (state * 1103515245 + 12345) & 0x7fffffff;
			return state / 0x7fffffff;
		};
	}

	const SCOPES: Scope[] = [
		{ type: "cantina", ref: "c1" },
		{ type: "sede", ref: "s1" },
		{ type: "marchio", ref: "m1" },
		{ type: "vino", ref: "w1" },
		{ type: "vino", ref: "w2" },
		{ type: "annata", ref: "w1:2021" },
		{ type: "annata", ref: "w1:2022" },
		{ type: "lotto", ref: "w1:2021:l1" },
		{ type: "vigneto", ref: "v1" },
		{ type: "territorio", ref: "Soave" },
	];
	const KEYS = [
		"gradazione_alcolica", "denominazione", "partita_iva", "nome", "storia",
		"vitigni", "sede_legale", undefined, "", "chiave_ignota",
	];
	const SEVERITIES: IssueSeverity[] = [
		"bloccante", "da_confermare", "miglioramento", "superato",
	];
	const STATI = ["bozza", "inviata", "risposta", "scaduta", "escalata"] as const;

	test("ogni anomalia finisce in una bozza o fra le scartate, con un motivo", () => {
		const rnd = makeRandom(0x5eed1);
		const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

		for (let iter = 0; iter < 800; iter++) {
			const findings: IndexedFinding[] = Array.from(
				{ length: 1 + Math.floor(rnd() * 10) },
				(_, i) => {
					const scope = pick(SCOPES);
					return {
						issueId: `i${i}`,
						severity: pick(SEVERITIES),
						code: pick(["A", "B", "C"]),
						scope,
						factKey: pick(KEYS),
						evidence: [PROV_DOC],
						targets: [{ target: "referenza" as const }],
						detail: `motivo ${i}`,
					};
				},
			);

			const facts: Fact[] = Array.from({ length: Math.floor(rnd() * 5) }, () => {
				const scope = pick(SCOPES);
				const key = pick(KEYS) ?? "x";
				return fact(scope.type, scope.ref, key, {
					state: pick(["proposto", "approvato", "superato", "da_confermare"] as const),
					value: pick([
						{ kind: "testo", text: "v" },
						{ kind: "non_disponibile" },
					] as FactValue[]),
				});
			});

			const existing: ExistingQuestion[] = Array.from(
				{ length: Math.floor(rnd() * 4) },
				() => {
					const scope = pick(SCOPES);
					return {
						semanticKey: semanticKey(scope, pick(KEYS)),
						state: pick(STATI),
						cycle: pick([1, 2] as const),
					};
				},
			);

			const out = planQuestions({ findings, facts, existing });

			const coperte = new Set(out.drafts.flatMap((d) => d.issueIds));
			const scartate = new Set(out.skipped.map((s) => s.issueId));

			for (const f of findings) {
				const inDraft = coperte.has(f.issueId);
				const inSkipped = scartate.has(f.issueId);
				assert.ok(
					inDraft || inSkipped,
					`iterazione ${iter}: anomalia ${f.issueId} svanita (gravità ${f.severity})`,
				);
				assert.ok(
					!(inDraft && inSkipped),
					`iterazione ${iter}: anomalia ${f.issueId} sia chiesta sia scartata`,
				);
			}
		}
	});

	test("ogni bozza porta almeno un'anomalia e un motivo", () => {
		const rnd = makeRandom(0xbeef);
		const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

		for (let iter = 0; iter < 400; iter++) {
			const findings: IndexedFinding[] = Array.from(
				{ length: 1 + Math.floor(rnd() * 8) },
				(_, i) => ({
					issueId: `i${i}`,
					severity: pick(SEVERITIES),
					code: "X",
					scope: pick(SCOPES),
					factKey: pick(KEYS),
					evidence: [],
					targets: [{ target: "referenza" as const }],
					detail: `motivo ${i}`,
				}),
			);

			for (const d of planQuestions({ findings, facts: [], existing: [] }).drafts) {
				assert.ok(d.issueIds.length > 0, `bozza senza anomalie: ${d.semanticKey}`);
				assert.equal(d.reasons.length, d.issueIds.length, "un motivo per anomalia");
				assert.ok(d.topic.length > 0);
				assert.ok(d.semanticKey.length > 0);
			}
		}
	});

	test("il piano non dipende dall'ordine, su qualunque ingresso", () => {
		const rnd = makeRandom(0xfeed);
		const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

		for (let iter = 0; iter < 400; iter++) {
			const findings: IndexedFinding[] = Array.from(
				{ length: 1 + Math.floor(rnd() * 8) },
				(_, i) => ({
					issueId: `i${i}`,
					severity: pick(SEVERITIES),
					code: pick(["A", "B"]),
					scope: pick(SCOPES),
					factKey: pick(KEYS),
					evidence: [],
					targets: [{ target: "referenza" as const }],
					detail: `motivo ${i}`,
				}),
			);

			const diretto = planQuestions({ findings, facts: [], existing: [] });
			const inverso = planQuestions({
				findings: [...findings].reverse(),
				facts: [],
				existing: [],
			});

			const chiavi = (p: typeof diretto) =>
				p.drafts.map((d) => `${d.semanticKey}|${[...d.issueIds].sort().join(",")}`).sort();

			assert.deepEqual(chiavi(inverso), chiavi(diretto), `iterazione ${iter}`);
		}
	});
});
