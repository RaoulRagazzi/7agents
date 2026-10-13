/**
 * Passata avversariale sulla Sentinella.
 *
 * I test puntuali provano che ogni controllo trovi ciò che deve trovare. Questo
 * prova le proprietà che valgono **su qualunque ingresso**, incluso quello
 * malformato: un fascicolo corrotto, un riferimento illegale, un numero che non
 * è un numero. Sono le proprietà che un controllo esatto non può perdere.
 *
 * Il generatore è deterministico: un fallimento è riproducibile, e un test che
 * passa oggi e fallisce domani sugli stessi dati non sarebbe una prova.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { CODES, runDeterministicChecks } from "../sentinel.ts";
import type { SentinelContext } from "../sentinel.ts";
import type { Fact, FactValue, Provenance, ScopeType } from "../types.ts";

const CTX: SentinelContext = { currentYear: 2026 };
const VALID_CODES = new Set<string>(CODES);
const SEVERITIES = new Set(["bloccante", "da_confermare", "miglioramento", "superato"]);

const SCOPES: ScopeType[] = [
	"cantina", "marchio", "sede", "vino", "annata", "lotto", "vigneto", "territorio",
];

/** Riferimenti deliberatamente ostili, inclusi quelli che non dovrebbero esistere. */
const REFS = [
	"", " ", ":", "::", "w1", "w1:2021", "w1:2021:l1", "w1:21", "w1:99999",
	"a".repeat(300), "🍷", "w1:2021:", "Ä", "\u0000", "w1\n:2021", "-1", "w1:0000",
];

const KEYS = [
	"gradazione_alcolica", "denominazione", "tipologia", "vitigni", "colore", "nome",
	"data_sboccatura", "partita_iva", "solforosa_totale", "", "chiave_ignota",
	"contenitore_affinamento", "metodo_spumantizzazione", "affinamento", "acidita_totale",
];

/** Generatore lineare: riproducibile, e indipendente dall'ambiente. */
function makeRandom(seed: number) {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x7fffffff;
	};
}

function build(rnd: () => number): Fact[] {
	const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

	const value = (): FactValue => {
		switch (Math.floor(rnd() * 7)) {
			case 0:
				return {
					kind: "numero",
					// NaN e Infinity superano ogni confronto: devono essere respinti
					value: pick([0, -1, 13.5, 1e308, NaN, Infinity, -0, 1e-10, 999_999]),
					unit: pick(["%vol", "g/l", "mg/l", "", "\u0000"]),
				};
			case 1:
				return {
					kind: "testo",
					text: pick(["Soave Classico", "", " ", "🍷", "a".repeat(5_000), "D.O.C.", "spumante"]),
				};
			case 2:
				return {
					kind: "data",
					iso: pick(["2021-01-01", "", "abc", "0000-00-00", "2021", "9999-12-31", "2021-13-45"]),
				};
			case 3:
				return {
					kind: "elenco",
					items: pick([[], ["Garganega"], ["", " "], Array<string>(200).fill("x")]),
				};
			case 4:
				return { kind: "booleano", value: rnd() > 0.5 };
			case 5:
				return { kind: "non_disponibile" };
			default:
				return { kind: "testo", text: pick(["fermo", "passito", "bianco", "ambrato"]) };
		}
	};

	const provenance = (): readonly [Provenance, ...Provenance[]] =>
		pick([
			[{ kind: "documento", documentId: "d1", page: 1 }],
			[{ kind: "inferenza_modello", promptVersion: "x", runId: "r" }],
			[{ kind: "dichiarazione", answerId: "a", respondent: "x", receivedAt: 0 }],
		] as readonly [Provenance, ...Provenance[]][]);

	return Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, i) => ({
		id: `f${i}`,
		cantinaId: "c1",
		scope: { type: pick(SCOPES), ref: pick(REFS) },
		key: pick(KEYS),
		value: value(),
		state: pick(["proposto", "da_confermare", "approvato", "superato"] as const),
		visibility: pick(["pubblico", "commerciale", "interno", "riservato"] as const),
		version: 1,
		agent: "t",
		promptVersion: "t@1",
		provenance: provenance(),
		createdAt: 0,
		approvedAt: 1,
		approvedBy: "orchestratore",
	}));
}

