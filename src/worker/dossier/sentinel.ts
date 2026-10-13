/**
 * La Sentinella: la metà deterministica.
 *
 * Le regole esatte vanno al software perché lì sono affidabili e gratuite; al
 * modello resta l'incongruenza di significato, che nessuna regola cattura.
 * Questo file contiene solo la prima metà.
 *
 * Tre impegni di esattezza, che valgono per ogni controllo qui dentro:
 *
 *  1. **Nessun non-determinismo.** Nessun `Date.now()`, nessun ordine di chiavi
 *     implicito. L'anno corrente arriva dal contesto, perché un controllo che
 *     dipende dall'orologio di sistema dà esiti diversi a distanza di un anno
 *     sugli stessi dati.
 *  2. **L'ignoto non è un errore.** L'ontologia è un seme: una denominazione che
 *     non vi compare è un miglioramento, non un blocco. Bloccare su un elenco
 *     incompleto sarebbe un errore peggiore del non controllare.
 *  3. **Nessun doppio referto.** Se l'unità è sbagliata il valore non viene
 *     classificato: classificarlo darebbe due anomalie per una sola causa.
 *
 * Vedi docs/vinoveritas/03-agenti.md §6
 */

import { normaliseText } from "./candidates.ts";
import type { TranslationRef } from "./invalidation.ts";
import type { Ontology } from "./ontology.ts";
import { ONTOLOGY } from "./ontology.ts";
import { classify, PLAUSIBILITY, PRIMA_ANNATA } from "./ranges.ts";
import { canReachApproved, targetMatches } from "./types.ts";
import type { Fact, IssueSeverity, Provenance, Scope, TargetRef } from "./types.ts";

export interface Finding {
	readonly severity: IssueSeverity;
	readonly code: string;
	readonly scope: Scope;
	readonly factKey?: string;
	readonly evidence: readonly Provenance[];
	readonly targets: readonly TargetRef[];
	readonly detail: string;
}

export interface SentinelContext {
	/** Iniettato, non letto dall'orologio: vedi impegno 1. */
	readonly currentYear: number;
	readonly ontology?: Ontology;
}

export interface SentinelInput {
	readonly facts: readonly Fact[];
	readonly translations?: readonly TranslationRef[];
}

/** Chiavi la cui esposizione pubblica è un errore, non una scelta. */
const CHIAVI_RISERVATE = new Set([
	"codice_fiscale",
	"partita_iva",
	"identificativo_fiscale",
	"sede_legale",
	"contatto_amministrativo",
	"iban",
	"rea",
]);

// ─── Riferimenti d'ambito ───────────────────────────────────────────────────

/** Un riferimento d'annata è esattamente `{vino}:{anno a quattro cifre}`. */
export function parseVintageRef(
	ref: string,
): { readonly wineRef: string; readonly year: number } | null {
	const match = /^([^:]+):(\d{4})$/.exec(ref);
	if (match === null) return null;
	return { wineRef: match[1]!, year: Number(match[2]) };
}

/** Un riferimento di lotto è `{vino}:{anno}:{lotto}`. */
export function parseLotRef(
	ref: string,
): { readonly wineRef: string; readonly year: number; readonly lot: string } | null {
	const match = /^([^:]+):(\d{4}):([^:]+)$/.exec(ref);
	if (match === null) return null;
	return { wineRef: match[1]!, year: Number(match[2]), lot: match[3]! };
}

/** La referenza a cui un ambito appartiene, o `null` se non è una referenza. */
export function wineRefOf(scope: Scope): string | null {
	switch (scope.type) {
		case "vino":
			return scope.ref;
		case "annata":
			return parseVintageRef(scope.ref)?.wineRef ?? null;
		case "lotto":
			return parseLotRef(scope.ref)?.wineRef ?? null;
		default:
			return null;
	}
}

/**
 * Le destinazioni che un'anomalia su questo ambito sospende.
 *
 * Una referenza è sempre qualificata: un bloccante sull'annata di un vino non
 * deve chiudere le altre referenze.
 */
