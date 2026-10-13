/**
 * La porta verso il database.
 *
 * La forma è quella di D1 (`prepare().bind().all()/first()/run()`), così che un
 * `D1Database` reale la soddisfi strutturalmente senza adattatore. Nei test
 * l'implementazione è un involucro su `node:sqlite`: lo stesso SQL, lo stesso
 * motore, nessun simulacro.
 */

export type SqlValue = string | number | null;

export interface SqlResult<T> {
	readonly results: T[];
}

export interface SqlBoundStatement {
	all<T>(): Promise<SqlResult<T>>;
	first<T>(): Promise<T | null>;
	run(): Promise<unknown>;
}

export interface SqlStatement extends SqlBoundStatement {
	bind(...values: SqlValue[]): SqlBoundStatement;
}

export interface SqlDatabase {
	prepare(sql: string): SqlStatement;
	/**
	 * Esegue più istruzioni in una sola transazione, quando il driver lo
	 * offre. È opzionale perché non ogni driver la fornisce, e il chiamante
	 * ricade su scritture sequenziali — ma dove l'atomicità serve, un'operazione
	 * che la richiede deve dichiararlo invece di sperarci.
	 *
	 * La firma coincide con `D1Database.batch`, che la soddisfa nativamente.
	 */
	batch?(statements: SqlBoundStatement[]): Promise<unknown>;
}

/** Violazione di un vincolo di unicità, distinta da un errore qualunque. */
export function isUniqueViolation(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /UNIQUE constraint failed|D1_ERROR.*UNIQUE/i.test(message);
}

/** Violazione di un CHECK o di una chiave esterna. */
export function isConstraintViolation(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /CHECK constraint failed|FOREIGN KEY constraint failed/i.test(message);
}
