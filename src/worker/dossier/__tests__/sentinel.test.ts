import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
	blocksTarget,
	checkApprovatoSenzaAppoggio,
	checkCoerenzaTemporale,
	checkControlliSpecifici,
	checkDenominazioneEVitigni,
	checkInsiemiChiusi,
	checkOmonimie,
	checkPlausibilita,
	checkRiferimenti,
	checkTraduzioni,
	checkUnita,
	checkVisibilita,
	checkVocabolari,
	CHECKS,
	CODES,
	findDenominazione,
	normaliseDenominazione,
	parseLotRef,
	parseVintageRef,
	runDeterministicChecks,
	targetsFor,
	wineRefOf,
} from "../sentinel.ts";
import type { Finding, SentinelContext } from "../sentinel.ts";
import { ONTOLOGY } from "../ontology.ts";
import { classify, PLAUSIBILITY, PRIMA_ANNATA } from "../ranges.ts";
import { targetMatches } from "../types.ts";
import type { Fact, FactValue, ScopeType } from "../types.ts";
import { fact, PROV_DOC, PROV_INFERENZA } from "./fixtures.ts";

const CTX: SentinelContext = { currentYear: 2026 };

const num = (value: number, unit: string): FactValue => ({ kind: "numero", value, unit });
const txt = (text: string): FactValue => ({ kind: "testo", text });
const list = (...items: string[]): FactValue => ({ kind: "elenco", items });

function f(
	scopeType: ScopeType,
	ref: string,
	key: string,
	value: FactValue,
	over: Partial<Fact> = {},
): Fact {
	return fact(scopeType, ref, key, { value, ...over });
}

const codes = (findings: readonly Finding[]) => findings.map((x) => x.code);

/** Le regole presenti, senza fidarsi dell'indice. */
function rules(): [string, NonNullable<(typeof PLAUSIBILITY)[string]>][] {
	return Object.entries(PLAUSIBILITY).flatMap(([key, rule]) =>
		rule === undefined ? [] : [[key, rule] as [string, NonNullable<typeof rule>]],
	);
}

// ─── Coerenza fra le tabelle ────────────────────────────────────────────────

describe("coerenza fra ontologia e intervalli", () => {
	test("ogni chiave con un intervallo ha la stessa unità nell'ontologia", () => {
		for (const [key, rule] of rules()) {
			assert.equal(
				ONTOLOGY.unita[key],
				rule.unit,
				`${key}: l'unità dell'intervallo (${rule.unit}) non combacia con l'ontologia (${ONTOLOGY.unita[key]})`,
			);
		}
	});

	test("ogni chiave con un'unità nell'ontologia ha un intervallo", () => {
		for (const key of Object.keys(ONTOLOGY.unita)) {
			assert.ok(
				PLAUSIBILITY[key] !== undefined,
				`${key} ha un'unità ma nessun intervallo di plausibilità`,
			);
		}
	});

	test("l'intervallo abituale sta dentro quello assoluto", () => {
		for (const [key, rule] of rules()) {
			assert.ok(rule.hard.min <= rule.typical.min, `${key}: min`);
			assert.ok(rule.typical.max <= rule.hard.max, `${key}: max`);
			assert.ok(rule.typical.min <= rule.typical.max, `${key}: abituale invertito`);
			assert.ok(rule.rationale.length > 10, `${key}: manca la motivazione`);
		}
	});
});

describe("estremi degli intervalli", () => {
	// l'off-by-one sui bordi è il modo tipico in cui un controllo esatto sbaglia
	for (const [key, rule] of rules()) {
		test(`${key}: i bordi appartengono all'intervallo`, () => {
			assert.equal(classify(key, rule.typical.min), "ammissibile", "typical.min escluso");
			assert.equal(classify(key, rule.typical.max), "ammissibile", "typical.max escluso");
			assert.notEqual(classify(key, rule.hard.min), "impossibile", "hard.min escluso");
			assert.notEqual(classify(key, rule.hard.max), "impossibile", "hard.max escluso");
		});

		test(`${key}: appena fuori è insolito, appena oltre è impossibile`, () => {
			const eps = 0.001;
			if (rule.typical.max < rule.hard.max) {
				assert.equal(classify(key, rule.typical.max + eps), "insolito");
			}
			if (rule.typical.min > rule.hard.min) {
				assert.equal(classify(key, rule.typical.min - eps), "insolito");
			}
			assert.equal(classify(key, rule.hard.max + eps), "impossibile");
			assert.equal(classify(key, rule.hard.min - eps), "impossibile");
		});
	}

	test("una chiave senza intervallo è «ignota», non ammissibile per difetto", () => {
		assert.equal(classify("chiave_senza_intervallo", 9_999), "ignota");
	});
});

// ─── Riferimenti d'ambito ───────────────────────────────────────────────────

