/**
 * L'Ambasciatore: la parte deterministica.
 *
 * Trasforma le anomalie in domande, e soprattutto decide **quali domande non
 * fare**. È il componente che governa l'indicatore «minuti richiesti al
 * produttore», e lo governa togliendo, non aggiungendo.
 *
 * Tre meccanismi, tutti verificabili senza modello:
 *
 *  1. **Verifica preliminare**: se il fascicolo contiene già la risposta, non
 *     si chiede. Incluso il caso in cui la risposta è «non disponibile».
 *  2. **Chiave semantica**: una domanda già posta non si ripone. L'indice unico
 *     su `(cantina, chiave semantica)` lo impone anche al livello del database,
 *     e il secondo ciclo è quindi un aggiornamento, non una nuova riga.
 *  3. **Rilascio a lotti**: le domande si accumulano e partono insieme. Sei
 *     domande in una volta costano meno di sei interruzioni.
 *
 * L'Ambasciatore **non propone fatti**: non ha ambiti in scrittura. Registra la
 * risposta e riferisce cosa ne segue; a proporre è lo specialista competente, e
 * ad approvare l'orchestrazione.
 *
 * Vedi docs/vinoveritas/03-agenti.md §7 e docs/vinoveritas/04-flussi.md §3
 */

import type { Finding } from "./sentinel.ts";
import { wineRefOf } from "./sentinel.ts";
import type { Fact, Scope } from "./types.ts";

export type Audience = "enologo" | "amministrazione" | "marketing" | "titolare";

/** Le anomalie che generano una domanda. Un miglioramento non interrompe. */
const GRAVITA_INTERROGABILI = new Set(["bloccante", "da_confermare"]);

/**
 * L'interlocutore per una chiave, dedotto dall'ambito e dalla chiave.
 *
 * La mappa è deliberatamente grossolana: sbagliare interlocutore costa un
 * rimbalzo, mentre una mappa troppo fine costa manutenzione a ogni chiave nuova.
 * Il titolare è il destinatario di riserva, non l'opzione preferita.
 */
export function audienceFor(scope: Scope, factKey: string | undefined): Audience {
	const key = factKey ?? "";

	if (
		/^(codice_fiscale|partita_iva|identificativo_fiscale|sede_legale|rea|iban|contatto_amministrativo)$/.test(
			key,
		) ||
		scope.type === "sede"
	) {
		return "amministrazione";
	}

	if (/^(nome|storia|storia_sintesi|filosofia|descrizione|nota_degustazione)/.test(key)) {
		return "marketing";
	}

	if (scope.type === "vino" || scope.type === "annata" || scope.type === "lotto") {
		return "enologo";
	}

	if (scope.type === "vigneto" || scope.type === "territorio") {
		return "enologo";
	}

	return "titolare";
}

/**
 * L'argomento per cui le domande si raggruppano.
 *
 * Il raggruppamento è per **referenza**, non per anomalia: al produttore
 * conviene rispondere a tutto ciò che riguarda un vino in una volta.
 */
export function topicFor(scope: Scope): string {
	const wine = wineRefOf(scope);
	if (wine !== null) return `referenza:${wine}`;
	if (scope.type === "sede" || scope.type === "marchio") return "anagrafica";
	if (scope.type === "vigneto" || scope.type === "territorio") return "vigneti";
	return `cantina:${scope.ref}`;
}

/**
 * La chiave semantica: l'identità di una domanda.
 *
 * Deliberatamente **non** include il codice dell'anomalia né il suo testo. Due
 * anomalie diverse sullo stesso dato — «manca» e «è contraddittorio» — sono la
 * stessa domanda per il produttore: *che valore ha questo dato?* Includere il
 * codice le farebbe partire entrambe, che è esattamente la duplicazione da
 * evitare.
 */
export function semanticKey(scope: Scope, factKey: string | undefined): string {
	return `${scope.type}:${scope.ref}/${factKey ?? "*"}`;
}

export interface QuestionDraft {
	readonly semanticKey: string;
	readonly topic: string;
	readonly audience: Audience;
	readonly scope: Scope;
	readonly factKey?: string;
	/** Le anomalie che questa domanda risolve: può essere più d'una. */
	readonly issueIds: readonly string[];
	/** I motivi delle anomalie, da cui si formula il testo. */
	readonly reasons: readonly string[];
	/** Vero se almeno un'anomalia è bloccante: determina la priorità. */
	readonly blocking: boolean;
}

export type SkipReason =
	| "risposta_gia_nel_fascicolo"
	| "dato_dichiarato_non_disponibile"
	| "domanda_gia_posta"
	| "gravita_non_interrogabile";

export interface QuestionPlan {
	readonly drafts: readonly QuestionDraft[];
	/** Le anomalie non trasformate in domanda, con il perché. */
	readonly skipped: readonly {
		readonly issueId: string;
		readonly reason: SkipReason;
	}[];
}

