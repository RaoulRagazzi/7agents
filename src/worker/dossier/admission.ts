/**
 * La funzione di ammissione.
 *
 * È l'unico varco fra il piano cognitivo e il fascicolo, ed è il punto in cui
 * le invarianti del programma smettono di essere raccomandazioni. Un agente
 * propone; questa funzione decide se la proposta diventa un record. Ogni
 * rifiuto viene registrato (tabella `admission_rejection`) invece di riuscire.
 *
 * Vedi docs/vinoveritas/02-fascicolo.md e docs/vinoveritas/03-agenti.md
 */

import type {
	Fact,
	FactState,
	Provenance,
	Scope,
	Visibility,
} from "./types.ts";
import { canReachApproved } from "./types.ts";
import type { VinoVeritasAgentSpec } from "./agents.ts";

/** Ciò che un agente può emettere: una proposta, non un fatto. */
export interface FactDraft {
	readonly cantinaId: string;
	readonly scope: Scope;
	readonly key: string;
	readonly value: Fact["value"];
	readonly lang?: string;
	readonly visibility: Visibility;
	readonly confidence?: number;
	readonly provenance: readonly Provenance[];
	/** Un agente può proporre solo questi due stati. */
	readonly state: Extract<FactState, "proposto" | "da_confermare">;
}

export type RejectionCode =
	| "PROVENIENZA_ASSENTE"
	| "AMBITO_NON_CONCESSO"
	| "STATO_NON_PROPONIBILE"
	| "CHIAVE_RISERVATA_ESPOSTA"
	| "CHIAVE_NON_AMMESSA"
	| "STRUMENTO_ASSENTE"
	| "FIDUCIA_FUORI_INTERVALLO";

export type Admission =
	| { readonly ok: true; readonly draft: FactDraft }
	| {
			readonly ok: false;
			readonly code: RejectionCode;
			readonly detail: string;
	  };

/**
 * Chiavi che non possono essere pubbliche: i dati amministrativi riservati
 * restano separati dai contenuti pubblici, e il filtro non è una convenzione
 * applicata a valle ma un rifiuto in ingresso.
 */
const CHIAVI_RISERVATE: readonly string[] = [
	"codice_fiscale",
	"partita_iva",
	"identificativo_fiscale",
	"sede_legale",
	"contatto_amministrativo",
	"iban",
	"rea",
];

/**
 * Chiavi che il sistema non ammette da nessun agente. `nota_degustazione_agente`
 * è la più importante: l'agente non degusta, e una nota del produttore non può
 * essere presentata come una degustazione propria.
 */
const CHIAVI_VIETATE: readonly string[] = [
	"nota_degustazione_agente",
	"punteggio_agente",
	"premio_attribuito_da_agente",
];

const VISIBILITA_AMMESSA_PER_RISERVATE: readonly Visibility[] = [
	"riservato",
	"interno",
];

/**
 * Ammette o respinge una proposta.
 *
 * I controlli sono in ordine di costo crescente e il primo che fallisce
 * determina l'esito, così che il motivo registrato sia il più specifico.
 */
export function admitFact(
	agent: VinoVeritasAgentSpec,
	draft: FactDraft,
): Admission {
	const reject = (code: RejectionCode, detail: string): Admission => ({
		ok: false,
		code,
		detail,
	});

	// L'agente deve possedere lo strumento per proporre.
	if (!agent.tools.includes("proponi_fatto")) {
		return reject(
			"STRUMENTO_ASSENTE",
			`l'agente ${agent.id} non possiede "proponi_fatto"`,
		);
	}

	// Invariante 1: nessun dato senza provenienza.
	if (draft.provenance.length === 0) {
		return reject(
			"PROVENIENZA_ASSENTE",
			`${draft.scope.type}/${draft.key} proposto senza provenienza`,
		);
	}

	// Invariante 4: nessuna scrittura fuori ambito.
	if (!agent.writeScopes.includes(draft.scope.type)) {
		return reject(
			"AMBITO_NON_CONCESSO",
			`l'agente ${agent.id} non può scrivere in ambito ${draft.scope.type}`,
		);
	}

	// Nessun agente approva: il tipo lo esclude, il controllo copre
	// l'uscita non tipizzata che arriva dal modello.
	const state: string = draft.state;
	if (state !== "proposto" && state !== "da_confermare") {
		return reject(
			"STATO_NON_PROPONIBILE",
			`stato "${state}" non proponibile da un agente`,
		);
	}

	if (CHIAVI_VIETATE.includes(draft.key)) {
		return reject(
			"CHIAVE_NON_AMMESSA",
			`la chiave "${draft.key}" non è ammessa da nessun agente`,
		);
	}

	if (
		CHIAVI_RISERVATE.includes(draft.key) &&
		!VISIBILITA_AMMESSA_PER_RISERVATE.includes(draft.visibility)
	) {
		return reject(
			"CHIAVE_RISERVATA_ESPOSTA",
			`"${draft.key}" richiede visibilità riservata, proposta "${draft.visibility}"`,
		);
	}

	if (
		draft.confidence !== undefined &&
		(draft.confidence < 0 || draft.confidence > 1)
	) {
		return reject(
			"FIDUCIA_FUORI_INTERVALLO",
			`fiducia ${draft.confidence} fuori da [0,1]`,
		);
	}

	return { ok: true, draft };
}

