import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { evaluateGate, GATES } from "../gates.ts";
import type { Fact, GateTarget, Issue } from "../types.ts";
import { blockingIssue, fact, referenceFacts } from "./fixtures.ts";

describe("cancelli", () => {
	test("una referenza con i fatti approvati apre", () => {
		const r = evaluateGate({ target: "referenza", ref: "w1" }, referenceFacts("w1"), []);
		assert.equal(r.open, true);
	});

	test("un dato mancante chiude e lo dichiara", () => {
		const facts = referenceFacts("w1").filter((f) => f.key !== "vitigni");
		const r = evaluateGate({ target: "referenza", ref: "w1" }, facts, []);
		assert.equal(r.open, false);
		assert.ok(
			!r.open && r.reasons.some((m) => m.includes("vitigni")),
			"il motivo deve nominare il dato mancante",
		);
	});

	test("un'anomalia bloccante sulla referenza la chiude", () => {
		const r = evaluateGate(
			{ target: "referenza", ref: "w1" },
			referenceFacts("w1"),
			[blockingIssue("w1")],
		);
		assert.equal(r.open, false);
	});

	test("un'anomalia risolta o accettata non blocca", () => {
		for (const state of ["risolta", "accettata"] as const) {
			const r = evaluateGate(
				{ target: "referenza", ref: "w1" },
				referenceFacts("w1"),
				[blockingIssue("w1", { state })],
			);
			assert.equal(r.open, true, `stato ${state} non deve bloccare`);
		}
	});

	test("un bloccante non qualificato chiude tutte le referenze", () => {
		const issue = blockingIssue("w1", { targets: [{ target: "referenza" }] });
		const r = evaluateGate({ target: "referenza", ref: "w2" }, referenceFacts("w2"), [issue]);
		assert.equal(r.open, false);
	});

	test("il Sommelier richiede il profilo e il numero minimo di referenze", () => {
		const pack = [fact("cantina", "c1", "pacchetto_contenuti")];
		assert.equal(evaluateGate({ target: "sommelier" }, pack, [], [], 5).open, false);
		assert.equal(evaluateGate({ target: "sommelier" }, pack, [], ["profilo"], 2).open, false);
		assert.equal(evaluateGate({ target: "sommelier" }, pack, [], ["profilo"], 3).open, true);
	});

	test("una chiave facoltativa è soddisfatta da 'non disponibile'", () => {
		const facts = [
			fact("cantina", "c1", "ragione_sociale"),
			fact("sede", "s1", "sede_legale", { visibility: "riservato" }),
			fact("cantina", "c1", "contatto_pubblico"),
			fact("marchio", "m1", "nome_commerciale"),
			// storia_sintesi ha mustHaveValue: false
			fact("cantina", "c1", "storia_sintesi", { value: { kind: "non_disponibile" } }),
		];
		assert.equal(evaluateGate({ target: "profilo" }, facts, []).open, true);
	});

	test("una chiave obbligatoria NON è soddisfatta da 'non disponibile'", () => {
		const facts = referenceFacts("w1").map((f) =>
			f.key === "denominazione" ? { ...f, value: { kind: "non_disponibile" } as const } : f,
		);
		assert.equal(evaluateGate({ target: "referenza", ref: "w1" }, facts, []).open, false);
	});
});

describe("proprietà dei cancelli", () => {
	// generatore deterministico: un test riproducibile vale più di uno casuale
	let seed = 0x2f6e2b1;
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

	const TARGETS: readonly GateTarget[] = [
		"profilo",
		"referenza",
		"sommelier",
		"materiali_commerciali",
	];

	test("impermeabilità al proposto: un fascicolo non approvato non apre nulla", () => {
		for (let i = 0; i < 300; i++) {
			const wine = `w${Math.floor(rnd() * 3)}`;
			const state = pick(["proposto", "da_confermare", "superato"] as const);
			const facts: Fact[] = [
				...referenceFacts(wine),
				fact("cantina", "c1", "pacchetto_contenuti"),
				fact("cantina", "c1", "ragione_sociale"),
				fact("sede", "s1", "sede_legale"),
				fact("cantina", "c1", "contatto_pubblico"),
				fact("marchio", "m1", "nome_commerciale"),
				fact("cantina", "c1", "storia_sintesi"),
				fact("cantina", "c1", "lingue_richieste"),
			].map((f) => ({ ...f, state }));

			const target = pick(TARGETS);
			const r = evaluateGate(
				{ target, ref: target === "referenza" ? wine : undefined },
				facts,
				[],
				["profilo"],
				9,
			);
			assert.equal(r.open, false, `${target} aperto con fatti in stato ${state}`);
		}
	});

	test("monotonia: aggiungere un bloccante non può aprire un cancello chiuso", () => {
		for (let i = 0; i < 300; i++) {
			const wine = `w${Math.floor(rnd() * 3)}`;
			// un sottoinsieme casuale dei fatti richiesti
			const facts = referenceFacts(wine).filter(() => rnd() > 0.3);
			const target = { target: "referenza" as const, ref: wine };

			const before = evaluateGate(target, facts, []);
			const extra: Issue[] = [blockingIssue(wine, { id: `i${i}` })];
			const after = evaluateGate(target, facts, extra);

			if (!before.open) {
				assert.equal(after.open, false, "un bloccante in più ha aperto un cancello chiuso");
			}
			assert.equal(after.open, false, "con un bloccante attivo il cancello resta chiuso");
		}
	});

	test("granularità: un bloccante su una referenza non chiude le altre", () => {
		for (let i = 0; i < 100; i++) {
			const a = `w${Math.floor(rnd() * 5)}`;
			let b = `w${Math.floor(rnd() * 5)}`;
			if (a === b) b = `${b}_bis`;

			const r = evaluateGate(
				{ target: "referenza", ref: b },
				referenceFacts(b),
				[blockingIssue(a)],
			);
			assert.equal(r.open, true, `il bloccante su ${a} ha chiuso ${b}`);
		}
	});

	test("ogni cancello dichiarato è valutabile", () => {
		for (const target of TARGETS) {
			assert.ok(GATES[target], `cancello ${target} non dichiarato`);
			assert.doesNotThrow(() => evaluateGate({ target }, [], []));
		}
	});
});
