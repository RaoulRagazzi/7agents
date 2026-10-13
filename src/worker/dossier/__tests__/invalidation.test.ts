import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { dependentClosure, planRevalidation } from "../invalidation.ts";
import type {
	ActivationOpFactRef,
	FactEdge,
	TranslationRef,
} from "../invalidation.ts";

const edge = (derived: string, source: string, rule = "derivazione"): FactEdge => ({
	derivedFactId: derived,
	sourceFactId: source,
	rule,
});

describe("chiusura dei dipendenti", () => {
	test("segue la catena in profondità", () => {
		const edges = [edge("b", "a"), edge("c", "b"), edge("d", "c")];
		assert.deepEqual(dependentClosure(["a"], edges), ["b", "c", "d"]);
	});

	test("la radice non si rimette in riesame", () => {
		const edges = [edge("b", "a")];
		assert.ok(!dependentClosure(["a"], edges).includes("a"));
	});

	test("non risale verso le origini", () => {
		const edges = [edge("b", "a"), edge("c", "b")];
		assert.deepEqual(dependentClosure(["c"], edges), []);
	});

	test("i rami indipendenti non vengono toccati", () => {
		const edges = [edge("b", "a"), edge("y", "x")];
		assert.deepEqual(dependentClosure(["a"], edges), ["b"]);
	});

	test("tollera i cicli senza ciclare", () => {
		const edges = [edge("b", "a"), edge("a", "b"), edge("c", "b")];
		const out = dependentClosure(["a"], edges);
		assert.deepEqual(out, ["b", "c"]);
	});

	test("un grafo vuoto non produce nulla", () => {
		assert.deepEqual(dependentClosure(["a"], []), []);
	});
});

describe("piano di riesame", () => {
	// la scheda 2021 (gradazione) alimenta un paragrafo commerciale;
	// l'annata 2020 e la storia della cantina sono indipendenti
	const edges = [
		edge("par_commerciale_2021", "grad_2021"),
		edge("par_commerciale_2020", "grad_2020"),
		edge("par_storia", "fondazione"),
	];

	const translations: TranslationRef[] = [
		{ id: "t_grad2021_en", factId: "grad_2021", lang: "en", sourceVersion: 1, state: "approvata" },
		{ id: "t_grad2021_de", factId: "grad_2021", lang: "de", sourceVersion: 1, state: "approvata" },
		{ id: "t_par2021_en", factId: "par_commerciale_2021", lang: "en", sourceVersion: 1, state: "approvata" },
		{ id: "t_grad2020_en", factId: "grad_2020", lang: "en", sourceVersion: 1, state: "approvata" },
		{ id: "t_storia_en", factId: "par_storia", lang: "en", sourceVersion: 1, state: "approvata" },
	];

	const operationFacts: ActivationOpFactRef[] = [
		{ opId: "op_ref_2021", factId: "grad_2021", factVersion: 1 },
		{ opId: "op_ref_2020", factId: "grad_2020", factVersion: 1 },
		{ opId: "op_profilo", factId: "fondazione", factVersion: 1 },
	];

	const plan = planRevalidation("grad_2021", 2, edges, translations, operationFacts);

	test("rimette in riesame soltanto i dipendenti", () => {
		assert.deepEqual(plan.factsToReview, ["par_commerciale_2021"]);
	});

	test("un aggiornamento alla gradazione 2021 non tocca il 2020", () => {
		assert.ok(!plan.factsToReview.includes("par_commerciale_2020"));
		assert.ok(!plan.translationsStale.includes("t_grad2020_en"));
		assert.ok(!plan.operationsReexecutable.includes("op_ref_2020"));
	});

	test("non tocca la storia della cantina né le sue traduzioni", () => {
		assert.ok(!plan.factsToReview.includes("par_storia"));
		assert.ok(!plan.translationsStale.includes("t_storia_en"));
		assert.ok(!plan.operationsReexecutable.includes("op_profilo"));
	});

	test("marca stale le traduzioni della radice e dei dipendenti", () => {
		assert.deepEqual(plan.translationsStale, [
			"t_grad2021_de",
			"t_grad2021_en",
			"t_par2021_en",
		]);
	});

	test("marca rieseguibile solo l'operazione che citava la versione superata", () => {
		assert.deepEqual(plan.operationsReexecutable, ["op_ref_2021"]);
	});

	test("un'operazione già alla nuova versione non torna rieseguibile", () => {
		const p = planRevalidation(
			"grad_2021",
			2,
			edges,
			[],
			[{ opId: "op_aggiornata", factId: "grad_2021", factVersion: 2 }],
		);
		assert.deepEqual(p.operationsReexecutable, []);
	});

	test("una traduzione già stale non si rimarca", () => {
		const p = planRevalidation(
			"grad_2021",
			2,
			[],
			[{ id: "t", factId: "grad_2021", lang: "en", sourceVersion: 1, state: "stale" }],
			[],
		);
		assert.deepEqual(p.translationsStale, []);
	});

	test("il numero di record toccati resta proporzionale alle dipendenze", () => {
		// cinque traduzioni e tre operazioni nel fascicolo; la modifica ne tocca
		// tre e una: senza il grafo sarebbero cinque e tre
		assert.equal(translations.length, 5);
		assert.equal(plan.translationsStale.length, 3);
		assert.equal(operationFacts.length, 3);
		assert.equal(plan.operationsReexecutable.length, 1);
	});
});
