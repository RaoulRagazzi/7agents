import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { admitFact, approveFact, PRECEDENZA } from "../admission.ts";
import type { FactDraft } from "../admission.ts";
import { getAgent } from "../agents.ts";
import type { Provenance } from "../types.ts";
import { PROV_DICH, PROV_DOC, PROV_INFERENZA, PROV_WEB } from "./fixtures.ts";

const anagrafica = getAgent("anagrafica")!;
const identita = getAgent("identita")!;
const specialista = getAgent("specialista_bianchi_spumanti_passiti")!;
const sentinella = getAgent("sentinella")!;

function draft(overrides: Partial<FactDraft> = {}): FactDraft {
	return {
		cantinaId: "c1",
		scope: { type: "cantina", ref: "c1" },
		key: "anno_fondazione",
		value: { kind: "numero", value: 1932, unit: "anno" },
		visibility: "pubblico",
		provenance: [PROV_DOC],
		state: "proposto",
		...overrides,
	};
}

describe("ammissione", () => {
	test("una proposta ben formata è ammessa", () => {
		assert.equal(admitFact(anagrafica, draft()).ok, true);
	});

	test("invariante 1: nessun dato senza provenienza", () => {
		const r = admitFact(anagrafica, draft({ provenance: [] }));
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.code, "PROVENIENZA_ASSENTE");
	});

	test("invariante 4: nessuna scrittura fuori ambito", () => {
		// l'Anagrafica non può scrivere una caratteristica di vigneto
		const r = admitFact(
			anagrafica,
			draft({ scope: { type: "vigneto", ref: "v1" }, key: "altitudine" }),
		);
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.code, "AMBITO_NON_CONCESSO");
	});

	test("lo specialista delle referenze non può scrivere in ambito territorio", () => {
		const r = admitFact(
			specialista,
			draft({ scope: { type: "territorio", ref: "Soave DOC" }, key: "clima" }),
		);
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.code, "AMBITO_NON_CONCESSO");
	});

	test("l'agente Identità può scrivere in territorio ma non in vino", () => {
		assert.equal(
			admitFact(
				identita,
				draft({ scope: { type: "territorio", ref: "Soave DOC" }, key: "clima" }),
			).ok,
			true,
		);
		const r = admitFact(
			identita,
			draft({ scope: { type: "vino", ref: "w1" }, key: "denominazione" }),
		);
		assert.equal(!r.ok && r.code, "AMBITO_NON_CONCESSO");
	});

	test("un agente senza 'proponi_fatto' è respinto a priori", () => {
		const r = admitFact(sentinella, draft());
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.code, "STRUMENTO_ASSENTE");
	});

	test("nessun agente può proporre lo stato approvato", () => {
		// uscita non tipizzata, come arriverebbe dal modello
		const hostile = { ...draft(), state: "approvato" } as unknown as FactDraft;
		const r = admitFact(anagrafica, hostile);
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.code, "STATO_NON_PROPONIBILE");
	});

	test("i dati fiscali non possono nascere pubblici", () => {
		for (const key of ["partita_iva", "codice_fiscale", "sede_legale", "iban"]) {
			const r = admitFact(anagrafica, draft({ key, visibility: "pubblico" }));
			assert.equal(r.ok, false, `${key} ammesso come pubblico`);
			assert.equal(!r.ok && r.code, "CHIAVE_RISERVATA_ESPOSTA");

			assert.equal(
				admitFact(anagrafica, draft({ key, visibility: "riservato" })).ok,
				true,
				`${key} respinto anche come riservato`,
			);
		}
	});

	test("l'agente non può presentare una degustazione come propria", () => {
		const r = admitFact(
			specialista,
			draft({
				scope: { type: "annata", ref: "w1:2021" },
				key: "nota_degustazione_agente",
			}),
		);
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.code, "CHIAVE_NON_AMMESSA");
	});

	test("la nota del produttore è invece ammessa, come dichiarazione", () => {
		const r = admitFact(
			specialista,
			draft({
				scope: { type: "annata", ref: "w1:2021" },
				key: "nota_degustazione_produttore",
				provenance: [PROV_DICH],
			}),
		);
		assert.equal(r.ok, true);
	});

	test("la fiducia fuori intervallo è respinta", () => {
		for (const confidence of [-0.1, 1.5]) {
			const r = admitFact(anagrafica, draft({ confidence }));
			assert.equal(!r.ok && r.code, "FIDUCIA_FUORI_INTERVALLO");
		}
	});
});

