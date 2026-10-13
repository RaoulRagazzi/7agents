import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { resolveCandidates, valuesAgree } from "../candidates.ts";
import type { Candidate, SourceLevel } from "../candidates.ts";
import type { FactValue } from "../types.ts";

let n = 0;
function cand(level: SourceLevel, value: FactValue): Candidate {
	n += 1;
	return {
		id: `cand_${n}`,
		value,
		level,
		provenance: { kind: "documento", documentId: "d1", page: 1 },
	};
}

const num = (v: number, unit = "%vol"): FactValue => ({ kind: "numero", value: v, unit });
const txt = (t: string): FactValue => ({ kind: "testo", text: t });

describe("concordanza dei valori", () => {
	test("la gradazione ammette un decimo di scarto", () => {
		assert.equal(valuesAgree("gradazione_alcolica", num(13.5), num(13.55)), true);
		assert.equal(valuesAgree("gradazione_alcolica", num(13.5), num(13.6)), true);
		assert.equal(valuesAgree("gradazione_alcolica", num(13.5), num(14)), false);
	});

	test("la denominazione non ammette varianti di valore", () => {
		assert.equal(valuesAgree("denominazione", txt("Soave Classico"), txt("Soave Classico")), true);
		assert.equal(valuesAgree("denominazione", txt("Soave Classico"), txt("Soave")), false);
	});

	test("il confronto testuale normalizza accenti, maiuscole e punteggiatura", () => {
		assert.equal(valuesAgree("denominazione", txt("Soave Classico D.O.C."), txt("soave classico doc")), true);
		assert.equal(valuesAgree("nome", txt("Valpolicella  Ripasso"), txt("valpolicella ripasso")), true);
		assert.equal(valuesAgree("nome", txt("Nerò d'Avola"), txt("nero d avola")), true);
	});

	test("una chiave senza tolleranza dichiarata non ammette scarto", () => {
		assert.equal(valuesAgree("chiave_ignota", num(10), num(10.01)), false);
		assert.equal(valuesAgree("chiave_ignota", num(10), num(10)), true);
	});

	test("unità diverse non concordano, nemmeno a numero uguale", () => {
		assert.equal(valuesAgree("gradazione_alcolica", num(13.5, "%vol"), num(13.5, "g/l")), false);
	});

	test("gli elenchi concordano a meno dell'ordine", () => {
		const a: FactValue = { kind: "elenco", items: ["Garganega", "Trebbiano"] };
		const b: FactValue = { kind: "elenco", items: ["trebbiano", "garganega"] };
		const c: FactValue = { kind: "elenco", items: ["Garganega"] };
		assert.equal(valuesAgree("vitigni", a, b), true);
		assert.equal(valuesAgree("vitigni", a, c), false);
	});

	test("tipi diversi non concordano", () => {
		assert.equal(valuesAgree("x", num(13), txt("13")), false);
	});
});

