/**
 * Serializzazione delle operazioni su una cantina.
 *
 * ## Perché non basta il Durable Object
 *
 * Un Durable Object è a thread singolo, e la tentazione è concludere che le sue
 * operazioni siano già serializzate. Non lo sono, e la differenza è precisa:
 * gli *input gate* del runtime rinviano gli eventi mentre è in corso
 * un'operazione sullo **storage del Durable Object**. Una chiamata a D1 non è
 * un'operazione su quello storage — è una chiamata a un servizio esterno — e
 * durante la sua attesa il cancello è aperto, quindi un'altra richiesta entra e
 * si interfoglia.
 *
 * Il fascicolo vive in D1. Quindi la serializzazione va scritta, non
 * presupposta: una catena di promesse fa passare una operazione alla volta.
 *
 * Questo rende sicura la sequenza «leggi la versione, scrivi la versione+1»,
 * che altrimenti dipenderebbe soltanto dai vincoli del database per non
 * produrre due versioni uguali.
 */

export interface LockStats {
	/** Operazioni completate, riuscite o meno. */
	readonly completate: number;
	/** Operazioni attualmente in coda, inclusa quella in corso. */
	readonly inCoda: number;
	/** La più lunga attesa osservata prima dell'inizio, in millisecondi. */
	readonly attesaMassimaMs: number;
}

export interface Clock {
	now(): number;
}

/**
 * Una coda che esegue una operazione alla volta, nell'ordine di arrivo.
 *
 * Il fallimento di un'operazione **non** rompe la catena: la successiva parte
 * comunque. Una coda che si blocca al primo errore trasformerebbe un errore
 * singolo nel blocco di tutta la cantina.
 */
export class SerialQueue {
	#tail: Promise<unknown> = Promise.resolve();
	#completate = 0;
	#inCoda = 0;
	#attesaMassimaMs = 0;
	readonly #clock: Clock;

	constructor(clock: Clock = { now: () => Date.now() }) {
		this.#clock = clock;
	}

	/**
	 * Accoda `work` e restituisce il suo esito.
	 *
	 * L'ordine di esecuzione è l'ordine delle chiamate: ciò che conta non è che
	 * ogni operazione riesca, ma che nessuna veda il fascicolo a metà di
	 * un'altra.
	 */
	run<T>(work: () => Promise<T>): Promise<T> {
		this.#inCoda += 1;
		const accodatoIl = this.#clock.now();

		const esegui = async (): Promise<T> => {
			const attesa = this.#clock.now() - accodatoIl;
			if (attesa > this.#attesaMassimaMs) this.#attesaMassimaMs = attesa;
			try {
				return await work();
			} finally {
				this.#completate += 1;
				this.#inCoda -= 1;
			}
		};

		// `then(esegui, esegui)`: la catena continua anche se la precedente ha
		// fallito. Senza il secondo argomento un errore bloccherebbe la coda.
		const risultato = this.#tail.then(esegui, esegui);

		// la coda prosegue su un ramo che non rigetta mai, altrimenti il rifiuto
		// si propagherebbe a tutte le operazioni successive
		this.#tail = risultato.then(
			() => undefined,
			() => undefined,
		);

		return risultato;
	}

	get stats(): LockStats {
		return {
			completate: this.#completate,
			inCoda: this.#inCoda,
			attesaMassimaMs: this.#attesaMassimaMs,
		};
	}

	/** Attende che la coda si svuoti. Per i collaudi e per la chiusura ordinata. */
	async drain(): Promise<void> {
		await this.#tail;
	}
}