describe("forma dei riferimenti", () => {
	test("un'annata è esattamente {vino}:{anno a quattro cifre}", () => {
		assert.deepEqual(parseVintageRef("w1:2021"), { wineRef: "w1", year: 2021 });
		assert.deepEqual(parseVintageRef("soave_classico:1999"), {
			wineRef: "soave_classico",
			year: 1999,
		});
	});

	test("forme non valide sono rifiutate", () => {
		for (const bad of [
			"w1",
			"w1:21",
			"w1:20211",
			"w1:2021:l1",
			":2021",
			"w1:",
			"w1:abcd",
			"w1:2021 ",
			"",
		]) {
			assert.equal(parseVintageRef(bad), null, `«${bad}» accettata`);
		}
	});

	test("un lotto è {vino}:{anno}:{lotto}", () => {
		assert.deepEqual(parseLotRef("w1:2021:l7"), { wineRef: "w1", year: 2021, lot: "l7" });
		for (const bad of ["w1:2021", "w1:2021:", "w1::l7", "w1:2021:l7:extra"]) {
			assert.equal(parseLotRef(bad), null, `«${bad}» accettata`);
		}
	});

	test("la referenza di appartenenza si ricava da ogni ambito di prodotto", () => {
		assert.equal(wineRefOf({ type: "vino", ref: "w1" }), "w1");
		assert.equal(wineRefOf({ type: "annata", ref: "w1:2021" }), "w1");
		assert.equal(wineRefOf({ type: "lotto", ref: "w1:2021:l7" }), "w1");
		assert.equal(wineRefOf({ type: "cantina", ref: "c1" }), null);
		assert.equal(wineRefOf({ type: "annata", ref: "malformato" }), null);
	});

	test("le destinazioni sono sempre qualificate per le referenze", () => {
		assert.deepEqual(targetsFor({ type: "annata", ref: "w1:2021" }), [
			{ target: "referenza", ref: "w1" },
		]);
		assert.deepEqual(targetsFor({ type: "cantina", ref: "c1" }), [{ target: "profilo" }]);
	});
});

describe("denominazioni", () => {
	test("il tipo non è parte del nome", () => {
		assert.equal(normaliseDenominazione("Soave Classico DOC"), "soave classico");
		assert.equal(normaliseDenominazione("Soave Classico D.O.C."), "soave classico");
		assert.equal(normaliseDenominazione("soave classico"), "soave classico");
		assert.equal(normaliseDenominazione("Franciacorta DOCG"), "franciacorta");
	});

	test("si riconosce la denominazione comunque la scriva la cantina", () => {
		for (const scritta of [
			"Soave Classico",
			"soave classico doc",
			"SOAVE CLASSICO D.O.C.",
			"  Soave   Classico  DOC ",
		]) {
			assert.ok(findDenominazione(scritta, ONTOLOGY), `«${scritta}» non riconosciuta`);
		}
	});

	test("una denominazione diversa non viene confusa", () => {
		assert.equal(findDenominazione("Soave Superiore", ONTOLOGY), undefined);
		assert.equal(findDenominazione("Soave", ONTOLOGY), undefined);
	});
});

// ─── I controlli, uno per uno ───────────────────────────────────────────────

describe("approvato senza appoggio", () => {
	test("un approvato con sola inferenza è bloccante", () => {
		const out = checkApprovatoSenzaAppoggio({
			facts: [f("vino", "w1", "denominazione", txt("Soave Classico"), {
				state: "approvato",
				provenance: [PROV_INFERENZA],
			})],
		});
		assert.deepEqual(codes(out), ["APPROVATO_SENZA_APPOGGIO"]);
		assert.equal(out[0]!.severity, "bloccante");
		assert.deepEqual(out[0]!.evidence, [PROV_INFERENZA]);
	});

	test("un approvato con appoggio documentale non è segnalato", () => {
		const out = checkApprovatoSenzaAppoggio({
			facts: [f("vino", "w1", "x", txt("y"), { state: "approvato", provenance: [PROV_DOC] })],
		});
		assert.deepEqual(out, []);
	});

	test("un proposto con sola inferenza non è segnalato: è legittimo", () => {
		const out = checkApprovatoSenzaAppoggio({
			facts: [f("vino", "w1", "x", txt("y"), { state: "proposto", provenance: [PROV_INFERENZA] })],
		});
		assert.deepEqual(out, []);
	});

	test("i superati non si controllano", () => {
		const out = checkApprovatoSenzaAppoggio({
			facts: [f("vino", "w1", "x", txt("y"), { state: "superato", provenance: [PROV_INFERENZA] })],
		});
		assert.deepEqual(out, []);
	});
});

