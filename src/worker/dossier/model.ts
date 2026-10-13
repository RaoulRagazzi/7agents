/**
 * La porta verso il modello, e la contabilità di ciò che costa.
 *
 * Il kernel d'agente non parla con l'SDK: parla con questa interfaccia. Due
 * conseguenze volute: il kernel si prova senza spendere, e la misura del costo
 * vive in un unico punto invece di essere stimata a valle.
 *
 * Vedi docs/vinoveritas/01-architettura.md §3 e docs/vinoveritas/05-piano.md §5
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Un blocco del prefisso stabile. Entra in cache e **non deve contenere nulla
 * che vari fra chiamate**: un orario, un identificativo, un ordine di chiavi
 * non deterministico invalidano il prefisso e il risparmio svanisce senza
 * che nulla si rompa visibilmente.
 */
export interface StableBlock {
	readonly text: string;
	/** L'ultimo blocco stabile porta il punto di interruzione della cache. */
	readonly cache?: boolean;
}

/** Un documento passato al modello, con le citazioni attive. */
export interface DocumentBlock {
	readonly documentId: string;
	readonly title: string;
	readonly text: string;
	/**
	 * Le citazioni sono sempre attive: la provenienza con pagina e intervallo è
	 * un requisito del fascicolo, non un'opzione della richiesta.
	 */
	readonly citations: true;
}

export interface ModelRequest {
	readonly model: string;
	readonly effort: Effort;
	/** Istruzioni versionate + ontologia: la parte che va in cache. */
	readonly stable: readonly StableBlock[];
	/** La fetta di fascicolo e i documenti: la parte che varia. */
	readonly documents: readonly DocumentBlock[];
	readonly task: string;
	/** Schema rigido dell'uscita: un'estrazione non conforme non esiste. */
	readonly outputSchema: unknown;
	readonly maxTokens: number;
	/** Tetto di token di cui il modello è consapevole: si conclude con ordine. */
	readonly taskBudgetTokens: number;
}

export interface ModelUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheCreationTokens: number;
}

export interface Citation {
	readonly documentId: string;
	readonly page: number;
	readonly charStart?: number;
	readonly charEnd?: number;
	readonly citedText: string;
}

export type ModelOutcome =
	| {
			readonly kind: "ok";
			/** L'uscita strutturata, già validata contro lo schema dal server. */
			readonly data: unknown;
			readonly citations: readonly Citation[];
			readonly usage: ModelUsage;
	  }
	| {
			readonly kind: "rifiuto";
			readonly category: string | null;
			readonly usage: ModelUsage;
	  }
	| {
			readonly kind: "troncato";
			readonly usage: ModelUsage;
	  }
	| {
			readonly kind: "errore";
			readonly retryable: boolean;
			readonly message: string;
			readonly usage?: ModelUsage;
	  };

export interface ModelClient {
	/**
	 * `signal` porta la scadenza dell'attività. Un budget di durata che non
	 * raggiunge la richiesta in volo non limita nulla: controllare il tempo
	 * *fra* i tentativi lascia passare una singola chiamata lunga quanto vuole.
	 */
	invoke(request: ModelRequest, signal?: AbortSignal): Promise<ModelOutcome>;
}

/**
 * Tariffe in dollari per milione di token, al 24 giugno 2026.
 *
 * Vanno riverificate: una tariffa che cambia e non viene aggiornata non rompe
 * nulla, falsifica solo l'indicatore «costo per cantina attivata». Per questo
 * il listino è un dato esplicito e non una costante sparsa nel codice.
 */
export interface ModelRates {
	readonly input: number;
	readonly output: number;
	/** Lettura dalla cache: circa un decimo dell'ingresso. */
	readonly cacheRead: number;
	/** Scrittura in cache: circa 1,25 volte l'ingresso. */
	readonly cacheWrite: number;
}

export const RATES: Readonly<Record<string, ModelRates>> = {
	"claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	"claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export const RATES_AS_OF = "2026-06-24";

/** Il modello predefinito di tutti e dieci gli agenti. */
export const DEFAULT_MODEL = "claude-opus-5";

/**
 * Il costo di una chiamata, in dollari.
 *
 * `inputTokens` non comprende i token letti dalla cache né quelli scritti: le
 * tre voci sono disgiunte e si tariffano separatamente.
 */
export function computeCost(model: string, usage: ModelUsage): number {
	const rates = RATES[model];
	if (rates === undefined) {
		throw new Error(`tariffe non note per il modello ${model}`);
	}

	return (
		(usage.inputTokens * rates.input +
			usage.outputTokens * rates.output +
			usage.cacheReadTokens * rates.cacheRead +
			usage.cacheCreationTokens * rates.cacheWrite) /
		1_000_000
	);
}

/**
 * Quota di token serviti dalla cache. È la metrica da guardare: se resta a
 * zero fra chiamate consecutive dello stesso agente, qualcosa invalida il
 * prefisso stabile — e la prima leva di costo, che è gratuita, non sta
 * funzionando.
 */
export function cacheHitRatio(usage: ModelUsage): number {
	const total = usage.inputTokens + usage.cacheReadTokens;
	return total === 0 ? 0 : usage.cacheReadTokens / total;
}

export const ZERO_USAGE: ModelUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheCreationTokens: 0,
};

export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
		cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
	};
}
