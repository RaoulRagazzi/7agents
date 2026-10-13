/**
 * L'adattatore verso l'API Claude.
 *
 * È l'unico file che conosce l'SDK. Il kernel parla con `ModelClient`, quindi
 * si prova senza spendere; qui vivono le scelte di piattaforma e i vincoli veri
 * dell'API.
 *
 * ## Perché uno strumento e non `output_config.format`
 *
 * Le citazioni sui documenti sono **incompatibili** con `output_config.format`:
 * insieme l'API restituisce 400. E le citazioni non sono negoziabili — la
 * provenienza con pagina e intervallo è un requisito del fascicolo, non
 * un'opzione.
 *
 * Quindi l'uscita strutturata passa da uno strumento con `strict: true`, che
 * garantisce argomenti conformi allo schema e convive con le citazioni. È anche
 * più coerente col resto del progetto: `proponi_fatto` è già uno strumento del
 * catalogo, non un formato di risposta.
 *
 * Vedi docs/vinoveritas/01-architettura.md §2
 */

import Anthropic from "@anthropic-ai/sdk";

import type {
	Citation,
	ModelClient,
	ModelOutcome,
	ModelRequest,
	ModelUsage,
} from "./model.ts";

/** Lo strumento con cui ogni agente consegna la propria uscita strutturata. */
export const OUTPUT_TOOL_NAME = "proponi_fatti";

/** Il tetto di token di cui il modello è consapevole richiede questa beta. */
const TASK_BUDGET_BETA = "task-budgets-2026-03-13";

/** Minimo imposto dall'API per `task_budget.total`. */
const MIN_TASK_BUDGET = 20_000;

export interface AnthropicClientOptions {
	readonly apiKey?: string;
	readonly client?: Anthropic;
}

export class AnthropicModelClient implements ModelClient {
	readonly #client: Anthropic;

	constructor(options: AnthropicClientOptions = {}) {
		this.#client =
			options.client ??
			(options.apiKey === undefined
				? new Anthropic()
				: new Anthropic({ apiKey: options.apiKey }));
	}

	async invoke(request: ModelRequest, signal?: AbortSignal): Promise<ModelOutcome> {
		try {
			// Streaming: con max_tokens grandi una richiesta non in streaming
			// incontra i limiti di tempo HTTP, e `task_budget` lo richiede.
			const stream = this.#client.beta.messages.stream({
				model: request.model,
				max_tokens: request.maxTokens,
				betas: [TASK_BUDGET_BETA],
				// Su Opus 5 il pensiero è attivo per difetto; la profondità si
				// regola con lo sforzo, che è la prima leva di costo.
				thinking: { type: "adaptive" },
				output_config: {
					effort: request.effort,
					task_budget: {
						type: "tokens",
						total: Math.max(MIN_TASK_BUDGET, request.taskBudgetTokens),
					},
				},
				system: buildSystem(request),
				tools: [
					{
						name: OUTPUT_TOOL_NAME,
						description:
							"Consegna i fatti proposti. Ogni fatto porta l'ambito, la chiave, " +
							"il valore e gli indici delle citazioni che lo sostengono.",
						input_schema: request.outputSchema as Anthropic.Tool["input_schema"],
						// argomenti garantiti conformi allo schema
						strict: true,
					},
				],
				// `auto` più un'istruzione esplicita invece di forzare lo strumento:
				// i modelli più recenti rifiutano `tool_choice` forzato con 400.
				tool_choice: { type: "auto" },
				messages: [{ role: "user", content: buildUserContent(request) }],
			}, { signal });

			const message = await stream.finalMessage();
			return readMessage(message);
		} catch (error) {
			return mapError(error);
		}
	}
}

function buildSystem(request: ModelRequest): Anthropic.TextBlockParam[] {
	return request.stable.map((block) => ({
		type: "text" as const,
		text: block.text,
		// Il punto di interruzione sta sull'ultimo blocco stabile: tutto ciò che
		// lo precede entra in cache per un'ora. Un orario o un identificativo in
		// uno di questi blocchi annullerebbe il risparmio senza alcun errore.
		...(block.cache === true
			? { cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }
			: {}),
	}));
}