describe("unità di misura", () => {
	test("un'unità diversa da quella dichiarata è bloccante", () => {
		const out = checkUnita(
			{ facts: [f("annata", "w1:2021", "gradazione_alcolica", num(13.5, "g/l"))] },
			CTX,
		);
		assert.deepEqual(codes(out), ["UNITA_ERRATA"]);
		assert.equal(out[0]!.severity, "bloccante");
		assert.match(out[0]!.detail, /attesa «%vol»/);
	});

	test("l'unità corretta non è segnalata", () => {
		const out = checkUnita(
			{ facts: [f("annata", "w1:2021", "gradazione_alcolica", num(13.5, "%vol"))] },
			CTX,
		);
		assert.deepEqual(out, []);
	});

	test("una chiave senza unità dichiarata non è segnalata", () => {
		const out = checkUnita({ facts: [f("vino", "w1", "bottiglie", num(5_000, "pz"))] }, CTX);
		assert.deepEqual(out, []);
	});

	test("ogni chiave dell'ontologia è controllata", () => {
		for (const [key, unit] of Object.entries(ONTOLOGY.unita)) {
			const out = checkUnita(
				{ facts: [f("annata", "w1:2021", key, num(1, `${unit}_sbagliata`))] },
				CTX,
			);
			assert.deepEqual(codes(out), ["UNITA_ERRATA"], `${key} non controllata`);
		}
	});
});

describe("plausibilità", () => {
	test("un valore impossibile è bloccante e cita la motivazione", () => {
		const out = checkPlausibilita(
			{ facts: [f("annata", "w1:2021", "gradazione_alcolica", num(135, "%vol"))] },
			CTX,
		);
		assert.deepEqual(codes(out), ["VALORE_IMPOSSIBILE"]);
		assert.equal(out[0]!.severity, "bloccante");
		assert.match(out[0]!.detail, /non è un vino/);
	});

	test("un valore insolito è da confermare, non bloccante", () => {
		const out = checkPlausibilita(
			{ facts: [f("annata", "w1:2021", "gradazione_alcolica", num(23, "%vol"))] },
			CTX,
		);
		assert.deepEqual(codes(out), ["VALORE_INSOLITO"]);
		assert.equal(out[0]!.severity, "da_confermare");
	});

	test("la solforosa oltre il limite di base è da confermare, con la nota sulla deroga", () => {
		const out = checkPlausibilita(
			{ facts: [f("annata", "w1:2021", "solforosa_totale", num(250, "mg/l"))] },
			CTX,
		);
		assert.deepEqual(codes(out), ["VALORE_INSOLITO"]);
		assert.equal(out[0]!.severity, "da_confermare");
		assert.match(out[0]!.detail, /deroga di categoria/);
	});

	test("nessun doppio referto: con l'unità sbagliata il valore non si classifica", () => {
		const facts = [f("annata", "w1:2021", "gradazione_alcolica", num(135, "g/l"))];
		assert.deepEqual(codes(checkUnita({ facts }, CTX)), ["UNITA_ERRATA"]);
		assert.deepEqual(
			codes(checkPlausibilita({ facts }, CTX)),
			[],
			"una sola causa deve dare una sola anomalia",
		);
	});

	test("un dato dichiarato non disponibile non viene classificato", () => {
		const out = checkPlausibilita(
			{ facts: [f("annata", "w1:2021", "gradazione_alcolica", { kind: "non_disponibile" })] },
			CTX,
		);
		assert.deepEqual(out, []);
	});
});

describe("insiemi chiusi", () => {
	test("una tipologia fuori dall'insieme è bloccante", () => {
		const out = checkInsiemiChiusi({ facts: [f("vino", "w1", "tipologia", txt("frizzante"))] }, CTX);
		assert.deepEqual(codes(out), ["TIPOLOGIA_IGNOTA"]);
		assert.equal(out[0]!.severity, "bloccante");
	});

	test("ogni tipologia dell'ontologia è accettata, in qualunque grafia", () => {
		for (const t of ONTOLOGY.tipologie) {
			for (const scritta of [t, t.toUpperCase(), ` ${t} `]) {
				assert.deepEqual(
					checkInsiemiChiusi({ facts: [f("vino", "w1", "tipologia", txt(scritta))] }, CTX),
					[],
					`«${scritta}» rifiutata`,
				);
			}
		}
	});

	test("ogni colore dell'ontologia è accettato, e uno inventato è bloccante", () => {
		for (const c of ONTOLOGY.colori) {
			assert.deepEqual(
				checkInsiemiChiusi({ facts: [f("vino", "w1", "colore", txt(c))] }, CTX),
				[],
			);
		}
		assert.deepEqual(
			codes(checkInsiemiChiusi({ facts: [f("vino", "w1", "colore", txt("ambrato"))] }, CTX)),
			["COLORE_IGNOTO"],
		);
	});
});

