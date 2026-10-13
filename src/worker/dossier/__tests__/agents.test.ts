import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
	ACTIVATION_TOOLS,
	AGENTS,
	FORBIDDEN_TOOL_PATTERNS,
	getAgent,
} from "../agents.ts";

describe("la squadra dei dieci agenti", () => {
	test("sono dieci, numerati da 1 a 10, con id distinti", () => {
		assert.equal(AGENTS.length, 10);
		assert.deepEqual(
			AGENTS.map((a) => a.numero).sort((x, y) => x - y),
			[1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
		);
		assert.equal(new Set(AGENTS.map((a) => a.id)).size, 10);
	});

	test("nessun agente può approvare", () => {
		for (const a of AGENTS) {
			assert.equal(a.canApprove, false, `${a.id} potrebbe approvare`);
		}
	});

	test("writeScopes è sempre un sottoinsieme di readScopes", () => {
		for (const a of AGENTS) {
			for (const scope of a.writeScopes) {
				assert.ok(
					a.readScopes.includes(scope),
					`${a.id} scrive in ${scope} senza poterlo leggere`,
				);
			}
		}
	});

	test("ogni agente ha un budget con limiti positivi", () => {
		for (const a of AGENTS) {
			assert.ok(a.budget.maxDurationMs > 0, `${a.id}: durata`);
			assert.ok(a.budget.maxCostUsd > 0, `${a.id}: costo`);
			assert.ok(a.budget.maxAttempts > 0, `${a.id}: tentativi`);
			assert.ok(a.budget.taskBudgetTokens > 0, `${a.id}: token`);
		}
	});

	test("gli agenti 4 e 5 condividono prompt, ambiti e strumenti", () => {
		const a4 = getAgent("specialista_bianchi_spumanti_passiti");
		const a5 = getAgent("specialista_altre_referenze");
		assert.ok(a4 && a5);
		assert.equal(a4.promptVersion, a5.promptVersion);
		assert.deepEqual(a4.readScopes, a5.readScopes);
		assert.deepEqual(a4.writeScopes, a5.writeScopes);
		assert.deepEqual(a4.tools, a5.tools);
	});
});

describe("separazione delle capacità", () => {
	test("solo il Responsabile dell'attivazione ha strumenti di attivazione", () => {
		for (const a of AGENTS) {
			const hasActivation = a.tools.some((t) => ACTIVATION_TOOLS.includes(t));
			assert.equal(
				hasActivation,
				a.id === "attivazione",
				`${a.id}: strumenti di attivazione inattesi`,
			);
		}
	});

	test("il Documentalista legge contenuto non fidato e non ha potere di scrittura", () => {
		const doc = getAgent("documentalista");
		assert.ok(doc);
		assert.deepEqual(doc.writeScopes, []);
		assert.deepEqual(doc.readScopes, []);
		for (const t of doc.tools) {
			assert.ok(
				!ACTIVATION_TOOLS.includes(t),
				`il Documentalista possiede "${t}"`,
			);
		}
		assert.ok(!doc.tools.includes("proponi_fatto"));
	});

	test("Sentinella, Ambasciatore e Coordinatore non scrivono fatti", () => {
		for (const id of ["sentinella", "ambasciatore", "coordinatore"]) {
			const a = getAgent(id);
			assert.ok(a, id);
			assert.deepEqual(a.writeScopes, [], `${id} ha ambiti in scrittura`);
			assert.ok(!a.tools.includes("proponi_fatto"), `${id} propone fatti`);
		}
	});

	test("la Sentinella può leggere i passaggi originali dei documenti", () => {
		const s = getAgent("sentinella");
		assert.ok(s?.tools.includes("leggi_passaggio_documento"));
	});

	test("il Responsabile dell'attivazione non legge testo grezzo di documenti", () => {
		const a = getAgent("attivazione");
		assert.ok(a);
		assert.ok(!a.tools.includes("leggi_documenti"));
		assert.ok(!a.tools.includes("estrai_testo_con_citazioni"));
		assert.ok(a.tools.includes("leggi_fatti_approvati"));
	});
});

describe("confine e-label", () => {
	// La e-label mantiene il proprio percorso separato: questo programma non
	// autorizza modifiche automatiche alla pagina normativa. Se una capacità
	// e-label comparisse fra gli strumenti di un agente, questa build fallisce.
	test("nessuno strumento di nessun agente tocca la e-label", () => {
		for (const a of AGENTS) {
			for (const tool of a.tools) {
				for (const pattern of FORBIDDEN_TOOL_PATTERNS) {
					assert.ok(
						!pattern.test(tool),
						`l'agente ${a.id} possiede lo strumento "${tool}", vietato da ${pattern}`,
					);
				}
			}
		}
	});

	test("gli schemi vietati riconoscono le varianti attese", () => {
		const varianti = [
			"modifica_elabel",
			"aggiorna_e_label",
			"scrivi_e-label",
			"pubblica_etichetta_elettronica",
			"aggiorna_pagina_normativa",
		];
		for (const v of varianti) {
			assert.ok(
				FORBIDDEN_TOOL_PATTERNS.some((p) => p.test(v)),
				`"${v}" non riconosciuto come capacità e-label`,
			);
		}
	});
});
