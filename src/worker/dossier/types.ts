/**
 * Fascicolo VinoVeritas — contratto delle fondamenta comuni (Tranche 2).
 *
 * Questi tipi sono la forma su cui lavorano tutti e dieci gli agenti. Le tre
 * invarianti del programma sono espresse qui come vincoli di tipo, non come
 * raccomandazioni: un fatto senza provenienza non è rappresentabile, un ambito
 * non è una stringa libera, e lo stato di approvazione non è un booleano.
 *
 * Vedi docs/vinoveritas/02-fascicolo.md
 */

/** Ambiti, dal più ampio al più stretto. La chiave di un fatto li include. */
export type ScopeType =
	| "cantina"
	| "marchio"
	| "sede"
	| "vino"
	| "annata"
	| "lotto"
	| "vigneto"
	| "territorio";

/**
 * L'identità di un fatto è (cantinaId, scope, key) — mai la sola chiave.
 * È ciò che impedisce alla gradazione del 2021 di collidere con quella del 2022.
 */
export interface Scope {
	readonly type: ScopeType;
	/** Riferimento interno all'ambito: id vino, "wine_1f2c:2021", denominazione. */
	readonly ref: string;
}

/**
 * Ciclo di vita del fatto. `approvato` è l'unico stato leggibile dal piano di
 * attivazione; `superato` conserva la storia fuori dall'indice dei fatti vivi.
 */
export type FactState =
	| "proposto"
	| "da_confermare"
	| "approvato"
	| "superato";

/** I dati amministrativi riservati non raggiungono mai i contenuti pubblici. */
export type Visibility = "pubblico" | "commerciale" | "interno" | "riservato";

/**
 * Provenienza. Unione discriminata: ogni variante porta ciò che serve a tornare
 * alla fonte originale, perché la Sentinella controlla i documenti, non i
 * riepiloghi degli altri agenti.
 */
export type Provenance =
	| {
			readonly kind: "documento";
			readonly documentId: string;
			readonly page: number;
			readonly charStart?: number;
			readonly charEnd?: number;
	  }
	| {
			readonly kind: "dichiarazione";
			readonly answerId: string;
			readonly respondent: string;
			readonly receivedAt: number;
	  }
	| {
			readonly kind: "pagina_pubblica";
			readonly url: string;
			readonly retrievedAt: number;
			readonly snapshotKey?: string;
	  }
	| {
			readonly kind: "derivato";
			readonly fromFactIds: readonly string[];
			readonly rule: string;
	  }
	| {
			readonly kind: "inferenza_modello";
			readonly promptVersion: string;
			readonly runId: string;
	  };

/** Il valore dichiarato non disponibile è un dato approvato, non un'assenza. */
export type FactValue =
	| { readonly kind: "testo"; readonly text: string }
	| { readonly kind: "numero"; readonly value: number; readonly unit: string }
	| { readonly kind: "data"; readonly iso: string }
	| { readonly kind: "elenco"; readonly items: readonly string[] }
	| { readonly kind: "booleano"; readonly value: boolean }
	| { readonly kind: "non_disponibile" };

export interface Fact {
	readonly id: string;
	readonly cantinaId: string;
	readonly scope: Scope;
	readonly key: string;
	readonly value: FactValue;
	readonly lang?: string;
	readonly state: FactState;
	readonly visibility: Visibility;
	readonly confidence?: number;
	readonly version: number;
	readonly supersedes?: string;
	readonly agent: string;
	readonly promptVersion: string;
	/** Mai vuota: è l'invariante "nessun dato senza provenienza". */
	readonly provenance: readonly [Provenance, ...Provenance[]];
	readonly createdAt: number;
	readonly approvedAt?: number;
	readonly approvedBy?: string;
}

/** Le quattro categorie della Sentinella. */
export type IssueSeverity =
	| "bloccante"
	| "da_confermare"
	| "miglioramento"
	| "superato";

/** Le destinazioni che un'anomalia può sospendere, una per volta. */
export type GateTarget =
	| "profilo"
	| "referenza"
	| "sommelier"
	| "materiali_commerciali";

/**
 * Destinazione concreta: `referenza` è sempre qualificata dall'id del vino, così
 * che un bloccante su una referenza non fermi le altre ventinove.
 */
export interface TargetRef {
	readonly target: GateTarget;
	readonly ref?: string;
}

