/**
 * Le domande di **una** cantina.
 *
 * Stessa garanzia del fascicolo e dell'archivio: si ottiene da una cantina e
 * nessun metodo accetta un `cantinaId`. Si raggiunge da `dossier.questions`.
 *
 * Il ciclo di vita è esplicito e verificato, non implicito negli aggiornamenti:
 *
 *     bozza ──rilascia──▶ inviata ──risposta──▶ risposta
 *       ▲                     │
 *       └──ciclo 2────── scaduta ──oltre 2 cicli──▶ escalata
 *
 * Il secondo ciclo è un **aggiornamento** della riga esistente, non una nuova
 * riga: l'indice unico su `(cantina, chiave semantica)` lo impone, e la
 * conseguenza è giusta — una domanda ha un'identità e un contatore, non due
 * incarnazioni.
 *
 * Vedi docs/vinoveritas/03-agenti.md §7
 */

import type { AnswerConsequence, AnswerKind, QuestionDraft } from "./ambassador.ts";
import { consequenceOf, MAX_CICLI, nextCycle } from "./ambassador.ts";
import type { Clock, IdSource } from "./repository.ts";
import type { SqlDatabase, SqlValue } from "./sql.ts";
import { isUniqueViolation } from "./sql.ts";
import type { Scope } from "./types.ts";

export type QuestionState = "bozza" | "inviata" | "risposta" | "scaduta" | "escalata";

export const QUESTION_STATES: readonly QuestionState[] = [
	"bozza",
	"inviata",
	"risposta",
	"scaduta",
	"escalata",
];

export type QuestionEvent = "rilascia" | "rispondi" | "scadi" | "riapri" | "escala";

/**
 * Le transizioni ammesse. `null` significa «non ammessa», e il chiamante
 * ottiene un esito invece di una scrittura silenziosa che non fa nulla.
 */
export function nextState(
	current: QuestionState,
	event: QuestionEvent,
): QuestionState | null {
	switch (current) {
		case "bozza":
			return event === "rilascia" ? "inviata" : event === "escala" ? "escalata" : null;
		case "inviata":
			return event === "rispondi"
				? "risposta"
				: event === "scadi"
					? "scaduta"
					: event === "escala"
						? "escalata"
						: null;
		case "scaduta":
			return event === "riapri" ? "bozza" : event === "escala" ? "escalata" : null;
		// terminali
		case "risposta":
		case "escalata":
			return null;
	}
}

export interface QuestionRecord {
	readonly id: string;
	readonly semanticKey: string;
	readonly topic: string;
	readonly audience: string;
	readonly lang: string;
	readonly body: string;
	readonly state: QuestionState;
	readonly cycle: 1 | 2;
	readonly blocking: boolean;
	readonly scope?: Scope;
	readonly factKey?: string;
	readonly issueIds: readonly string[];
	readonly createdAt: number;
	readonly sentAt?: number;
}

export type OpenOutcome =
	| { readonly action: "creata"; readonly questionId: string }
	/**
	 * `cycle` è il ciclo effettivo, non assunto: `nextCycle` ha un ramo
	 * difensivo per un contatore fuori intervallo, e affermare «2» lo
	 * nasconderebbe dietro un'asserzione di tipo.
	 */
	| { readonly action: "riaperta"; readonly questionId: string; readonly cycle: 1 | 2 }
	| { readonly action: "saltata"; readonly reason: string }
	| { readonly action: "escalation"; readonly questionId: string };

export interface AnswerInput {
	readonly kind: AnswerKind;
	readonly content?: string;
	readonly documentId?: string;
	readonly respondent: string;
}

export type RecordAnswerOutcome =
	| { readonly ok: true; readonly answerId: string; readonly consequence: AnswerConsequence }
	| { readonly ok: false; readonly reason: string };

interface QuestionRow {
	id: string;
	semantic_key: string;
	topic: string;
	audience: string;
	lang: string;
	body: string;
	state: string;
	cycle: number;
	blocking: number;
	scope_type: string | null;
	scope_ref: string | null;
	fact_key: string | null;
	issue_ids_json: string;
	created_at: number;
	sent_at: number | null;
}

export class CantinaQuestions {
	readonly #db: SqlDatabase;
	readonly #cantinaId: string;
	readonly #clock: Clock;
	readonly #ids: IdSource;

	constructor(db: SqlDatabase, cantinaId: string, clock: Clock, ids: IdSource) {
		this.#db = db;
		this.#cantinaId = cantinaId;
		this.#clock = clock;
		this.#ids = ids;
	}