export interface ExistingQuestion {
	readonly semanticKey: string;
	readonly state: "bozza" | "inviata" | "risposta" | "scaduta" | "escalata";
	readonly cycle: 1 | 2;
}

export interface PlanInput {
	/** Le anomalie aperte, già classificate dalla Sentinella. */
	readonly findings: readonly (Finding & { readonly issueId: string })[];
	/** I fatti del fascicolo: serve a verificare che la risposta non ci sia già. */
	readonly facts: readonly Fact[];
	/** Le domande già presenti, per chiave semantica. */
	readonly existing: readonly ExistingQuestion[];
}

/**
 * Pianifica le domande.
 *
 * Funzione pura: dato lo stesso fascicolo produce lo stesso piano, e `skipped`
 * rende visibile in collaudo *quante* domande sono state evitate e perché —
 * senza quel conteggio un filtro troppo stretto passerebbe inosservato.
 */
export function planQuestions(input: PlanInput): QuestionPlan {
	const drafts = new Map<string, QuestionDraft>();
	const skipped: { issueId: string; reason: SkipReason }[] = [];

	const byKey = new Map(input.existing.map((q) => [q.semanticKey, q]));

	// indice dei fatti vivi per (ambito, chiave)
	const live = new Map<string, Fact>();
	for (const f of input.facts) {
		if (f.state === "superato") continue;
		live.set(`${f.scope.type}:${f.scope.ref}/${f.key}`, f);
	}

	// ordine stabile: il piano non deve dipendere dall'ordine delle anomalie
	const findings = [...input.findings].sort((a, b) => {
		const ka = `${semanticKey(a.scope, a.factKey)}\u0000${a.code}\u0000${a.issueId}`;
		const kb = `${semanticKey(b.scope, b.factKey)}\u0000${b.code}\u0000${b.issueId}`;
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});

	for (const finding of findings) {
		if (!GRAVITA_INTERROGABILI.has(finding.severity)) {
			skipped.push({ issueId: finding.issueId, reason: "gravita_non_interrogabile" });
			continue;
		}

		const key = semanticKey(finding.scope, finding.factKey);

		// 1. la risposta è già nel fascicolo?
		const existingFact = live.get(key);
		if (existingFact !== undefined && existingFact.state === "approvato") {
			skipped.push({
				issueId: finding.issueId,
				reason:
					existingFact.value.kind === "non_disponibile"
						? "dato_dichiarato_non_disponibile"
						: "risposta_gia_nel_fascicolo",
			});
			continue;
		}

		// 2. l'ho già chiesto?
		const already = byKey.get(key);
		if (already !== undefined && already.state !== "scaduta") {
			skipped.push({ issueId: finding.issueId, reason: "domanda_gia_posta" });
			continue;
		}

		// 3. raggruppa: più anomalie sullo stesso dato sono una domanda
		const current = drafts.get(key);
		if (current === undefined) {
			drafts.set(key, {
				semanticKey: key,
				topic: topicFor(finding.scope),
				audience: audienceFor(finding.scope, finding.factKey),
				scope: finding.scope,
				factKey: finding.factKey,
				issueIds: [finding.issueId],
				reasons: [finding.detail],
				blocking: finding.severity === "bloccante",
			});
		} else {
			drafts.set(key, {
				...current,
				issueIds: [...current.issueIds, finding.issueId],
				reasons: [...current.reasons, finding.detail],
				blocking: current.blocking || finding.severity === "bloccante",
			});
		}
	}

	return { drafts: [...drafts.values()], skipped };
}

/**
 * Raggruppa le bozze per argomento e interlocutore, come vanno presentate.
 *
 * L'ordine è stabile e le bloccanti vengono prima: se il produttore risponde
 * solo alle prime, deve aver sbloccato qualcosa.
 */
export interface QuestionBatch {
	readonly topic: string;
	readonly audience: Audience;
	readonly drafts: readonly QuestionDraft[];
	readonly blocking: boolean;
}

export function groupDrafts(drafts: readonly QuestionDraft[]): QuestionBatch[] {
	const groups = new Map<string, QuestionDraft[]>();

	for (const draft of drafts) {
		const key = `${draft.topic}\u0000${draft.audience}`;
		groups.set(key, [...(groups.get(key) ?? []), draft]);
	}

	const batches: QuestionBatch[] = [...groups.entries()].map(([key, items]) => {
		const [topic, audience] = key.split("\u0000") as [string, Audience];
		return {
			topic,
			audience,
			drafts: [...items].sort((a, b) => {
				// bloccanti prima, poi per chiave semantica
				if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
				return a.semanticKey < b.semanticKey ? -1 : a.semanticKey > b.semanticKey ? 1 : 0;
			}),
			blocking: items.some((d) => d.blocking),
		};
	});

	return batches.sort((a, b) => {
		if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
		const ka = `${a.topic}\u0000${a.audience}`;
		const kb = `${b.topic}\u0000${b.audience}`;
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});
}

// ─── Politica di rilascio ───────────────────────────────────────────────────