export function targetsFor(scope: Scope): readonly TargetRef[] {
	const wine = wineRefOf(scope);
	if (wine !== null) return [{ target: "referenza", ref: wine }];
	return [{ target: "profilo" }];
}

// ─── Denominazioni ──────────────────────────────────────────────────────────

const TIPO_DENOMINAZIONE = /\b(docg|doc|igt|igp|dop|vdt)\b/g;

/**
 * Normalizza una denominazione per il confronto, togliendo il tipo.
 *
 * «Soave Classico DOC» e «Soave Classico» sono la stessa denominazione: il tipo
 * è un attributo, non parte del nome. Senza questo passaggio un confronto
 * esatto fallirebbe sul modo in cui la cantina scrive il nome.
 */
export function normaliseDenominazione(value: string): string {
	return normaliseText(value).replace(TIPO_DENOMINAZIONE, "").replace(/\s+/g, " ").trim();
}

export function findDenominazione(value: string, ontology: Ontology) {
	const wanted = normaliseDenominazione(value);
	return ontology.denominazioni.find((d) => normaliseDenominazione(d.nome) === wanted);
}

// ─── Lettura dei fatti ──────────────────────────────────────────────────────

/**
 * L'unità dichiarata per una chiave, o `undefined`.
 *
 * Un solo punto di lettura: un accesso diretto su un indice restituirebbe un
 * tipo che promette sempre un valore, e il controllo sull'assenza sembrerebbe
 * codice morto pur essendo necessario.
 */
function declaredUnit(ontology: Ontology, key: string): string | undefined {
	return ontology.unita[key];
}

/**
 * I fatti da controllare, in ordine deterministico.
 *
 * L'ordinamento non è cosmetico. Diversi controlli scelgono «il primo fatto»
 * di un ambito — come rappresentante di un'anomalia che riguarda l'ambito, o
 * come valore da confrontare. Senza un ordine stabile quel «primo» dipende
 * dall'ordine in cui la query ha restituito le righe, e lo stesso fascicolo
 * produce anomalie con evidenze diverse da un'esecuzione all'altra.
 *
 * Ordinando qui, una volta, la proprietà vale per tutti i controlli a valle
 * invece di dover essere ricordata in ciascuno.
 */
function live(facts: readonly Fact[]): Fact[] {
	// i superati non si controllano: sono storia, non contenuto
	return facts
		.filter((f) => f.state !== "superato")
		.sort((a, b) => {
			const ka = `${a.scope.type}\u0000${a.scope.ref}\u0000${a.key}\u0000${a.id}`;
			const kb = `${b.scope.type}\u0000${b.scope.ref}\u0000${b.key}\u0000${b.id}`;
			return ka < kb ? -1 : ka > kb ? 1 : 0;
		});
}

function textOf(fact: Fact | undefined): string | undefined {
	return fact?.value.kind === "testo" ? fact.value.text : undefined;
}

function find(
	facts: readonly Fact[],
	scopeType: Scope["type"],
	ref: string,
	key: string,
): Fact | undefined {
	return facts.find(
		(f) => f.scope.type === scopeType && f.scope.ref === ref && f.key === key,
	);
}

function finding(
	fact: Fact,
	severity: IssueSeverity,
	code: string,
	detail: string,
): Finding {
	return {
		severity,
		code,
		scope: fact.scope,
		factKey: fact.key,
		evidence: fact.provenance,
		targets: targetsFor(fact.scope),
		detail,
	};
}

// ─── I controlli ────────────────────────────────────────────────────────────

/**
 * Invariante 2 vista dal fascicolo: un fatto approvato deve avere un appoggio
 * documentale o dichiarativo. L'ammissione lo impedisce in scrittura; questo
 * controlla il contenuto, che è ciò che la Sentinella deve fare.
 */
