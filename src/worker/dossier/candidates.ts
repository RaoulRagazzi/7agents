/**
 * Risoluzione delle fonti contraddittorie.
 *
 * Quando più fonti propongono valori diversi per la stessa (ambito, chiave), il
 * sistema non scegle in base alla fiducia dichiarata dal modello: applica una
 * tabella di precedenza deterministica e, a pari livello, apre un'anomalia.
 *
 * Vedi docs/vinoveritas/02-fascicolo.md §3
 */

import { PRECEDENZA, TOLLERANZA } from "./admission.ts";
import type { FactValue, IssueSeverity, Provenance } from "./types.ts";

/** Il livello di precedenza di una provenienza. */
export type SourceLevel = keyof typeof PRECEDENZA;

export interface Candidate {
	readonly id: string;
	readonly value: FactValue;
	/**
	 * `documento_ufficiale` non è una variante di `Provenance`: è un documento
	 * la cui classificazione lo rende autorevole (certificazione, atto). La
	 * distinzione vive nella classe del documento, non nel tipo di provenienza.
	 */
	readonly level: SourceLevel;
	readonly provenance: Provenance;
}

export type Resolution =
	| {
			readonly outcome: "unico";
			readonly winner: Candidate;
			readonly state: "proposto";
			readonly discarded: readonly Candidate[];
	  }
	| {
			readonly outcome: "precedenza";
			readonly winner: Candidate;
			readonly state: "proposto";
			readonly discarded: readonly Candidate[];
	  }
	| {
			readonly outcome: "concorde";
			readonly winner: Candidate;
			readonly state: "proposto";
			readonly discarded: readonly Candidate[];
	  }
	| {
			readonly outcome: "contraddizione";
			/** Nessun vincitore: il dato resta fuori dall'attivazione. */
			readonly severity: Extract<IssueSeverity, "da_confermare">;
			readonly code: string;
			readonly conflicting: readonly Candidate[];
	  }
	| { readonly outcome: "nessun_candidato" };

/** Due valori sono concordi entro la tolleranza della chiave. */
export function valuesAgree(
	key: string,
	a: FactValue,
	b: FactValue,
): boolean {
	if (a.kind !== b.kind) return false;

	switch (a.kind) {
		case "numero": {
			const other = b as Extract<FactValue, { kind: "numero" }>;
			if (a.unit !== other.unit) return false;
			// una tolleranza non dichiarata significa nessuna variante ammessa
			const tolerance = TOLLERANZA[key] ?? 0;
			return Math.abs(a.value - other.value) <= tolerance;
		}
		case "testo": {
			const other = b as Extract<FactValue, { kind: "testo" }>;
			return normalise(a.text) === normalise(other.text);
		}
		case "data":
			return a.iso === (b as Extract<FactValue, { kind: "data" }>).iso;
		case "booleano":
			return a.value === (b as Extract<FactValue, { kind: "booleano" }>).value;
		case "elenco": {
			const other = b as Extract<FactValue, { kind: "elenco" }>;
			if (a.items.length !== other.items.length) return false;
			const left = [...a.items].map(normalise).sort();
			const right = [...other.items].map(normalise).sort();
			return left.every((x, i) => x === right[i]);
		}
		case "non_disponibile":
			return true;
	}
}

function normalise(text: string): string {
	return (
		text
			.normalize("NFKD")
			.replace(/\p{Diacritic}/gu, "")
			// i punti delle abbreviazioni cadono prima della punteggiatura
			// generale: nel dominio "D.O.C." e "DOC" sono la stessa denominazione,
			// e lo stesso vale per "S.r.l." e "Srl". Il punto va rimosso, non
			// convertito in spazio, altrimenti diventa "d o c"
			.replace(/\./g, "")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.trim()
	);
}

/**
 * Risolve i candidati per una chiave.
 *
 * - un solo candidato, o tutti concordi → proposto;
 * - il più autorevole è isolato al suo livello → proposto, gli altri registrati;
 * - i primi due sono a pari livello e divergono → contraddizione, nessun
 *   vincitore: il dato non raggiunge l'attivazione.
 */
export function resolveCandidates(
	key: string,
	candidates: readonly Candidate[],
): Resolution {
	if (candidates.length === 0) return { outcome: "nessun_candidato" };

	const sorted = [...candidates].sort(
		(a, b) => PRECEDENZA[a.level] - PRECEDENZA[b.level],
	);
	// non-null: la guardia sulla lunghezza garantisce il primo elemento
	const head = sorted[0]!;
	const rest = sorted.slice(1);

	if (rest.length === 0) {
		return { outcome: "unico", winner: head, state: "proposto", discarded: [] };
	}

	if (rest.every((c) => valuesAgree(key, head.value, c.value))) {
		return { outcome: "concorde", winner: head, state: "proposto", discarded: rest };
	}

	// i candidati al livello di testa che divergono dal capofila
	const sameLevel = rest.filter(
		(c) => PRECEDENZA[c.level] === PRECEDENZA[head.level],
	);
	const dissenting = sameLevel.filter(
		(c) => !valuesAgree(key, head.value, c.value),
	);

	if (dissenting.length > 0) {
		return {
			outcome: "contraddizione",
			severity: "da_confermare",
			code: `CONTRADDIZIONE_${key.toUpperCase()}`,
			conflicting: [head, ...dissenting],
		};
	}

	// il capofila è isolato al suo livello: la precedenza decide
	return { outcome: "precedenza", winner: head, state: "proposto", discarded: rest };
}