function buildUserContent(
	request: ModelRequest,
): Anthropic.Beta.BetaContentBlockParam[] {
	const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];

	for (const doc of request.documents) {
		blocks.push({
			type: "document",
			title: doc.title,
			source: { type: "text", media_type: "text/plain", data: doc.text },
			// la provenienza con pagina e intervallo arriva da qui
			citations: { enabled: doc.citations },
		});
	}

	blocks.push({
		type: "text",
		text: `${request.task}\n\nConsegna il risultato chiamando lo strumento ${OUTPUT_TOOL_NAME}.`,
	});

	return blocks;
}

function readUsage(usage: Anthropic.Beta.BetaUsage | undefined): ModelUsage {
	return {
		inputTokens: usage?.input_tokens ?? 0,
		outputTokens: usage?.output_tokens ?? 0,
		cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
		cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
	};
}

function readMessage(message: Anthropic.Beta.BetaMessage): ModelOutcome {
	const usage = readUsage(message.usage);

	// Lo stato si controlla prima del contenuto: un rifiuto arriva con HTTP 200.
	if (message.stop_reason === "refusal") {
		return {
			kind: "rifiuto",
			category: message.stop_details?.category ?? null,
			usage,
		};
	}

	if (message.stop_reason === "max_tokens") {
		return { kind: "troncato", usage };
	}

	const citations: Citation[] = [];
	let data: unknown;

	for (const block of message.content) {
		if (block.type === "tool_use" && block.name === OUTPUT_TOOL_NAME) {
			// L'input arriva già come oggetto: non va mai confrontato come stringa,
			// perché l'escaping del JSON varia fra modelli.
			data = block.input;
			continue;
		}

		if (block.type === "text") {
			for (const citation of block.citations ?? []) {
				const mapped = mapCitation(citation);
				if (mapped !== undefined) citations.push(mapped);
			}
		}
	}

	if (data === undefined) {
		return {
			kind: "errore",
			retryable: true,
			message: `il modello non ha chiamato ${OUTPUT_TOOL_NAME}`,
			usage,
		};
	}

	return { kind: "ok", data, citations, usage };
}

function mapCitation(citation: Anthropic.TextCitation): Citation | undefined {
	switch (citation.type) {
		case "page_location":
			return {
				documentId: citation.document_title ?? String(citation.document_index),
				page: citation.start_page_number,
				citedText: citation.cited_text,
			};
		case "char_location":
			return {
				documentId: citation.document_title ?? String(citation.document_index),
				// una citazione per caratteri non ha pagina: 0 significa "documento"
				page: 0,
				charStart: citation.start_char_index,
				charEnd: citation.end_char_index,
				citedText: citation.cited_text,
			};
		default:
			return undefined;
	}
}

/**
 * Distingue il ritentabile dal definitivo. Una sola `catch` generica
 * perderebbe la differenza, e il kernel ritenterebbe un 400 tre volte.
 */
function mapError(error: unknown): ModelOutcome {
	if (error instanceof Anthropic.APIUserAbortError) {
		return { kind: "errore", retryable: false, message: "attività interrotta" };
	}
	if (error instanceof Anthropic.RateLimitError) {
		return { kind: "errore", retryable: true, message: `limite di frequenza: ${error.message}` };
	}
	if (error instanceof Anthropic.APIConnectionError) {
		return { kind: "errore", retryable: true, message: `connessione: ${error.message}` };
	}
	if (error instanceof Anthropic.AuthenticationError) {
		return { kind: "errore", retryable: false, message: `autenticazione: ${error.message}` };
	}
	if (error instanceof Anthropic.BadRequestError) {
		// una richiesta malformata non migliora ritentandola
		return { kind: "errore", retryable: false, message: `richiesta non valida: ${error.message}` };
	}
	if (error instanceof Anthropic.APIError) {
		const status = error.status ?? 0;
		return {
			kind: "errore",
			retryable: status >= 500 || status === 408 || status === 409,
			message: `API ${status}: ${error.message}`,
		};
	}
	return {
		kind: "errore",
		retryable: false,
		message: error instanceof Error ? error.message : String(error),
	};
}