describe("denominazione e vitigni", () => {
	test("una denominazione ignota è un miglioramento, non un blocco", () => {
		const out = checkDenominazioneEVitigni(
			{ facts: [f("vino", "w1", "denominazione", txt("Colli Inventati DOC"))] },
			CTX,
		);
		assert.deepEqual(codes(out), ["DENOMINAZIONE_IGNOTA"]);
		assert.equal(out[0]!.severity, "miglioramento");
		assert.match(out[0]!.detail, /non sono verificabili/);
	});

	test("un vitigno non ammesso dalla denominazione nota è da confermare", () => {
		const out = checkDenominazioneEVitigni(
			{
				facts: [
					f("vino", "w1", "denominazione", txt("Soave Classico DOC")),
					f("vino", "w1", "vitigni", list("Garganega", "Nebbiolo")),
				],
			},
			CTX,
		);
		assert.deepEqual(codes(out), ["VITIGNO_NON_AMMESSO"]);
		assert.equal(out[0]!.severity, "da_confermare");
		assert.match(out[0]!.detail, /Nebbiolo/);
		assert.equal(out[0]!.factKey, "vitigni");
		// entrambe le evidenze sono allegate
		assert.equal(out[0]!.evidence.length, 2);
	});

	test("vitigni tutti ammessi non producono nulla", () => {
		const out = checkDenominazioneEVitigni(
			{
				facts: [
					f("vino", "w1", "denominazione", txt("Franciacorta DOCG")),
					f("vino", "w1", "vitigni", list("chardonnay", "PINOT NERO")),
				],
			},
			CTX,
		);
		assert.deepEqual(out, []);
	});

	test("senza denominazione nota i vitigni NON si controllano", () => {
		// l'elenco degli ammessi non è noto: segnalare sarebbe indovinare
		const out = checkDenominazioneEVitigni(
			{
				facts: [
					f("vino", "w1", "denominazione", txt("Denominazione Inesistente")),
					f("vino", "w1", "vitigni", list("Qualunque Cosa")),
				],
			},
			CTX,
		);
		assert.deepEqual(codes(out), ["DENOMINAZIONE_IGNOTA"]);
	});

	test("i vitigni di una referenza non si confrontano con la denominazione di un'altra", () => {
		const out = checkDenominazioneEVitigni(
			{
				facts: [
					f("vino", "w1", "denominazione", txt("Soave Classico")),
					f("vino", "w2", "vitigni", list("Nebbiolo")),
				],
			},
			CTX,
		);
		assert.deepEqual(out, []);
	});
});

describe("vocabolari", () => {
	test("un metodo di spumantizzazione ignoto è da confermare", () => {
		const out = checkVocabolari(
			{ facts: [f("vino", "w1", "metodo_spumantizzazione", txt("metodo segreto"))] },
			CTX,
		);
		assert.deepEqual(codes(out), ["METODO_SPUMANTIZZAZIONE_IGNOTO"]);
		assert.equal(out[0]!.severity, "da_confermare");
	});

	test("ogni metodo dell'ontologia è accettato", () => {
		for (const m of ONTOLOGY.metodiSpumantizzazione) {
			assert.deepEqual(
				checkVocabolari({ facts: [f("vino", "w1", "metodo_spumantizzazione", txt(m))] }, CTX),
				[],
				`«${m}» rifiutato`,
			);
		}
	});

	test("un contenitore di affinamento ignoto è solo un miglioramento", () => {
		const out = checkVocabolari(
			{ facts: [f("annata", "w1:2021", "contenitore_affinamento", txt("vasca di marmo"))] },
			CTX,
		);
		assert.deepEqual(codes(out), ["AFFINAMENTO_IGNOTO"]);
		assert.equal(out[0]!.severity, "miglioramento");
	});
});

describe("controlli specifici per tipologia", () => {
	test("uno spumante senza metodo è da confermare", () => {
		const out = checkControlliSpecifici({
			facts: [f("vino", "w1", "tipologia", txt("spumante"))],
		});
		assert.deepEqual(codes(out), ["CONTROLLO_SPECIFICO_ASSENTE"]);
		assert.equal(out[0]!.severity, "da_confermare");
		assert.equal(out[0]!.factKey, "metodo_spumantizzazione");
	});

	test("il metodo sull'annata soddisfa il controllo sul vino", () => {
		const out = checkControlliSpecifici({
			facts: [
				f("vino", "w1", "tipologia", txt("spumante")),
				f("annata", "w1:2021", "metodo_spumantizzazione", txt("metodo classico")),
			],
		});
		assert.deepEqual(out, []);
	});

	test("un passito senza tecnica di appassimento è da confermare", () => {
		const out = checkControlliSpecifici({
			facts: [f("vino", "w1", "tipologia", txt("passito"))],
		});
		assert.deepEqual(codes(out), ["CONTROLLO_SPECIFICO_ASSENTE"]);
		assert.equal(out[0]!.factKey, "tecnica_appassimento");
	});

	test("un fermo non richiede nulla di specifico", () => {
		assert.deepEqual(
			checkControlliSpecifici({ facts: [f("vino", "w1", "tipologia", txt("fermo"))] }),
			[],
		);
	});

	test("il metodo di un'altra referenza non soddisfa il controllo", () => {
		const out = checkControlliSpecifici({
			facts: [
				f("vino", "w1", "tipologia", txt("spumante")),
				f("annata", "w2:2021", "metodo_spumantizzazione", txt("metodo classico")),
			],
		});
		assert.deepEqual(codes(out), ["CONTROLLO_SPECIFICO_ASSENTE"]);
	});
});

