/**
 * Il pacchetto di contenuti per il Sommelier.
 *
 * Il Sommelier non può citare un dato non approvato, un dato riservato o un
 * dato di un'altra cantina — non perché gli sia stato chiesto di non farlo, ma
 * perché quei contenuti non entrano nel suo indice. Questo modulo è il filtro,
 * ed è l'unico punto in cui il confine viene tracciato.
 *
 * Vedi docs/vinoveritas/04-flussi.md §6 e docs/vinoveritas/01-architettura.md §5
 */

import type { Fact, Visibility } from "./types.ts";

/** Le visibilità ammesse per destinazione. */
export const VISIBILITA_PER_DESTINAZIONE: Readonly<
	Record<"sommelier" | "profilo" | "materiali_commerciali", readonly Visibility[]>
> = {
	// il più restrittivo: solo ciò che è pubblico
	sommelier: ["pubblico"],
	profilo: ["pubblico", "commerciale"],
	materiali_commerciali: ["pubblico", "commerciale"],
};

export interface PackEntry {
	readonly factId: string;
	readonly version: number;
	readonly scope: Fact["scope"];
	readonly key: string;
	readonly value: Fact["value"];
	readonly lang?: string;
}

export interface ContentPack {
	readonly cantinaId: string;
	readonly destination: keyof typeof VISIBILITA_PER_DESTINAZIONE;
	/** Spazio dei nomi di Vectorize: un recupero non può attraversarlo. */
	readonly namespace: string;
	readonly entries: readonly PackEntry[];
	/** Le versioni usate: entrano nella chiave d'operazione. */
	readonly factVersions: readonly { factId: string; version: number }[];
	readonly excluded: {
		readonly nonApprovati: number;
		readonly visibilitaNegata: number;
		readonly altraCantina: number;
		readonly senzaValore: number;
	};
}

/**
 * Costruisce il pacchetto. È una funzione pura, e i suoi quattro filtri sono
 * contati: `excluded` rende visibile in collaudo *quanto* è stato scartato e
 * perché, invece di lasciare che un filtro troppo stretto passi inosservato.
 *
 * Un fatto `non_disponibile` non entra nel pacchetto: è un dato approvato utile
 * a fermare le domande, non un contenuto da esporre.
 */
export function buildContentPack(
	cantinaId: string,
	destination: keyof typeof VISIBILITA_PER_DESTINAZIONE,
	facts: readonly Fact[],
): ContentPack {
	const ammesse = VISIBILITA_PER_DESTINAZIONE[destination];

	const excluded = {
		nonApprovati: 0,
		visibilitaNegata: 0,
		altraCantina: 0,
		senzaValore: 0,
	};

	const entries: PackEntry[] = [];

	for (const fact of facts) {
		// difesa in profondità: il repository è già per cantina, ma un pacchetto
		// costruito da una lista assemblata a mano non deve poter sbagliare
		if (fact.cantinaId !== cantinaId) {
			excluded.altraCantina += 1;
			continue;
		}
		if (fact.state !== "approvato") {
			excluded.nonApprovati += 1;
			continue;
		}
		if (!ammesse.includes(fact.visibility)) {
			excluded.visibilitaNegata += 1;
			continue;
		}
		if (fact.value.kind === "non_disponibile") {
			excluded.senzaValore += 1;
			continue;
		}

		entries.push({
			factId: fact.id,
			version: fact.version,
			scope: fact.scope,
			key: fact.key,
			value: fact.value,
			lang: fact.lang,
		});
	}

	entries.sort((a, b) => (a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0));

	return {
		cantinaId,
		destination,
		namespace: vectorizeNamespace(cantinaId),
		entries,
		factVersions: entries.map((e) => ({ factId: e.factId, version: e.version })),
		excluded,
	};
}

/** Lo spazio dei nomi è per cantina: è la forma dell'isolamento nel recupero. */
export function vectorizeNamespace(cantinaId: string): string {
	return `cantina:${cantinaId}`;
}
