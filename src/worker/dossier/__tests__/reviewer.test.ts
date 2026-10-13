import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
	claimsIn,
	LESSICO_AFFERMAZIONI,
	ontologyProtectedTerms,
	REVIEW_CODES,
	reviewAll,
	isInvariantUnit,
	reviewTranslation,
	stripProtectedTerms,
	UNITA_INVARIANTI,
	unitsIn,
} from "../reviewer.ts";
import type { ReviewContext, TranslationCandidate } from "../reviewer.ts";
import { CODES as SENTINEL_CODES } from "../sentinel.ts";
import { ONTOLOGY } from "../ontology.ts";
import type { Finding } from "../sentinel.ts";
import { PROV_DOC } from "./fixtures.ts";

const TERMS = ontologyProtectedTerms();
const CTX: ReviewContext = { factVersion: 1, evidence: [PROV_DOC] };

function cand(over: Partial<TranslationCandidate> = {}): TranslationCandidate {
	return {
		translationId: "t1",
		factId: "f1",
		scope: { type: "annata", ref: "w1:2021" },
		factKey: "scheda",
		sourceLang: "it",
		lang: "en",
		sourceText: "Soave Classico 2021. Gradazione 12,5 %vol, acidità 6,1 g/l.",
		text: "Soave Classico 2021. Alcohol 12.5 %vol, acidity 6.1 g/l.",
		sourceVersion: 1,
		register: "tecnica",
		...over,
	};
}

const codes = (f: readonly Finding[]) => f.map((x) => x.code);

describe("termini protetti", () => {
	test("l'ontologia fornisce denominazioni e vitigni", () => {
		assert.ok(TERMS.includes("Soave Classico"));
		assert.ok(TERMS.includes("Garganega"));
		assert.ok(TERMS.includes("Franciacorta"));
		assert.ok(TERMS.includes("Pinot nero"));
	});

	test("l'elenco è ordinato e senza duplicati", () => {
		assert.deepEqual([...TERMS], [...new Set(TERMS)].sort());
	});

	test("i termini escono dal testo prima della scansione", () => {
		const out = stripProtectedTerms("Soave Classico Superiore 2021", TERMS);
		assert.ok(!out.includes("soave"));
		assert.ok(out.includes("superiore"), "ciò che non è protetto resta");
	});

	test("il termine più lungo viene rimosso per primo", () => {
		// se togliesse «Soave» prima, resterebbe «classico» orfano
		const out = stripProtectedTerms("Soave Classico", TERMS);
		assert.equal(out, "");
	});
});

describe("la trappola del superlativo", () => {
	test("«Soave Superiore» non è una qualità aggiunta", () => {
		// «superiore» è una qualificazione di denominazione, non una vanteria
		assert.deepEqual(claimsIn("Soave Classico Superiore", "it", TERMS), []);
	});

	test("il lessico non contiene qualificazioni di denominazione", () => {
		const vietati = ["superiore", "classico", "riserva", "gran", "selezione"];
		for (const [lang, lexicon] of Object.entries(LESSICO_AFFERMAZIONI)) {
			for (const vietato of vietati) {
				assert.ok(
					!lexicon.includes(vietato),
					`${lang}: «${vietato}» non può stare nel lessico delle affermazioni`,
				);
			}
		}
	});

	test("il lessico non contiene descrittori sensoriali legittimi", () => {
		const descrittori = ["intenso", "ricco", "elegante", "persistente", "fine"];
		for (const [lang, lexicon] of Object.entries(LESSICO_AFFERMAZIONI)) {
			for (const d of descrittori) {
				assert.ok(!lexicon.includes(d), `${lang}: «${d}» è un descrittore, non una vanteria`);
			}
		}
	});

	test("un premio vero viene riconosciuto", () => {
		assert.ok(claimsIn("Vino premiato con medaglia d'oro", "it", TERMS).length > 0);
		assert.ok(claimsIn("Award winning wine", "en", TERMS).length > 0);
	});

	test("il confronto è per parola intera", () => {
		// «premiato» non deve scattare dentro un'altra parola
		assert.deepEqual(claimsIn("prezzo", "it", TERMS), []);
		assert.deepEqual(claimsIn("bestiame", "en", TERMS), []);
	});

	test("una lingua senza lessico non produce falsi allarmi", () => {
		assert.deepEqual(claimsIn("qualunque testo", "ja", TERMS), []);
	});
});