describe("riferimenti", () => {
	test("un'annata senza il suo vino è orfana e bloccante", () => {
		const out = checkRiferimenti(
			{ facts: [f("annata", "w1:2021", "gradazione_alcolica", num(13, "%vol"))] },
			CTX,
		);
		assert.deepEqual(codes(out), ["RIFERIMENTO_ORFANO"]);
		assert.equal(out[0]!.severity, "bloccante");
		assert.deepEqual(out[0]!.targets, [{ target: "referenza", ref: "w1" }]);
	});

	test("con il suo vino presente non è orfana", () => {
		const out = checkRiferimenti(
			{
				facts: [
					f("vino", "w1", "denominazione", txt("Soave Classico")),
					f("annata", "w1:2021", "gradazione_alcolica", num(13, "%vol")),
				],
			},
			CTX,
		);
		assert.deepEqual(out, []);
	});

	test("un riferimento malformato è bloccante", () => {
		const out = checkRiferimenti({ facts: [f("annata", "non_valido", "x", txt("y"))] }, CTX);
		assert.deepEqual(codes(out), ["RIFERIMENTO_MALFORMATO"]);
	});

	test("un'annata nel futuro è bloccante, l'anno corrente no", () => {
		const futura = checkRiferimenti(
			{
				facts: [
					f("vino", "w1", "denominazione", txt("Soave Classico")),
					f("annata", "w1:2027", "x", txt("y")),
				],
			},
			CTX,
		);
		assert.ok(codes(futura).includes("ANNATA_FUORI_INTERVALLO"));

		const corrente = checkRiferimenti(
			{
				facts: [
					f("vino", "w1", "denominazione", txt("Soave Classico")),
					f("annata", "w1:2026", "x", txt("y")),
				],
			},
			CTX,
		);
		assert.deepEqual(corrente, []);
	});

	test("l'anno corrente viene dal contesto, non dall'orologio di sistema", () => {
		const facts = [
			f("vino", "w1", "denominazione", txt("Soave Classico")),
			f("annata", "w1:2030", "x", txt("y")),
		];
		assert.ok(codes(checkRiferimenti({ facts }, { currentYear: 2026 })).includes("ANNATA_FUORI_INTERVALLO"));
		assert.deepEqual(checkRiferimenti({ facts }, { currentYear: 2031 }), []);
	});

	test("un'annata prima del primo anno ammesso è bloccante", () => {
		const facts = [
			f("vino", "w1", "denominazione", txt("Soave Classico")),
			f("annata", `w1:${PRIMA_ANNATA - 1}`, "x", txt("y")),
		];
		assert.ok(codes(checkRiferimenti({ facts }, CTX)).includes("ANNATA_FUORI_INTERVALLO"));
	});

	test("un lotto senza la sua annata è orfano", () => {
		const out = checkRiferimenti(
			{
				facts: [
					f("vino", "w1", "denominazione", txt("Soave Classico")),
					f("lotto", "w1:2021:l7", "data_sboccatura", { kind: "data", iso: "2024-03-01" }),
				],
			},
			CTX,
		);
		assert.deepEqual(codes(out), ["RIFERIMENTO_ORFANO"]);
	});

	test("un solo referto per ambito anche con più fatti sbagliati", () => {
		const out = checkRiferimenti(
			{
				facts: [
					f("annata", "w1:2021", "a", txt("x")),
					f("annata", "w1:2021", "b", txt("y")),
					f("annata", "w1:2021", "c", txt("z")),
				],
			},
			CTX,
		);
		assert.equal(out.length, 1, "tre fatti, una sola causa, un solo referto");
	});
});