describe("approvazione", () => {
	const req = { approvedBy: "orchestratore", now: 100 };

	test("una provenienza documentale porta all'approvazione", () => {
		assert.equal(approveFact({ state: "proposto", provenance: [PROV_DOC] }, req).ok, true);
	});

	test("una dichiarazione del produttore porta all'approvazione", () => {
		assert.equal(approveFact({ state: "proposto", provenance: [PROV_DICH] }, req).ok, true);
	});

	test("invariante 2: l'inferenza del modello non raggiunge mai l'approvato", () => {
		const r = approveFact({ state: "proposto", provenance: [PROV_INFERENZA] }, req);
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.code, "PROVENIENZA_NON_APPROVABILE");
	});

	test("una pagina pubblica da sola non basta", () => {
		const r = approveFact({ state: "proposto", provenance: [PROV_WEB] }, req);
		assert.equal(!r.ok && r.code, "PROVENIENZA_NON_APPROVABILE");
	});

	test("inferenza più documento basta: conta la presenza di un appoggio", () => {
		const r = approveFact(
			{ state: "proposto", provenance: [PROV_INFERENZA, PROV_DOC] },
			req,
		);
		assert.equal(r.ok, true);
	});

	test("un fatto da_confermare richiede la risposta del produttore", () => {
		const senza = approveFact({ state: "da_confermare", provenance: [PROV_DOC] }, req);
		assert.equal(senza.ok, false);
		assert.equal(!senza.ok && senza.code, "CONFERMA_MANCANTE");

		const con = approveFact(
			{ state: "da_confermare", provenance: [PROV_DOC] },
			{ ...req, confirmationAnswerId: "ans_9" },
		);
		assert.equal(con.ok, true);
	});

	test("una provenienza vuota non approva", () => {
		const r = approveFact({ state: "proposto", provenance: [] }, req);
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.code, "PROVENIENZA_NON_APPROVABILE");
		assert.match(!r.ok ? r.detail : "", /nessuna/);
	});

	test("uno stato approvato o superato non si riapprova", () => {
		for (const state of ["approvato", "superato"] as const) {
			const r = approveFact({ state, provenance: [PROV_DOC] }, req);
			assert.equal(!r.ok && r.code, "STATO_NON_APPROVABILE");
		}
	});

	test("nessuna combinazione di provenienze non appoggiate approva", () => {
		const nonApprovabili: Provenance[] = [
			PROV_INFERENZA,
			PROV_WEB,
			{ kind: "derivato", fromFactIds: ["f1"], rule: "promozione_ambito" },
		];
		// tutti i sottoinsiemi non vuoti
		for (let mask = 1; mask < 1 << nonApprovabili.length; mask++) {
			const provenance = nonApprovabili.filter((_, i) => mask & (1 << i));
			const r = approveFact({ state: "proposto", provenance }, req);
			assert.equal(
				r.ok,
				false,
				`approvato con ${provenance.map((p) => p.kind).join("+")}`,
			);
		}
	});
});

describe("precedenza delle fonti", () => {
	test("il documento ufficiale precede la dichiarazione, che precede il web", () => {
		assert.ok(PRECEDENZA.documento_ufficiale < PRECEDENZA.dichiarazione);
		assert.ok(PRECEDENZA.dichiarazione < PRECEDENZA.documento);
		assert.ok(PRECEDENZA.documento < PRECEDENZA.pagina_pubblica);
		assert.ok(PRECEDENZA.pagina_pubblica < PRECEDENZA.derivato);
		assert.ok(PRECEDENZA.derivato < PRECEDENZA.inferenza_modello);
	});

	test("l'inferenza del modello è sempre l'ultima", () => {
		const values = Object.values(PRECEDENZA);
		assert.equal(PRECEDENZA.inferenza_modello, Math.max(...values));
	});
});
