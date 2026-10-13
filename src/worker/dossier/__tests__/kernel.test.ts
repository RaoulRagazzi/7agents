import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { getAgent } from "../agents.ts";
import { AgentKernel, buildRequest, provenanceFromCitations, sqlSpendLedger } from "../kernel.ts";
import type { AgentTask } from "../kernel.ts";
import { cacheHitRatio, computeCost, RATES, ZERO_USAGE } from "../model.ts";
import type { CantinaDossier } from "../repository.ts";
import { openDossier } from "../repository.ts";
import { SqliteDatabase, fixedClock, sequentialIds } from "./sqlite-adapter.ts";
import { citation, FakeModel, okWith, usage } from "./fake-model.ts";

const specialista = getAgent("specialista_bianchi_spumanti_passiti")!;
const sentinella = getAgent("sentinella")!;

let db: SqliteDatabase;
let dossier: CantinaDossier;
let model: FakeModel;
let kernel: AgentKernel;

const SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["facts"],
	properties: { facts: { type: "array" } },
};

function task(over: Partial<AgentTask> = {}): AgentTask {
	return {
		instruction: "Estrai la scheda dell'annata 2021.",
		documents: [
			{
				documentId: "doc_scheda",
				title: "doc_scheda",
				text: "Gradazione 12,5 %vol. Metodo classico, 30 mesi sui lieviti.",
				citations: true,
			},
		],
		scopes: [{ type: "annata", ref: "w1:2021" }],
		outputSchema: SCHEMA,
		...over,
	};
}

/** Una proposta nella forma che lo schema rigido impone. */
function proposta(over: Record<string, unknown> = {}) {
	return {
		scope: { type: "annata", ref: "w1:2021" },
		key: "gradazione_alcolica",
		value: { kind: "numero", value: 12.5, unit: "%vol" },
		visibility: "pubblico",
		...over,
	};
}

beforeEach(async () => {
	db = new SqliteDatabase();
	db.addCantina("c1", "Tenuta di Prova");
	db.addDocument("doc_scheda", "c1", "sha_1");
	dossier = await openDossier(db, "c1", { clock: fixedClock(), ids: sequentialIds() });
	model = new FakeModel();
	kernel = new AgentKernel({
		db,
		model,
		clock: fixedClock(),
		ids: sequentialIds("_k"),
	});
});

describe("contabilità del costo", () => {
	test("le tre voci sono disgiunte e si tariffano separatamente", () => {
		const cost = computeCost("claude-opus-5", {
			inputTokens: 10_000,
			outputTokens: 3_000,
			cacheReadTokens: 15_000,
			cacheCreationTokens: 0,
		});
		// 10k×$5 + 3k×$25 + 15k×$0,50, per milione
		const expected = (10_000 * 5 + 3_000 * 25 + 15_000 * 0.5) / 1_000_000;
		assert.equal(cost, expected);
		assert.ok(Math.abs(cost - 0.1325) < 1e-9, `atteso ~$0,1325, ottenuto $${cost}`);
	});

	test("la lettura dalla cache costa un decimo dell'ingresso", () => {
		const rates = RATES["claude-opus-5"]!;
		assert.equal(rates.cacheRead, rates.input / 10);
	});

	test("la scrittura in cache costa 1,25 volte l'ingresso", () => {
		const rates = RATES["claude-opus-5"]!;
		assert.equal(rates.cacheWrite, rates.input * 1.25);
	});

	test("un uso nullo costa zero", () => {
		assert.equal(computeCost("claude-opus-5", ZERO_USAGE), 0);
	});

	test("un modello senza tariffe è un errore, non un costo zero", () => {
		assert.throws(() => computeCost("modello-ignoto", ZERO_USAGE), /tariffe non note/);
	});

	test("la quota di cache è la metrica da guardare", () => {
		assert.equal(cacheHitRatio({ ...ZERO_USAGE, inputTokens: 10, cacheReadTokens: 30 }), 0.75);
		assert.equal(cacheHitRatio({ ...ZERO_USAGE, inputTokens: 10 }), 0, "nessun riuso");
		assert.equal(cacheHitRatio(ZERO_USAGE), 0, "nessun token: non divide per zero");
	});

	test("ogni modello del listino ha tariffe coerenti", () => {
		for (const [name, rates] of Object.entries(RATES)) {
			assert.ok(rates.output > rates.input, `${name}: l'uscita deve costare più dell'ingresso`);
			assert.ok(rates.cacheRead < rates.input, `${name}: la cache deve costare meno`);
			assert.ok(rates.cacheWrite > rates.input, `${name}: la scrittura in cache costa di più`);
		}
	});
});

