/**
 * Il Revisore linguistico ed enologico: la parte deterministica.
 *
 * Lavora sui contenuti **approvati** nella lingua di origine, e verifica ciò che
 * è verificabile meccanicamente: valori numerici, unità di misura, nomi propri,
 * denominazioni, e l'assenza di affermazioni aggiunte. Al modello resta la
 * fedeltà del significato e la qualità della resa.
 *
 * Il guardrail del programma — *non aggiunge premi, qualità o caratteristiche
 * assenti nell'originale* — è qui un controllo, non una raccomandazione.
 *
 * ## Il motivo per cui alcuni controlli sono «da confermare» e non bloccanti
 *
 * Un numero presente o assente è un fatto: bloccante. Un'affermazione aggiunta
 * si riconosce da un lessico, e un lessico è una euristica: «Superiore» è una
 * qualificazione di denominazione, non una vanteria, e bloccare «Soave
 * Superiore» per un superlativo inesistente sarebbe un errore peggiore del non
 * controllare. I termini protetti vengono quindi rimossi dal testo **prima**
 * della scansione, e ciò che resta produce al massimo una conferma.
 *
 * Vedi docs/vinoveritas/03-agenti.md §10
 */

import { normaliseText } from "./candidates.ts";
import { extractNumbers, unmatchedNumbers } from "./numbers.ts";
import type { Ontology } from "./ontology.ts";
import { ONTOLOGY } from "./ontology.ts";
import type { Finding } from "./sentinel.ts";
import type { Provenance, Scope } from "./types.ts";

/** Traduzione tecnica o adattamento promozionale: criteri diversi. */
export type Register = "tecnica" | "promozionale";

export interface TranslationCandidate {
	readonly translationId: string;
	readonly factId: string;
	readonly scope: Scope;
	readonly factKey: string;
	readonly sourceLang: string;
	readonly lang: string;
	readonly sourceText: string;
	readonly text: string;
	/** La versione del testo di partenza a cui questa traduzione è legata. */
	readonly sourceVersion: number;
	readonly register: Register;
}

export interface ReviewContext {
	/** La versione attuale del fatto di partenza. */
	readonly factVersion: number;
	/**
	 * Termini che devono comparire **verbatim**: denominazioni, vitigni, nomi
	 * propri, toponimi. Una denominazione tradotta è un errore, non una scelta.
	 */
	readonly protectedTerms?: readonly string[];
	readonly evidence?: readonly Provenance[];
	readonly ontology?: Ontology;
}

export const REVIEW_CODES = [
	/** Condiviso con la Sentinella: stesso significato, stesso codice. */
	"TRADUZIONE_DA_RIESAMINARE",
	"TRADUZIONE_VUOTA",
	"NUMERO_AGGIUNTO",
	"NUMERO_PERDUTO",
	"UNITA_PERDUTA",
	"TERMINE_PROTETTO_ALTERATO",
	"AFFERMAZIONE_AGGIUNTA",
] as const;

/**
 * Lessico delle affermazioni di merito, per lingua.
 *
 * Volutamente **ristretto**: solo termini che non hanno altro significato nel
 * dominio. Non contiene «superiore», «classico», «riserva», «gran» — che sono
 * qualificazioni di denominazione — né «ricco» o «intenso», che sono
 * descrittori sensoriali legittimi. Un lessico ampio produrrebbe falsi allarmi
 * su traduzioni corrette, e un falso allarme costa una conferma inutile al
 * produttore.
 */
export const LESSICO_AFFERMAZIONI: Readonly<Record<string, readonly string[]>> = {
	it: [
		"premio", "premiato", "pluripremiato", "medaglia", "medaglia d oro",
		"miglior", "migliore", "eccellenza", "insuperabile", "numero uno",
		"vincitore", "trofeo",
	],
	en: [
		"award", "awarded", "award winning", "medal", "gold medal", "best",
		"finest", "unrivalled", "unrivaled", "winner", "trophy", "acclaimed",
	],
	de: [
		"preis", "pramiert", "auszeichnung", "goldmedaille", "beste", "bester",
		"sieger", "trophae",
	],
	fr: [
		"prix", "prime", "medaille", "medaille d or", "meilleur", "excellence",
		"vainqueur", "trophee",
	],
};

/** I termini da proteggere, dall'ontologia. */
export function ontologyProtectedTerms(
	ontology: Ontology = ONTOLOGY,
): readonly string[] {
	const terms = new Set<string>();
	for (const d of ontology.denominazioni) {
		terms.add(d.nome);
		for (const v of d.vitigniAmmessi) terms.add(v);
	}
	return [...terms].sort();
}

