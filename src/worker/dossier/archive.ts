/**
 * L'archivio delle fonti di **una** cantina.
 *
 * Vale la stessa proprietà del fascicolo: l'archivio si ottiene da una cantina
 * e nessun metodo accetta un `cantinaId`. Si raggiunge da `dossier.archive`.
 *
 * L'archivio produce **fonti**, non fatti: sono gli agenti 2–5 a proporre fatti
 * a partire da esse. La separazione evita che un errore di classificazione
 * diventi direttamente un dato.
 *
 * Vedi docs/vinoveritas/03-agenti.md §8
 */

import type { Chunk, ClassProposal, DocumentClass, PageText } from "./ingest.ts";
import { chunkPages, proposeClass, richiedeConferma, valutaLeggibilita } from "./ingest.ts";
import type { DocumentBlock } from "./model.ts";
import type { Clock, IdSource } from "./repository.ts";
import type { ObjectStore } from "./storage.ts";
import { objectKey, sha256Hex } from "./storage.ts";
import type { SqlDatabase, SqlValue } from "./sql.ts";
import { isUniqueViolation } from "./sql.ts";
import type { Scope } from "./types.ts";

export type DocumentStatus = "caricato" | "estratto" | "illeggibile";

export interface DocumentRecord {
	readonly id: string;
	readonly sha256: string;
	readonly key: string;
	readonly mime: string;
	readonly filename?: string;
	readonly sizeBytes?: number;
	readonly pages?: number;
	readonly documentClass?: DocumentClass;
	readonly classConfidence?: number;
	readonly status: DocumentStatus;
	readonly illegibleReason?: string;
}

export interface IngestInput {
	readonly bytes: Uint8Array;
	readonly filename: string;
	readonly mime: string;
	readonly uploadedBy: string;
}

export type IngestResult =
	| {
			readonly status: "nuovo";
			readonly documentId: string;
			readonly sha256: string;
			readonly key: string;
			readonly proposal: ClassProposal;
			readonly needsConfirmation: boolean;
	  }
	| {
			/** Lo stesso contenuto era già presente: non si crea una seconda fonte. */
			readonly status: "duplicato";
			readonly documentId: string;
			readonly sha256: string;
	  };

export interface ExtractionResult {
	readonly status: "estratto" | "illeggibile";
	readonly chunks: number;
	readonly reason?: string;
}

export interface LinkProposal {
	readonly scope: Scope;
	readonly confidence: number;
}

