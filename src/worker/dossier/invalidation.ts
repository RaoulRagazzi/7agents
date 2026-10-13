/**
 * Invalidazione selettiva.
 *
 * Quando un fatto cambia versione si rimette in riesame **soltanto** ciò che ne
 * dipende. È la differenza fra un aggiornamento e una ricostruzione, e si misura
 * nel costo per cantina: senza il grafo, l'unica alternativa sicura sarebbe
 * rielaborare tutto a ogni modifica.
 *
 * Vedi docs/vinoveritas/02-fascicolo.md §4
 */

export interface FactEdge {
	readonly derivedFactId: string;
	readonly sourceFactId: string;
	readonly rule: string;
}

export interface TranslationRef {
	readonly id: string;
	readonly factId: string;
	readonly lang: string;
	readonly sourceVersion: number;
	readonly state: "fresca" | "stale" | "approvata";
}

export interface ActivationOpFactRef {
	readonly opId: string;
	readonly factId: string;
	readonly factVersion: number;
}

export interface RevalidationPlan {
	/** Fatti derivati da rimettere in riesame, esclusa la radice. */
	readonly factsToReview: readonly string[];
	/** Traduzioni il cui testo di partenza è cambiato. */
	readonly translationsStale: readonly string[];
	/**
	 * Operazioni che citavano una versione ora superata. Marcate rieseguibili,
	 * **non** rieseguite: il Coordinatore decide quando.
	 */
	readonly operationsReexecutable: readonly string[];
}

/**
 * Chiusura transitiva dei dipendenti lungo `fact_edge`.
 *
 * Tollera i cicli: un grafo di dipendenze costruito da estrazioni automatiche
 * può contenerne, e una visita ingenua non terminerebbe.
 */
export function dependentClosure(
	rootFactIds: readonly string[],
	edges: readonly FactEdge[],
): readonly string[] {
	const bySource = new Map<string, string[]>();
	for (const edge of edges) {
		const list = bySource.get(edge.sourceFactId);
		if (list === undefined) {
			bySource.set(edge.sourceFactId, [edge.derivedFactId]);
		} else {
			list.push(edge.derivedFactId);
		}
	}

	const roots = new Set(rootFactIds);
	const seen = new Set<string>();
	const queue = [...rootFactIds];

	while (queue.length > 0) {
		// non-null: la guardia del while garantisce un elemento
		const current = queue.pop() as string;
		for (const dependent of bySource.get(current) ?? []) {
			if (seen.has(dependent)) continue;
			seen.add(dependent);
			queue.push(dependent);
		}
	}

	// la radice non si rimette in riesame: è la modifica stessa
	return [...seen].filter((id) => !roots.has(id)).sort();
}

/**
 * Costruisce il piano di riesame per un fatto che è passato a `newVersion`.
 *
 * Le traduzioni e le operazioni toccate sono quelle della radice **e** dei
 * dipendenti: un paragrafo derivato che cita la gradazione va ritradotto quanto
 * la gradazione stessa.
 */
export function planRevalidation(
	changedFactId: string,
	newVersion: number,
	edges: readonly FactEdge[],
	translations: readonly TranslationRef[],
	operationFacts: readonly ActivationOpFactRef[],
): RevalidationPlan {
	const dependents = dependentClosure([changedFactId], edges);
	const touched = new Set<string>([changedFactId, ...dependents]);

	const translationsStale = translations
		.filter((t) => {
			if (!touched.has(t.factId)) return false;
			if (t.state === "stale") return false; // già marcata
			// solo la radice ha una versione nuova da confrontare; i dipendenti
			// vanno comunque rivisti perché il loro contenuto cambierà
			return t.factId === changedFactId
				? t.sourceVersion < newVersion
				: true;
		})
		.map((t) => t.id)
		.sort();

	const operationsReexecutable = [
		...new Set(
			operationFacts
				.filter((o) => {
					if (!touched.has(o.factId)) return false;
					return o.factId === changedFactId
						? o.factVersion < newVersion
						: true;
				})
				.map((o) => o.opId),
		),
	].sort();

	return {
		factsToReview: dependents,
		translationsStale,
		operationsReexecutable,
	};
}
