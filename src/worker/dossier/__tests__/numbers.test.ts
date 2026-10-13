import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
	extractNumbers,
	readings,
	tokensMatch,
	unmatchedNumbers,
} from "../numbers.ts";

const vals = (raw: string) => readings(raw).sort((a, b) => a - b);

describe("letture di un token numerico", () => {
	test("un intero ha una sola lettura", () => {
		assert.deepEqual(vals("2021"), [2021]);
		assert.deepEqual(vals("0"), [0]);
		assert.deepEqual(vals("12"), [12]);
	});

	test("un decimale con una cifra: la virgola e il punto sono equivalenti", () => {
		assert.deepEqual(vals("12,5"), [12.5]);
		assert.deepEqual(vals("12.5"), [12.5]);
	});

	test("un token ambiguo porta entrambe le letture, invece di indovinare", () => {
		// «1.200» è milleduecento in italiano, uno-punto-due altrove
		assert.deepEqual(vals("1.200"), [1.2, 1200]);
		assert.deepEqual(vals("1,200"), [1.2, 1200]);
	});

	test("due separatori diversi risolvono l'ambiguità", () => {
		assert.deepEqual(vals("1.200,50"), [1200.5]);
		assert.deepEqual(vals("1,200.50"), [1200.5]);
	});

	test("più gruppi di migliaia", () => {
		assert.deepEqual(vals("1.200.000"), [1_200_000]);
	});

	test("un gruppo non di tre cifre non è una lettura di migliaia", () => {
		assert.deepEqual(vals("12,50"), [12.5]);
		assert.deepEqual(vals("1,20"), [1.2]);
	});

	test("gli spazi come separatore delle migliaia non confondono", () => {
		assert.deepEqual(vals("1 200"), [1200]);
		assert.deepEqual(vals("1 200"), [1200]);
	});
});

describe("estrazione dal testo", () => {
	test("trova i valori di una scheda tecnica", () => {
		const t = extractNumbers(
			"Gradazione 12,5 %vol, acidità 6,1 g/l, solforosa 95 mg/l, annata 2021.",
		);
		assert.deepEqual(t.map((x) => x.raw), ["12,5", "6,1", "95", "2021"]);
	});

	test("un intervallo dà due valori", () => {
		assert.deepEqual(extractNumbers("affinamento 6-8 mesi").map((x) => x.raw), ["6", "8"]);
	});

	test("un testo senza numeri non ne produce", () => {
		assert.deepEqual(extractNumbers("Soave Classico, vinificato in acciaio."), []);
		assert.deepEqual(extractNumbers(""), []);
	});

	test("l'ordine è quello del testo", () => {
		assert.deepEqual(extractNumbers("3 poi 1 poi 2").map((x) => x.raw), ["3", "1", "2"]);
	});
});

describe("corrispondenza fra token", () => {
	const t = (raw: string) => extractNumbers(raw)[0]!;

	test("le due convenzioni decimali combaciano", () => {
		assert.equal(tokensMatch(t("12,5"), t("12.5")), true);
	});

	test("un ambiguo combacia con entrambe le sue letture", () => {
		assert.equal(tokensMatch(t("1.200"), t("1200")), true);
		assert.equal(tokensMatch(t("1.200"), t("1,2")), true);
	});

	test("valori davvero diversi non combaciano", () => {
		assert.equal(tokensMatch(t("12,5"), t("13,5")), false);
		assert.equal(tokensMatch(t("2021"), t("2022")), false);
	});
});

describe("valori non corrisposti", () => {
	const n = extractNumbers;

	test("nessuna perdita fra le due convenzioni", () => {
		const it = n("Gradazione 12,5 %vol, acidità 6,1 g/l");
		const en = n("Alcohol 12.5 %vol, acidity 6.1 g/l");
		assert.deepEqual(unmatchedNumbers(it, en), []);
		assert.deepEqual(unmatchedNumbers(en, it), []);
	});

	test("un valore perso viene trovato", () => {
		const it = n("12,5 %vol e 6,1 g/l");
		const en = n("12.5 %vol");
		assert.deepEqual(unmatchedNumbers(it, en).map((x) => x.raw), ["6,1"]);
	});

	test("un valore aggiunto viene trovato nel verso opposto", () => {
		const it = n("12,5 %vol");
		const en = n("12.5 %vol, aged 24 months");
		assert.deepEqual(unmatchedNumbers(en, it).map((x) => x.raw), ["24"]);
	});

	test("un valore alterato compare in entrambi i versi", () => {
		const it = n("12,5 %vol");
		const en = n("13.5 %vol");
		assert.deepEqual(unmatchedNumbers(it, en).map((x) => x.raw), ["12,5"]);
		assert.deepEqual(unmatchedNumbers(en, it).map((x) => x.raw), ["13.5"]);
	});

	test("il confronto tiene conto della molteplicità", () => {
		// due occorrenze nell'originale richiedono due occorrenze nella traduzione
		const due = n("6 mesi in acciaio, 6 mesi in bottiglia");
		const una = n("6 months in steel and bottle");
		assert.equal(unmatchedNumbers(due, una).length, 1, "una perdita non deve sfuggire");
		assert.deepEqual(unmatchedNumbers(una, due), []);
	});

	test("l'ambiguità non genera mai un falso allarme", () => {
		// «1.200 bottiglie» tradotto «1,200 bottles»: nessuna anomalia
		const it = n("1.200 bottiglie prodotte");
		const en = n("1,200 bottles produced");
		assert.deepEqual(unmatchedNumbers(it, en), []);
		assert.deepEqual(unmatchedNumbers(en, it), []);
	});

	test("testi vuoti non producono nulla", () => {
		assert.deepEqual(unmatchedNumbers([], n("12,5")), []);
		assert.deepEqual(unmatchedNumbers(n("12,5"), []).map((x) => x.raw), ["12,5"]);
	});
});
