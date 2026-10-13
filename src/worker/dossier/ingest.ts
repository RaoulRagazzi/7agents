/**
 * Segmentazione e classificazione: la metà deterministica del Documentalista.
 *
 * Tutto ciò che qui si decide è decidibile senza modello, e quindi va deciso
 * senza modello: offset esatti, confini di pagina, deduplica, proposte di
 * classe. Al modello resta l'estrazione del testo con le citazioni.
 *
 * Vedi docs/vinoveritas/03-agenti.md §8
 */

/** Il testo di una pagina, come lo restituisce l'estrazione. */
export interface PageText {
	readonly page: number;
	readonly text: string;
}

/**
 * Un frammento indicizzabile.
 *
 * `charStart` e `charEnd` sono **offset dentro la pagina**, non dentro il
 * documento: è così che una citazione del modello torna al passaggio esatto, e
 * il test verifica che `page.text.slice(charStart, charEnd) === text`.
 */
export interface Chunk {
	readonly page: number;
	readonly charStart: number;
	readonly charEnd: number;
	readonly text: string;
}

export interface ChunkOptions {
	readonly maxChars?: number;
	readonly overlapChars?: number;
}

const WORD_BREAK = /\s/;

/**
 * Segmenta pagina per pagina.
 *
 * Un frammento **non attraversa mai una pagina**: un passaggio che cita due
 * pagine diverse non avrebbe una provenienza sola, e la Sentinella non potrebbe
 * tornare alla fonte.
 */
export function chunkPages(
	pages: readonly PageText[],
	options: ChunkOptions = {},
): Chunk[] {
	const maxChars = options.maxChars ?? 1_200;
	const overlapChars = options.overlapChars ?? 120;

	if (maxChars <= 0) throw new Error("maxChars deve essere positivo");
	if (overlapChars < 0 || overlapChars >= maxChars) {
		throw new Error("overlapChars deve stare fra 0 e maxChars");
	}

	const chunks: Chunk[] = [];

	for (const { page, text } of pages) {
		let cursor = 0;

		while (cursor < text.length) {
			// salta lo spazio iniziale senza perdere l'allineamento degli offset
			while (cursor < text.length && WORD_BREAK.test(text[cursor]!)) cursor += 1;
			if (cursor >= text.length) break;

			const hardEnd = Math.min(cursor + maxChars, text.length);
			const end = hardEnd === text.length ? hardEnd : softBreak(text, cursor, hardEnd);

			const slice = text.slice(cursor, end);
			const trimmedEnd = end - (slice.length - trimEndLength(slice));

			if (trimmedEnd > cursor) {
				chunks.push({
					page,
					charStart: cursor,
					charEnd: trimmedEnd,
					text: text.slice(cursor, trimmedEnd),
				});
			}

			// l'avanzamento è sempre positivo: senza questa garanzia una
			// sovrapposizione mal tarata girerebbe per sempre
			const next = Math.max(cursor + 1, end - overlapChars);
			cursor = next;
		}
	}

	return chunks;
}

/**
 * Arretra fino all'ultimo confine naturale dentro la finestra: fine di
 * paragrafo, poi fine di frase, poi spazio. Se non ne trova nessuno taglia di
 * netto — una parola spezzata è meglio di un frammento sovradimensionato.
 */
function softBreak(text: string, start: number, hardEnd: number): number {
	const window = text.slice(start, hardEnd);
	const floor = Math.floor(window.length * 0.4);

	const paragraph = window.lastIndexOf("\n\n");
	if (paragraph >= floor) return start + paragraph + 2;

	for (const terminator of [". ", "! ", "? ", ".\n", "!\n", "?\n"]) {
		const found = window.lastIndexOf(terminator);
		if (found >= floor) return start + found + terminator.length;
	}

	const space = window.lastIndexOf(" ");
	if (space >= floor) return start + space + 1;

	return hardEnd;
}

function trimEndLength(slice: string): number {
	let length = slice.length;
	while (length > 0 && WORD_BREAK.test(slice[length - 1]!)) length -= 1;
	return length;
}

// ─── Classificazione ────────────────────────────────────────────────────────

export type DocumentClass =
	| "scheda_tecnica"
	| "listino"
	| "certificazione"
	| "foto"
	| "rassegna_stampa"
	| "documento_amministrativo"
	| "ignoto";

export interface ClassProposal {
	readonly documentClass: DocumentClass;
	readonly confidence: number;
}

const NAME_RULES: readonly {
	readonly pattern: RegExp;
	readonly documentClass: DocumentClass;
	readonly confidence: number;
}[] = [
	{ pattern: /scheda|tecnic|fiche|datasheet/i, documentClass: "scheda_tecnica", confidence: 0.8 },
	{ pattern: /listino|prezz|price|tarif/i, documentClass: "listino", confidence: 0.8 },
	// `docg?` senza confini di parola matcherebbe "documento", "documentazione",
	// "documenti": su nomi di file italiani è un errore quasi sistematico
	{ pattern: /certificat|biolog|organic|\bdocg?\b|attestat/i, documentClass: "certificazione", confidence: 0.7 },
	{ pattern: /rassegna|stampa|press|recension|articol/i, documentClass: "rassegna_stampa", confidence: 0.7 },
	{ pattern: /visura|statut|atto|camera|fattur|bilanci/i, documentClass: "documento_amministrativo", confidence: 0.8 },
];

/**
 * Propone una classe. **È una proposta**: una classificazione sbagliata non
 * deve diventare direttamente un dato, perciò la fiducia viaggia col valore e
 * sotto soglia l'associazione va confermata.
 */
export function proposeClass(filename: string, mime: string): ClassProposal {
	if (mime.startsWith("image/")) {
		return { documentClass: "foto", confidence: 0.95 };
	}

	for (const rule of NAME_RULES) {
		if (rule.pattern.test(filename)) {
			return { documentClass: rule.documentClass, confidence: rule.confidence };
		}
	}

	return { documentClass: "ignoto", confidence: 0 };
}

/** Sotto questa soglia la classe proposta richiede una conferma. */
export const SOGLIA_CONFERMA = 0.75;

export function richiedeConferma(proposal: ClassProposal): boolean {
	return proposal.confidence < SOGLIA_CONFERMA;
}

/**
 * Un testo estratto è utilizzabile?
 *
 * Il Documentalista deve segnalare l'illeggibile invece di produrre
 * un'estrazione a bassa fiducia che inquina il fascicolo. Il criterio è
 * grossolano per scelta: poche righe di caratteri sporchi sono il segno tipico
 * di un riconoscimento fallito su una scansione.
 */
export function valutaLeggibilita(pages: readonly PageText[]): {
	readonly leggibile: boolean;
	readonly reason?: string;
} {
	const text = pages.map((p) => p.text).join("\n");
	const stripped = text.replace(/\s/g, "");

	if (stripped.length === 0) {
		return { leggibile: false, reason: "nessun testo estratto" };
	}
	if (stripped.length < 40) {
		return {
			leggibile: false,
			reason: `testo troppo breve per essere una fonte (${stripped.length} caratteri)`,
		};
	}

	const letters = (stripped.match(/\p{L}|\p{N}/gu) ?? []).length;
	const ratio = letters / stripped.length;
	if (ratio < 0.6) {
		return {
			leggibile: false,
			reason: `testo prevalentemente non alfabetico (${Math.round(ratio * 100)}% utile)`,
		};
	}

	return { leggibile: true };
}
