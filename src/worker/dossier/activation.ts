/**
 * Attivazione idempotente.
 *
 * La chiave d'operazione include le versioni dei fatti usati. Ne seguono le due
 * proprietà che il programma richiede: ritentare dopo un errore non duplica, e
 * aggiornare resta distinguibile dal creare.
 *
 * Vedi docs/vinoveritas/04-flussi.md §4
 */

import type { ActivationState, TargetRef } from "./types.ts";

export interface FactVersionRef {
	readonly factId: string;
	readonly version: number;
}

/**
 * Chiave deterministica dell'operazione.
 *
 * I riferimenti vengono ordinati prima dell'impronta: lo stesso insieme di fatti
 * presentato in ordine diverso deve dare la stessa chiave, altrimenti un
 * ritentativo con una query non ordinata creerebbe un duplicato.
 */
export async function operationKey(
	cantinaId: string,
	target: TargetRef,
	facts: readonly FactVersionRef[],
): Promise<string> {
	const ordered = [...facts]
		.sort((a, b) =>
			a.factId === b.factId ? a.version - b.version : a.factId < b.factId ? -1 : 1,
		)
		.map((f) => `${f.factId}@${f.version}`);

	const payload = JSON.stringify([
		cantinaId,
		target.target,
		target.ref ?? null,
		ordered,
	]);

	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(payload),
	);

	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export type ActivationEvent =
	| "salva_riuscito"
	| "pubblica_riuscito"
	| "verifica_coincide"
	| "verifica_divergente"
	| "abbandona";

export interface ActivationTransition {
	readonly state: ActivationState;
	/**
	 * Presente quando la transizione richiede di aprire un'anomalia. Una
	 * divergenza fra ciò che abbiamo scritto e ciò che rileggiamo significa che
	 * qualcosa non abbiamo capito: ritentare la amplificherebbe.
	 */
	readonly raiseIssueCode?: string;
}

/**
 * Macchina a stati dell'attivazione. Restituisce `null` per una transizione non
 * ammessa — fra cui qualunque evento su uno stato terminale.
 *
 * `verificato` si raggiunge solo da `pubblicato` con `verifica_coincide`, cioè
 * dopo una rilettura da VinoVeritas: l'assenza di errore in scrittura non è una
 * verifica.
 */
export function applyActivationEvent(
	current: ActivationState,
	event: ActivationEvent,
): ActivationTransition | null {
	if (current === "verificato" || current === "fallito") return null;

	if (event === "abbandona") return { state: "fallito" };

	switch (current) {
		case "preparato":
			return event === "salva_riuscito" ? { state: "salvato" } : null;
		case "salvato":
			return event === "pubblica_riuscito" ? { state: "pubblicato" } : null;
		case "pubblicato":
			if (event === "verifica_coincide") return { state: "verificato" };
			if (event === "verifica_divergente") {
				// nessun ritentativo automatico: si segnala
				return {
					state: "pubblicato",
					raiseIssueCode: "DIVERGENZA_POST_SALVATAGGIO",
				};
			}
			return null;
	}
}

export interface ExistingOperation {
	readonly operationKey: string;
	readonly state: ActivationState;
	readonly attempts: number;
}

export type ActivationDecision =
	| { readonly action: "salta"; readonly reason: string }
	| { readonly action: "riprendi"; readonly from: ActivationState }
	| { readonly action: "prepara" }
	| { readonly action: "blocca"; readonly reason: string };

/**
 * Decide cosa fare davanti a un'operazione con questa chiave. È la funzione che
 * rende il ritentativo sicuro: la ripresa riparte dal punto raggiunto invece di
 * rifare ciò che è già riuscito.
 */
export function decideActivation(
	existing: ExistingOperation | undefined,
	maxAttempts: number,
): ActivationDecision {
	if (existing === undefined) return { action: "prepara" };

	if (existing.state === "verificato") {
		return { action: "salta", reason: "operazione già verificata" };
	}

	if (existing.attempts >= maxAttempts) {
		return {
			action: "blocca",
			reason: `tentativi esauriti (${existing.attempts}/${maxAttempts})`,
		};
	}

	if (existing.state === "fallito") {
		return { action: "blocca", reason: "operazione abbandonata" };
	}

	return { action: "riprendi", from: existing.state };
}
