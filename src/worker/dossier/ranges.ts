/**
 * Intervalli di plausibilità enologica.
 *
 * Due bande per chiave, e la distinzione fra le due è il punto di questo file:
 *
 *  - **`hard`**: fuori da qui il valore non descrive un vino. Un errore di
 *    trascrizione, un'unità sbagliata, una cifra saltata. Esito bloccante.
 *  - **`typical`**: dentro `hard` ma fuori da qui il valore è insolito, non
 *    impossibile. Esito «da confermare»: esistono vini così, e dichiararli
 *    sbagliati sarebbe un errore peggiore del non controllarli.
 *
 * **Questi sono intervalli di plausibilità, non limiti di legge.** La Sentinella
 * segnala; non giudica la conformità normativa. Dove un limite di legge esiste
 * (la solforosa) è trattato come soglia di conferma con una nota sulle deroghe,
 * perché il limite dipende dalla categoria del vino e da deroghe specifiche: un
 * limite sbagliato cablato come bloccante sarebbe peggio di nessun controllo.
 */

export interface Range {
	readonly min: number;
	readonly max: number;
}

export interface PlausibilityRule {
	readonly unit: string;
	/** Fuori: il valore non descrive un vino. */
	readonly hard: Range;
	/** Fuori ma dentro `hard`: insolito, da confermare. */
	readonly typical: Range;
	/** Perché questi estremi. Compare nel messaggio dell'anomalia. */
	readonly rationale: string;
}

export const PLAUSIBILITY: Readonly<Record<string, PlausibilityRule | undefined>> = {
	gradazione_alcolica: {
		unit: "%vol",
		// nessun vino supera i 25 %vol; i liquorosi arrivano a 22
		hard: { min: 0, max: 25 },
		// i fermi stanno sopra 4,5 e sotto 17; i liquorosi fino a 22
		typical: { min: 4.5, max: 22 },
		rationale: "un vino sta fra 4,5 e 22 %vol; oltre 25 non è un vino",
	},

	acidita_totale: {
		unit: "g/l",
		hard: { min: 0, max: 20 },
		// espressa in acido tartarico: i bianchi freschi arrivano a 9-10
		typical: { min: 3.5, max: 12 },
		rationale: "acidità totale in acido tartarico, fra 3,5 e 12 g/l",
	},

	zuccheri_residui: {
		unit: "g/l",
		// i passiti e le vendemmie tardive raggiungono valori molto alti
		hard: { min: 0, max: 600 },
		typical: { min: 0, max: 400 },
		rationale: "fino a 400 g/l nei passiti; oltre 600 non è un vino",
	},

	solforosa_totale: {
		unit: "mg/l",
		hard: { min: 0, max: 500 },
		// 200 mg/l è il limite di base per bianchi e rosati; le deroghe per i
		// vini dolci e per alcune categorie salgono oltre
		typical: { min: 0, max: 200 },
		rationale:
			"oltre 200 mg/l serve una deroga di categoria: va confermato, non dichiarato errato",
	},

	resa_per_ettaro: {
		unit: "q/ha",
		hard: { min: 0, max: 300 },
		// i disciplinari delle denominazioni stanno fra 70 e 130 q/ha
		typical: { min: 20, max: 150 },
		rationale: "i disciplinari stanno fra 70 e 130 q/ha; oltre 300 è implausibile",
	},

	altitudine: {
		unit: "m s.l.m.",
		// i vigneti più alti del mondo sfiorano i 3000 m
		hard: { min: -10, max: 3_000 },
		typical: { min: 0, max: 900 },
		rationale: "in Europa i vigneti stanno sotto i 900 m; il massimo mondiale è ~3000 m",
	},

	temperatura_servizio: {
		unit: "°C",
		hard: { min: -5, max: 30 },
		typical: { min: 4, max: 20 },
		rationale: "temperatura di servizio fra 4 e 20 °C",
	},

	permanenza_lieviti: {
		unit: "mesi",
		// alcuni metodo classico restano sui lieviti oltre dieci anni
		hard: { min: 0, max: 240 },
		typical: { min: 0, max: 120 },
		rationale: "permanenza sui lieviti fino a dieci anni nei metodo classico",
	},

	affinamento: {
		unit: "mesi",
		hard: { min: 0, max: 600 },
		typical: { min: 0, max: 120 },
		rationale: "affinamento fino a dieci anni; oltre cinquanta è implausibile",
	},
};

/** Il primo anno di vendemmia ammesso. Prima di questo si tratta di un errore. */
export const PRIMA_ANNATA = 1800;

export type Plausibility = "ammissibile" | "insolito" | "impossibile";

export function classify(key: string, value: number): Plausibility | "ignota" {
	const rule = PLAUSIBILITY[key];
	if (rule === undefined) return "ignota";

	// NaN e Infinity superano ogni confronto: senza questa guardia un valore non
	// numerico passerebbe come ammissibile, che è il modo peggiore di sbagliare
	if (!Number.isFinite(value)) return "impossibile";

	if (value < rule.hard.min || value > rule.hard.max) return "impossibile";
	if (value < rule.typical.min || value > rule.typical.max) return "insolito";
	return "ammissibile";
}