	/**
	 * Apre una bozza, oppure riapre al secondo ciclo una domanda scaduta.
	 *
	 * Non è un `INSERT OR REPLACE`: una domanda già viva viene **saltata**, e
	 * una scaduta che ha già usato i suoi cicli viene **escalata**. Sostituire
	 * la riga perderebbe il contatore, che è l'unica cosa che fa terminare il
	 * ciclo delle domande.
	 */
	async open(draft: QuestionDraft, lang: string, body: string): Promise<OpenOutcome> {
		const existing = await this.#findByKey(draft.semanticKey);

		if (existing !== null) {
			if (existing.state !== "scaduta") {
				return {
					action: "saltata",
					reason: `domanda già in stato «${existing.state}»`,
				};
			}

			const next = nextCycle(existing.cycle);
			if (next === "escalation") {
				await this.#transition(existing.id, "escala");
				return { action: "escalation", questionId: existing.id };
			}

			await this.#db
				.prepare(
					`UPDATE question SET state='bozza', cycle=?, body=?, issue_ids_json=?,
					                     blocking=?, sent_at=NULL, released_at=NULL
					 WHERE id=? AND cantina_id=?`,
				)
				.bind(
					next,
					body,
					JSON.stringify(draft.issueIds),
					draft.blocking ? 1 : 0,
					existing.id,
					this.#cantinaId,
				)
				.run();

			return { action: "riaperta", questionId: existing.id, cycle: next };
		}

		const id = this.#ids.next("q");
		try {
			await this.#db
				.prepare(
					`INSERT INTO question (id,cantina_id,issue_ids_json,topic,audience,lang,body,
					                       semantic_key,state,cycle,created_at,scope_type,scope_ref,
					                       fact_key,blocking)
					 VALUES (?,?,?,?,?,?,?,?,'bozza',1,?,?,?,?,?)`,
				)
				.bind(
					id,
					this.#cantinaId,
					JSON.stringify(draft.issueIds),
					draft.topic,
					draft.audience,
					lang,
					body,
					draft.semanticKey,
					this.#clock.now(),
					draft.scope.type,
					draft.scope.ref,
					draft.factKey ?? null,
					draft.blocking ? 1 : 0,
				)
				.run();
		} catch (error) {
			if (isUniqueViolation(error)) {
				// una pianificazione concorrente è arrivata prima
				return { action: "saltata", reason: "chiave semantica già presente" };
			}
			throw error;
		}

		return { action: "creata", questionId: id };
	}