describe("omonimie", () => {
	test("due referenze con lo stesso nome sono da confermare, entrambe", () => {
		const out = checkOmonimie({
			facts: [
				f("vino", "w1", "nome", txt("Le Rive")),
				f("vino", "w2", "nome", txt("le  rive")),
			],
		});
		assert.deepEqual(codes(out), ["NOMI_OMONIMI", "NOMI_OMONIMI"]);
		assert.deepEqual(
			out.map((x) => x.scope.ref).sort(),
			["w1", "w2"],
		);
	});

	test("nomi diversi non producono nulla", () => {
		assert.deepEqual(
			checkOmonimie({
				facts: [
					f("vino", "w1", "nome", txt("Le Rive")),
					f("vino", "w2", "nome", txt("Monte Grande")),
				],
			}),
			[],
		);
	});

	test("il caso di prova: stessa denominazione e stessa annata su due referenze", () => {
		const out = checkOmonimie({
			facts: [
				f("vino", "w1", "denominazione", txt("Soave Classico DOC")),
				f("vino", "w2", "denominazione", txt("Soave Classico")),
				f("annata", "w1:2021", "gradazione_alcolica", num(12.5, "%vol")),
				f("annata", "w2:2021", "gradazione_alcolica", num(13, "%vol")),
			],
		});
		assert.deepEqual(codes(out), ["ANNATE_OMONIME", "ANNATE_OMONIME"]);
		assert.match(out[0]!.detail, /2021/);
		assert.match(out[0]!.detail, /formato o codice interno/);
	});

	test("stessa denominazione ma annate diverse non è un'omonimia", () => {
		const out = checkOmonimie({
			facts: [
				f("vino", "w1", "denominazione", txt("Soave Classico")),
				f("vino", "w2", "denominazione", txt("Soave Classico")),
				f("annata", "w1:2021", "x", txt("a")),
				f("annata", "w2:2022", "x", txt("b")),
			],
		});
		assert.deepEqual(out, []);
	});

	test("una sola referenza con una denominazione non è omonima di sé stessa", () => {
		const out = checkOmonimie({
			facts: [
				f("vino", "w1", "denominazione", txt("Soave Classico")),
				f("annata", "w1:2021", "x", txt("a")),
				f("annata", "w1:2022", "x", txt("b")),
			],
		});
		assert.deepEqual(out, []);
	});
});

describe("coerenza temporale", () => {
	test("una sboccatura prima della vendemmia è bloccante", () => {
		const out = checkCoerenzaTemporale({
			facts: [
				f("lotto", "w1:2021:l7", "data_sboccatura", { kind: "data", iso: "2020-11-30" }),
			],
		});
		assert.deepEqual(codes(out), ["SBOCCATURA_PRIMA_VENDEMMIA"]);
		assert.equal(out[0]!.severity, "bloccante");
	});

	test("una sboccatura nello stesso anno o dopo è ammessa", () => {
		for (const iso of ["2021-01-05", "2021-12-31", "2026-04-01"]) {
			assert.deepEqual(
				checkCoerenzaTemporale({
					facts: [f("lotto", "w1:2021:l7", "data_sboccatura", { kind: "data", iso })],
				}),
				[],
				iso,
			);
		}
	});
});

describe("visibilità", () => {
	test("un dato riservato esposto è bloccante", () => {
		for (const visibility of ["pubblico", "commerciale"] as const) {
			const out = checkVisibilita({
				facts: [f("sede", "s1", "partita_iva", txt("IT00000000000"), { visibility })],
			});
			assert.deepEqual(codes(out), ["DATO_RISERVATO_ESPOSTO"], visibility);
			assert.equal(out[0]!.severity, "bloccante");
		}
	});

	test("lo stesso dato riservato o interno non è segnalato", () => {
		for (const visibility of ["riservato", "interno"] as const) {
			assert.deepEqual(
				checkVisibilita({
					facts: [f("sede", "s1", "partita_iva", txt("x"), { visibility })],
				}),
				[],
				visibility,
			);
		}
	});
});

describe("traduzioni", () => {
	test("una traduzione da riesaminare blocca i materiali commerciali", () => {
		const target = f("annata", "w1:2021", "gradazione_alcolica", num(13, "%vol"));
		const out = checkTraduzioni({
			facts: [target],
			translations: [
				{ id: "t1", factId: target.id, lang: "en", sourceVersion: 1, state: "stale" },
				{ id: "t2", factId: target.id, lang: "de", sourceVersion: 2, state: "approvata" },
			],
		});
		assert.deepEqual(codes(out), ["TRADUZIONE_DA_RIESAMINARE"]);
		assert.deepEqual(out[0]!.targets, [{ target: "materiali_commerciali" }]);
		assert.match(out[0]!.detail, /en/);
	});

	test("senza traduzioni non produce nulla", () => {
		assert.deepEqual(checkTraduzioni({ facts: [] }), []);
	});
});

// ─── Registro e determinismo ────────────────────────────────────────────────