export function checkApprovatoSenzaAppoggio(input: SentinelInput): Finding[] {
	return live(input.facts)
		.filter((f) => f.state === "approvato" && !canReachApproved(f.provenance))
		.map((f) =>
			finding(
				f,
				"bloccante",
				"APPROVATO_SENZA_APPOGGIO",
				`approvato con sola provenienza ${f.provenance.map((p) => p.kind).join(", ")}`,
			),
		);
}

/** L'unità dichiarata dall'ontologia per la chiave è una regola esatta. */
export function checkUnita(input: SentinelInput, ctx: SentinelContext): Finding[] {
	const ontology = ctx.ontology ?? ONTOLOGY;

	return live(input.facts).flatMap((f) => {
		if (f.value.kind !== "numero") return [];
		const expected = declaredUnit(ontology, f.key);
		if (expected === undefined || f.value.unit === expected) return [];
		return [
			finding(
				f,
				"bloccante",
				"UNITA_ERRATA",
				`unità «${f.value.unit}» per ${f.key}: attesa «${expected}»`,
			),
		];
	});
}

/**
 * Plausibilità del valore.
 *
 * Non classifica i valori la cui unità è già stata segnalata: una sola causa
 * deve produrre una sola anomalia (impegno 3).
 */
export function checkPlausibilita(
	input: SentinelInput,
	ctx: SentinelContext,
): Finding[] {
	const ontology = ctx.ontology ?? ONTOLOGY;

	return live(input.facts).flatMap((f) => {
		if (f.value.kind !== "numero") return [];

		const expected = declaredUnit(ontology, f.key);
		if (expected !== undefined && f.value.unit !== expected) return [];

		const rule = PLAUSIBILITY[f.key];
		if (rule === undefined) return [];

		switch (classify(f.key, f.value.value)) {
			case "impossibile":
				return [
					finding(
						f,
						"bloccante",
						"VALORE_IMPOSSIBILE",
						`${f.value.value} ${f.value.unit} fuori dall'intervallo ` +
							`[${rule.hard.min}, ${rule.hard.max}]: ${rule.rationale}`,
					),
				];
			case "insolito":
				return [
					finding(
						f,
						"da_confermare",
						"VALORE_INSOLITO",
						`${f.value.value} ${f.value.unit} fuori dall'intervallo abituale ` +
							`[${rule.typical.min}, ${rule.typical.max}]: ${rule.rationale}`,
					),
				];
			default:
				return [];
		}
	});
}

/** Tipologia e colore sono insiemi chiusi: un valore fuori è un errore. */
export function checkInsiemiChiusi(
	input: SentinelInput,
	ctx: SentinelContext,
): Finding[] {
	const ontology = ctx.ontology ?? ONTOLOGY;
	const findings: Finding[] = [];

	for (const f of live(input.facts)) {
		const text = textOf(f);
		if (text === undefined) continue;
		const value = normaliseText(text);

		if (f.key === "tipologia" && !ontology.tipologie.some((t) => normaliseText(t) === value)) {
			findings.push(
				finding(
					f,
					"bloccante",
					"TIPOLOGIA_IGNOTA",
					`tipologia «${text}» non fra: ${ontology.tipologie.join(", ")}`,
				),
			);
		}

		if (f.key === "colore" && !ontology.colori.some((c) => normaliseText(c) === value)) {
			findings.push(
				finding(
					f,
					"bloccante",
					"COLORE_IGNOTO",
					`colore «${text}» non fra: ${ontology.colori.join(", ")}`,
				),
			);
		}
	}

	return findings;
}

/**
 * Denominazione e vitigni.
 *
 * Una denominazione che non compare nell'ontologia è un **miglioramento**: il
 * catalogo è un seme, e bloccare su un elenco incompleto è l'errore peggiore
 * (impegno 2). I vitigni si controllano **solo** quando la denominazione è nota,
 * perché altrimenti l'elenco degli ammessi non è noto.
 */
