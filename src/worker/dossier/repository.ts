/**
 * Accesso al fascicolo, con `cantina_id` imposto in un unico punto.
 *
 * La proprietà che conta non è che le query *contengano* il predicato, ma che
 * non sia possibile scriverne una che lo *ometta*: il repository si costruisce
 * da una cantina e nessun metodo accetta un `cantinaId` come argomento. Un
 * errore di isolamento richiederebbe di aggirare questo modulo, non di
 * dimenticare una clausola.
 *
 * Criterio di completamento della Tranche 2 — vedi docs/vinoveritas/01-architettura.md §4
 */

import type { FactDraft } from "./admission.ts";
import { admitFact, approveFact } from "./admission.ts";
import type { ApprovalRequest, RejectionCode } from "./admission.ts";
import type { VinoVeritasAgentSpec } from "./agents.ts";
import { CantinaArchive } from "./archive.ts";
import type { SqlBoundStatement, SqlDatabase, SqlValue } from "./sql.ts";
import { isUniqueViolation } from "./sql.ts";
import type {
	Fact,
	FactState,
	Issue,
	Provenance,
	Scope,
	Visibility,
} from "./types.ts";

/** Riga grezza della tabella `fact`. */
interface FactRow {
	id: string;
	cantina_id: string;
	scope_type: string;
	scope_ref: string;
	key: string;
	value_json: string;
	lang: string | null;
	state: string;
	visibility: string;
	confidence: number | null;
	version: number;
	supersedes: string | null;
	agent: string;
	prompt_version: string;
	created_at: number;
	approved_at: number | null;
	approved_by: string | null;
}

interface SourceRow {
	fact_id: string;
	kind: string;
	document_id: string | null;
	page: number | null;
	char_start: number | null;
	char_end: number | null;
	url: string | null;
	retrieved_at: number | null;
	snapshot_key: string | null;
	answer_id: string | null;
	respondent: string | null;
	rule: string | null;
	prompt_version: string | null;
	run_id: string | null;
}

/** Una riga del fascicolo che viola un'invariante strutturale. */
export class CorruptDossierError extends Error {
	override readonly name = "CorruptDossierError";
}

export type WriteCode =
	| RejectionCode
	/** Esiste già un fatto vivo per quella (ambito, chiave). */
	| "CHIAVE_GIA_VIVA"
	/**
	 * Il fatto da superare non è più vivo: qualcun altro ne ha già aperto una
	 * nuova versione. È il caso di due aggiornamenti concorrenti, e va
	 * restituito come esito perché il chiamante possa rileggere e riprovare —
	 * non propagato come eccezione.
	 */
	| "CONFLITTO_VERSIONE"
	| "FATTO_ASSENTE";

export type WriteOutcome =
	| { readonly ok: true; readonly factId: string }
	| {
			readonly ok: false;
			readonly code: WriteCode;
			readonly detail: string;
	  };

export interface Clock {
	now(): number;
}

export interface IdSource {
	next(prefix: string): string;
}

/**
 * Il fascicolo di **una** cantina. Si ottiene solo da `openDossier`, e da quel
 * momento la cantina non è più un parametro: è parte dell'identità dell'oggetto.
 */
export class CantinaDossier {
	readonly #db: SqlDatabase;
	readonly #cantinaId: string;
	readonly #clock: Clock;
	readonly #ids: IdSource;

	/** L'archivio delle fonti della stessa cantina, con la stessa garanzia. */
	readonly archive: CantinaArchive;

	constructor(
		db: SqlDatabase,
		cantinaId: string,
		clock: Clock,
		ids: IdSource,
	) {
		this.#db = db;
		this.#cantinaId = cantinaId;
		this.#clock = clock;
		this.#ids = ids;
		this.archive = new CantinaArchive(db, cantinaId, clock, ids);
	}

	get cantinaId(): string {
		return this.#cantinaId;
	}

	// ─── Lettura ────────────────────────────────────────────────────────────