export interface ReleasePolicy {
	/** Numero di bozze pendenti oltre il quale si rilascia comunque. */
	readonly soglia: number;
	/** Durata della finestra di attesa, in millisecondi. */
	readonly finestraMs: number;
	/** Quante domande al massimo in un solo lotto. */
	readonly maxPerLotto: number;
}

export const POLITICA_PREDEFINITA: ReleasePolicy = {
	soglia: 5,
	// mezza giornata: abbastanza per accorpare, non tanto da sembrare fermo
	finestraMs: 12 * 60 * 60 * 1_000,
	// oltre sette domande in una volta il produttore si scoraggia
	maxPerLotto: 7,
};

export interface ReleaseState {
	readonly pending: number;
	/** Istante della bozza più vecchia, o `undefined` se non ce ne sono. */
	readonly oldestDraftAt?: number;
	/** Iniettato, non letto dall'orologio. */
	readonly now: number;
	/** Vero se un cancello è bloccato: allora non si aspetta. */
	readonly gateBlocked: boolean;
}

export type ReleaseDecision =
	| { readonly release: false; readonly reason: string }
	| { readonly release: true; readonly reason: string; readonly limit: number };

/**
 * Rilasciare o attendere.
 *
 * Tre condizioni per rilasciare, in ordine di urgenza: un cancello bloccato,
 * la soglia raggiunta, la finestra scaduta. Senza nessuna delle tre si attende,
 * perché accorpare è l'unico modo di tenere bassi i minuti chiesti al
 * produttore.
 */
export function shouldRelease(
	policy: ReleasePolicy,
	state: ReleaseState,
): ReleaseDecision {
	if (state.pending === 0) {
		return { release: false, reason: "nessuna domanda pendente" };
	}

	const limit = Math.min(state.pending, policy.maxPerLotto);

	if (state.gateBlocked) {
		return { release: true, reason: "un cancello è bloccato: non si attende", limit };
	}

	if (state.pending >= policy.soglia) {
		return {
			release: true,
			reason: `soglia raggiunta (${state.pending}/${policy.soglia})`,
			limit,
		};
	}

	if (
		state.oldestDraftAt !== undefined &&
		state.now - state.oldestDraftAt >= policy.finestraMs
	) {
		return { release: true, reason: "finestra di attesa scaduta", limit };
	}

	return {
		release: false,
		reason: `si attende: ${state.pending}/${policy.soglia} domande, finestra non scaduta`,
	};
}

// ─── Esito di una risposta ──────────────────────────────────────────────────

export type AnswerKind = "testo" | "documento" | "non_disponibile";

/**
 * Cosa segue da una risposta.
 *
 * L'Ambasciatore non propone fatti — non ha ambiti in scrittura. Restituisce
 * **cosa va proposto e da chi**, e l'orchestrazione lo esegue passando dallo
 * specialista competente e poi dalla Sentinella.
 */
export type AnswerConsequence =
	| {
			/**
			 * Il produttore ha dichiarato il dato non disponibile. Il fatto da
			 * proporre è `non_disponibile` con provenienza dichiarativa, e
			 * l'approvazione è meccanica: non c'è nulla che uno specialista possa
			 * riesaminare. Resta dell'orchestrazione, non dell'Ambasciatore.
			 */
			readonly kind: "proponi_non_disponibile";
			readonly scope: Scope;
			readonly factKey: string;
			readonly answerId: string;
			readonly approvazioneMeccanica: true;
	  }
	| {
			/** Una risposta di merito torna allo specialista competente. */
			readonly kind: "instrada_allo_specialista";
			readonly scope: Scope;
			readonly factKey: string;
			readonly answerId: string;
			readonly approvazioneMeccanica: false;
	  }
	| {
			/** Un documento allegato rientra dal Documentalista. */
			readonly kind: "instrada_al_documentalista";
			readonly documentId: string;
			readonly answerId: string;
			readonly approvazioneMeccanica: false;
	  };

export function consequenceOf(
	kind: AnswerKind,
	scope: Scope,
	factKey: string,
	answerId: string,
	documentId?: string,
): AnswerConsequence {
	switch (kind) {
		case "non_disponibile":
			return {
				kind: "proponi_non_disponibile",
				scope,
				factKey,
				answerId,
				approvazioneMeccanica: true,
			};
		case "documento":
			return {
				kind: "instrada_al_documentalista",
				documentId: documentId ?? "",
				answerId,
				approvazioneMeccanica: false,
			};
		case "testo":
			return {
				kind: "instrada_allo_specialista",
				scope,
				factKey,
				answerId,
				approvazioneMeccanica: false,
			};
	}
}

/** Il limite di cicli del programma. Oltre, si escala al Coordinatore. */
export const MAX_CICLI = 2;

export function nextCycle(cycle: number): 1 | 2 | "escalation" {
	if (cycle < 1) return 1;
	if (cycle >= MAX_CICLI) return "escalation";
	return (cycle + 1) as 2;
}