export function checkDenominazioneEVitigni(
	input: SentinelInput,
	ctx: SentinelContext,
): Finding[] {
	const ontology = ctx.ontology ?? ONTOLOGY;
	const facts = live(input.facts);
	const findings: Finding[] = [];

	for (const f of facts) {
		if (f.key !== "denominazione") continue;
		const text = textOf(f);
		if (text === undefined) continue;

		const known = findDenominazione(text, ontology);
		if (known === undefined) {
			findings.push(
				finding(
					f,
					"miglioramento",
					"DENOMINAZIONE_IGNOTA",
					`«${text}» non è nell'ontologia (${ontology.version}): i vitigni ammessi ` +
						"non sono verificabili",
				),
			);
			continue;
		}

		const vitigniFact = find(facts, f.scope.type, f.scope.ref, "vitigni");
		if (vitigniFact === undefined || vitigniFact.value.kind !== "elenco") continue;

		const ammessi = new Set(known.vitigniAmmessi.map(normaliseText));
		const estranei = vitigniFact.value.items.filter(
			(v) => !ammessi.has(normaliseText(v)),
		);

		if (estranei.length > 0) {
			findings.push({
				severity: "da_confermare",
				code: "VITIGNO_NON_AMMESSO",
				scope: vitigniFact.scope,
				factKey: "vitigni",
				evidence: [...vitigniFact.provenance, ...f.provenance],
				targets: targetsFor(vitigniFact.scope),
				detail:
					`${estranei.join(", ")} non fra i vitigni ammessi da ${known.nome} ` +
					`(${known.vitigniAmmessi.join(", ")})`,
			});
		}
	}

	return findings;
}

/** Il metodo di spumantizzazione e i termini di affinamento sono vocabolari. */
export function checkVocabolari(
	input: SentinelInput,
	ctx: SentinelContext,
): Finding[] {
	const ontology = ctx.ontology ?? ONTOLOGY;
	const findings: Finding[] = [];

	for (const f of live(input.facts)) {
		const text = textOf(f);
		if (text === undefined) continue;
		const value = normaliseText(text);

		if (
			f.key === "metodo_spumantizzazione" &&
			!ontology.metodiSpumantizzazione.some((m) => normaliseText(m) === value)
		) {
			findings.push(
				finding(
					f,
					"da_confermare",
					"METODO_SPUMANTIZZAZIONE_IGNOTO",
					`metodo «${text}» non fra: ${ontology.metodiSpumantizzazione.join(", ")}`,
				),
			);
		}

		if (
			f.key === "contenitore_affinamento" &&
			!ontology.terminiAffinamento.some((t) => normaliseText(t) === value)
		) {
			findings.push(
				finding(
					f,
					"miglioramento",
					"AFFINAMENTO_IGNOTO",
					`contenitore «${text}» non fra i termini noti`,
				),
			);
		}
	}

	return findings;
}

/**
 * Controlli specifici per tipologia.
 *
 * Uno spumante senza metodo e un passito senza indicazione di appassimento sono
 * schede incomplete: «da confermare», perché il dato esiste sempre e la cantina
 * può fornirlo.
 */
export function checkControlliSpecifici(input: SentinelInput): Finding[] {
	const facts = live(input.facts);
	const findings: Finding[] = [];

	const richieste: Readonly<Record<string, readonly string[]>> = {
		spumante: ["metodo_spumantizzazione"],
		passito: ["tecnica_appassimento"],
	};

	for (const f of facts) {
		if (f.key !== "tipologia") continue;
		const tipologia = textOf(f);
		if (tipologia === undefined) continue;

		const wanted = richieste[normaliseText(tipologia)];
		if (wanted === undefined) continue;

		// la tipologia sta sul vino, ma se arrivasse su un'annata il riferimento
		// grezzo sarebbe «{vino}:{anno}» e non combacerebbe con nulla
		const wine = wineRefOf(f.scope) ?? f.scope.ref;
		for (const key of wanted) {
			// il dato può stare sul vino o su una sua annata
			const presente = facts.some(
				(x) => x.key === key && wineRefOf(x.scope) === wine,
			);
			if (presente) continue;

			findings.push({
				severity: "da_confermare",
				code: "CONTROLLO_SPECIFICO_ASSENTE",
				scope: f.scope,
				factKey: key,
				evidence: f.provenance,
				targets: targetsFor(f.scope),
				detail: `un ${tipologia} richiede ${key}, assente per ${wine}`,
			});
		}
	}

	return findings;
}