	/**
	 * I fatti vivi della cantina. Il filtro sullo stato è opzionale; il filtro
	 * sulla cantina non lo è e non è esposto.
	 */
	async listFacts(filter: {
		readonly states?: readonly FactState[];
		readonly scopeType?: Scope["type"];
		readonly scopeRef?: string;
		readonly visibilities?: readonly Visibility[];
	} = {}): Promise<Fact[]> {
		const where = ["cantina_id = ?"];
		const params: SqlValue[] = [this.#cantinaId];

		if (filter.states !== undefined) {
			where.push(`state IN (${filter.states.map(() => "?").join(",")})`);
			params.push(...filter.states);
		}
		if (filter.scopeType !== undefined) {
			where.push("scope_type = ?");
			params.push(filter.scopeType);
		}
		if (filter.scopeRef !== undefined) {
			where.push("scope_ref = ?");
			params.push(filter.scopeRef);
		}
		if (filter.visibilities !== undefined) {
			where.push(`visibility IN (${filter.visibilities.map(() => "?").join(",")})`);
			params.push(...filter.visibilities);
		}

		const rows = await this.#db
			.prepare(`SELECT * FROM fact WHERE ${where.join(" AND ")} ORDER BY id`)
			.bind(...params)
			.all<FactRow>();

		return Promise.all(rows.results.map((r) => this.#hydrate(r)));
	}

	/** I soli fatti approvati: ciò che il piano di attivazione può leggere. */
	listApprovedFacts(scopeRef?: string): Promise<Fact[]> {
		return this.listFacts({ states: ["approvato"], scopeRef });
	}

	async getLiveFact(scope: Scope, key: string): Promise<Fact | null> {
		const row = await this.#db
			.prepare(
				`SELECT * FROM fact
				 WHERE cantina_id = ? AND scope_type = ? AND scope_ref = ? AND key = ?
				   AND state IN ('proposto','da_confermare','approvato')`,
			)
			.bind(this.#cantinaId, scope.type, scope.ref, key)
			.first<FactRow>();

		return row === null ? null : this.#hydrate(row);
	}

	async listOpenIssues(): Promise<Issue[]> {
		const rows = await this.#db
			.prepare(
				`SELECT * FROM issue WHERE cantina_id = ? AND state IN ('aperta','in_domanda')
				 ORDER BY id`,
			)
			.bind(this.#cantinaId)
			.all<{
				id: string;
				severity: string;
				code: string;
				scope_type: string;
				scope_ref: string;
				fact_key: string | null;
				evidence_json: string;
				targets_json: string;
				state: string;
				cycle: number;
			}>();

		return rows.results.map((r) => ({
			id: r.id,
			cantinaId: this.#cantinaId,
			severity: r.severity as Issue["severity"],
			code: r.code,
			scope: { type: r.scope_type as Scope["type"], ref: r.scope_ref },
			factKey: r.fact_key ?? undefined,
			evidence: JSON.parse(r.evidence_json) as Provenance[],
			targets: JSON.parse(r.targets_json) as Issue["targets"],
			state: r.state as Issue["state"],
			cycle: r.cycle as 1 | 2,
		}));
	}

	// ─── Scrittura ──────────────────────────────────────────────────────────

	/**
	 * Propone un fatto. Passa dalla funzione di ammissione: una scrittura fuori
	 * ambito, senza provenienza o con uno stato non proponibile viene respinta e
	 * **registrata** in `admission_rejection`.
	 *
	 * Il `cantinaId` del draft viene ignorato: vale quello del fascicolo. Un
	 * agente non può scrivere nella cantina sbagliata nemmeno dichiarandola.
	 */
	async proposeFact(
		agent: VinoVeritasAgentSpec,
		draft: FactDraft,
		runId?: string,
	): Promise<WriteOutcome> {
		const scoped: FactDraft = { ...draft, cantinaId: this.#cantinaId };
		const verdict = admitFact(agent, scoped);

		if (!verdict.ok) {
			await this.#recordRejection(agent, scoped, verdict.code, verdict.detail, runId);
			return { ok: false, code: verdict.code, detail: verdict.detail };
		}

		const id = this.#ids.next("fact");
		const now = this.#clock.now();

		try {
			await this.#db
				.prepare(
					`INSERT INTO fact (id,cantina_id,scope_type,scope_ref,key,value_json,lang,
					                   state,visibility,confidence,version,agent,prompt_version,
					                   created_at)
					 VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
				)
				.bind(
					id,
					this.#cantinaId,
					scoped.scope.type,
					scoped.scope.ref,
					scoped.key,
					JSON.stringify(scoped.value),
					scoped.lang ?? null,
					scoped.state,
					scoped.visibility,
					scoped.confidence ?? null,
					agent.id,
					agent.promptVersion,
					now,
				)
				.run();
		} catch (error) {
			if (isUniqueViolation(error)) {
				const detail = `esiste già un fatto vivo per ${scoped.scope.type}/${scoped.key}`;
				await this.#recordRejection(agent, scoped, "CHIAVE_GIA_VIVA", detail, runId);
				return { ok: false, code: "CHIAVE_GIA_VIVA", detail };
			}
			throw error;
		}

		await this.#insertSources(id, scoped.provenance);
		return { ok: true, factId: id };
	}

	/**
	 * Approva un fatto. **Non è un'operazione d'agente**: la firma richiede un
	 * approvatore, e `approveFact` respinge una provenienza non appoggiata.
	 *
	 * Il predicato sulla cantina è nella `UPDATE`: un id di un'altra cantina non
	 * aggiorna nulla.
	 */
	async approve(
		factId: string,
		request: Omit<ApprovalRequest, "now">,
	): Promise<{ ok: boolean; detail?: string }> {
		const fact = await this.#loadById(factId);
		if (fact === null) {
			return { ok: false, detail: "fatto non presente in questo fascicolo" };
		}

		const verdict = approveFact(fact, { ...request, now: this.#clock.now() });
		if (!verdict.ok) return { ok: false, detail: verdict.detail };

		await this.#db
			.prepare(
				`UPDATE fact SET state='approvato', approved_at=?, approved_by=?
				 WHERE id=? AND cantina_id=?`,
			)
			.bind(verdict.approvedAt, verdict.approvedBy, factId, this.#cantinaId)
			.run();

		return { ok: true };
	}

	/**
	 * Apre una nuova versione di un fatto. La precedente passa a `superato` —
	 * non viene cancellata: la storia resta, e l'indice dei fatti vivi si libera.
	 *
	 * Chi chiama ottiene l'id del nuovo fatto e deve poi costruire il piano di
	 * riesame con `planRevalidation`.
	 */
	async supersede(
		agent: VinoVeritasAgentSpec,
		factId: string,
		draft: FactDraft,
	): Promise<WriteOutcome> {
		const previous = await this.#loadById(factId);
		if (previous === null) {
			return {
				ok: false,
				code: "FATTO_ASSENTE",
				detail: "fatto da superare non presente in questo fascicolo",
			};
		}

		// Chi è già stato superato non si supera di nuovo. Senza questo controllo
		// due aggiornamenti concorrenti produrrebbero due versioni 2 della stessa
		// chiave, e l'unica cosa che li fermerebbe sarebbe l'indice dei fatti
		// vivi — con un'eccezione al posto di un esito.
		if (previous.state === "superato") {
			return {
				ok: false,
				code: "CONFLITTO_VERSIONE",
				detail: `il fatto ${factId} (versione ${previous.version}) è già stato superato`,
			};
		}

		const scoped: FactDraft = { ...draft, cantinaId: this.#cantinaId };
		const verdict = admitFact(agent, scoped);
		if (!verdict.ok) {
			await this.#recordRejection(agent, scoped, verdict.code, verdict.detail);
			return { ok: false, code: verdict.code, detail: verdict.detail };
		}

		const id = this.#ids.next("fact");

		// Il superamento della versione precedente e l'inserimento della nuova
		// devono avvenire insieme: a metà strada l'indice dei fatti vivi
		// resterebbe senza alcun fatto vivo per quella chiave, e un cancello
		// valutato in quell'istante leggerebbe un dato semplicemente assente.
		const statements = [
			this.#db
				.prepare(
					`UPDATE fact SET state='superato'
					 WHERE id=? AND cantina_id=? AND state IN ('proposto','da_confermare','approvato')`,
				)
				.bind(factId, this.#cantinaId),
			this.#db
				.prepare(
					`INSERT INTO fact (id,cantina_id,scope_type,scope_ref,key,value_json,lang,
					                   state,visibility,confidence,version,supersedes,agent,
					                   prompt_version,created_at)
					 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				)
				.bind(
					id,
					this.#cantinaId,
					scoped.scope.type,
					scoped.scope.ref,
					scoped.key,
					JSON.stringify(scoped.value),
					scoped.lang ?? null,
					scoped.state,
					scoped.visibility,
					scoped.confidence ?? null,
					previous.version + 1,
					factId,
					agent.id,
					agent.promptVersion,
					this.#clock.now(),
				),
			...this.#sourceStatements(id, scoped.provenance),
		];

		try {
			await this.#writeAtomically(statements);
		} catch (error) {
			if (isUniqueViolation(error)) {
				// un'altra scrittura ha occupato la chiave fra la lettura e qui
				const detail = `un altro fatto vivo occupa ${scoped.scope.type}/${scoped.key}`;
				await this.#recordRejection(agent, scoped, "CHIAVE_GIA_VIVA", detail);
				return { ok: false, code: "CHIAVE_GIA_VIVA", detail };
			}
			throw error;
		}

		return { ok: true, factId: id };
	}

	async openIssue(issue: Omit<Issue, "id" | "cantinaId">): Promise<string> {
		const id = this.#ids.next("issue");
		await this.#db
			.prepare(
				`INSERT INTO issue (id,cantina_id,severity,code,scope_type,scope_ref,fact_key,
				                    evidence_json,targets_json,state,cycle,created_at)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
			)
			.bind(
				id,
				this.#cantinaId,
				issue.severity,
				issue.code,
				issue.scope.type,
				issue.scope.ref,
				issue.factKey ?? null,
				JSON.stringify(issue.evidence),
				JSON.stringify(issue.targets),
				issue.state,
				issue.cycle,
				this.#clock.now(),
			)
			.run();
		return id;
	}

	async listRejections(): Promise<
		{ agent: string; code: string; detail: string }[]
	> {
		const rows = await this.#db
			.prepare(
				`SELECT agent, code, detail FROM admission_rejection
				 WHERE cantina_id = ? ORDER BY created_at, id`,
			)
			.bind(this.#cantinaId)
			.all<{ agent: string; code: string; detail: string }>();
		return rows.results;
	}

	// ─── Interno ────────────────────────────────────────────────────────────

	async #loadById(factId: string): Promise<Fact | null> {
		const row = await this.#db
			.prepare(`SELECT * FROM fact WHERE id=? AND cantina_id=?`)
			.bind(factId, this.#cantinaId)
			.first<FactRow>();
		return row === null ? null : this.#hydrate(row);
	}

	async #hydrate(row: FactRow): Promise<Fact> {
		const sources = await this.#db
			.prepare(`SELECT * FROM fact_source WHERE fact_id=? ORDER BY id`)
			.bind(row.id)
			.all<SourceRow>();

		const provenance = sources.results.map(toProvenance);
		const [head, ...tail] = provenance;

		if (head === undefined) {
			// Invariante 1: nessun dato senza provenienza. Una riga che la viola è
			// un fascicolo corrotto, non un caso d'uso: segnalarlo qui lo rende
			// visibile subito invece di propagarlo come fatto senza fonte.
			throw new CorruptDossierError(
				`il fatto ${row.id} non ha provenienza: invariante 1 violata`,
			);
		}

		return {
			id: row.id,
			cantinaId: row.cantina_id,
			scope: { type: row.scope_type as Scope["type"], ref: row.scope_ref },
			key: row.key,
			value: JSON.parse(row.value_json) as Fact["value"],
			lang: row.lang ?? undefined,
			state: row.state as FactState,
			visibility: row.visibility as Visibility,
			confidence: row.confidence ?? undefined,
			version: row.version,
			supersedes: row.supersedes ?? undefined,
			agent: row.agent,
			promptVersion: row.prompt_version,
			provenance: [head, ...tail],
			createdAt: row.created_at,
			approvedAt: row.approved_at ?? undefined,
			approvedBy: row.approved_by ?? undefined,
		};
	}

	#sourceStatements(
		factId: string,
		provenance: readonly Provenance[],
	): SqlBoundStatement[] {
		return provenance.map((p) => {
			const values = flattenProvenance(p);
			return this.#db
				.prepare(
					`INSERT INTO fact_source (id,fact_id,${SOURCE_COLUMNS.join(",")})
					 VALUES (${["?", "?", ...values.map(() => "?")].join(",")})`,
				)
				.bind(this.#ids.next("src"), factId, ...values);
		});
	}

	async #insertSources(
		factId: string,
		provenance: readonly Provenance[],
	): Promise<void> {
		await this.#writeAtomically(this.#sourceStatements(factId, provenance));
	}

	/**
	 * Usa la transazione del driver quando c'è; altrimenti scrive in sequenza.
	 * La ricaduta non è silenziosa per caso: `batch` è opzionale sulla porta
	 * perché non ogni driver la offre, e il comportamento degradato è peggiore
	 * ma definito.
	 */
	async #writeAtomically(statements: SqlBoundStatement[]): Promise<void> {
		if (statements.length === 0) return;

		const batch = this.#db.batch;
		if (batch !== undefined) {
			await batch.call(this.#db, statements);
			return;
		}

		for (const statement of statements) {
			await statement.run();
		}
	}

	async #recordRejection(
		agent: VinoVeritasAgentSpec,
		draft: FactDraft,
		code: string,
		detail: string,
		runId?: string,
	): Promise<void> {
		await this.#db
			.prepare(
				`INSERT INTO admission_rejection (id,cantina_id,agent,run_id,code,detail,
				                                  scope_type,scope_ref,key,created_at)
				 VALUES (?,?,?,?,?,?,?,?,?,?)`,
			)
			.bind(
				this.#ids.next("rej"),
				this.#cantinaId,
				agent.id,
				runId ?? null,
				code,
				detail,
				draft.scope.type,
				draft.scope.ref,
				draft.key,
				this.#clock.now(),
			)
			.run();
	}
}

/**
 * L'unico modo di ottenere un fascicolo. Verifica che la cantina esista: aprire
 * il fascicolo di una cantina inesistente è un errore, non un insieme vuoto.
 */
export async function openDossier(
	db: SqlDatabase,
	cantinaId: string,
	options: { clock?: Clock; ids?: IdSource } = {},
): Promise<CantinaDossier> {
	const row = await db
		.prepare(`SELECT id FROM cantina WHERE id = ?`)
		.bind(cantinaId)
		.first<{ id: string }>();

	if (row === null) {
		throw new Error(`cantina non presente: ${cantinaId}`);
	}

	return new CantinaDossier(
		db,
		cantinaId,
		options.clock ?? { now: () => Date.now() },
		options.ids ?? defaultIdSource(),
	);
}

export function defaultIdSource(): IdSource {
	let counter = 0;
	return {
		next(prefix) {
			counter += 1;
			return `${prefix}_${counter.toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
		},
	};
}

/**
 * Le colonne di `fact_source`, in un unico posto: la stessa lista genera i
 * segnaposto della INSERT e l'ordine dei valori legati. Il binding posizionale
 * scritto a mano invita a sbagliare — un valore dimenticato in una variante
 * passa inosservato finché non lo si rilegge.
 */
const SOURCE_COLUMNS = [
	"kind",
	"document_id",
	"page",
	"char_start",
	"char_end",
	"url",
	"retrieved_at",
	"snapshot_key",
	"answer_id",
	"respondent",
	"rule",
	"prompt_version",
	"run_id",
] as const;

type SourceColumn = (typeof SOURCE_COLUMNS)[number];

/** Ogni variante dichiara solo le colonne che la riguardano. */
function provenanceColumns(p: Provenance): Partial<Record<SourceColumn, SqlValue>> {
	switch (p.kind) {
		case "documento":
			return {
				kind: p.kind,
				document_id: p.documentId,
				page: p.page,
				char_start: p.charStart ?? null,
				char_end: p.charEnd ?? null,
			};
		case "dichiarazione":
			return {
				kind: p.kind,
				answer_id: p.answerId,
				respondent: p.respondent,
				retrieved_at: p.receivedAt,
			};
		case "pagina_pubblica":
			return {
				kind: p.kind,
				url: p.url,
				retrieved_at: p.retrievedAt,
				snapshot_key: p.snapshotKey ?? null,
			};
		case "derivato":
			return {
				kind: p.kind,
				rule: `${p.rule}:${p.fromFactIds.join(",")}`,
			};
		case "inferenza_modello":
			return {
				kind: p.kind,
				prompt_version: p.promptVersion,
				run_id: p.runId,
			};
	}
}

function flattenProvenance(p: Provenance): SqlValue[] {
	const columns = provenanceColumns(p);
	return SOURCE_COLUMNS.map((c) => columns[c] ?? null);
}

function toProvenance(row: SourceRow): Provenance {
	switch (row.kind) {
		case "documento":
			return {
				kind: "documento",
				documentId: row.document_id ?? "",
				page: row.page ?? 0,
				charStart: row.char_start ?? undefined,
				charEnd: row.char_end ?? undefined,
			};
		case "dichiarazione":
			return {
				kind: "dichiarazione",
				answerId: row.answer_id ?? "",
				respondent: row.respondent ?? "",
				receivedAt: row.retrieved_at ?? 0,
			};
		case "pagina_pubblica":
			return {
				kind: "pagina_pubblica",
				url: row.url ?? "",
				retrievedAt: row.retrieved_at ?? 0,
				snapshotKey: row.snapshot_key ?? undefined,
			};
		case "derivato": {
			const [rule, ids] = (row.rule ?? ":").split(":");
			return {
				kind: "derivato",
				rule: rule ?? "",
				fromFactIds: (ids ?? "").split(",").filter((s) => s.length > 0),
			};
		}
		default:
			return {
				kind: "inferenza_modello",
				promptVersion: row.prompt_version ?? "",
				runId: row.run_id ?? "",
			};
	}
}