export type ApprovalCode =
	| "PROVENIENZA_NON_APPROVABILE"
	| "CONFERMA_MANCANTE"
	| "STATO_NON_APPROVABILE";

export type Approval =
	| { readonly ok: true; readonly approvedAt: number; readonly approvedBy: string }
	| { readonly ok: false; readonly code: ApprovalCode; readonly detail: string };

/**
 * Ciò che l'approvazione esamina. Accetta una provenienza eventualmente vuota,
 * a differenza di `Fact`: giudicare un insieme di provenienze non appoggiate —
 * o assente — è precisamente il suo compito, e il chiamante la riceve da
 * un'uscita di modello o da una riga di database, non da un tipo garantito.
 */
export interface ApprovalCandidate {
	readonly state: FactState;
	readonly provenance: readonly Provenance[];
}

export interface ApprovalRequest {
	readonly approvedBy: string;
	readonly now: number;
	/**
	 * Presente quando il produttore ha confermato. Un fatto `da_confermare`
	 * non si approva senza.
	 */
	readonly confirmationAnswerId?: string;
}

/**
 * Approva un fatto. **Non è un'operazione d'agente**: è una transizione del
 * piano di orchestrazione, e `canApprove` è false per tutti e dieci gli agenti.
 *
 * Invariante 2: un fatto la cui provenienza è soltanto `inferenza_modello` o
 * `pagina_pubblica` non raggiunge mai `approvato` per via automatica. È il
 * confine fra proposta e dato.
 */
export function approveFact(
	fact: ApprovalCandidate,
	request: ApprovalRequest,
): Approval {
	if (fact.state !== "proposto" && fact.state !== "da_confermare") {
		return {
			ok: false,
			code: "STATO_NON_APPROVABILE",
			detail: `uno stato "${fact.state}" non si approva`,
		};
	}

	if (!canReachApproved(fact.provenance)) {
		return {
			ok: false,
			code: "PROVENIENZA_NON_APPROVABILE",
			detail:
				"serve almeno una provenienza documentale o dichiarativa, trovate: " +
				(fact.provenance.map((p) => p.kind).join(", ") || "nessuna"),
		};
	}

	if (
		fact.state === "da_confermare" &&
		request.confirmationAnswerId === undefined
	) {
		return {
			ok: false,
			code: "CONFERMA_MANCANTE",
			detail: "un fatto da_confermare richiede una risposta del produttore",
		};
	}

	return { ok: true, approvedAt: request.now, approvedBy: request.approvedBy };
}

/**
 * Tabella di precedenza per le fonti contraddittorie. Minore = più autorevole.
 * Il sistema non sceglie in base alla fiducia dichiarata dal modello.
 */
export const PRECEDENZA: Readonly<Record<Provenance["kind"] | "documento_ufficiale", number>> = {
	documento_ufficiale: 0,
	documento: 2,
	dichiarazione: 1,
	pagina_pubblica: 3,
	derivato: 4,
	inferenza_modello: 5,
};

/** Tolleranza per chiave nel confronto fra candidati. 0 = nessuna variante. */
export const TOLLERANZA: Readonly<Record<string, number>> = {
	gradazione_alcolica: 0.1,
	resa_per_ettaro: 0,
	altitudine: 10,
	denominazione: 0,
};