export interface Issue {
	readonly id: string;
	readonly cantinaId: string;
	readonly severity: IssueSeverity;
	readonly code: string;
	readonly scope: Scope;
	/** Il dato interessato, come richiesto dal programma. */
	readonly factKey?: string;
	/** Le evidenze: riferimenti a fatti e a passaggi di documento. */
	readonly evidence: readonly Provenance[];
	/**
	 * Il motivo in chiaro, con la motivazione del controllo. È il testo da cui
	 * l'Ambasciatore formula la domanda: ricostruirlo a valle non darebbe la
	 * stessa cosa.
	 */
	readonly detail?: string;
	readonly targets: readonly TargetRef[];
	readonly state: "aperta" | "in_domanda" | "risolta" | "accettata";
	/** Due cicli senza esito, poi escalation al Coordinatore. */
	readonly cycle: 1 | 2;
}

/**
 * Un'anomalia su `a` riguarda la destinazione `b`?
 *
 * La relazione è simmetrica nell'assenza di riferimento: un'anomalia non
 * qualificata riguarda ogni referenza, e una domanda non qualificata («qualche
 * referenza è sospesa?») è riguardata da ogni anomalia su una referenza. Senza
 * il secondo verso, chiedere «referenza» senza riferimento darebbe sempre falso
 * pur essendoci un blocco — un errore silenzioso.
 *
 * Definita una volta sola perché i cancelli e la Sentinella non possano
 * divergere su cosa sospende cosa.
 */
export function targetMatches(a: TargetRef, b: TargetRef): boolean {
	if (a.target !== b.target) return false;
	if (a.ref === undefined || b.ref === undefined) return true;
	return a.ref === b.ref;
}

/**
 * I quattro stati che il Responsabile dell'attivazione distingue sempre.
 * `verificato` si raggiunge solo rileggendo da VinoVeritas.
 */
export type ActivationState =
	| "preparato"
	| "salvato"
	| "pubblicato"
	| "verificato"
	| "fallito";

export interface ActivationOperation {
	readonly id: string;
	readonly cantinaId: string;
	readonly target: TargetRef;
	/**
	 * sha256(cantinaId, target, ref, [(factId, version) ordinati]).
	 * Vincolo di unicità in D1: ritentare dopo un errore non duplica.
	 */
	readonly operationKey: string;
	readonly payloadHash: string;
	readonly state: ActivationState;
	readonly externalId?: string;
	readonly attempts: number;
	readonly lastError?: string;
	readonly verifiedAt?: number;
}

/** Una riga per esecuzione: è la fonte del costo per cantina attivata. */
export interface AgentRun {
	readonly id: string;
	readonly cantinaId: string;
	readonly agent: string;
	readonly model: string;
	readonly promptVersion: string;
	readonly effort: "low" | "medium" | "high" | "xhigh" | "max";
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly costUsd: number;
	readonly durationMs: number;
	readonly outcome: "ok" | "rifiutato" | "limite_superato" | "errore";
}

/**
 * Nessun agente approva. `writeScopes` è sempre un sottoinsieme di `readScopes`,
 * e la funzione di ammissione respinge le scritture fuori ambito registrando
 * l'evento invece di eseguirlo.
 */
export interface AgentSpec {
	readonly id: string;
	readonly promptVersion: string;
	readonly model: string;
	readonly effort: AgentRun["effort"];
	readonly readScopes: readonly ScopeType[];
	readonly writeScopes: readonly ScopeType[];
	readonly tools: readonly string[];
	readonly budget: {
		readonly maxDurationMs: number;
		readonly maxCostUsd: number;
		readonly maxAttempts: number;
		readonly taskBudgetTokens: number;
	};
	/** Falso per tutti e dieci: l'approvazione è una transizione, non un'uscita. */
	readonly canApprove: false;
}

/**
 * Una provenienza `inferenza_modello` non può mai portare da sola
 * all'approvazione: è il confine fra proposta e dato.
 */
export function canReachApproved(
	provenance: readonly Provenance[],
): boolean {
	return provenance.some(
		(p) => p.kind === "documento" || p.kind === "dichiarazione",
	);
}

/**
 * Regola di non contaminazione: un fatto di un ambito non è leggibile come
 * fatto di un altro. L'attraversamento esiste solo come promozione esplicita,
 * che genera un fatto `da_confermare` e una domanda.
 */
export function isSameScope(a: Scope, b: Scope): boolean {
	return a.type === b.type && a.ref === b.ref;
}