/** La forma dei riferimenti d'ambito è esatta, e un orfano è un errore. */
export function checkRiferimenti(
	input: SentinelInput,
	ctx: SentinelContext,
): Finding[] {
	const facts = live(input.facts);
	const findings: Finding[] = [];

	const vini = new Set(facts.filter((f) => f.scope.type === "vino").map((f) => f.scope.ref));
	const annate = new Set(
		facts.filter((f) => f.scope.type === "annata").map((f) => f.scope.ref),
	);

	const segnalati = new Set<string>();
	const once = (f: Fact, code: string, detail: string, severity: IssueSeverity) => {
		const key = `${code}:${f.scope.type}:${f.scope.ref}`;
		if (segnalati.has(key)) return;
		segnalati.add(key);
		findings.push(finding(f, severity, code, detail));
	};

	for (const f of facts) {
		if (f.scope.type === "annata") {
			const parsed = parseVintageRef(f.scope.ref);
			if (parsed === null) {
				once(
					f,
					"RIFERIMENTO_MALFORMATO",
					`«${f.scope.ref}» non è nella forma {vino}:{anno}`,
					"bloccante",
				);
				continue;
			}
			if (parsed.year < PRIMA_ANNATA || parsed.year > ctx.currentYear) {
				once(
					f,
					"ANNATA_FUORI_INTERVALLO",
					`annata ${parsed.year} fuori da [${PRIMA_ANNATA}, ${ctx.currentYear}]`,
					"bloccante",
				);
			}
			if (!vini.has(parsed.wineRef)) {
				once(
					f,
					"RIFERIMENTO_ORFANO",
					`l'annata ${f.scope.ref} non ha un vino ${parsed.wineRef} nel fascicolo`,
					"bloccante",
				);
			}
			continue;
		}

		if (f.scope.type === "lotto") {
			const parsed = parseLotRef(f.scope.ref);
			if (parsed === null) {
				once(
					f,
					"RIFERIMENTO_MALFORMATO",
					`«${f.scope.ref}» non è nella forma {vino}:{anno}:{lotto}`,
					"bloccante",
				);
				continue;
			}
			if (!annate.has(`${parsed.wineRef}:${parsed.year}`)) {
				once(
					f,
					"RIFERIMENTO_ORFANO",
					`il lotto ${f.scope.ref} non ha l'annata ${parsed.wineRef}:${parsed.year}`,
					"bloccante",
				);
			}
		}
	}

	return findings;
}

/**
 * Omonimie.
 *
 * Due referenze con lo stesso nome normalizzato, o la stessa denominazione con
 * la stessa annata, sono il caso in cui un'estrazione attacca un dato alla
 * referenza sbagliata. «Da confermare»: non si indovina.
 */