describe("prefisso stabile e cache", () => {
	test("due compiti diversi producono un prefisso identico byte per byte", () => {
		const a = buildRequest(specialista, task({ instruction: "Primo compito." }));
		const b = buildRequest(
			specialista,
			task({
				instruction: "Secondo compito, del tutto diverso.",
				documents: [
					{ documentId: "altro", title: "altro", text: "altro testo", citations: true },
				],
			}),
		);
		assert.deepEqual(a.stable, b.stable, "il prefisso stabile è cambiato fra due chiamate");
		assert.equal(
			JSON.stringify(a.stable),
			JSON.stringify(b.stable),
			"differenza byte per byte nel prefisso",
		);
	});

	test("il punto di interruzione sta sull'ultimo blocco stabile, e solo lì", () => {
		const r = buildRequest(specialista, task());
		assert.ok(r.stable.length >= 2);
		assert.equal(r.stable.filter((b) => b.cache === true).length, 1);
		assert.equal(r.stable[r.stable.length - 1]!.cache, true);
	});

	test("nessun invalidatore silenzioso nel prefisso: né orari né identificativi", () => {
		const testo = buildRequest(specialista, task()).stable.map((b) => b.text).join("\n");

		// un timestamp epoch a 13 cifre, una data ISO completa con orario, un UUID
		assert.ok(!/\b1[0-9]{12}\b/.test(testo), "timestamp epoch nel prefisso");
		assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(testo), "data con orario nel prefisso");
		assert.ok(
			!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(testo),
			"UUID nel prefisso",
		);
	});

	test("il prefisso è deterministico anche se gli ambiti arrivano in ordine diverso", () => {
		const uno = { ...specialista, readScopes: ["vino", "annata", "lotto"] as const };
		const due = { ...specialista, readScopes: ["lotto", "annata", "vino"] as const };
		assert.deepEqual(
			buildRequest(uno, task()).stable,
			buildRequest(due, task()).stable,
			"l'ordine degli ambiti ha cambiato il prefisso",
		);
	});

	test("agenti diversi hanno prefissi diversi: la cache è per agente", () => {
		const a = buildRequest(specialista, task());
		const b = buildRequest(sentinella, task({ scopes: [] }));
		assert.notDeepEqual(a.stable, b.stable);
	});

	test("l'ontologia è nel prefisso, non nel compito", () => {
		const r = buildRequest(specialista, task());
		const prefisso = r.stable.map((b) => b.text).join("\n");
		assert.match(prefisso, /Ontologia enologica/);
		assert.match(prefisso, /Franciacorta/);
		assert.ok(!r.task.includes("Ontologia"), "l'ontologia non deve stare nella parte variabile");
	});

	test("il tetto di token consapevole viene dal budget dell'agente", () => {
		const r = buildRequest(specialista, task());
		assert.equal(r.taskBudgetTokens, specialista.budget.taskBudgetTokens);
		assert.equal(r.effort, specialista.effort);
		assert.equal(r.model, "claude-opus-5");
	});
});