function finding(
	candidate: TranslationCandidate,
	severity: Finding["severity"],
	code: string,
	detail: string,
	evidence: readonly Provenance[],
): Finding {
	return {
		severity,
		code,
		scope: candidate.scope,
		factKey: candidate.factKey,
		evidence,
		// una traduzione guasta sospende la destinazione linguistica, non la referenza
		targets: [{ target: "materiali_commerciali" }],
		detail,
	};
}

/**
 * Rimuove i termini protetti dal testo, per la scansione del lessico.
 *
 * È il passaggio che evita il falso allarme su «Soave Superiore»: la
 * denominazione esce dal testo prima che si cerchino le vanterie.
 */
export function stripProtectedTerms(
	text: string,
	protectedTerms: readonly string[],
): string {
	let out = normaliseText(text);
	// dal più lungo al più corto: «Soave Classico» prima di «Soave»
	for (const term of [...protectedTerms].sort((a, b) => b.length - a.length)) {
		const normalised = normaliseText(term);
		if (normalised.length === 0) continue;
		out = out.split(normalised).join(" ");
	}
	return out.replace(/\s+/g, " ").trim();
}

/** Le affermazioni di merito presenti in un testo, per la sua lingua. */
export function claimsIn(
	text: string,
	lang: string,
	protectedTerms: readonly string[],
): string[] {
	const lexicon = LESSICO_AFFERMAZIONI[lang.toLowerCase().slice(0, 2)];
	if (lexicon === undefined) return [];

	// imbottito ai bordi: così il confronto per parola intera vale anche a
	// inizio e fine testo, senza un ramo a parte
	const scanned = ` ${stripProtectedTerms(text, protectedTerms)} `;
	return lexicon
		.filter((term) => scanned.includes(` ${normaliseText(term)} `))
		.sort();
}

/**
 * Le unità che **non** si traducono.
 *
 * La distinzione è necessaria e non ovvia. `%vol`, `g/l`, `mg/l`, `q/ha` e `°C`
 * sono simboli: identici in ogni lingua, e un loro cambiamento in una
 * traduzione tecnica è un errore. `mesi` e `m s.l.m.` sono **parole**: «mesi» →
 * «months» e «m s.l.m.» → «m a.s.l.» sono traduzioni corrette, e pretenderle
 * invariate segnalerebbe come errore il lavoro fatto bene.
 *
 * L'elenco è esplicito invece di dedotto: una regola del tipo «è un simbolo se
 * non contiene lettere» classificherebbe male sia `%vol` sia `q/ha`.
 */
export const UNITA_INVARIANTI: readonly string[] = [
	"%vol",
	"g/l",
	"mg/l",
	"q/ha",
	"°C",
];

/** Vero se l'unità deve comparire identica in ogni lingua. */
export function isInvariantUnit(unit: string): boolean {
	return UNITA_INVARIANTI.includes(unit);
}

/**
 * Le unità invarianti presenti in un testo.
 *
 * Le unità lessicali sono deliberatamente escluse: la loro fedeltà si verifica
 * attraverso il numero che le accompagna, non attraverso la loro grafia.
 */
export function unitsIn(text: string, ontology: Ontology = ONTOLOGY): string[] {
	const units = new Set<string>();
	for (const key of Object.keys(ontology.unita)) {
		const unit = ontology.unita[key];
		if (unit === undefined || unit.length === 0) continue;
		if (!isInvariantUnit(unit)) continue;
		if (text.includes(unit)) units.add(unit);
	}
	return [...units].sort();
}

/**
 * Rivede una traduzione.
 *
 * Funzione pura. L'ordine dell'uscita è stabile, come per la Sentinella: un
 * elenco di anomalie che cambia ordine fra due esecuzioni sugli stessi dati è
 * indistinguibile da un elenco cambiato.
 */