export function checkOmonimie(input: SentinelInput): Finding[] {
	const facts = live(input.facts);
	const findings: Finding[] = [];

	const perNome = new Map<string, Fact[]>();
	for (const f of facts) {
		if (f.scope.type !== "vino" || f.key !== "nome") continue;
		const text = textOf(f);
		if (text === undefined) continue;
		const key = normaliseText(text);
		perNome.set(key, [...(perNome.get(key) ?? []), f]);
	}

	for (const [, gruppo] of perNome) {
		if (gruppo.length < 2) continue;
		// l'elenco nel messaggio è ordinato: un testo che cambia fra due
		// esecuzioni sugli stessi dati è indistinguibile da un testo cambiato
		const refs = [...new Set(gruppo.map((f) => f.scope.ref))].sort();
		for (const f of gruppo) {
			findings.push(
				finding(
					f,
					"da_confermare",
					"NOMI_OMONIMI",
					`più referenze con lo stesso nome: ${refs.join(", ")}`,
				),
			);
		}
	}

	// stessa denominazione e stessa annata su referenze distinte
	const perDenominazione = new Map<string, Fact[]>();
	for (const f of facts) {
		if (f.scope.type !== "vino" || f.key !== "denominazione") continue;
		const text = textOf(f);
		if (text === undefined) continue;
		const key = normaliseDenominazione(text);
		perDenominazione.set(key, [...(perDenominazione.get(key) ?? []), f]);
	}

	for (const [, gruppo] of perDenominazione) {
		if (gruppo.length < 2) continue;

		const anniPerVino = new Map<string, Set<number>>();
		for (const f of gruppo) {
			const anni = new Set<number>();
			for (const a of facts) {
				if (a.scope.type !== "annata") continue;
				const parsed = parseVintageRef(a.scope.ref);
				if (parsed?.wineRef === f.scope.ref) anni.add(parsed.year);
			}
			anniPerVino.set(f.scope.ref, anni);
		}

		for (const f of gruppo) {
			const miei = anniPerVino.get(f.scope.ref) ?? new Set();
			const collisioni = [...miei].filter((anno) =>
				gruppo.some(
					(altro) =>
						altro.scope.ref !== f.scope.ref &&
						(anniPerVino.get(altro.scope.ref) ?? new Set()).has(anno),
				),
			);
			if (collisioni.length === 0) continue;

			findings.push(
				finding(
					f,
					"da_confermare",
					"ANNATE_OMONIME",
					`stessa denominazione e stesse annate (${collisioni.sort().join(", ")}) ` +
						`di un'altra referenza: disambiguare su formato o codice interno`,
				),
			);
		}
	}

	return findings;
}

/** La sboccatura non può precedere la vendemmia dell'annata del lotto. */
export function checkCoerenzaTemporale(input: SentinelInput): Finding[] {
	const facts = live(input.facts);
	const findings: Finding[] = [];

	for (const f of facts) {
		if (f.scope.type !== "lotto" || f.key !== "data_sboccatura") continue;
		if (f.value.kind !== "data") continue;

		const parsed = parseLotRef(f.scope.ref);
		if (parsed === null) continue;

		const year = Number(f.value.iso.slice(0, 4));
		if (!Number.isFinite(year)) continue;

		if (year < parsed.year) {
			findings.push(
				finding(
					f,
					"bloccante",
					"SBOCCATURA_PRIMA_VENDEMMIA",
					`sboccatura ${f.value.iso} precede la vendemmia ${parsed.year}`,
				),
			);
		}
	}

	return findings;
}

/** Un dato riservato esposto come pubblico è un errore, non una scelta. */
export function checkVisibilita(input: SentinelInput): Finding[] {
	return live(input.facts)
		.filter(
			(f) =>
				CHIAVI_RISERVATE.has(f.key) &&
				(f.visibility === "pubblico" || f.visibility === "commerciale"),
		)
		.map((f) =>
			finding(
				f,
				"bloccante",
				"DATO_RISERVATO_ESPOSTO",
				`${f.key} ha visibilità «${f.visibility}»: deve restare riservato`,
			),
		);
}

/** Una traduzione il cui testo di partenza è cambiato non è pubblicabile. */
export function checkTraduzioni(input: SentinelInput): Finding[] {
	const stale = (input.translations ?? []).filter((t) => t.state === "stale");
	if (stale.length === 0) return [];

	const byFact = new Map(live(input.facts).map((f) => [f.id, f]));
	const findings: Finding[] = [];

	for (const t of stale) {
		const fact = byFact.get(t.factId);
		const scope: Scope = fact?.scope ?? { type: "cantina", ref: "" };
		findings.push({
			severity: "bloccante",
			code: "TRADUZIONE_DA_RIESAMINARE",
			scope,
			factKey: fact?.key,
			evidence: fact?.provenance ?? [],
			targets: [{ target: "materiali_commerciali" }],
			detail: `la traduzione ${t.lang} di ${t.factId} è legata alla versione ${t.sourceVersion}, ora superata`,
		});
	}

	return findings;
}