describe("provenienza dalle citazioni", () => {
	test("una citazione diventa provenienza documentale", () => {
		const p = provenanceFromCitations([citation("doc_1", 4)], undefined, "x@1", "run_1");
		assert.equal(p.length, 1);
		assert.deepEqual(p[0], { kind: "documento", documentId: "doc_1", page: 4,
			charStart: undefined, charEnd: undefined });
	});

	test("senza citazioni la provenienza è inferenza del modello", () => {
		const p = provenanceFromCitations([], undefined, "x@1", "run_1");
		assert.equal(p[0].kind, "inferenza_modello");
	});

	test("gli indici selezionano le citazioni, e quelli fuori intervallo cadono", () => {
		const cs = [citation("a", 1), citation("b", 2), citation("c", 3)];
		const p = provenanceFromCitations(cs, [2, 0, 99], "x@1", "run_1");
		assert.equal(p.length, 2);
		assert.deepEqual(p.map((x) => (x.kind === "documento" ? x.documentId : "")), ["c", "a"]);
	});

	test("indici tutti non validi ricadono sull'inferenza, non su un elenco vuoto", () => {
		const p = provenanceFromCitations([citation("a", 1)], [7, 8], "x@1", "run_1");
		assert.equal(p.length, 1);
		assert.equal(p[0].kind, "inferenza_modello");
	});
});

describe("esecuzione", () => {
	test("una proposta citata entra nel fascicolo e può essere approvata", async () => {
		model.queue(okWith([proposta({ citationIndexes: [0] })], [citation("doc_scheda", 9)]));

		const r = await kernel.run(dossier, specialista, task());
		assert.equal(r.outcome, "ok");
		assert.equal(r.admitted.length, 1);
		assert.deepEqual(r.rejected, []);

		const [fact] = await dossier.listFacts();
		assert.equal(fact!.provenance[0].kind, "documento");
		assert.equal((await dossier.approve(fact!.id, { approvedBy: "orchestratore" })).ok, true);
	});

	test("una proposta senza citazioni entra ma non è approvabile", async () => {
		model.queue(okWith([proposta()], []));

		const r = await kernel.run(dossier, specialista, task());
		assert.equal(r.outcome, "ok");
		assert.equal(r.admitted.length, 1);

		const [fact] = await dossier.listFacts();
		assert.equal(fact!.provenance[0].kind, "inferenza_modello");

		const esito = await dossier.approve(fact!.id, { approvedBy: "orchestratore" });
		assert.equal(esito.ok, false, "l'inferenza non deve poter essere approvata");
	});

	test("una proposta fuori ambito è respinta e contata, senza fermare le altre", async () => {
		model.queue(
			okWith(
				[
					proposta({ citationIndexes: [0] }),
					proposta({ scope: { type: "territorio", ref: "Soave DOC" }, key: "clima" }),
				],
				[citation("doc_scheda", 9)],
			),
		);

		const r = await kernel.run(dossier, specialista, task());
		assert.equal(r.outcome, "ok");
		assert.equal(r.admitted.length, 1);
		assert.equal(r.rejected.length, 1);
		assert.equal(r.rejected[0]!.code, "AMBITO_NON_CONCESSO");

		// il rifiuto è registrato, non soltanto restituito
		assert.equal((await dossier.listRejections()).length, 1);
	});

	test("un compito fuori dagli ambiti leggibili non spende una chiamata", async () => {
		const r = await kernel.run(
			dossier,
			specialista,
			task({ scopes: [{ type: "sede", ref: "s1" }] }),
		);
		assert.equal(r.outcome, "rifiutato");
		assert.equal(model.calls, 0, "non deve essere stata fatta alcuna chiamata");
		assert.equal(r.costUsd, 0);
		assert.match(r.detail ?? "", /sede/);
	});

	test("un'uscita priva della chiamata allo strumento si ritenta", async () => {
		model.queue(
			{ kind: "errore", retryable: true, message: "nessuna chiamata allo strumento", usage: usage() },
			okWith([proposta({ citationIndexes: [0] })], [citation("doc_scheda", 1)]),
		);

		const r = await kernel.run(dossier, specialista, task());
		assert.equal(r.outcome, "ok");
		assert.equal(r.attempts, 2);
		assert.equal(model.calls, 2);
	});

	test("un errore non ritentabile si ferma al primo tentativo", async () => {
		model.always({ kind: "errore", retryable: false, message: "richiesta non valida" });

		const r = await kernel.run(dossier, specialista, task());
		assert.equal(r.outcome, "errore");
		assert.equal(r.attempts, 1);
		assert.equal(model.calls, 1, "un 400 non migliora ritentandolo");
	});

	test("un rifiuto del modello non si ritenta identico", async () => {
		model.always({ kind: "rifiuto", category: "cyber", usage: usage() });

		const r = await kernel.run(dossier, specialista, task());
		assert.equal(r.outcome, "rifiutato");
		assert.equal(model.calls, 1);
		assert.match(r.detail ?? "", /cyber/);
	});

	test("i tentativi si esauriscono e l'esito lo dice", async () => {
		model.always({ kind: "troncato", usage: usage({ outputTokens: 100 }) });

		const r = await kernel.run(dossier, specialista, task());
		assert.equal(r.outcome, "errore");
		assert.equal(r.attempts, specialista.budget.maxAttempts);
		assert.equal(model.calls, specialista.budget.maxAttempts);
		assert.match(r.detail ?? "", /tentativi esauriti/);
	});
});

