/**
 * Involucro `node:sqlite` sulla porta SQL.
 *
 * D1 è SQLite e la porta ha la forma di D1, quindi i test girano sullo stesso
 * SQL e sugli stessi vincoli che agiranno in produzione: nessun simulacro del
 * database, solo un adattatore sull'interfaccia sincrona di Node.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type {
	SqlBoundStatement,
	SqlDatabase,
	SqlResult,
	SqlStatement,
	SqlValue,
} from "../sql.ts";
import type { Clock, IdSource } from "../repository.ts";

const here = dirname(fileURLToPath(import.meta.url));

const MIGRATIONS_DIR = join(here, "..", "..", "..", "..", "migrations");

/**
 * Tutte le migrazioni, nell'ordine. Applicarle a catena nei test verifica che
 * compongano: una `ALTER TABLE` su una tabella che non esiste più nella forma
 * attesa fallisce qui invece che in produzione.
 */
export const MIGRATION = ["0001_fascicolo.sql", "0002_archivio.sql"]
	.map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf8"))
	.join("\n");

/**
 * Una sola classe per entrambi i ruoli della porta: `bind` restituisce una
 * nuova istanza con i parametri legati.
 *
 * Senza proprietà di parametro nel costruttore: il type stripping di Node è
 * "strip-only" e rifiuta ogni sintassi che richieda generazione di codice
 * (proprietà di parametro, enum, namespace, decoratori). È il prezzo dello zero
 * dipendenze, e vale conoscerlo prima di pagarlo per sbaglio.
 */
class Statement implements SqlStatement {
	readonly #db: DatabaseSync;
	readonly #sql: string;
	readonly #params: SqlValue[];

	constructor(db: DatabaseSync, sql: string, params: SqlValue[] = []) {
		this.#db = db;
		this.#sql = sql;
		this.#params = params;
	}

	bind(...values: SqlValue[]): SqlBoundStatement {
		return new Statement(this.#db, this.#sql, values);
	}

	all<T>(): Promise<SqlResult<T>> {
		try {
			const rows = this.#db.prepare(this.#sql).all(...this.#params) as T[];
			return Promise.resolve({ results: rows });
		} catch (error) {
			return Promise.reject(error);
		}
	}

	first<T>(): Promise<T | null> {
		try {
			const row = this.#db.prepare(this.#sql).get(...this.#params) as T | undefined;
			return Promise.resolve(row ?? null);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	run(): Promise<unknown> {
		// l'eccezione sincrona di node:sqlite diventa un rifiuto, come su D1
		try {
			return Promise.resolve(this.#db.prepare(this.#sql).run(...this.#params));
		} catch (error) {
			return Promise.reject(error);
		}
	}
}

export class SqliteDatabase implements SqlDatabase {
	readonly #db: DatabaseSync;

	constructor() {
		this.#db = new DatabaseSync(":memory:");
		this.#db.exec("PRAGMA foreign_keys = ON;");
		this.#db.exec(MIGRATION);
	}

	prepare(sql: string): SqlStatement {
		return new Statement(this.#db, sql);
	}

	/** Transazione reale: se una istruzione fallisce, nessuna resta applicata. */
	async batch(statements: SqlBoundStatement[]): Promise<unknown> {
		this.#db.exec("BEGIN");
		try {
			const results = [];
			for (const statement of statements) {
				results.push(await statement.run());
			}
			this.#db.exec("COMMIT");
			return results;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	/** Query dirette per le asserzioni dei test, fuori dal repository. */
	raw<T>(sql: string, ...params: SqlValue[]): T[] {
		return this.#db.prepare(sql).all(...params) as T[];
	}

	exec(sql: string): void {
		this.#db.exec(sql);
	}

	addCantina(id: string, nome: string): void {
		this.#db
			.prepare(
				`INSERT INTO cantina (id,nome,lingua_origine,created_at) VALUES (?,?,'it',0)`,
			)
			.run(id, nome);
	}

	addDocument(id: string, cantinaId: string, sha: string): void {
		this.#db
			.prepare(
				`INSERT INTO source_document (id,cantina_id,sha256,r2_key,mime,stato,uploaded_by,uploaded_at)
				 VALUES (?,?,?,?,'application/pdf','estratto','u',0)`,
			)
			.run(id, cantinaId, sha, `r2/${id}`);
	}
}

/** Orologio e id deterministici: un test riproducibile vale più di uno realistico. */
export function fixedClock(start = 1_000): Clock {
	let t = start;
	return { now: () => (t += 1) };
}

export function sequentialIds(tag = ""): IdSource {
	const counters = new Map<string, number>();
	return {
		next(prefix) {
			const n = (counters.get(prefix) ?? 0) + 1;
			counters.set(prefix, n);
			return `${prefix}${tag}_${n}`;
		},
	};
}
