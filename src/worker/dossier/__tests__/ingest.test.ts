import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
	chunkPages,
	proposeClass,
	richiedeConferma,
	SOGLIA_CONFERMA,
	valutaLeggibilita,
} from "../ingest.ts";
import type { PageText } from "../ingest.ts";
import { objectKey, sha256Hex } from "../storage.ts";

const encode = (s: string) => new TextEncoder().encode(s);

/** Un testo lungo e realistico, con paragrafi e frasi. */
function paragraphs(n: number): string {
	return Array.from(
		{ length: n },
		(_, i) =>
			`Paragrafo ${i + 1}. La gradazione dichiarata è di dodici virgola cinque per cento ` +
			`in volume. L'affinamento avviene in acciaio per sei mesi, poi in bottiglia. ` +
			`Il vigneto si trova a trecento metri di altitudine con esposizione a sud.`,
	).join("\n\n");
}

describe("impronta e chiave dell'oggetto", () => {
	test("la stessa impronta per lo stesso contenuto", async () => {
		const a = await sha256Hex(encode("contenuto"));
		const b = await sha256Hex(encode("contenuto"));
		assert.equal(a, b);
		assert.match(a, /^[0-9a-f]{64}$/);
	});

	test("impronte diverse per contenuti diversi", async () => {
		assert.notEqual(await sha256Hex(encode("a")), await sha256Hex(encode("b")));
	});

	test("l'impronta nota di una stringa nota", async () => {
		// SHA-256 di "abc", valore di riferimento
		assert.equal(
			await sha256Hex(encode("abc")),
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	test("la chiave porta la cantina e l'impronta", () => {
		const key = objectKey("c1", "deadbeef");
		assert.equal(key, "cantina/c1/originali/deadbeef");
		assert.notEqual(key, objectKey("c2", "deadbeef"));
	});
});

describe("segmentazione: invarianti", () => {
	const pages: PageText[] = [
		{ page: 1, text: paragraphs(6) },
		{ page: 2, text: paragraphs(4) },
		{ page: 3, text: "Breve." },
	];

	test("ogni offset è esatto: il testo è la fetta che dichiara", () => {
		for (const chunk of chunkPages(pages, { maxChars: 300, overlapChars: 40 })) {
			const page = pages.find((p) => p.page === chunk.page)!;
			assert.equal(
				page.text.slice(chunk.charStart, chunk.charEnd),
				chunk.text,
				`offset non esatti a pagina ${chunk.page}:${chunk.charStart}`,
			);
		}
	});

	test("nessun frammento supera il massimo", () => {
		for (const max of [120, 300, 1_200]) {
			for (const chunk of chunkPages(pages, { maxChars: max, overlapChars: 20 })) {
				assert.ok(chunk.text.length <= max, `${chunk.text.length} > ${max}`);
			}
		}
	});

	test("nessun frammento attraversa una pagina", () => {
		const chunks = chunkPages(pages, { maxChars: 200, overlapChars: 30 });
		const perPagina = new Map<number, number>();
		for (const c of chunks) {
			perPagina.set(c.page, (perPagina.get(c.page) ?? 0) + 1);
			assert.ok([1, 2, 3].includes(c.page));
		}
		assert.equal(perPagina.size, 3, "ogni pagina deve avere almeno un frammento");
	});

	test("l'intero testo di ogni pagina è coperto", () => {
		const chunks = chunkPages(pages, { maxChars: 250, overlapChars: 50 });
		for (const page of pages) {
			const covered = new Set<number>();
			for (const c of chunks.filter((x) => x.page === page.page)) {
				for (let i = c.charStart; i < c.charEnd; i++) covered.add(i);
			}
			// ogni carattere non bianco deve stare in almeno un frammento
			for (let i = 0; i < page.text.length; i++) {
				if (/\s/.test(page.text[i]!)) continue;
				assert.ok(covered.has(i), `carattere ${i} di pagina ${page.page} non coperto`);
			}
		}
	});

	test("nessun frammento comincia o finisce con spazio", () => {
		for (const chunk of chunkPages(pages, { maxChars: 180, overlapChars: 25 })) {
			assert.equal(chunk.text, chunk.text.trim(), "frammento con spazio ai bordi");
		}
	});

	test("i frammenti si sovrappongono: il contesto non si perde al taglio", () => {
		const chunks = chunkPages([{ page: 1, text: paragraphs(8) }], {
			maxChars: 300,
			overlapChars: 80,
		});
		assert.ok(chunks.length > 2);
		for (let i = 1; i < chunks.length; i++) {
			assert.ok(
				chunks[i]!.charStart < chunks[i - 1]!.charEnd,
				"frammenti consecutivi senza sovrapposizione",
			);
		}
	});

	test("è deterministica", () => {
		const a = chunkPages(pages, { maxChars: 220, overlapChars: 30 });
		const b = chunkPages(pages, { maxChars: 220, overlapChars: 30 });
		assert.deepEqual(a, b);
	});

	test("taglia ai confini naturali quando può", () => {
		const text = "Prima frase breve. Seconda frase che continua il discorso. Terza.";
		const [first] = chunkPages([{ page: 1, text }], { maxChars: 40, overlapChars: 5 });
		assert.ok(first);
		assert.ok(
			first.text.endsWith(".") || first.text.endsWith("frase"),
			`taglio non naturale: "${first.text}"`,
		);
	});

	test("una parola più lunga della finestra viene tagliata invece di bloccare", () => {
		const text = "x".repeat(500);
		const chunks = chunkPages([{ page: 1, text }], { maxChars: 100, overlapChars: 10 });
		assert.ok(chunks.length > 1);
		assert.ok(chunks.every((c) => c.text.length <= 100));
	});

	test("una pagina vuota o di soli spazi non produce frammenti", () => {
		assert.deepEqual(chunkPages([{ page: 1, text: "" }]), []);
		assert.deepEqual(chunkPages([{ page: 1, text: "   \n\n  \t " }]), []);
		assert.deepEqual(chunkPages([]), []);
	});

	test("i parametri incoerenti sono un errore, non un comportamento sorprendente", () => {
		assert.throws(() => chunkPages(pages, { maxChars: 0 }), /maxChars/);
		assert.throws(() => chunkPages(pages, { maxChars: 100, overlapChars: 100 }), /overlapChars/);
		assert.throws(() => chunkPages(pages, { maxChars: 100, overlapChars: -1 }), /overlapChars/);
	});

	test("termina su testi grandi senza girare a vuoto", () => {
		const chunks = chunkPages([{ page: 1, text: paragraphs(300) }], {
			maxChars: 500,
			overlapChars: 100,
		});
		assert.ok(chunks.length > 50);
		assert.ok(chunks.length < 5_000, "troppi frammenti: la sovrapposizione non avanza");
	});
});

describe("classificazione: è una proposta", () => {
	const casi = [
		["scheda-tecnica-soave-2021.pdf", "application/pdf", "scheda_tecnica"],
		["Fiche_technique.pdf", "application/pdf", "scheda_tecnica"],
		["listino-prezzi-2026.xlsx", "application/vnd.ms-excel", "listino"],
		["certificato-biologico.pdf", "application/pdf", "certificazione"],
		["rassegna-stampa.pdf", "application/pdf", "rassegna_stampa"],
		["visura-camerale.pdf", "application/pdf", "documento_amministrativo"],
		["vigneto-alba.jpg", "image/jpeg", "foto"],
		["documento.pdf", "application/pdf", "ignoto"],
		["documentazione-generale.pdf", "application/pdf", "ignoto"],
		["soave-classico-docg.pdf", "application/pdf", "certificazione"],
		["disciplinare-DOC.pdf", "application/pdf", "certificazione"],
	] as const;

	for (const [filename, mime, expected] of casi) {
		test(`«${filename}» → ${expected}`, () => {
			assert.equal(proposeClass(filename, mime).documentClass, expected);
		});
	}

	test("il tipo immagine vince sul nome", () => {
		assert.equal(proposeClass("scheda-tecnica.jpg", "image/jpeg").documentClass, "foto");
	});

	test("una classe ignota ha fiducia nulla e richiede conferma", () => {
		const p = proposeClass("x.pdf", "application/pdf");
		assert.equal(p.confidence, 0);
		assert.ok(richiedeConferma(p));
	});

	test("una certificazione riconosciuta resta sotto soglia: va confermata", () => {
		const p = proposeClass("certificato.pdf", "application/pdf");
		assert.ok(p.confidence < SOGLIA_CONFERMA);
		assert.ok(richiedeConferma(p), "una classe incerta non deve diventare un dato");
	});

	test("una scheda tecnica riconosciuta non richiede conferma", () => {
		assert.ok(!richiedeConferma(proposeClass("scheda-tecnica.pdf", "application/pdf")));
	});
});

describe("giudizio di leggibilità", () => {
	test("un testo normale è leggibile", () => {
		assert.equal(valutaLeggibilita([{ page: 1, text: paragraphs(1) }]).leggibile, true);
	});

	test("nessun testo estratto è illeggibile, e lo dice", () => {
		const v = valutaLeggibilita([{ page: 1, text: "" }]);
		assert.equal(v.leggibile, false);
		assert.match(v.reason ?? "", /nessun testo/);
	});

	test("poche righe non bastano a essere una fonte", () => {
		const v = valutaLeggibilita([{ page: 1, text: "Soave 2021" }]);
		assert.equal(v.leggibile, false);
		assert.match(v.reason ?? "", /troppo breve/);
	});

	test("il tipico esito di un riconoscimento fallito è illeggibile", () => {
		const sporco = "~|#@^¬ł€¶•ªº–≠«∑€®†¥øπ å∫ç∂´ƒ©˙∆˚¬…æ Ω≈ç√∫˜µ≤≥÷ ~|#@^¬ł€¶•ªº–≠«∑";
		const v = valutaLeggibilita([{ page: 1, text: sporco }]);
		assert.equal(v.leggibile, false);
		assert.match(v.reason ?? "", /non alfabetico/);
	});

	test("un testo con punteggiatura abbondante resta leggibile", () => {
		const v = valutaLeggibilita([
			{ page: 1, text: "Gradazione: 12,5 %vol. Acidità: 6,1 g/l. Zuccheri: 3,2 g/l. Solforosa: 80 mg/l." },
		]);
		assert.equal(v.leggibile, true);
	});
});