describe("budget", () => {
	test("il costo si verifica dopo ogni tentativo: tre dentro il limite possono superarlo insieme", async () => {
		// $1,25 per tentativo contro un tetto di $2: il secondo lo supera
		const costoso = usage({ inputTokens: 0, outputTokens: 50_000, cacheReadTokens: 0 });
		model.always({ kind: "troncato", usage: costoso });

		const singolo = computeCost(specialista.model, costoso);
		assert.ok(singolo < specialista.budget.maxCostUsd, "il singolo tentativo sta nel limite");

		const r = await kernel.run(dossier, specialista, task());
		assert.equal(r.outcome, "limite_superato");
		assert.equal(r.attempts, 2);
		assert.match(r.detail ?? "", /costo superato/);
	});

	test("una singola chiamata troppo lunga viene interrotta", async () => {
		// un agente con 30ms di budget e un modello che ne impiega molti di più
		const impaziente = {
			...specialista,
			budget: { ...specialista.budget, maxDurationMs: 30 },
		};
		let interrotta = false;

		const lento = {
			invoke: (_r: unknown, signal?: AbortSignal) =>
				new Promise<never>((_resolve, reject) => {
					const timer = setTimeout(() => reject(new Error("mai")), 5_000);
					signal?.addEventListener("abort", () => {
						interrotta = true;
						clearTimeout(timer);
						reject(new Error("interrotta"));
					});
				}),
		};

		const k = new AgentKernel({
			db,
			model: lento as never,
			clock: fixedClock(),
			ids: sequentialIds("_t"),
		});

		const r = await k.run(dossier, impaziente, task());
		assert.equal(r.outcome, "limite_superato");
		assert.match(r.detail ?? "", /durata superata/);
		assert.ok(interrotta, "il segnale di interruzione deve raggiungere la richiesta");
	});

	test("la durata residua si riduce fra i tentativi e finisce per esaurirsi", async () => {
		// orologio che avanza di 40ms a ogni lettura, budget 100ms:
		// i tentativi si fermano quando il residuo arriva a zero
		let t = 0;
		const avanzante = { now: () => (t += 40) };
		const impaziente = {
			...specialista,
			budget: { ...specialista.budget, maxDurationMs: 100, maxAttempts: 10 },
		};

		const k = new AgentKernel({
			db,
			model: model.always({ kind: "troncato", usage: usage({ outputTokens: 1 }) }),
			clock: avanzante,
			ids: sequentialIds("_d"),
		});

		const r = await k.run(dossier, impaziente, task());
		assert.equal(r.outcome, "limite_superato");
		assert.ok(r.attempts < 10, `si è fermato a ${r.attempts} tentativi invece di dieci`);
		assert.match(r.detail ?? "", /durata superata/);
	});

	test("il tetto della cantina blocca prima di spendere", async () => {
		const k = new AgentKernel({
			db,
			model,
			clock: fixedClock(),
			ids: sequentialIds("_c"),
			ledger: { spentUsd: () => Promise.resolve(60) },
			maxCantinaCostUsd: 60,
		});

		const r = await k.run(dossier, specialista, task());
		assert.equal(r.outcome, "limite_superato");
		assert.equal(model.calls, 0);
		assert.match(r.detail ?? "", /tetto della cantina/);
	});

	test("il registro della spesa somma le esecuzioni della cantina", async () => {
		model.always(okWith([proposta({ citationIndexes: [0] })], [citation("doc_scheda", 1)]));
		await kernel.run(dossier, specialista, task());
		await kernel.run(dossier, specialista, task({ scopes: [{ type: "vino", ref: "w1" }] }));

		const speso = await sqlSpendLedger(db).spentUsd("c1");
		assert.ok(speso > 0);
		assert.ok(Math.abs(speso - 2 * 0.1325) < 1e-6, `atteso ~$0,265, ottenuto $${speso}`);

		// e non conta la spesa di un'altra cantina
		db.addCantina("c2", "Altra");
		assert.equal(await sqlSpendLedger(db).spentUsd("c2"), 0);
	});
});