describe("registro dei controlli", () => {
	test("i nomi dei controlli sono distinti", () => {
		const names = CHECKS.map((c) => c.name);
		assert.equal(new Set(names).size, names.length);
	});

	test("i codici dichiarati sono distinti", () => {
		assert.equal(new Set(CODES).size, CODES.length);
	});

	test("ogni codice emesso è dichiarato in CODES", () => {
		// un fascicolo costruito per far scattare tutto
		const facts: Fact[] = [
			f("vino", "w1", "denominazione", txt("Soave Classico DOC")),
			f("vino", "w1", "vitigni", list("Garganega", "Nebbiolo")),
			f("vino", "w1", "tipologia", txt("spumante")),
			f("vino", "w1", "colore", txt("ambrato")),
			f("vino", "w1", "nome", txt("Le Rive")),
			f("vino", "w2", "nome", txt("le rive")),
			f("vino", "w2", "denominazione", txt("Soave Classico")),
			f("vino", "w3", "denominazione", txt("Denominazione Inventata")),
			f("annata", "w1:2021", "gradazione_alcolica", num(135, "%vol")),
			f("annata", "w1:2022", "solforosa_totale", num(250, "mg/l")),
			f("annata", "w2:2021", "acidita_totale", num(6, "g/kg")),
			f("annata", "w1:2030", "x", txt("y")),
			f("annata", "malformata", "x", txt("y")),
			f("annata", "w9:2021", "x", txt("y")),
			f("lotto", "w1:2021:l7", "data_sboccatura", { kind: "data", iso: "2019-01-01" }),
			f("lotto", "w9:2021:l1", "x", txt("y")),
			f("sede", "s1", "partita_iva", txt("IT0"), { visibility: "pubblico" }),
			f("cantina", "c1", "storia", txt("x"), {
				state: "approvato",
				provenance: [PROV_INFERENZA],
			}),
			f("annata", "w1:2021", "contenitore_affinamento", txt("vasca di marmo")),
			f("vino", "w4", "tipologia", txt("frizzante")),
			f("vino", "w5", "metodo_spumantizzazione", txt("metodo segreto")),
		];
		const translations = [
			{ id: "t1", factId: facts[0]!.id, lang: "en", sourceVersion: 1, state: "stale" as const },
		];

		const findings = runDeterministicChecks({ facts, translations }, CTX);
		const emessi = new Set(findings.map((x) => x.code));

		for (const code of emessi) {
			assert.ok(CODES.includes(code as (typeof CODES)[number]), `${code} non dichiarato`);
		}
		// e il fascicolo di prova deve far scattare tutti i codici dichiarati
		for (const code of CODES) {
			assert.ok(emessi.has(code), `nessun caso di prova per ${code}`);
		}
	});
});

describe("determinismo", () => {
	const facts: Fact[] = [
		f("vino", "w1", "denominazione", txt("Soave Classico")),
		f("vino", "w1", "vitigni", list("Garganega", "Nebbiolo")),
		f("annata", "w1:2021", "gradazione_alcolica", num(135, "%vol")),
		f("annata", "w1:2030", "solforosa_totale", num(250, "mg/l")),
		f("sede", "s1", "partita_iva", txt("x"), { visibility: "pubblico" }),
	];

	test("lo stesso fascicolo dà lo stesso elenco", () => {
		assert.deepEqual(
			runDeterministicChecks({ facts }, CTX),
			runDeterministicChecks({ facts }, CTX),
		);
	});

	test("l'ordine dei fatti in ingresso non cambia l'elenco", () => {
		const a = runDeterministicChecks({ facts }, CTX);
		const b = runDeterministicChecks({ facts: [...facts].reverse() }, CTX);
		assert.deepEqual(
			a.map((x) => `${x.code}|${x.scope.type}:${x.scope.ref}|${x.factKey ?? ""}`),
			b.map((x) => `${x.code}|${x.scope.type}:${x.scope.ref}|${x.factKey ?? ""}`),
		);
	});

	test("l'elenco è ordinato per codice, ambito e chiave", () => {
		const out = runDeterministicChecks({ facts }, CTX);
		const keys = out.map((x) => `${x.code}|${x.scope.type}:${x.scope.ref}|${x.factKey ?? ""}`);
		assert.deepEqual(keys, [...keys].sort());
	});

	test("un fascicolo vuoto non produce anomalie", () => {
		assert.deepEqual(runDeterministicChecks({ facts: [] }, CTX), []);
	});

	test("un fascicolo corretto non produce anomalie", () => {
		const puliti: Fact[] = [
			f("vino", "w1", "denominazione", txt("Soave Classico DOC"), { state: "approvato" }),
			f("vino", "w1", "tipologia", txt("fermo"), { state: "approvato" }),
			f("vino", "w1", "colore", txt("bianco"), { state: "approvato" }),
			f("vino", "w1", "vitigni", list("Garganega", "Trebbiano di Soave"), { state: "approvato" }),
			f("annata", "w1:2021", "gradazione_alcolica", num(12.5, "%vol"), { state: "approvato" }),
			f("annata", "w1:2021", "solforosa_totale", num(120, "mg/l"), { state: "approvato" }),
			f("sede", "s1", "sede_legale", txt("Via Roma 1"), {
				state: "approvato",
				visibility: "riservato",
			}),
		];
		assert.deepEqual(runDeterministicChecks({ facts: puliti }, CTX), []);
	});
});