describe("unità di misura", () => {
	test("riconosce le unità dell'ontologia nel testo", () => {
		const units = unitsIn("12,5 %vol, 6,1 g/l, 95 mg/l");
		assert.ok(units.includes("%vol"));
		assert.ok(units.includes("g/l"));
		assert.ok(units.includes("mg/l"));
	});

	test("un testo senza unità non ne produce", () => {
		assert.deepEqual(unitsIn("Soave Classico, acciaio"), []);
	});

	test("ogni unità invariante è riconoscibile, le lessicali no", () => {
		for (const key of Object.keys(ONTOLOGY.unita)) {
			const unit = ONTOLOGY.unita[key];
			if (unit === undefined || unit.length === 0) continue;
			const found = unitsIn(`valore 1 ${unit}`).includes(unit);
			assert.equal(
				found,
				isInvariantUnit(unit),
				`${unit}: riconosciuta=${found}, invariante=${isInvariantUnit(unit)}`,
			);
		}
	});

	test("i simboli sono invarianti, le parole no", () => {
		for (const unit of ["%vol", "g/l", "mg/l", "q/ha", "°C"]) {
			assert.equal(isInvariantUnit(unit), true, unit);
		}
		for (const unit of ["mesi", "m s.l.m.", "anno"]) {
			assert.equal(isInvariantUnit(unit), false, unit);
		}
	});

	test("ogni unità invariante dichiarata esiste nell'ontologia", () => {
		const dichiarate = new Set(
			Object.keys(ONTOLOGY.unita)
				.map((k) => ONTOLOGY.unita[k])
				.filter((u): u is string => u !== undefined),
		);
		for (const unit of UNITA_INVARIANTI) {
			assert.ok(dichiarate.has(unit), `${unit} non è un'unità dell'ontologia`);
		}
	});
});

describe("una traduzione fedele", () => {
	test("non produce anomalie", () => {
		assert.deepEqual(reviewTranslation(cand(), CTX), []);
	});

	test("resta fedele anche cambiando convenzione decimale", () => {
		const out = reviewTranslation(
			cand({
				sourceText: "1.200 bottiglie, 12,5 %vol",
				text: "1,200 bottles, 12.5 %vol",
			}),
			CTX,
		);
		assert.deepEqual(out, [], "l'ambiguità decimale non deve generare allarmi");
	});

	test("un originale e una traduzione vuoti non sono un errore", () => {
		assert.deepEqual(
			reviewTranslation(cand({ sourceText: "   ", text: "" }), CTX),
			[],
		);
	});
});

describe("fedeltà numerica", () => {
	test("un valore perso è bloccante, insieme alla sua unità", () => {
		// omettere «6,1 g/l» perde il numero **e** l'unità: sono due anomalie
		// complementari, non un doppio referto. Una traduzione può perdere
		// l'unità conservando il numero («12.5» invece di «12.5 %vol»), e quel
		// caso solo il controllo sulle unità lo vede
		const out = reviewTranslation(
			cand({ text: "Soave Classico 2021. Alcohol 12.5 %vol." }),
			CTX,
		);
		assert.deepEqual(codes(out), ["NUMERO_PERDUTO", "UNITA_PERDUTA"]);
		const numero = out.find((x) => x.code === "NUMERO_PERDUTO")!;
		assert.equal(numero.severity, "bloccante");
		assert.match(numero.detail, /6,1/);
	});

	test("un valore aggiunto è bloccante", () => {
		const out = reviewTranslation(
			cand({
				text: "Soave Classico 2021. Alcohol 12.5 %vol, acidity 6.1 g/l, aged 24 months.",
			}),
			CTX,
		);
		assert.deepEqual(codes(out), ["NUMERO_AGGIUNTO"]);
		assert.match(out[0]!.detail, /24/);
	});

	test("un valore alterato è segnalato nei due versi", () => {
		const out = reviewTranslation(
			cand({ text: "Soave Classico 2021. Alcohol 13.5 %vol, acidity 6.1 g/l." }),
			CTX,
		);
		assert.deepEqual(codes(out), ["NUMERO_AGGIUNTO", "NUMERO_PERDUTO"]);
	});

	test("una perdita di molteplicità non sfugge", () => {
		const out = reviewTranslation(
			cand({
				sourceText: "6 mesi in acciaio, 6 mesi in bottiglia",
				text: "6 months in steel and bottle",
			}),
			CTX,
		);
		assert.deepEqual(codes(out), ["NUMERO_PERDUTO"]);
	});

	test("un'unità lessicale tradotta non è una perdita", () => {
		// «mesi» → «months» è una traduzione corretta: pretenderla invariata
		// segnalerebbe come errore il lavoro fatto bene
		const out = reviewTranslation(
			cand({
				sourceText: "affinamento 24 mesi, altitudine 300 m s.l.m.",
				text: "aged 24 months, altitude 300 m a.s.l.",
			}),
			CTX,
		);
		assert.deepEqual(out, []);
	});
});

