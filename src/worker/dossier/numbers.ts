/**
 * Confronto di valori numerici fra lingue.
 *
 * Il problema: «12,5» in italiano e «12.5» in inglese sono lo stesso valore, e
 * «1.200» può essere milleduecento (separatore delle migliaia italiano) oppure
 * uno-punto-due (decimale). Un estrattore che scelga un'interpretazione sbaglia
 * sistematicamente su una delle due convenzioni.
 *
 * La soluzione non è indovinare: un token ambiguo produce **tutti** i valori
 * che potrebbe rappresentare, e due token combaciano se condividono almeno
 * un'interpretazione. Così l'ambiguità non genera mai un falso allarme — e un
 * falso allarme su un numero bloccherebbe una traduzione corretta.
 */

/** Un token numerico trovato nel testo, con le sue letture possibili. */
export interface NumericToken {
	readonly raw: string;
	/** Tutti i valori che il token potrebbe rappresentare. */
	readonly values: readonly number[];
}

/**
 * I separatori ammessi dentro un token numerico: punto, virgola, spazio
 * normale, spazio insecabile (U+00A0) e spazio insecabile ristretto
 * (U+202F) — i separatori delle migliaia delle diverse convenzioni.
 *
 * Scritti come sequenze di escape e non come caratteri: uno spazio
 * invisibile nel codice sorgente non si può rivedere.
 */
const TOKEN = /\d+(?:[.,\u00a0\u202f ]\d+)*/g;

/**
 * Le letture possibili di un token.
 *
 * - `12,5` / `12.5` → decimale, e anche 125 se il separatore fosse di migliaia
 *   (non lo è con una sola cifra, ma la lettura si conserva per prudenza)
 * - `1.200` / `1,200` → milleduecento **o** 1,2
 * - `1.200,50` → solo milleduecento virgola cinquanta (due separatori diversi)
 * - `2021` → intero
 */
export function readings(raw: string): number[] {
	const cleaned = raw.replace(/[\u00a0\u202f ]/g, "");
	const values = new Set<number>();

	// nessun separatore: intero
	if (!/[.,]/.test(cleaned)) {
		const n = Number(cleaned);
		if (Number.isFinite(n)) values.add(n);
		return [...values];
	}

	const hasDot = cleaned.includes(".");
	const hasComma = cleaned.includes(",");

	if (hasDot && hasComma) {
		// due separatori diversi: l'ultimo è il decimale, l'altro le migliaia
		const lastDot = cleaned.lastIndexOf(".");
		const lastComma = cleaned.lastIndexOf(",");
		const decimal = lastDot > lastComma ? "." : ",";
		const thousands = decimal === "." ? "," : ".";
		const n = Number(
			cleaned.split(thousands).join("").replace(decimal, "."),
		);
		if (Number.isFinite(n)) values.add(n);
		return [...values];
	}

	const sep = hasDot ? "." : ",";
	const parts = cleaned.split(sep);

	// lettura come decimale: solo con un separatore
	if (parts.length === 2) {
		const asDecimal = Number(cleaned.replace(sep, "."));
		if (Number.isFinite(asDecimal)) values.add(asDecimal);
	}

	// lettura come migliaia: ogni gruppo dopo il primo deve avere tre cifre
	const groupsValid =
		parts.length >= 2 &&
		parts.slice(1).every((p) => p.length === 3) &&
		parts[0]!.length >= 1 &&
		parts[0]!.length <= 3;
	if (groupsValid) {
		const asThousands = Number(parts.join(""));
		if (Number.isFinite(asThousands)) values.add(asThousands);
	}

	return [...values];
}

/** I token numerici di un testo, nell'ordine in cui compaiono. */
export function extractNumbers(text: string): NumericToken[] {
	const tokens: NumericToken[] = [];
	for (const match of text.matchAll(TOKEN)) {
		const raw = match[0];
		const values = readings(raw);
		if (values.length > 0) tokens.push({ raw, values });
	}
	return tokens;
}

/** Due token combaciano se condividono almeno una lettura. */
export function tokensMatch(a: NumericToken, b: NumericToken): boolean {
	return a.values.some((v) => b.values.includes(v));
}

/**
 * I token del primo testo che nessun token del secondo può rappresentare.
 *
 * Confronto per **insiemi con molteplicità**: due occorrenze di «12,5»
 * nell'originale richiedono due occorrenze nella traduzione, altrimenti una
 * perdita passerebbe inosservata.
 */
export function unmatchedNumbers(
	from: readonly NumericToken[],
	to: readonly NumericToken[],
): NumericToken[] {
	const available = [...to];
	const missing: NumericToken[] = [];

	for (const token of from) {
		const index = available.findIndex((candidate) => tokensMatch(token, candidate));
		if (index === -1) missing.push(token);
		else available.splice(index, 1);
	}

	return missing;
}
