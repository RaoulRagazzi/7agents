import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { assignReference } from "../assignment.ts";
import type { WineColour, WineStyle } from "../assignment.ts";

const COLOURS: readonly WineColour[] = ["bianco", "rosso", "rosato", "sconosciuto"];
const STYLES: readonly WineStyle[] = [
	"fermo",
	"spumante",
	"passito",
	"fortificato",
	"sconosciuto",
];

const A4 = "specialista_bianchi_spumanti_passiti";
const A5 = "specialista_altre_referenze";

describe("assegnazione delle referenze", () => {
	test("tutti gli spumanti vanno all'agente 4, qualunque sia il colore", () => {
		for (const colour of COLOURS) {
			assert.equal(assignReference({ colour, style: "spumante" }), A4, colour);
		}
	});

	test("tutti i passiti vanno all'agente 4, qualunque sia il colore", () => {
		for (const colour of COLOURS) {
			assert.equal(assignReference({ colour, style: "passito" }), A4, colour);
		}
	});

	test("i bianchi fermi vanno all'agente 4", () => {
		assert.equal(assignReference({ colour: "bianco", style: "fermo" }), A4);
	});

	test("rossi e rosati fermi vanno all'agente 5", () => {
		assert.equal(assignReference({ colour: "rosso", style: "fermo" }), A5);
		assert.equal(assignReference({ colour: "rosato", style: "fermo" }), A5);
	});

	test("i fortificati non spumanti né passiti vanno all'agente 5", () => {
		assert.equal(assignReference({ colour: "rosso", style: "fortificato" }), A5);
		assert.equal(assignReference({ colour: "bianco", style: "fortificato" }), A5);
	});

	test("la tipologia dubbia va al Coordinatore, non indovinata", () => {
		for (const colour of COLOURS) {
			assert.equal(assignReference({ colour, style: "sconosciuto" }), "coordinatore");
		}
		assert.equal(
			assignReference({ colour: "sconosciuto", style: "fermo" }),
			"coordinatore",
		);
	});

	test("la funzione è totale: ogni combinazione ha un unico responsabile", () => {
		const ammessi = new Set([A4, A5, "coordinatore"]);
		for (const colour of COLOURS) {
			for (const style of STYLES) {
				const out = assignReference({ colour, style });
				assert.ok(ammessi.has(out), `${colour}/${style} → ${out}`);
			}
		}
	});

	test("è deterministica", () => {
		for (const colour of COLOURS) {
			for (const style of STYLES) {
				assert.equal(
					assignReference({ colour, style }),
					assignReference({ colour, style }),
				);
			}
		}
	});
});
