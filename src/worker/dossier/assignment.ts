/**
 * Regola di assegnazione fra l'agente 4 e l'agente 5.
 *
 * È codice e non prompt, per tre motivi: ogni prodotto deve avere un unico
 * responsabile, il caso dubbio deve avere una destinazione esplicita, e la
 * regola deve essere verificabile con un test invece che con una rilettura.
 *
 * Vedi docs/vinoveritas/03-agenti.md §4-5
 */

export type WineColour = "bianco" | "rosso" | "rosato" | "sconosciuto";

export type WineStyle =
	| "fermo"
	| "spumante"
	| "passito"
	| "fortificato"
	| "sconosciuto";

export interface WineTypology {
	readonly colour: WineColour;
	readonly style: WineStyle;
}

export type Assignee =
	/** Agente 4 — bianchi, spumanti e passiti. */
	| "specialista_bianchi_spumanti_passiti"
	/** Agente 5 — altre referenze. */
	| "specialista_altre_referenze"
	/** Tipologia dubbia: sottoposta al Coordinatore PRIMA dell'assegnazione. */
	| "coordinatore";

/**
 * Tutti gli spumanti e tutti i passiti, indipendentemente dal colore, oltre ai
 * bianchi fermi, vanno all'agente 4. Tutto il resto all'agente 5. La tipologia
 * non determinabile non viene indovinata: va al Coordinatore.
 */
export function assignReference(typology: WineTypology): Assignee {
	if (typology.style === "sconosciuto") return "coordinatore";

	if (typology.style === "spumante" || typology.style === "passito") {
		return "specialista_bianchi_spumanti_passiti";
	}

	if (typology.colour === "sconosciuto") return "coordinatore";

	if (typology.style === "fermo" && typology.colour === "bianco") {
		return "specialista_bianchi_spumanti_passiti";
	}

	return "specialista_altre_referenze";
}
