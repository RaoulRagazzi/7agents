/**
 * Un `ModelClient` finto: il kernel si prova senza spendere.
 *
 * Non imita il modello — imita la **porta**. Le risposte sono programmate dal
 * test, e l'oggetto registra le richieste ricevute, che è ciò che serve per
 * verificare il prefisso stabile e la cache.
 */

import type {
	Citation,
	ModelClient,
	ModelOutcome,
	ModelRequest,
	ModelUsage,
} from "../model.ts";

export const USAGE_TIPICA: ModelUsage = {
	inputTokens: 10_000,
	outputTokens: 3_000,
	cacheReadTokens: 15_000,
	cacheCreationTokens: 0,
};

export function usage(over: Partial<ModelUsage> = {}): ModelUsage {
	return { ...USAGE_TIPICA, ...over };
}

export class FakeModel implements ModelClient {
	readonly requests: ModelRequest[] = [];
	#queue: ModelOutcome[] = [];
	#fallback: ModelOutcome;

	constructor(fallback?: ModelOutcome) {
		this.#fallback =
			fallback ?? { kind: "ok", data: {}, citations: [], usage: usage() };
	}

	/** Programma gli esiti, nell'ordine in cui verranno restituiti. */
	queue(...outcomes: ModelOutcome[]): this {
		this.#queue.push(...outcomes);
		return this;
	}

	always(outcome: ModelOutcome): this {
		this.#fallback = outcome;
		return this;
	}

	get calls(): number {
		return this.requests.length;
	}

	invoke(request: ModelRequest): Promise<ModelOutcome> {
		this.requests.push(request);
		return Promise.resolve(this.#queue.shift() ?? this.#fallback);
	}
}

export function okWith(
	facts: unknown[],
	citations: readonly Citation[] = [],
	over: Partial<ModelUsage> = {},
): ModelOutcome {
	return { kind: "ok", data: { facts }, citations, usage: usage(over) };
}

export function citation(documentId: string, page: number): Citation {
	return { documentId, page, citedText: "passaggio citato" };
}