describe("unità e termini protetti", () => {
	test("in una traduzione tecnica un'unità persa è bloccante", () => {
		const out = reviewTranslation(
			cand({
				sourceText: "Gradazione 12,5 %vol",
				text: "Alcohol 12.5",
				register: "tecnica",
			}),
			CTX,
		);
		assert.deepEqual(codes(out), ["UNITA_PERDUTA"]);
		assert.equal(out[0]!.severity, "bloccante");
		assert.match(out[0]!.detail, /non si convertono/);
	});

	test("in un adattamento promozionale è soltanto da confermare", () => {
		const out = reviewTranslation(
			cand({
				sourceText: "Gradazione 12,5 %vol",
				text: "Alcohol 12.5",
				register: "promozionale",
			}),
			CTX,
		);
		assert.equal(out[0]!.severity, "da_confermare");
	});

	test("una denominazione tradotta è bloccante", () => {
		const out = reviewTranslation(
			cand({
				sourceText: "Soave Classico 2021, Garganega",
				text: "Classic Soave 2021, Garganega",
			}),
			CTX,
		);
		assert.deepEqual(codes(out), ["TERMINE_PROTETTO_ALTERATO"]);
		assert.match(out[0]!.detail, /Soave Classico/);
	});

	test("un vitigno tradotto è bloccante", () => {
		const out = reviewTranslation(
			cand({
				sourceText: "Franciacorta da Pinot nero",
				text: "Franciacorta from Black Pinot",
			}),
			CTX,
		);
		assert.deepEqual(codes(out), ["TERMINE_PROTETTO_ALTERATO"]);
		assert.match(out[0]!.detail, /Pinot nero/);
	});

	test("un termine assente anche dall'originale non è un errore", () => {
		// non si pretende che la traduzione aggiunga ciò che l'originale non ha
		const out = reviewTranslation(
			cand({ sourceText: "Vino bianco fermo", text: "Still white wine" }),
			CTX,
		);
		assert.deepEqual(out, []);
	});

	test("la grafia della denominazione può variare: conta il contenuto", () => {
		const out = reviewTranslation(
			cand({ sourceText: "SOAVE CLASSICO", text: "Soave Classico" }),
			CTX,
		);
		assert.deepEqual(out, []);
	});
});

describe("affermazioni aggiunte", () => {
	test("un premio inventato è da confermare, non bloccante", () => {
		const out = reviewTranslation(
			cand({
				sourceText: "Soave Classico, vinificato in acciaio.",
				text: "Soave Classico, award winning, made in steel.",
			}),
			CTX,
		);
		assert.deepEqual(codes(out), ["AFFERMAZIONE_AGGIUNTA"]);
		// euristica lessicale: una conferma, non un blocco
		assert.equal(out[0]!.severity, "da_confermare");
		assert.match(out[0]!.detail, /award winning/);
	});

	test("un premio presente nell'originale non è un'aggiunta", () => {
		const out = reviewTranslation(
			cand({
				sourceText: "Soave Classico, vino premiato.",
				text: "Soave Classico, award winning wine.",
			}),
			CTX,
		);
		assert.deepEqual(out, []);
	});

	test("il caso che il programma vieta: qualità assenti dall'originale", () => {
		const out = reviewTranslation(
			cand({
				sourceText: "Garganega in purezza, affinamento in acciaio.",
				text: "Pure Garganega, steel aged, the finest expression, gold medal winner.",
			}),
			CTX,
		);
		assert.ok(codes(out).includes("AFFERMAZIONE_AGGIUNTA"));
		assert.match(out[0]!.detail, /finest|gold medal|winner/);
	});

	test("ogni lingua del lessico riconosce le proprie affermazioni", () => {
		const casi: [string, string][] = [
			["it", "vino premiato"],
			["en", "award winning wine"],
			["de", "beste Qualitat"],
			["fr", "meilleur vin"],
		];
		for (const [lang, text] of casi) {
			const out = reviewTranslation(
				cand({ sourceText: "Vino bianco", lang, text }),
				CTX,
			);
			assert.ok(
				codes(out).includes("AFFERMAZIONE_AGGIUNTA"),
				`${lang}: «${text}» non riconosciuta`,
			);
		}
	});
});

