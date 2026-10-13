/**
 * L'ontologia enologica condivisa, come dato versionato.
 *
 * Sta qui e non nei prompt per tre motivi: è la parte più grande del prefisso
 * stabile e quindi quella che la cache ripaga; gli agenti 4 e 5 devono
 * condividerla esattamente; e aggiornarla deve essere una scrittura di dati con
 * un cambio di versione, non una modifica del codice.
 *
 * In esercizio vive in KV; questo è il seme e la forma.
 *
 * Vedi docs/vinoveritas/05-piano.md — passo 2
 */

export interface Denominazione {
	readonly nome: string;
	readonly tipo: "DOCG" | "DOC" | "IGT" | "VdT";
	/** Vitigni ammessi: alimenta un controllo deterministico della Sentinella. */
	readonly vitigniAmmessi: readonly string[];
}

export interface Ontology {
	readonly version: string;
	readonly tipologie: readonly string[];
	readonly colori: readonly string[];
	readonly unita: Readonly<Record<string, string | undefined>>;
	readonly formati: readonly { readonly nome: string; readonly litri: number }[];
	readonly denominazioni: readonly Denominazione[];
	readonly terminiAffinamento: readonly string[];
	readonly metodiSpumantizzazione: readonly string[];
}

export const ONTOLOGY: Ontology = {
	version: "ontologia@2026-03-11",

	tipologie: ["fermo", "spumante", "passito", "fortificato"],
	colori: ["bianco", "rosso", "rosato"],

	unita: {
		gradazione_alcolica: "%vol",
		acidita_totale: "g/l",
		zuccheri_residui: "g/l",
		solforosa_totale: "mg/l",
		resa_per_ettaro: "q/ha",
		altitudine: "m s.l.m.",
		temperatura_servizio: "°C",
		permanenza_lieviti: "mesi",
		affinamento: "mesi",
	},

	formati: [
		{ nome: "mezza", litri: 0.375 },
		{ nome: "standard", litri: 0.75 },
		{ nome: "magnum", litri: 1.5 },
		{ nome: "jeroboam", litri: 3 },
	],

	// seme minimo: in esercizio l'elenco completo viene da KV
	denominazioni: [
		{
			nome: "Franciacorta",
			tipo: "DOCG",
			vitigniAmmessi: ["Chardonnay", "Pinot nero", "Pinot bianco", "Erbamat"],
		},
		{
			nome: "Soave Classico",
			tipo: "DOC",
			vitigniAmmessi: ["Garganega", "Trebbiano di Soave", "Chardonnay"],
		},
		{
			nome: "Recioto di Soave",
			tipo: "DOCG",
			vitigniAmmessi: ["Garganega", "Trebbiano di Soave"],
		},
		{
			nome: "Valpolicella Ripasso",
			tipo: "DOC",
			vitigniAmmessi: ["Corvina", "Corvinone", "Rondinella", "Molinara"],
		},
		{
			nome: "Amarone della Valpolicella",
			tipo: "DOCG",
			vitigniAmmessi: ["Corvina", "Corvinone", "Rondinella"],
		},
	],

	terminiAffinamento: [
		"acciaio",
		"cemento",
		"anfora",
		"barrique",
		"tonneau",
		"botte grande",
		"bottiglia",
	],

	metodiSpumantizzazione: [
		"metodo classico",
		"metodo Martinotti",
		"metodo ancestrale",
		"rifermentazione in bottiglia",
	],
};

/**
 * L'ontologia resa testo per il prefisso stabile.
 *
 * **Deve essere deterministica byte per byte.** Le chiavi degli oggetti vengono
 * ordinate esplicitamente: affidarsi all'ordine di inserimento di `Object.keys`
 * basterebbe oggi e tradirebbe alla prima rifattorizzazione, invalidando la
 * cache senza rompere nulla di visibile.
 */
export function renderOntology(ontology: Ontology = ONTOLOGY): string {
	const unita = Object.keys(ontology.unita)
		.sort()
		.map((k) => `  ${k}: ${ontology.unita[k]}`)
		.join("\n");

	const denominazioni = [...ontology.denominazioni]
		.sort((a, b) => (a.nome < b.nome ? -1 : a.nome > b.nome ? 1 : 0))
		.map(
			(d) =>
				`  ${d.nome} (${d.tipo}) — vitigni ammessi: ${[...d.vitigniAmmessi]
					.sort()
					.join(", ")}`,
		)
		.join("\n");

	const formati = [...ontology.formati]
		.sort((a, b) => a.litri - b.litri)
		.map((f) => `  ${f.nome}: ${f.litri} l`)
		.join("\n");

	return [
		`# Ontologia enologica (${ontology.version})`,
		"",
		`Tipologie: ${[...ontology.tipologie].sort().join(", ")}`,
		`Colori: ${[...ontology.colori].sort().join(", ")}`,
		"",
		"Unità di misura per chiave:",
		unita,
		"",
		"Formati:",
		formati,
		"",
		"Denominazioni:",
		denominazioni,
		"",
		`Termini di affinamento: ${[...ontology.terminiAffinamento].sort().join(", ")}`,
		`Metodi di spumantizzazione: ${[...ontology.metodiSpumantizzazione].sort().join(", ")}`,
	].join("\n");
}

/** Vitigni ammessi per una denominazione: controllo deterministico, non AI. */
export function vitigniAmmessi(
	denominazione: string,
	ontology: Ontology = ONTOLOGY,
): readonly string[] | undefined {
	const found = ontology.denominazioni.find(
		(d) => d.nome.toLowerCase() === denominazione.toLowerCase(),
	);
	return found?.vitigniAmmessi;
}
