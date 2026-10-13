/**
 * I cancelli del Coordinatore.
 *
 * Il "via libera" non è una frase del modello: è il risultato di questa
 * funzione pura, valutata sull'insieme dei fatti APPROVATI e delle anomalie
 * aperte. Un'anomalia bloccante sulla destinazione chiude il cancello
 * qualunque cosa il Coordinatore abbia concluso.
 *
 * Vedi docs/vinoveritas/04-flussi.md §2
 */

import type { Fact, GateTarget, Issue, TargetRef } from "./types.ts";
import { targetMatches } from "./types.ts";

export interface GateRequirement {
	/** Ambito in cui la chiave deve esistere, approvata. */
	readonly scopeType: Fact["scope"]["type"];
	readonly key: string;
	/** Se falso, un valore `non_disponibile` dichiarato soddisfa comunque. */
	readonly mustHaveValue: boolean;
}

export interface GateSpec {
	readonly target: GateTarget;
	readonly requires: readonly GateRequirement[];
	/** Cancelli che devono essere già aperti. */
	readonly dependsOn: readonly GateTarget[];
	readonly minReferences?: number;
}

export type GateResult =
	| { readonly open: true }
	| { readonly open: false; readonly reasons: readonly string[] };

/**
 * I cancelli sono dati dichiarativi: tararli non richiede di toccare la logica
 * di orchestrazione.
 */
export const GATES: Readonly<Record<GateTarget, GateSpec>> = {
	profilo: {
		target: "profilo",
		requires: [
			{ scopeType: "cantina", key: "ragione_sociale", mustHaveValue: true },
			{ scopeType: "sede", key: "sede_legale", mustHaveValue: true },
			{ scopeType: "cantina", key: "contatto_pubblico", mustHaveValue: true },
			{ scopeType: "marchio", key: "nome_commerciale", mustHaveValue: true },
			{ scopeType: "cantina", key: "storia_sintesi", mustHaveValue: false },
		],
		dependsOn: [],
	},
	referenza: {
		target: "referenza",
		requires: [
			{ scopeType: "vino", key: "denominazione", mustHaveValue: true },
			{ scopeType: "vino", key: "tipologia", mustHaveValue: true },
			{ scopeType: "vino", key: "vitigni", mustHaveValue: true },
			{ scopeType: "annata", key: "gradazione_alcolica", mustHaveValue: true },
		],
		dependsOn: [],
	},
	sommelier: {
		target: "sommelier",
		requires: [
			{ scopeType: "cantina", key: "pacchetto_contenuti", mustHaveValue: true },
		],
		dependsOn: ["profilo"],
		minReferences: 3,
	},
	materiali_commerciali: {
		target: "materiali_commerciali",
		requires: [
			{ scopeType: "cantina", key: "lingue_richieste", mustHaveValue: true },
		],
		dependsOn: ["profilo"],
		minReferences: 1,
	},
};

/**
 * Un'anomalia bloccante è rilevante se punta a questa destinazione.
 *
 * La relazione vive in `targetMatches`: una referenza non qualificata blocca
 * tutte, qualificata solo la sua.
 */
function blocks(issue: Issue, target: TargetRef): boolean {
	if (issue.severity !== "bloccante") return false;
	if (issue.state === "risolta" || issue.state === "accettata") return false;
	return issue.targets.some((t) => targetMatches(t, target));
}

function satisfies(fact: Fact, req: GateRequirement): boolean {
	if (fact.state !== "approvato") return false;
	if (fact.scope.type !== req.scopeType) return false;
	if (fact.key !== req.key) return false;
	if (req.mustHaveValue && fact.value.kind === "non_disponibile") return false;
	return true;
}

/**
 * Valuta un cancello.
 *
 * Proprietà verificate dai test:
 *  - solo i fatti `approvato` contano: un fascicolo di soli `proposto` dà chiuso;
 *  - aggiungere un'anomalia bloccante non può aprire un cancello chiuso;
 *  - un bloccante su `referenza:X` non chiude `referenza:Y`.
 */
export function evaluateGate(
	target: TargetRef,
	facts: readonly Fact[],
	issues: readonly Issue[],
	openGates: readonly GateTarget[] = [],
	readyReferences = 0,
): GateResult {
	const spec = GATES[target.target];
	const reasons: string[] = [];

	for (const dep of spec.dependsOn) {
		if (!openGates.includes(dep)) {
			reasons.push(`cancello richiesto non aperto: ${dep}`);
		}
	}

	if (spec.minReferences !== undefined && readyReferences < spec.minReferences) {
		reasons.push(
			`referenze pronte insufficienti: ${readyReferences}/${spec.minReferences}`,
		);
	}

	for (const req of spec.requires) {
		const inScope = facts.filter(
			(f) => target.ref === undefined || isRelevantRef(f, target.ref),
		);
		if (!inScope.some((f) => satisfies(f, req))) {
			reasons.push(`dato mancante o non approvato: ${req.scopeType}/${req.key}`);
		}
	}

	for (const issue of issues) {
		if (blocks(issue, target)) {
			reasons.push(`anomalia bloccante: ${issue.code} (${issue.id})`);
		}
	}

	return reasons.length === 0 ? { open: true } : { open: false, reasons };
}

/** Per una referenza, i fatti rilevanti sono quelli del vino e delle sue annate. */
function isRelevantRef(fact: Fact, ref: string): boolean {
	if (fact.scope.ref === ref) return true;
	// annata: "wine_1f2c:2021" — lotto: "wine_1f2c:2021:lot_7"
	return fact.scope.ref.startsWith(`${ref}:`);
}