describe("legame con la versione sorgente", () => {
	test("una traduzione legata a una versione superata è bloccante", () => {
		const out = reviewTranslation(cand({ sourceVersion: 1 }), { factVersion: 2 });
		assert.ok(codes(out).includes("TRADUZIONE_DA_RIESAMINARE"));
		assert.equal(out[0]!.severity, "bloccante");
		assert.match(out[0]!.detail, /versione 1.*alla 2/);
	});

	test("alla versione corrente non è segnalata", () => {
		const out = reviewTranslation(cand({ sourceVersion: 2 }), { factVersion: 2 });
		assert.deepEqual(out, []);
	});
});

describe("traduzione vuota", () => {
	test("una traduzione vuota di un originale pieno è bloccante", () => {
		const out = reviewTranslation(cand({ text: "   " }), CTX);
		assert.deepEqual(codes(out), ["TRADUZIONE_VUOTA"]);
		assert.equal(out[0]!.severity, "bloccante");
	});

	test("non si accumulano altre anomalie su un testo vuoto", () => {
		// un testo vuoto perderebbe tutti i numeri, tutte le unità, tutti i
		// termini: un elenco di anomalie che dice la stessa cosa dieci volte
		const out = reviewTranslation(cand({ text: "" }), { factVersion: 2 });
		assert.deepEqual(codes(out), ["TRADUZIONE_DA_RIESAMINARE", "TRADUZIONE_VUOTA"]);
	});
});

describe("destinazione sospesa", () => {
	test("una traduzione guasta sospende i materiali, non la referenza", () => {
		const out = reviewTranslation(cand({ text: "Alcohol 13.5 %vol" }), CTX);
		assert.ok(out.length > 0);
		for (const f of out) {
			assert.deepEqual(f.targets, [{ target: "materiali_commerciali" }]);
		}
	});

	test("l'anomalia porta ambito, chiave ed evidenze del fatto di partenza", () => {
		const out = reviewTranslation(cand({ text: "Alcohol 13.5 %vol" }), CTX);
		assert.deepEqual(out[0]!.scope, { type: "annata", ref: "w1:2021" });
		assert.equal(out[0]!.factKey, "scheda");
		assert.deepEqual(out[0]!.evidence, [PROV_DOC]);
	});
});

describe("registro e codici", () => {
	test("i codici dichiarati sono distinti", () => {
		assert.equal(new Set(REVIEW_CODES).size, REVIEW_CODES.length);
	});

	test("l'unico codice condiviso con la Sentinella è quello voluto", () => {
		const condivisi = REVIEW_CODES.filter((c) =>
			(SENTINEL_CODES as readonly string[]).includes(c),
		);
		assert.deepEqual(condivisi, ["TRADUZIONE_DA_RIESAMINARE"]);
	});

	test("ogni codice emesso è dichiarato", () => {
		const casi: TranslationCandidate[] = [
			cand({ sourceVersion: 1, text: "Soave Classico 2021. Alcohol 12.5 %vol, acidity 6.1 g/l." }),
			cand({ text: "" }),
			cand({ text: "Soave Classico 2021. Alcohol 12.5 %vol, acidity 6.1 g/l, 24 months." }),
			cand({ text: "Soave Classico 2021. Alcohol 12.5 %vol." }),
			cand({ sourceText: "12,5 %vol", text: "12.5" }),
			cand({ sourceText: "Soave Classico", text: "Classic Soave" }),
			cand({ sourceText: "Vino bianco", text: "Award winning wine" }),
		];
		const emessi = new Set(
			casi.flatMap((c) => reviewTranslation(c, { factVersion: 2 })).map((f) => f.code),
		);
		for (const code of emessi) {
			assert.ok((REVIEW_CODES as readonly string[]).includes(code), `${code} non dichiarato`);
		}
		for (const code of REVIEW_CODES) {
			assert.ok(emessi.has(code), `nessun caso di prova per ${code}`);
		}
	});
});