describe("registrazione delle esecuzioni", () => {
	const esiti = [
		{ nome: "ok", programma: () => model.always(okWith([])), atteso: "ok" },
		{
			nome: "rifiuto del modello",
			programma: () => model.always({ kind: "rifiuto", category: null, usage: usage() }),
			atteso: "rifiutato",
		},
		{
			nome: "errore definitivo",
			programma: () => model.always({ kind: "errore", retryable: false, message: "x" }),
			atteso: "errore",
		},
	] as const;

	for (const { nome, programma, atteso } of esiti) {
		test(`un'esecuzione con esito «${nome}» è comunque registrata`, async () => {
			programma();
			const r = await kernel.run(dossier, specialista, task());
			assert.equal(r.outcome, atteso);

			const rows = db.raw<{ id: string; outcome: string; agent: string; cost_usd: number }>(
				`SELECT * FROM agent_run WHERE cantina_id='c1'`,
			);
			assert.equal(rows.length, 1, "un'esecuzione non registrata falsifica gli indicatori");
			assert.equal(rows[0]!.id, r.runId);
			assert.equal(rows[0]!.outcome, atteso);
			assert.equal(rows[0]!.agent, specialista.id);
		});
	}

	test("la riga porta modello, versione del prompt, sforzo e token della cache", async () => {
		model.always(okWith([]));
		await kernel.run(dossier, specialista, task());

		const [row] = db.raw<{
			model: string;
			prompt_version: string;
			effort: string;
			input_tokens: number;
			output_tokens: number;
			cache_read_tokens: number;
		}>(`SELECT * FROM agent_run WHERE cantina_id='c1'`);

		assert.equal(row!.model, "claude-opus-5");
		assert.equal(row!.prompt_version, specialista.promptVersion);
		assert.equal(row!.effort, specialista.effort);
		assert.equal(row!.input_tokens, 10_000);
		assert.equal(row!.output_tokens, 3_000);
		assert.equal(row!.cache_read_tokens, 15_000);
	});

	test("un'esecuzione fermata prima della chiamata è registrata a costo zero", async () => {
		const r = await kernel.run(dossier, specialista, task({ scopes: [{ type: "sede", ref: "s" }] }));
		const [row] = db.raw<{ outcome: string; cost_usd: number; input_tokens: number }>(
			`SELECT * FROM agent_run WHERE id=?`, r.runId,
		);
		assert.equal(row!.outcome, "rifiutato");
		assert.equal(row!.cost_usd, 0);
		assert.equal(row!.input_tokens, 0);
	});

	test("i token si sommano fra i tentativi", async () => {
		model.queue(
			{ kind: "troncato", usage: usage() },
			{ kind: "troncato", usage: usage() },
			okWith([]),
		);
		const r = await kernel.run(dossier, specialista, task());
		assert.equal(r.attempts, 3);
		assert.equal(r.usage.outputTokens, 9_000, "tre tentativi da 3k");
		assert.ok(Math.abs(r.costUsd - 3 * 0.1325) < 1e-9);
	});
});