const ITERAZIONI = 1_000;

describe("proprietà su qualunque ingresso", () => {
	test("nessun ingresso fa sollevare un'eccezione", () => {
		const rnd = makeRandom(0x9e3779b9);
		for (let i = 0; i < ITERAZIONI; i++) {
			const facts = build(rnd);
			assert.doesNotThrow(
				() => runDeterministicChecks({ facts }, CTX),
				`iterazione ${i}`,
			);
		}
	});

	test("ogni anomalia è ben formata: codice noto, gravità nota, motivo non vuoto", () => {
		const rnd = makeRandom(0x1234567);
		let prodotte = 0;

		for (let i = 0; i < ITERAZIONI; i++) {
			for (const x of runDeterministicChecks({ facts: build(rnd) }, CTX)) {
				prodotte += 1;
				assert.ok(VALID_CODES.has(x.code), `codice non dichiarato: ${x.code}`);
				assert.ok(SEVERITIES.has(x.severity), `gravità ignota: ${x.severity}`);
				assert.ok(x.detail.length > 0, `motivo vuoto per ${x.code}`);
				assert.ok(x.targets.length > 0, `nessuna destinazione per ${x.code}`);
				assert.ok(Array.isArray(x.evidence), `evidenze non elencabili per ${x.code}`);
			}
		}
		assert.ok(prodotte > 500, `troppe poche anomalie prodotte (${prodotte}): il generatore non morde`);
	});

	test("nessun motivo contiene «undefined»: un messaggio rotto è un errore", () => {
		const rnd = makeRandom(0xabcdef);
		for (let i = 0; i < ITERAZIONI; i++) {
			for (const x of runDeterministicChecks({ facts: build(rnd) }, CTX)) {
				assert.ok(
					!x.detail.includes("undefined"),
					`«undefined» nel motivo di ${x.code}: ${x.detail.slice(0, 100)}`,
				);
			}
		}
	});

	test("l'esito è deterministico", () => {
		const rnd = makeRandom(0x55555);
		for (let i = 0; i < ITERAZIONI; i++) {
			const facts = build(rnd);
			assert.deepEqual(
				runDeterministicChecks({ facts }, CTX),
				runDeterministicChecks({ facts }, CTX),
				`iterazione ${i}`,
			);
		}
	});

	test("l'esito non dipende dall'ordine dei fatti in ingresso", () => {
		// la proprietà più fragile: diversi controlli scelgono «il primo fatto»
		// di un ambito, e senza un ordine stabile quel primo cambia
		const rnd = makeRandom(0x777777);
		for (let i = 0; i < ITERAZIONI; i++) {
			const facts = build(rnd);
			const diretto = runDeterministicChecks({ facts }, CTX);
			const inverso = runDeterministicChecks({ facts: [...facts].reverse() }, CTX);

			assert.deepEqual(
				inverso,
				diretto,
				`iterazione ${i}: l'ordine in ingresso ha cambiato l'esito`,
			);
		}
	});

	test("un anno corrente più alto non può aggiungere anomalie", () => {
		// il controllo sull'annata futura può solo diventare più permissivo
		const rnd = makeRandom(0x31337);
		for (let i = 0; i < 300; i++) {
			const facts = build(rnd);
			const stretto = runDeterministicChecks({ facts }, { currentYear: 2026 });
			const largo = runDeterministicChecks({ facts }, { currentYear: 2100 });
			assert.ok(
				largo.length <= stretto.length,
				`iterazione ${i}: un anno più alto ha prodotto più anomalie`,
			);
		}
	});
});
