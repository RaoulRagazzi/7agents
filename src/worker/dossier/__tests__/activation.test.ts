import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
	applyActivationEvent,
	decideActivation,
	operationKey,
} from "../activation.ts";
import type { ActivationEvent, FactVersionRef } from "../activation.ts";
import type { ActivationState } from "../types.ts";

const facts: FactVersionRef[] = [
	{ factId: "f_denominazione", version: 1 },
	{ factId: "f_gradazione", version: 3 },
	{ factId: "f_vitigni", version: 2 },
];

describe("chiave d'operazione", () => {
	test("è stabile fra chiamate identiche", async () => {
		const a = await operationKey("c1", { target: "referenza", ref: "w1" }, facts);
		const b = await operationKey("c1", { target: "referenza", ref: "w1" }, facts);
		assert.equal(a, b);
		assert.match(a, /^[0-9a-f]{64}$/);
	});

	test("non dipende dall'ordine dei fatti: un ritentativo non duplica", async () => {
		const ordered = await operationKey("c1", { target: "referenza", ref: "w1" }, facts);
		const shuffled = await operationKey("c1", { target: "referenza", ref: "w1" }, [
			facts[2]!,
			facts[0]!,
			facts[1]!,
		]);
		assert.equal(ordered, shuffled);
	});

	test("cambia quando un fatto cambia versione: aggiornare resta distinguibile", async () => {
		const before = await operationKey("c1", { target: "referenza", ref: "w1" }, facts);
		const after = await operationKey("c1", { target: "referenza", ref: "w1" }, [
			facts[0]!,
			{ factId: "f_gradazione", version: 4 },
			facts[2]!,
		]);
		assert.notEqual(before, after);
	});

	test("separa le cantine, le destinazioni e i riferimenti", async () => {
		const base = await operationKey("c1", { target: "referenza", ref: "w1" }, facts);
		const altraCantina = await operationKey("c2", { target: "referenza", ref: "w1" }, facts);
		const altraDest = await operationKey("c1", { target: "profilo", ref: "w1" }, facts);
		const altroRif = await operationKey("c1", { target: "referenza", ref: "w2" }, facts);
		const senzaRif = await operationKey("c1", { target: "referenza" }, facts);

		assert.equal(new Set([base, altraCantina, altraDest, altroRif, senzaRif]).size, 5);
	});
});

describe("macchina a stati dell'attivazione", () => {
	test("il percorso lieto attraversa i quattro stati", () => {
		let state: ActivationState = "preparato";
		for (const event of [
			"salva_riuscito",
			"pubblica_riuscito",
			"verifica_coincide",
		] as const) {
			const t = applyActivationEvent(state, event);
			assert.ok(t, `transizione ${state} + ${event} rifiutata`);
			state = t.state;
		}
		assert.equal(state, "verificato");
	});

	test("verificato si raggiunge solo dalla rilettura", () => {
		// nessun altro stato/evento produce verificato
		const states: ActivationState[] = ["preparato", "salvato", "pubblicato"];
		const events: ActivationEvent[] = [
			"salva_riuscito",
			"pubblica_riuscito",
			"verifica_coincide",
			"verifica_divergente",
			"abbandona",
		];
		for (const s of states) {
			for (const e of events) {
				const t = applyActivationEvent(s, e);
				if (t?.state === "verificato") {
					assert.equal(s, "pubblicato");
					assert.equal(e, "verifica_coincide");
				}
			}
		}
	});

	test("non si salta un passo", () => {
		assert.equal(applyActivationEvent("preparato", "pubblica_riuscito"), null);
		assert.equal(applyActivationEvent("preparato", "verifica_coincide"), null);
		assert.equal(applyActivationEvent("salvato", "verifica_coincide"), null);
	});

	test("una divergenza segnala e non ritenta alla cieca", () => {
		const t = applyActivationEvent("pubblicato", "verifica_divergente");
		assert.ok(t);
		assert.equal(t.state, "pubblicato", "non deve avanzare né regredire");
		assert.equal(t.raiseIssueCode, "DIVERGENZA_POST_SALVATAGGIO");
	});

	test("gli stati terminali non accettano eventi", () => {
		for (const s of ["verificato", "fallito"] as const) {
			for (const e of [
				"salva_riuscito",
				"pubblica_riuscito",
				"verifica_coincide",
				"abbandona",
			] as const) {
				assert.equal(applyActivationEvent(s, e), null, `${s} + ${e}`);
			}
		}
	});

	test("abbandonare è possibile da ogni stato non terminale", () => {
		for (const s of ["preparato", "salvato", "pubblicato"] as const) {
			assert.equal(applyActivationEvent(s, "abbandona")?.state, "fallito");
		}
	});
});

describe("decisione sul ritentativo", () => {
	test("senza operazione precedente si prepara", () => {
		assert.deepEqual(decideActivation(undefined, 3), { action: "prepara" });
	});

	test("un'operazione già verificata si salta", () => {
		const d = decideActivation(
			{ operationKey: "k", state: "verificato", attempts: 1 },
			3,
		);
		assert.equal(d.action, "salta");
	});

	test("un'operazione a metà riprende dal punto raggiunto", () => {
		for (const state of ["preparato", "salvato", "pubblicato"] as const) {
			const d = decideActivation({ operationKey: "k", state, attempts: 1 }, 3);
			assert.equal(d.action, "riprendi");
			assert.equal(d.action === "riprendi" && d.from, state);
		}
	});

	test("tentativi esauriti blocca invece di insistere", () => {
		const d = decideActivation(
			{ operationKey: "k", state: "salvato", attempts: 3 },
			3,
		);
		assert.equal(d.action, "blocca");
	});

	test("un'operazione abbandonata non riparte da sola", () => {
		const d = decideActivation(
			{ operationKey: "k", state: "fallito", attempts: 1 },
			3,
		);
		assert.equal(d.action, "blocca");
	});
});