describe("risoluzione dei candidati", () => {
	test("nessun candidato", () => {
		assert.equal(resolveCandidates("k", []).outcome, "nessun_candidato");
	});

	test("un solo candidato diventa proposto", () => {
		const r = resolveCandidates("gradazione_alcolica", [cand("documento", num(13.5))]);
		assert.equal(r.outcome, "unico");
		assert.equal(r.outcome === "unico" && r.state, "proposto");
	});

	test("fonti concordi: vince la più autorevole, le altre sono registrate", () => {
		const r = resolveCandidates("gradazione_alcolica", [
			cand("pagina_pubblica", num(13.5)),
			cand("documento_ufficiale", num(13.52)),
		]);
		assert.equal(r.outcome, "concorde");
		assert.ok(r.outcome === "concorde");
		assert.equal(r.winner.level, "documento_ufficiale");
		assert.equal(r.discarded.length, 1);
	});

	test("la precedenza decide quando il capofila è isolato", () => {
		const r = resolveCandidates("gradazione_alcolica", [
			cand("pagina_pubblica", num(14)),
			cand("documento_ufficiale", num(13.5)),
			cand("inferenza_modello", num(12)),
		]);
		assert.equal(r.outcome, "precedenza");
		assert.ok(r.outcome === "precedenza");
		assert.equal(r.winner.level, "documento_ufficiale");
		assert.deepEqual(r.winner.value, num(13.5));
		assert.equal(r.discarded.length, 2);
	});

	test("il documento ufficiale batte la dichiarazione, che batte il sito", () => {
		const r = resolveCandidates("denominazione", [
			cand("pagina_pubblica", txt("Soave")),
			cand("dichiarazione", txt("Soave Superiore")),
			cand("documento_ufficiale", txt("Soave Classico")),
		]);
		assert.ok(r.outcome === "precedenza");
		assert.deepEqual(r.winner.value, txt("Soave Classico"));
	});

	test("la dichiarazione del produttore batte un documento commerciale", () => {
		const r = resolveCandidates("gradazione_alcolica", [
			cand("documento", num(14)),
			cand("dichiarazione", num(13.5)),
		]);
		assert.ok(r.outcome === "precedenza");
		assert.equal(r.winner.level, "dichiarazione");
	});

	test("pari livello e valori divergenti: contraddizione, nessun vincitore", () => {
		const r = resolveCandidates("gradazione_alcolica", [
			cand("documento", num(13.5)),
			cand("documento", num(14)),
		]);
		assert.equal(r.outcome, "contraddizione");
		assert.ok(r.outcome === "contraddizione");
		assert.equal(r.severity, "da_confermare");
		assert.equal(r.code, "CONTRADDIZIONE_GRADAZIONE_ALCOLICA");
		assert.equal(r.conflicting.length, 2);
		// la forma dell'esito non espone un vincitore: il dato resta fuori
		assert.ok(!("winner" in r));
	});

	test("pari livello entro tolleranza: concordi, non contraddittori", () => {
		const r = resolveCandidates("gradazione_alcolica", [
			cand("documento", num(13.5)),
			cand("documento", num(13.55)),
		]);
		assert.equal(r.outcome, "concorde");
	});

	test("una divergenza a livello più basso non apre una contraddizione", () => {
		// il sito dissente, ma il documento ufficiale è isolato in testa
		const r = resolveCandidates("gradazione_alcolica", [
			cand("documento_ufficiale", num(13.5)),
			cand("pagina_pubblica", num(14)),
		]);
		assert.equal(r.outcome, "precedenza");
	});

	test("tre fonti di pari livello con due d'accordo e una no: contraddizione", () => {
		const r = resolveCandidates("gradazione_alcolica", [
			cand("documento", num(13.5)),
			cand("documento", num(13.5)),
			cand("documento", num(15)),
		]);
		assert.equal(r.outcome, "contraddizione");
		assert.ok(r.outcome === "contraddizione");
		assert.equal(r.conflicting.length, 2, "capofila più i dissenzienti");
	});

	test("il caso del programma: scheda tecnica 13,5 contro listino 14", () => {
		const r = resolveCandidates("gradazione_alcolica", [
			cand("documento", num(13.5)),
			cand("documento", num(14)),
		]);
		assert.ok(r.outcome === "contraddizione");
		// entrambe le evidenze sono allegate
		assert.deepEqual(
			r.conflicting.map((c) => c.value),
			[num(13.5), num(14)],
		);
	});

	test("è deterministica", () => {
		const cs = [
			cand("documento", num(13.5)),
			cand("dichiarazione", num(13.5)),
			cand("pagina_pubblica", num(14)),
		];
		const a = resolveCandidates("gradazione_alcolica", cs);
		const b = resolveCandidates("gradazione_alcolica", [...cs].reverse());
		assert.equal(a.outcome, b.outcome);
		assert.equal(
			a.outcome === "precedenza" && a.winner.level,
			b.outcome === "precedenza" && b.winner.level,
		);
	});
});