export function reviewTranslation(
	candidate: TranslationCandidate,
	ctx: ReviewContext,
): Finding[] {
	const ontology = ctx.ontology ?? ONTOLOGY;
	const evidence = ctx.evidence ?? [];
	const protectedTerms = ctx.protectedTerms ?? ontologyProtectedTerms(ontology);
	const findings: Finding[] = [];

	// 1. il legame con la versione sorgente
	if (candidate.sourceVersion < ctx.factVersion) {
		findings.push(
			finding(
				candidate,
				"bloccante",
				"TRADUZIONE_DA_RIESAMINARE",
				`legata alla versione ${candidate.sourceVersion}, ora alla ${ctx.factVersion}`,
				evidence,
			),
		);
	}

	const sourceEmpty = candidate.sourceText.trim().length === 0;
	const targetEmpty = candidate.text.trim().length === 0;

	if (targetEmpty && !sourceEmpty) {
		findings.push(
			finding(
				candidate,
				"bloccante",
				"TRADUZIONE_VUOTA",
				`la traduzione ${candidate.lang} è vuota ma l'originale non lo è`,
				evidence,
			),
		);
		// senza testo gli altri controlli non dicono nulla di nuovo
		return sortFindings(findings);
	}

	// 2. fedeltà numerica, nei due versi
	const sourceNumbers = extractNumbers(candidate.sourceText);
	const targetNumbers = extractNumbers(candidate.text);

	const perduti = unmatchedNumbers(sourceNumbers, targetNumbers);
	if (perduti.length > 0) {
		findings.push(
			finding(
				candidate,
				"bloccante",
				"NUMERO_PERDUTO",
				`valori dell'originale assenti nella traduzione ${candidate.lang}: ` +
					perduti.map((t) => t.raw).join(", "),
				evidence,
			),
		);
	}

	const aggiunti = unmatchedNumbers(targetNumbers, sourceNumbers);
	if (aggiunti.length > 0) {
		findings.push(
			finding(
				candidate,
				"bloccante",
				"NUMERO_AGGIUNTO",
				`valori nella traduzione ${candidate.lang} assenti nell'originale: ` +
					aggiunti.map((t) => t.raw).join(", "),
				evidence,
			),
		);
	}

	// 3. unità di misura: non si convertono in una traduzione tecnica
	const sourceUnits = unitsIn(candidate.sourceText, ontology);
	const targetUnits = unitsIn(candidate.text, ontology);
	const unitaPerdute = sourceUnits.filter((u) => !targetUnits.includes(u));

	if (unitaPerdute.length > 0) {
		findings.push(
			finding(
				candidate,
				candidate.register === "tecnica" ? "bloccante" : "da_confermare",
				"UNITA_PERDUTA",
				`unità dell'originale assenti nella traduzione ${candidate.lang}: ` +
					`${unitaPerdute.join(", ")} — in una traduzione tecnica non si convertono`,
				evidence,
			),
		);
	}

	// 4. termini protetti: una denominazione tradotta è un errore
	const alterati = protectedTerms.filter((term) => {
		const normalised = normaliseText(term);
		if (normalised.length === 0) return false;
		if (!normaliseText(candidate.sourceText).includes(normalised)) return false;
		return !normaliseText(candidate.text).includes(normalised);
	});

	if (alterati.length > 0) {
		findings.push(
			finding(
				candidate,
				"bloccante",
				"TERMINE_PROTETTO_ALTERATO",
				`termini che devono comparire verbatim, assenti nella traduzione ` +
					`${candidate.lang}: ${alterati.join(", ")}`,
				evidence,
			),
		);
	}

	// 5. affermazioni aggiunte
	const claimsSource = claimsIn(candidate.sourceText, candidate.sourceLang, protectedTerms);
	const claimsTarget = claimsIn(candidate.text, candidate.lang, protectedTerms);

	if (claimsTarget.length > 0 && claimsSource.length === 0) {
		findings.push(
			finding(
				candidate,
				// euristica lessicale: una conferma, non un blocco
				"da_confermare",
				"AFFERMAZIONE_AGGIUNTA",
				`la traduzione ${candidate.lang} contiene affermazioni di merito assenti ` +
					`nell'originale: ${claimsTarget.join(", ")}`,
				evidence,
			),
		);
	}

	return sortFindings(findings);
}

function sortFindings(findings: Finding[]): Finding[] {
	return findings.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/**
 * Rivede più traduzioni. L'ordine è stabile anche fra candidati.
 */
export function reviewAll(
	candidates: readonly TranslationCandidate[],
	contextOf: (candidate: TranslationCandidate) => ReviewContext,
): Finding[] {
	const ordered = [...candidates].sort((a, b) => {
		const ka = `${a.factId}\u0000${a.lang}\u0000${a.translationId}`;
		const kb = `${b.factId}\u0000${b.lang}\u0000${b.translationId}`;
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});
	return ordered.flatMap((c) => reviewTranslation(c, contextOf(c)));
}