export class CantinaArchive {
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
	 * Acquisisce un materiale.
	 *
	 * La deduplica non è un algoritmo: la chiave dell'oggetto **è** l'impronta
	 * del contenuto, e l'indice unico su `(cantina, sha256)` fa il resto. Lo
	 * stesso file caricato due volte non genera due fonti, e non viene nemmeno
	 * riscritto nell'archivio.
	 */
	async ingest(store: ObjectStore, input: IngestInput): Promise<IngestResult> {
		const sha256 = await sha256Hex(input.bytes);

		const existing = await this.#findBySha(sha256);
		if (existing !== null) {
			return { status: "duplicato", documentId: existing, sha256 };
		}

		const key = objectKey(this.#cantinaId, sha256);
		const proposal = proposeClass(input.filename, input.mime);

		// l'originale prima della riga: una riga senza oggetto è una fonte
		// irraggiungibile, un oggetto senza riga è solo spazio occupato
		await store.put(key, input.bytes, {
			cantina: this.#cantinaId,
			filename: input.filename,
		});

		const id = this.#ids.next("doc");

		try {
			await this.#db
				.prepare(
					`INSERT INTO source_document (id,cantina_id,sha256,r2_key,mime,classe,stato,
					                              uploaded_by,uploaded_at,filename,size_bytes,
					                              class_confidence)
					 VALUES (?,?,?,?,?,?,'caricato',?,?,?,?,?)`,
				)
				.bind(
					id,
					this.#cantinaId,
					sha256,
					key,
					input.mime,
					proposal.documentClass,
					input.uploadedBy,
					this.#clock.now(),
					input.filename,
					input.bytes.byteLength,
					proposal.confidence,
				)
				.run();
		} catch (error) {
			if (isUniqueViolation(error)) {
				// un caricamento concorrente dello stesso contenuto è arrivato prima
				const other = await this.#findBySha(sha256);
				if (other !== null) {
					return { status: "duplicato", documentId: other, sha256 };
				}
			}
			throw error;
		}

		return {
			status: "nuovo",
			documentId: id,
			sha256,
			key,
			proposal,
			needsConfirmation: richiedeConferma(proposal),
		};
	}

	/**
	 * Registra l'esito dell'estrazione.
	 *
	 * Un testo che non supera il giudizio di leggibilità **non viene
	 * segmentato**: il documento resta `illeggibile` e nessun frammento entra
	 * nell'indice. È la differenza fra segnalare e indovinare.
	 *
	 * L'anomalia da aprire resta al chiamante: l'archivio produce fonti, non
	 * anomalie, e non ha accesso agli ambiti del fascicolo.
	 */
	async recordExtraction(
		documentId: string,
		pages: readonly PageText[],
		options?: { readonly maxChars?: number; readonly overlapChars?: number },
	): Promise<ExtractionResult> {
		const owned = await this.get(documentId);
		if (owned === null) {
			throw new Error(`documento non presente in questo archivio: ${documentId}`);
		}

		const verdict = valutaLeggibilita(pages);
		if (!verdict.leggibile) {
			await this.markIllegible(documentId, verdict.reason ?? "illeggibile");
			return { status: "illeggibile", chunks: 0, reason: verdict.reason };
		}

		const chunks = chunkPages(pages, options ?? {});

		const statements = chunks.map((chunk) =>
			this.#db
				.prepare(
					`INSERT INTO source_chunk (id,document_id,page,char_start,char_end,text)
					 VALUES (?,?,?,?,?,?)`,
				)
				.bind(
					this.#ids.next("chunk"),
					documentId,
					chunk.page,
					chunk.charStart,
					chunk.charEnd,
					chunk.text,
				),
		);

		statements.push(
			this.#db
				.prepare(
					`UPDATE source_document SET stato='estratto', pages=?, illegible_reason=NULL
					 WHERE id=? AND cantina_id=?`,
				)
				.bind(pages.length, documentId, this.#cantinaId),
		);

		const batch = this.#db.batch;
		if (batch !== undefined) await batch.call(this.#db, statements);
		else for (const statement of statements) await statement.run();

		return { status: "estratto", chunks: chunks.length };
	}

	async markIllegible(documentId: string, reason: string): Promise<void> {
		await this.#db
			.prepare(
				`UPDATE source_document SET stato='illeggibile', illegible_reason=?
				 WHERE id=? AND cantina_id=?`,
			)
			.bind(reason, documentId, this.#cantinaId)
			.run();
	}

	/**
	 * Propone un collegamento a cantina, vino o annata.
	 *
	 * Un'associazione incerta resta incerta: lo stato è `proposto` e la fiducia
	 * viaggia col collegamento, così che il Coordinatore sappia quali vanno
	 * confermate prima di far lavorare uno specialista sul documento sbagliato.
	 */
	async proposeLinks(
		documentId: string,
		links: readonly LinkProposal[],
	): Promise<number> {
		const owned = await this.get(documentId);
		if (owned === null) return 0;

		let written = 0;
		for (const link of links) {
			try {
				await this.#db
					.prepare(
						`INSERT INTO document_link (document_id,scope_type,scope_ref,confidence,
						                            state,created_at)
						 VALUES (?,?,?,?,'proposto',?)`,
					)
					.bind(
						documentId,
						link.scope.type,
						link.scope.ref,
						link.confidence,
						this.#clock.now(),
					)
					.run();
				written += 1;
			} catch (error) {
				// lo stesso collegamento proposto due volte non è un errore
				if (!isUniqueViolation(error)) throw error;
			}
		}
		return written;
	}

	async listLinks(
		documentId: string,
	): Promise<{ scope: Scope; confidence: number; state: string }[]> {
		const rows = await this.#db
			.prepare(
				`SELECT l.scope_type, l.scope_ref, l.confidence, l.state
				 FROM document_link l
				 JOIN source_document d ON d.id = l.document_id
				 WHERE l.document_id = ? AND d.cantina_id = ?
				 ORDER BY l.scope_type, l.scope_ref`,
			)
			.bind(documentId, this.#cantinaId)
			.all<{ scope_type: string; scope_ref: string; confidence: number; state: string }>();

		return rows.results.map((r) => ({
			scope: { type: r.scope_type as Scope["type"], ref: r.scope_ref },
			confidence: r.confidence,
			state: r.state,
		}));
	}

	async get(documentId: string): Promise<DocumentRecord | null> {
		const row = await this.#db
			.prepare(`SELECT * FROM source_document WHERE id=? AND cantina_id=?`)
			.bind(documentId, this.#cantinaId)
			.first<DocumentRow>();
		return row === null ? null : toRecord(row);
	}

	async list(filter: { readonly status?: DocumentStatus } = {}): Promise<DocumentRecord[]> {
		const where = ["cantina_id = ?"];
		const params: SqlValue[] = [this.#cantinaId];
		if (filter.status !== undefined) {
			where.push("stato = ?");
			params.push(filter.status);
		}

		const rows = await this.#db
			.prepare(`SELECT * FROM source_document WHERE ${where.join(" AND ")} ORDER BY id`)
			.bind(...params)
			.all<DocumentRow>();
		return rows.results.map(toRecord);
	}

	async listChunks(documentId: string): Promise<Chunk[]> {
		const rows = await this.#db
			.prepare(
				`SELECT c.page, c.char_start, c.char_end, c.text
				 FROM source_chunk c
				 JOIN source_document d ON d.id = c.document_id
				 WHERE c.document_id = ? AND d.cantina_id = ?
				 ORDER BY c.page, c.char_start`,
			)
			.bind(documentId, this.#cantinaId)
			.all<{ page: number; char_start: number; char_end: number; text: string }>();

		return rows.results.map((r) => ({
			page: r.page,
			charStart: r.char_start,
			charEnd: r.char_end,
			text: r.text,
		}));
	}

	/**
	 * I blocchi documento da passare al kernel.
	 *
	 * Chiude il giro fra ingestione e agenti: ciò che il kernel manda al modello
	 * viene dall'archivio della cantina, quindi un documento di un'altra cantina
	 * non può entrare in una richiesta. I documenti illeggibili sono esclusi:
	 * non sono fonti.
	 */
	async asModelDocuments(
		store: ObjectStore,
		documentIds: readonly string[],
	): Promise<DocumentBlock[]> {
		const blocks: DocumentBlock[] = [];

		for (const id of documentIds) {
			const record = await this.get(id);
			if (record === null || record.status === "illeggibile") continue;

			const chunks = await this.listChunks(id);
			const text =
				chunks.length > 0
					? chunks.map((c) => c.text).join("\n\n")
					: decodeText(await store.get(record.key));

			if (text.length === 0) continue;

			blocks.push({
				documentId: id,
				// il titolo è l'identificativo: è così che la citazione torna al documento
				title: id,
				text,
				citations: true,
			});
		}

		return blocks;
	}

	async #findBySha(sha256: string): Promise<string | null> {
		const row = await this.#db
			.prepare(`SELECT id FROM source_document WHERE cantina_id=? AND sha256=?`)
			.bind(this.#cantinaId, sha256)
			.first<{ id: string }>();
		return row?.id ?? null;
	}
}

interface DocumentRow {
	id: string;
	sha256: string;
	r2_key: string;
	mime: string;
	filename: string | null;
	size_bytes: number | null;
	pages: number | null;
	classe: string | null;
	class_confidence: number | null;
	stato: string;
	illegible_reason: string | null;
}

function toRecord(row: DocumentRow): DocumentRecord {
	return {
		id: row.id,
		sha256: row.sha256,
		key: row.r2_key,
		mime: row.mime,
		filename: row.filename ?? undefined,
		sizeBytes: row.size_bytes ?? undefined,
		pages: row.pages ?? undefined,
		documentClass: (row.classe ?? undefined) as DocumentClass | undefined,
		classConfidence: row.class_confidence ?? undefined,
		status: row.stato as DocumentStatus,
		illegibleReason: row.illegible_reason ?? undefined,
	};
}

function decodeText(bytes: Uint8Array | null): string {
	if (bytes === null) return "";
	return new TextDecoder().decode(bytes);
}