// ─── Registro ───────────────────────────────────────────────────────────────

export type Check = (input: SentinelInput, ctx: SentinelContext) => Finding[];

/**
 * L'elenco dei controlli è un dato: aggiungerne uno significa registrarlo qui,
 * dove è visibile in revisione, e un test verifica che nessun codice si
 * sovrapponga.
 */
export const CHECKS: readonly { readonly name: string; readonly run: Check }[] = [
	{ name: "approvato_senza_appoggio", run: checkApprovatoSenzaAppoggio },
	{ name: "unita", run: checkUnita },
	{ name: "plausibilita", run: checkPlausibilita },
	{ name: "insiemi_chiusi", run: checkInsiemiChiusi },
	{ name: "denominazione_e_vitigni", run: checkDenominazioneEVitigni },
	{ name: "vocabolari", run: checkVocabolari },
	{ name: "controlli_specifici", run: checkControlliSpecifici },
	{ name: "riferimenti", run: checkRiferimenti },
	{ name: "omonimie", run: checkOmonimie },
	{ name: "coerenza_temporale", run: checkCoerenzaTemporale },
	{ name: "visibilita", run: checkVisibilita },
	{ name: "traduzioni", run: checkTraduzioni },
];

/** Tutti i codici che la metà deterministica può emettere. */
export const CODES = [
	"APPROVATO_SENZA_APPOGGIO",
	"UNITA_ERRATA",
	"VALORE_IMPOSSIBILE",
	"VALORE_INSOLITO",
	"TIPOLOGIA_IGNOTA",
	"COLORE_IGNOTO",
	"DENOMINAZIONE_IGNOTA",
	"VITIGNO_NON_AMMESSO",
	"METODO_SPUMANTIZZAZIONE_IGNOTO",
	"AFFINAMENTO_IGNOTO",
	"CONTROLLO_SPECIFICO_ASSENTE",
	"RIFERIMENTO_MALFORMATO",
	"RIFERIMENTO_ORFANO",
	"ANNATA_FUORI_INTERVALLO",
	"NOMI_OMONIMI",
	"ANNATE_OMONIME",
	"SBOCCATURA_PRIMA_VENDEMMIA",
	"DATO_RISERVATO_ESPOSTO",
	"TRADUZIONE_DA_RIESAMINARE",
] as const;

/**
 * Esegue tutti i controlli deterministici.
 *
 * L'ordine dell'uscita è stabile — per codice, poi ambito, poi chiave — perché
 * un elenco di anomalie che cambia ordine fra due esecuzioni sugli stessi dati
 * è indistinguibile da un elenco cambiato.
 */
export function runDeterministicChecks(
	input: SentinelInput,
	ctx: SentinelContext,
): Finding[] {
	const findings = CHECKS.flatMap((check) => check.run(input, ctx));

	// Confronto per punti di codice, non `localeCompare`: quello dipende dal
	// locale dell'ambiente, e un ordine che cambia fra Node e il worker
	// renderebbe «stabile» una parola senza contenuto.
	return findings.sort((a, b) => {
		const ka = sortKey(a);
		const kb = sortKey(b);
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});
}

function sortKey(f: Finding): string {
	return `${f.code}\u0000${f.scope.type}:${f.scope.ref}\u0000${f.factKey ?? ""}`;
}

/**
 * Vero se qualche anomalia bloccante riguarda questa destinazione.
 *
 * Usa la stessa relazione dei cancelli: una sola definizione, così che le due
 * non possano divergere.
 */
export function blocksTarget(findings: readonly Finding[], target: TargetRef): boolean {
	return findings.some(
		(f) => f.severity === "bloccante" && f.targets.some((t) => targetMatches(t, target)),
	);
}