describe("determinismo", () => {
	const candidates: TranslationCandidate[] = [
		cand({ translationId: "t1", lang: "en", text: "Alcohol 13.5 %vol" }),
		cand({ translationId: "t2", lang: "de", text: "Alkohol 12,5 %vol, beste" }),
		cand({ translationId: "t3", lang: "fr", text: "" }),
	];

	test("lo stesso candidato dà lo stesso elenco", () => {
		assert.deepEqual(reviewTranslation(candidates[0]!, CTX), reviewTranslation(candidates[0]!, CTX));
	});

	test("l'ordine dei candidati non cambia l'esito complessivo", () => {
		const ctx = () => CTX;
		assert.deepEqual(reviewAll(candidates, ctx), reviewAll([...candidates].reverse(), ctx));
	});

	test("l'elenco di un candidato è ordinato per codice", () => {
		const out = reviewTranslation(
			cand({ sourceText: "Soave Classico 12,5 %vol", text: "Classic Soave 13.5" }),
			{ factVersion: 2 },
		);
		assert.deepEqual(codes(out), [...codes(out)].sort());
		assert.ok(out.length >= 4, "il caso deve far scattare più controlli insieme");
	});
});

describe("proprietà su qualunque ingresso", () => {
	function makeRandom(seed: number) {
		let state = seed;
		return () => {
			state = (state * 1103515245 + 12345) & 0x7fffffff;
			return state / 0x7fffffff;
		};
	}

	const TESTI = [
		"",
		"   ",
		"Soave Classico 2021. Gradazione 12,5 %vol.",
		"Alcohol 12.5 %vol, acidity 6.1 g/l",
		"1.200 bottiglie, 24 mesi, 300 m s.l.m.",
		"1,200 bottles, 24 months, 300 m a.s.l.",
		"Award winning, gold medal, the finest",
		"🍷 — vino premiato",
		"a".repeat(3_000),
		"12,5 12.5 1.200 1,200 2021 0 -1 1e10",
		"%vol g/l mg/l q/ha °C mesi",
		"\u0000    ",
		"Garganega, Pinot nero, Chardonnay, Erbamat",
		"Classic Soave from Black Pinot",
	];
	const LINGUE = ["it", "en", "de", "fr", "ja", "", "IT-it"];
	const REGISTRI = ["tecnica", "promozionale"] as const;

	test("nessun ingresso fa sollevare un'eccezione, e ogni anomalia è ben formata", () => {
		const rnd = makeRandom(0xc0ffee);
		const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
		let prodotte = 0;

		for (let i = 0; i < 1_200; i++) {
			const c = cand({
				sourceText: pick(TESTI),
				text: pick(TESTI),
				sourceLang: pick(LINGUE),
				lang: pick(LINGUE),
				register: pick(REGISTRI),
				sourceVersion: Math.floor(rnd() * 4),
			});
			const ctx: ReviewContext = { factVersion: Math.floor(rnd() * 4), evidence: [PROV_DOC] };

			let out: Finding[] = [];
			assert.doesNotThrow(() => {
				out = reviewTranslation(c, ctx);
			}, `iterazione ${i}`);

			for (const f of out) {
				prodotte += 1;
				assert.ok(
					(REVIEW_CODES as readonly string[]).includes(f.code),
					`codice non dichiarato: ${f.code}`,
				);
				assert.ok(f.detail.length > 0, `motivo vuoto per ${f.code}`);
				assert.ok(!f.detail.includes("undefined"), `«undefined» nel motivo di ${f.code}`);
				assert.deepEqual(f.targets, [{ target: "materiali_commerciali" }]);
			}
		}
		assert.ok(prodotte > 400, `troppe poche anomalie (${prodotte}): il generatore non morde`);
	});

	test("l'esito è deterministico su qualunque ingresso", () => {
		const rnd = makeRandom(0xdecaf);
		const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

		for (let i = 0; i < 600; i++) {
			const c = cand({
				sourceText: pick(TESTI),
				text: pick(TESTI),
				sourceLang: pick(LINGUE),
				lang: pick(LINGUE),
				register: pick(REGISTRI),
			});
			assert.deepEqual(
				reviewTranslation(c, CTX),
				reviewTranslation(c, CTX),
				`iterazione ${i}`,
			);
		}
	});

	test("un testo identico all'originale non produce mai anomalie di contenuto", () => {
		// la stessa lingua e lo stesso testo: qualunque segnalazione sarebbe falsa
		for (const testo of TESTI) {
			const out = reviewTranslation(
				cand({ sourceText: testo, text: testo, sourceLang: "it", lang: "it" }),
				CTX,
			);
			assert.deepEqual(out, [], `testo «${testo.slice(0, 40)}» segnalato contro sé stesso`);
		}
	});
});