	/**
	 * Rilascia fino a `limit` bozze, le bloccanti per prime.
	 *
	 * Il limite non è un dettaglio: è il meccanismo che tiene bassi i minuti
	 * chiesti al produttore. Ciò che resta in bozza partirà col lotto seguente.
	 */
	async release(limit: number): Promise<QuestionRecord[]> {
		if (limit <= 0) return [];

		const rows = await this.#db
			.prepare(
				`SELECT * FROM question
				 WHERE cantina_id=? AND state='bozza'
				 ORDER BY blocking DESC, created_at, id
				 LIMIT ?`,
			)
			.bind(this.#cantinaId, limit)
			.all<QuestionRow>();

		const released: QuestionRecord[] = [];
		const now = this.#clock.now();

		for (const row of rows.results) {
			const outcome = await this.#transition(row.id, "rilascia", now);
			if (outcome) released.push({ ...toRecord(row), state: "inviata", sentAt: now });
		}

		return released;
	}

	/**
	 * Registra una risposta e riferisce cosa ne segue.
	 *
	 * **Non propone il fatto**: l'Ambasciatore non ha ambiti in scrittura. La
	 * conseguenza dice all'orchestrazione cosa proporre e per mano di chi.
	 */
	async recordAnswer(
		questionId: string,
		input: AnswerInput,
	): Promise<RecordAnswerOutcome> {
		const question = await this.get(questionId);
		if (question === null) {
			return { ok: false, reason: "domanda non presente in questa cantina" };
		}
		if (nextState(question.state, "rispondi") === null) {
			return {
				ok: false,
				reason: `una domanda in stato «${question.state}» non accetta risposte`,
			};
		}
		if (input.kind === "documento" && input.documentId === undefined) {
			return { ok: false, reason: "una risposta con documento richiede un documento" };
		}
		if (question.scope === undefined || question.factKey === undefined) {
			return {
				ok: false,
				reason: "la domanda non porta ambito e chiave: impossibile instradare",
			};
		}

		const answerId = this.#ids.next("ans");
		await this.#db
			.prepare(
				`INSERT INTO answer (id,question_id,kind,content,document_id,respondent,received_at)
				 VALUES (?,?,?,?,?,?,?)`,
			)
			.bind(
				answerId,
				questionId,
				input.kind,
				input.content ?? null,
				input.documentId ?? null,
				input.respondent,
				this.#clock.now(),
			)
			.run();

		await this.#transition(questionId, "rispondi");

		return {
			ok: true,
			answerId,
			consequence: consequenceOf(
				input.kind,
				question.scope,
				question.factKey,
				answerId,
				input.documentId,
			),
		};
	}

	/**
	 * Fa scadere le domande inviate oltre il tempo concesso.
	 *
	 * Una risposta tardiva resta accettabile: la scadenza apre la possibilità
	 * di un secondo ciclo, non chiude la domanda.
	 */
	async expire(ttlMs: number): Promise<string[]> {
		const now = this.#clock.now();
		const rows = await this.#db
			.prepare(
				`SELECT * FROM question
				 WHERE cantina_id=? AND state='inviata' AND sent_at IS NOT NULL AND sent_at <= ?`,
			)
			.bind(this.#cantinaId, now - ttlMs)
			.all<QuestionRow>();

		const expired: string[] = [];
		for (const row of rows.results) {
			if (await this.#transition(row.id, "scadi")) expired.push(row.id);
		}
		return expired;
	}

	/** Escala una domanda al Coordinatore. */
	async escalate(questionId: string): Promise<boolean> {
		return this.#transition(questionId, "escala");
	}

	async get(questionId: string): Promise<QuestionRecord | null> {
		const row = await this.#db
			.prepare(`SELECT * FROM question WHERE id=? AND cantina_id=?`)
			.bind(questionId, this.#cantinaId)
			.first<QuestionRow>();
		return row === null ? null : toRecord(row);
	}

	async list(filter: { readonly state?: QuestionState } = {}): Promise<QuestionRecord[]> {
		const where = ["cantina_id = ?"];
		const params: SqlValue[] = [this.#cantinaId];
		if (filter.state !== undefined) {
			where.push("state = ?");
			params.push(filter.state);
		}

		const rows = await this.#db
			.prepare(
				`SELECT * FROM question WHERE ${where.join(" AND ")}
				 ORDER BY blocking DESC, created_at, id`,
			)
			.bind(...params)
			.all<QuestionRow>();
		return rows.results.map(toRecord);
	}

	/** Lo stato per decidere il rilascio: bozze pendenti e la più vecchia. */
	async releaseState(): Promise<{ pending: number; oldestDraftAt?: number }> {
		const row = await this.#db
			.prepare(
				`SELECT count(*) AS n, min(created_at) AS oldest FROM question
				 WHERE cantina_id=? AND state='bozza'`,
			)
			.bind(this.#cantinaId)
			.first<{ n: number; oldest: number | null }>();

		return {
			pending: row?.n ?? 0,
			oldestDraftAt: row?.oldest ?? undefined,
		};
	}

	/** Quante volte una domanda è stata posta: il contatore che fa terminare. */
	get maxCycles(): number {
		return MAX_CICLI;
	}

	async #findByKey(semanticKey: string): Promise<QuestionRecord | null> {
		const row = await this.#db
			.prepare(`SELECT * FROM question WHERE cantina_id=? AND semantic_key=?`)
			.bind(this.#cantinaId, semanticKey)
			.first<QuestionRow>();
		return row === null ? null : toRecord(row);
	}

	/**
	 * Applica una transizione, se ammessa.
	 *
	 * Il predicato sullo stato è nella `WHERE`: una transizione concorrente che
	 * ha già cambiato lo stato non viene sovrascritta.
	 */
	async #transition(
		questionId: string,
		event: QuestionEvent,
		at?: number,
	): Promise<boolean> {
		const current = await this.get(questionId);
		if (current === null) return false;

		const next = nextState(current.state, event);
		if (next === null) return false;

		const now = at ?? this.#clock.now();
		const sent = event === "rilascia" ? now : null;

		await this.#db
			.prepare(
				`UPDATE question
				 SET state=?, sent_at=COALESCE(?, sent_at), released_at=COALESCE(?, released_at)
				 WHERE id=? AND cantina_id=? AND state=?`,
			)
			.bind(next, sent, sent, questionId, this.#cantinaId, current.state)
			.run();

		return true;
	}
}

function toRecord(row: QuestionRow): QuestionRecord {
	const scope =
		row.scope_type !== null && row.scope_ref !== null
			? { type: row.scope_type as Scope["type"], ref: row.scope_ref }
			: undefined;

	return {
		id: row.id,
		semanticKey: row.semantic_key,
		topic: row.topic,
		audience: row.audience,
		lang: row.lang,
		body: row.body,
		state: row.state as QuestionState,
		cycle: row.cycle as 1 | 2,
		blocking: row.blocking === 1,
		scope,
		factKey: row.fact_key ?? undefined,
		issueIds: JSON.parse(row.issue_ids_json) as string[],
		createdAt: row.created_at,
		sentAt: row.sent_at ?? undefined,
	};
}
