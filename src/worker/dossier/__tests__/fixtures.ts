/** Costruttori per i casi di prova del fascicolo. */

import type { Fact, Issue, Provenance, ScopeType } from "../types.ts";

export const PROV_DOC: Provenance = {
	kind: "documento",
	documentId: "doc_1",
	page: 3,
};

export const PROV_DICH: Provenance = {
	kind: "dichiarazione",
	answerId: "ans_1",
	respondent: "titolare",
	receivedAt: 1,
};

export const PROV_INFERENZA: Provenance = {
	kind: "inferenza_modello",
	promptVersion: "x@1",
	runId: "run_1",
};

export const PROV_WEB: Provenance = {
	kind: "pagina_pubblica",
	url: "https://example.invalid/chi-siamo",
	retrievedAt: 1,
};

export function fact(
	scopeType: ScopeType,
	scopeRef: string,
	key: string,
	overrides: Partial<Fact> = {},
): Fact {
	return {
		id: `${scopeType}:${scopeRef}:${key}`,
		cantinaId: "c1",
		scope: { type: scopeType, ref: scopeRef },
		key,
		value: { kind: "testo", text: "valore" },
		state: "approvato",
		visibility: "pubblico",
		version: 1,
		agent: "test",
		promptVersion: "test@1",
		provenance: [PROV_DOC],
		createdAt: 0,
		approvedAt: 1,
		approvedBy: "orchestratore",
		...overrides,
	};
}

/** I fatti minimi perché `referenza_pronta(wine)` possa aprirsi. */
export function referenceFacts(wine: string): Fact[] {
	return [
		fact("vino", wine, "denominazione"),
		fact("vino", wine, "tipologia"),
		fact("vino", wine, "vitigni"),
		fact("annata", `${wine}:2021`, "gradazione_alcolica"),
	];
}

export function blockingIssue(
	wineRef: string,
	overrides: Partial<Issue> = {},
): Issue {
	return {
		id: `issue_${wineRef}`,
		cantinaId: "c1",
		severity: "bloccante",
		code: "CONTRADDIZIONE_GRADAZIONE",
		scope: { type: "vino", ref: wineRef },
		evidence: [PROV_DOC],
		targets: [{ target: "referenza", ref: wineRef }],
		state: "aperta",
		cycle: 1,
		...overrides,
	};
}