describe("sospensione mirata", () => {
	test("un bloccante su una referenza non sospende le altre", () => {
		const facts: Fact[] = [
			f("vino", "w1", "denominazione", txt("Soave Classico")),
			f("vino", "w2", "denominazione", txt("Franciacorta")),
			f("annata", "w1:2021", "gradazione_alcolica", num(135, "%vol")),
		];
		const findings = runDeterministicChecks({ facts }, CTX);

		assert.equal(blocksTarget(findings, { target: "referenza", ref: "w1" }), true);
		assert.equal(blocksTarget(findings, { target: "referenza", ref: "w2" }), false);
		assert.equal(blocksTarget(findings, { target: "profilo" }), false);
	});

	test("un bloccante sul profilo non sospende le referenze", () => {
		const facts = [
			f("sede", "s1", "partita_iva", txt("x"), { visibility: "pubblico" }),
			f("vino", "w1", "denominazione", txt("Soave Classico")),
		];
		const findings = runDeterministicChecks({ facts }, CTX);
		assert.equal(blocksTarget(findings, { target: "profilo" }), true);
		assert.equal(blocksTarget(findings, { target: "referenza", ref: "w1" }), false);
	});

	test("le anomalie non bloccanti non sospendono nulla", () => {
		const facts = [f("vino", "w1", "denominazione", txt("Denominazione Inventata"))];
		const findings = runDeterministicChecks({ facts }, CTX);
		assert.deepEqual(codes(findings), ["DENOMINAZIONE_IGNOTA"]);
		assert.equal(blocksTarget(findings, { target: "referenza", ref: "w1" }), false);
	});
});

describe("esattezza dei controlli: i modi di tradire", () => {
	test("un valore non numerico non passa come plausibile", () => {
		for (const value of [NaN, Infinity, -Infinity]) {
			assert.equal(
				classify("gradazione_alcolica", value),
				"impossibile",
				`${value} accettato`,
			);
			const out = checkPlausibilita(
				{ facts: [f("annata", "w1:2021", "gradazione_alcolica", num(value, "%vol"))] },
				CTX,
			);
			assert.deepEqual(codes(out), ["VALORE_IMPOSSIBILE"], `${value} non segnalato`);
		}
	});

	test("l'ordinamento non dipende dal locale dell'ambiente", () => {
		// caratteri che i collatori per locale ordinano in modo diverso
		const facts = [
			f("vino", "Ä", "denominazione", txt("Denominazione Inventata")),
			f("vino", "Z", "denominazione", txt("Altra Inventata")),
			f("vino", "a", "denominazione", txt("Terza Inventata")),
		];
		const out = runDeterministicChecks({ facts }, CTX);
		// per punti di codice: "Z" < "a" < "Ä"
		assert.deepEqual(
			out.map((x) => x.scope.ref),
			["Z", "a", "Ä"],
		);
	});

	test("una domanda senza riferimento rileva un blocco su qualunque referenza", () => {
		const facts = [
			f("vino", "w1", "denominazione", txt("Soave Classico")),
			f("annata", "w1:2021", "gradazione_alcolica", num(135, "%vol")),
		];
		const findings = runDeterministicChecks({ facts }, CTX);

		assert.equal(blocksTarget(findings, { target: "referenza", ref: "w1" }), true);
		assert.equal(
			blocksTarget(findings, { target: "referenza" }),
			true,
			"«qualche referenza è sospesa?» deve dire sì",
		);
		assert.equal(blocksTarget(findings, { target: "referenza", ref: "w2" }), false);
	});

	test("la relazione fra destinazioni è la stessa per cancelli e Sentinella", () => {
		const casi: [{ target: "referenza"; ref?: string }, { target: "referenza"; ref?: string }, boolean][] = [
			[{ target: "referenza", ref: "w1" }, { target: "referenza", ref: "w1" }, true],
			[{ target: "referenza", ref: "w1" }, { target: "referenza", ref: "w2" }, false],
			[{ target: "referenza" }, { target: "referenza", ref: "w1" }, true],
			[{ target: "referenza", ref: "w1" }, { target: "referenza" }, true],
			[{ target: "referenza" }, { target: "referenza" }, true],
		];
		for (const [a, b, expected] of casi) {
			assert.equal(targetMatches(a, b), expected, `${JSON.stringify([a, b])}`);
			assert.equal(targetMatches(b, a), expected, "la relazione deve essere simmetrica");
		}
	});

	test("ogni chiave con un'unità ha un intervallo, e viceversa: nessuna può mentire", () => {
		// se una chiave avesse un intervallo ma nessuna unità dichiarata, il
		// numero verrebbe classificato senza sapere in che unità è espresso
		const conIntervallo = new Set(rules().map(([k]) => k));
		const conUnita = new Set(Object.keys(ONTOLOGY.unita));
		assert.deepEqual([...conIntervallo].sort(), [...conUnita].sort());
	});
});
