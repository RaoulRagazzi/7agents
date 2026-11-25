/**
 * L'attore di una cantina: il punto di ingresso serializzato al suo fascicolo.
 *
 * Un Durable Object per cantina, raggiunto con `idFromName(cantinaId)`. Due
 * compiti, e nessun altro:
 *
 *  1. **Serializzare le mutazioni.** Ogni sequenza «leggi, decidi, scrivi» sul
 *     fascicolo passa da una coda. Non si affida al thread singolo del runtime:
 *     gli input gate rinviano gli eventi solo durante le operazioni sullo
 *     storage del Durable Object, e il fascicolo vive in D1 — vedi
 *     [`lock.ts`](./dossier/lock.ts).
 *  2. **Garantire un solo onboarding per cantina.** Due percorsi concorrenti
 *     sulla stessa cantina si farebbero domande a vicenda e aprirebbero due
 *     volte le stesse anomalie. La rivendicazione è nello storage dell'attore,
 *     che è il posto giusto: è l'unico stato per cui non serve il database.
 *
 * L'attore **non** contiene logica di dominio. Chiama il fascicolo, la
 * Sentinella e l'Ambasciatore, che restano funzioni pure o oggetti per cantina.
 * È un coordinatore di accesso, non un terzo livello di regole.
 *
 * Vedi docs/vinoveritas/01-architettura.md §4
 */

import { DurableObject } from "cloudflare:workers";

import type { FactDraft } from "./dossier/admission.ts";
import type { ApprovalRequest } from "./dossier/admission.ts";
import { getAgent } from "./dossier/agents.ts";
import type { QuestionDraft } from "./dossier/ambassador.ts";
import { groupDrafts, planQuestions, POLITICA_PREDEFINITA, shouldRelease } from "./dossier/ambassador.ts";
import { evaluateGate } from "./dossier/gates.ts";
import type { LockStats } from "./dossier/lock.ts";
import { SerialQueue } from "./dossier/lock.ts";
import type { ContentPack } from "./dossier/pack.ts";
import { buildContentPack } from "./dossier/pack.ts";
import { R2ObjectStore } from "./dossier/r2.ts";
import type { ObjectStore } from "./dossier/storage.ts";
import type { CantinaDossier, WriteOutcome } from "./dossier/repository.ts";
import { openDossier } from "./dossier/repository.ts";
import { blocksTarget, runDeterministicChecks } from "./dossier/sentinel.ts";
import type { Finding } from "./dossier/sentinel.ts";
import type { AnswerInput } from "./dossier/questions.ts";
import type { SqlDatabase } from "./dossier/sql.ts";
import type { GateTarget, TargetRef } from "./dossier/types.ts";

/** Chi tiene l'onboarding di questa cantina, e da quando. */
export interface RunClaim {
	readonly workflowId: string;
	readonly claimedAt: number;
}

export type ClaimOutcome =
	| { readonly ok: true; readonly claim: RunClaim }
	| { readonly ok: false; readonly heldBy: RunClaim };

export interface VerificationSummary {
	readonly findings: number;
	readonly bloccanti: number;
	readonly daConfermare: number;
	readonly miglioramenti: number;
	readonly issueIds: readonly string[];
	readonly codici: readonly string[];
}

export interface GateSummary {
	readonly target: GateTarget;
	readonly ref?: string;
	readonly open: boolean;
	readonly reasons: readonly string[];
}

export interface QuestionRound {
	readonly pianificate: number;
	readonly saltate: number;
	readonly aperte: number;
	readonly escalate: number;
	readonly rilasciate: number;
	readonly motivoRilascio: string;
	readonly lotti: readonly { topic: string; audience: string; domande: number }[];
}

export interface PackSummary {
	readonly entries: number;
	readonly namespace: string;
	/** I conteggi di ciò che è stato scartato, e perché. */
	readonly excluded: ContentPack["excluded"];
}

export interface IngestReport {
	readonly status: "nuovo" | "duplicato";
	readonly documentId: string;
	readonly sha256: string;
	readonly classe?: string;
	readonly daConfermare?: boolean;
	/** Falso quando l'estrazione è rinviata: il dettaglio dice perché. */
	readonly estratto: boolean;
	readonly frammenti: number;
	readonly dettaglio: string;
}

export interface OnboardingState {
	readonly cantinaId: string;
	readonly claim: RunClaim | null;
	readonly fatti: { approvati: number; proposti: number; daConfermare: number };
	readonly anomalieAperte: number;
	readonly domande: { bozze: number; inviate: number; risposte: number; escalate: number };
	readonly codaStats: LockStats;
}

const CHIAVE_CLAIM = "claim";

export class CantinaActor extends DurableObject<Env> {
	readonly #queue = new SerialQueue();
	#cantinaId: string | null = null;

	/**
	 * L'attore non conosce la propria cantina dal nome dell'oggetto: il runtime
	 * non lo restituisce. Il primo chiamante la dichiara, e da quel momento è
	 * fissata — un attore che servisse due cantine annullerebbe l'isolamento.
	 */
	async bind(cantinaId: string): Promise<{ ok: boolean; detail?: string }> {
		const salvata = await this.ctx.storage.get<string>("cantinaId");

		if (salvata !== undefined && salvata !== cantinaId) {
			return {
				ok: false,
				detail: `questo attore serve la cantina ${salvata}, non ${cantinaId}`,
			};
		}
		if (salvata === undefined) await this.ctx.storage.put("cantinaId", cantinaId);

		this.#cantinaId = cantinaId;
		return { ok: true };
	}

	async #dossier(): Promise<CantinaDossier> {
		const cantinaId =
			this.#cantinaId ?? (await this.ctx.storage.get<string>("cantinaId")) ?? null;
		if (cantinaId === null) {
			throw new Error("attore non legato a una cantina: chiamare prima bind()");
		}
		this.#cantinaId = cantinaId;
		return openDossier(this.env.DB as unknown as SqlDatabase, cantinaId);
	}

	// ─── Un solo onboarding per cantina ─────────────────────────────────────

	/**
	 * Rivendica l'onboarding.
	 *
	 * Rivendicare due volte con lo stesso identificativo riesce: un Workflow che
	 * ritenta un passo deve poter rieseguire la rivendicazione senza bloccarsi
	 * su sé stesso.
	 */
	claim(workflowId: string): Promise<ClaimOutcome> {
		return this.#queue.run(async () => {
			const attuale = await this.ctx.storage.get<RunClaim>(CHIAVE_CLAIM);

			if (attuale !== undefined && attuale.workflowId !== workflowId) {
				return { ok: false as const, heldBy: attuale };
			}

			const claim: RunClaim = attuale ?? { workflowId, claimedAt: Date.now() };
			await this.ctx.storage.put(CHIAVE_CLAIM, claim);
			return { ok: true as const, claim };
		});
	}

	/** Rilascia l'onboarding. Rilasciare ciò che non si tiene non è un errore. */
	release(workflowId: string): Promise<{ released: boolean }> {
		return this.#queue.run(async () => {
			const attuale = await this.ctx.storage.get<RunClaim>(CHIAVE_CLAIM);
			if (attuale === undefined || attuale.workflowId !== workflowId) {
				return { released: false };
			}
			await this.ctx.storage.delete(CHIAVE_CLAIM);
			return { released: true };
		});
	}

	async activeClaim(): Promise<RunClaim | null> {
		return (await this.ctx.storage.get<RunClaim>(CHIAVE_CLAIM)) ?? null;
	}

	// ─── Mutazioni serializzate ─────────────────────────────────────────────

	proposeFacts(
		agentId: string,
		drafts: readonly FactDraft[],
		runId?: string,
	): Promise<WriteOutcome[]> {
		return this.#queue.run(async () => {
			const agent = getAgent(agentId);
			if (agent === undefined) {
				throw new Error(`agente non noto: ${agentId}`);
			}
			const dossier = await this.#dossier();

			const esiti: WriteOutcome[] = [];
			for (const draft of drafts) {
				esiti.push(await dossier.proposeFact(agent, draft, runId));
			}
			return esiti;
		});
	}

	approveFacts(
		factIds: readonly string[],
		request: Omit<ApprovalRequest, "now">,
	): Promise<{ factId: string; ok: boolean; detail?: string }[]> {
		return this.#queue.run(async () => {
			const dossier = await this.#dossier();
			const esiti: { factId: string; ok: boolean; detail?: string }[] = [];
			for (const factId of factIds) {
				const esito = await dossier.approve(factId, request);
				esiti.push({ factId, ...esito });
			}
			return esiti;
		});
	}

	/**
	 * Apre una nuova versione di un fatto.
	 *
	 * È l'operazione che la coda esiste per proteggere: fra la lettura della
	 * versione e la scrittura della successiva non deve entrare nessuno.
	 */
	supersedeFact(
		agentId: string,
		factId: string,
		draft: FactDraft,
	): Promise<WriteOutcome> {
		return this.#queue.run(async () => {
			const agent = getAgent(agentId);
			if (agent === undefined) throw new Error(`agente non noto: ${agentId}`);
			const dossier = await this.#dossier();
			return dossier.supersede(agent, factId, draft);
		});
	}

	// ─── Verifica ───────────────────────────────────────────────────────────

	/**
	 * Esegue i controlli deterministici sui fatti approvati e salva le anomalie.
	 *
	 * I miglioramenti facoltativi vengono salvati come gli altri: non bloccano,
	 * ma sparire non è la stessa cosa che non bloccare.
	 */
	verify(currentYear: number, cycle: 1 | 2 = 1): Promise<VerificationSummary> {
		return this.#queue.run(async () => {
			const dossier = await this.#dossier();
			const facts = await dossier.listApprovedFacts();
			const findings = runDeterministicChecks({ facts }, { currentYear });
			const issueIds = await dossier.openFindings(findings, cycle);

			const perGravita = (g: Finding["severity"]) =>
				findings.filter((f) => f.severity === g).length;

			return {
				findings: findings.length,
				bloccanti: perGravita("bloccante"),
				daConfermare: perGravita("da_confermare"),
				miglioramenti: perGravita("miglioramento"),
				issueIds,
				codici: [...new Set(findings.map((f) => f.code))].sort(),
			};
		});
	}

	/** Valuta i cancelli richiesti e registra l'esito in `gate_evaluation`. */
	gates(targets: readonly TargetRef[]): Promise<GateSummary[]> {
		return this.#queue.run(async () => {
			const dossier = await this.#dossier();
			const facts = await dossier.listApprovedFacts();
			const issues = await dossier.listOpenIssues();

			// quali referenze sono pronte: serve ai cancelli che ne contano un minimo
			const vini = [
				...new Set(facts.filter((f) => f.scope.type === "vino").map((f) => f.scope.ref)),
			];
			const referenzePronte = vini.filter(
				(ref) => evaluateGate({ target: "referenza", ref }, facts, issues).open,
			).length;

			const aperti: GateTarget[] = [];
			const esiti: GateSummary[] = [];

			// l'ordine conta: il Sommelier dipende dal profilo, quindi il profilo
			// va valutato prima
			const ordinati = [...targets].sort((a, b) => peso(a.target) - peso(b.target));

			for (const target of ordinati) {
				const esito = evaluateGate(target, facts, issues, aperti, referenzePronte);
				if (esito.open) aperti.push(target.target);

				esiti.push({
					target: target.target,
					ref: target.ref,
					open: esito.open,
					reasons: esito.open ? [] : esito.reasons,
				});

				await this.env.DB.prepare(
					`INSERT INTO gate_evaluation (id,cantina_id,target,target_ref,open,reasons_json,evaluated_at)
					 VALUES (?,?,?,?,?,?,?)`,
				)
					.bind(
						`gate_${crypto.randomUUID()}`,
						dossier.cantinaId,
						target.target,
						target.ref ?? null,
						esito.open ? 1 : 0,
						JSON.stringify(esito.open ? [] : esito.reasons),
						Date.now(),
					)
					.run();
			}

			return esiti;
		});
	}

	// ─── Domande ────────────────────────────────────────────────────────────

	/**
	 * Pianifica, apre e rilascia un giro di domande.
	 *
	 * Serializzato per intero: la pianificazione legge le domande esistenti per
	 * non duplicarle, e fra quella lettura e l'apertura non deve entrare un
	 * altro giro.
	 *
	 * Non prende il ciclo come parametro: il contatore vive sulla domanda, e
	 * `questions.open` lo incrementa da sé riaprendo una scaduta. Passarlo da
	 * fuori darebbe due fonti di verità per lo stesso numero.
	 */
	askRound(lang: string): Promise<QuestionRound> {
		return this.#queue.run(async () => {
			const dossier = await this.#dossier();
			const facts = await dossier.listFacts();
			const issues = await dossier.listOpenIssues();
			const esistenti = (await dossier.questions.list()).map((q) => ({
				semanticKey: q.semanticKey,
				state: q.state,
				cycle: q.cycle,
			}));

			const findings = issues.map((i) => ({
				issueId: i.id,
				severity: i.severity,
				code: i.code,
				scope: i.scope,
				factKey: i.factKey,
				evidence: i.evidence,
				targets: i.targets,
				detail: i.detail ?? i.code,
				// rilette dal database: il campo vive sull'anomalia, vedi sotto
				contestaValore: i.contestaValore,
			}));

			const piano = planQuestions({ findings, facts, existing: esistenti });

			let aperte = 0;
			let escalate = 0;
			for (const draft of piano.drafts) {
				const esito = await dossier.questions.open(draft, lang, formulaTesto(draft));
				if (esito.action === "creata" || esito.action === "riaperta") aperte += 1;
				if (esito.action === "escalation") escalate += 1;
			}

			const stato = await dossier.questions.releaseState();
			const bloccato = issues.some(
				(i) =>
					i.severity === "bloccante" &&
					blocksTarget([{ ...i, detail: i.detail ?? "" }], { target: "profilo" }),
			);
			const decisione = shouldRelease(POLITICA_PREDEFINITA, {
				...stato,
				now: Date.now(),
				gateBlocked: bloccato || piano.drafts.some((d) => d.blocking),
			});

			const rilasciate = decisione.release
				? await dossier.questions.release(decisione.limit)
				: [];

			const lotti = groupDrafts(piano.drafts).map((b) => ({
				topic: b.topic,
				audience: b.audience,
				domande: b.drafts.length,
			}));

			return {
				pianificate: piano.drafts.length,
				saltate: piano.skipped.length,
				aperte,
				escalate,
				rilasciate: rilasciate.length,
				motivoRilascio: decisione.reason,
				lotti,
			};
		});
	}

	/** Le domande della cantina. Lettura: non passa dalla coda. */
	async listQuestions(): Promise<
		{ id: string; state: string; cycle: number; blocking: boolean; factKey?: string; body: string }[]
	> {
		const dossier = await this.#dossier();
		return (await dossier.questions.list()).map((q) => ({
			id: q.id,
			state: q.state,
			cycle: q.cycle,
			blocking: q.blocking,
			factKey: q.factKey,
			body: q.body,
		}));
	}

	recordAnswer(questionId: string, input: AnswerInput): Promise<unknown> {
		return this.#queue.run(async () => {
			const dossier = await this.#dossier();
			return dossier.questions.recordAnswer(questionId, input);
		});
	}

	expireQuestions(ttlMs: number): Promise<string[]> {
		return this.#queue.run(async () => {
			const dossier = await this.#dossier();
			return dossier.questions.expire(ttlMs);
		});
	}

	// ─── Archivio delle fonti ───────────────────────────────────────────────

	#store(): ObjectStore {
		return new R2ObjectStore(this.env.ORIGINALI);
	}

	/**
	 * Acquisisce un materiale e, se è testuale, lo estrae subito.
	 *
	 * La distinzione non è una scorciatoia: per un file di testo il contenuto
	 * **è** il testo, e passarlo al modello per farselo restituire sarebbe
	 * spendere per nulla. Un PDF o un'immagine richiedono l'estrazione con le
	 * citazioni, che richiede il modello: restano in stato `caricato`, e
	 * l'esito lo dichiara invece di lasciarlo supporre.
	 */
	ingestDocument(input: {
		readonly bytes: Uint8Array;
		readonly filename: string;
		readonly mime: string;
		readonly uploadedBy: string;
	}): Promise<IngestReport> {
		return this.#queue.run(async () => {
			const dossier = await this.#dossier();
			const esito = await dossier.archive.ingest(this.#store(), input);

			if (esito.status === "duplicato") {
				return {
					status: "duplicato" as const,
					documentId: esito.documentId,
					sha256: esito.sha256,
					estratto: false,
					frammenti: 0,
					dettaglio: "lo stesso contenuto era già presente",
				};
			}

			const testuale = input.mime.startsWith("text/");
			if (!testuale) {
				return {
					status: "nuovo" as const,
					documentId: esito.documentId,
					sha256: esito.sha256,
					classe: esito.proposal.documentClass,
					daConfermare: esito.needsConfirmation,
					estratto: false,
					frammenti: 0,
					dettaglio:
						`estrazione rinviata: un ${input.mime} richiede le citazioni, ` +
						"che richiedono il modello",
				};
			}

			const testo = new TextDecoder().decode(input.bytes);
			const estrazione = await dossier.archive.recordExtraction(esito.documentId, [
				{ page: 1, text: testo },
			]);

			return {
				status: "nuovo" as const,
				documentId: esito.documentId,
				sha256: esito.sha256,
				classe: esito.proposal.documentClass,
				daConfermare: esito.needsConfirmation,
				estratto: estrazione.status === "estratto",
				frammenti: estrazione.chunks,
				dettaglio:
					estrazione.status === "estratto"
						? `${estrazione.chunks} frammenti indicizzabili`
						: (estrazione.reason ?? "illeggibile"),
			};
		});
	}

	/** I materiali della cantina. Lettura: non passa dalla coda. */
	async listDocuments(): Promise<
		{
			id: string;
			filename?: string;
			mime: string;
			classe?: string;
			status: string;
			pages?: number;
			sizeBytes?: number;
			illegibleReason?: string;
		}[]
	> {
		const dossier = await this.#dossier();
		return (await dossier.archive.list()).map((d) => ({
			id: d.id,
			filename: d.filename,
			mime: d.mime,
			classe: d.documentClass,
			status: d.status,
			pages: d.pages,
			sizeBytes: d.sizeBytes,
			illegibleReason: d.illegibleReason,
		}));
	}

	/**
	 * I blocchi documento pronti per il modello.
	 *
	 * Vengono dall'archivio della cantina, quindi un documento di un'altra
	 * cantina non può entrare in una richiesta. È il collegamento fra
	 * l'ingestione e gli agenti, e il motivo per cui l'attore lo espone invece
	 * di lasciare che il kernel peschi dal database.
	 */
	async modelDocuments(
		documentIds: readonly string[],
	): Promise<{ documentId: string; title: string; text: string }[]> {
		const dossier = await this.#dossier();
		const blocchi = await dossier.archive.asModelDocuments(this.#store(), documentIds);
		return blocchi.map((b) => ({
			documentId: b.documentId,
			title: b.title,
			text: b.text,
		}));
	}

	// ─── Attivazione ────────────────────────────────────────────────────────

	/** Costruisce il pacchetto di contenuti per una destinazione. */
	buildPack(
		destination: "sommelier" | "profilo" | "materiali_commerciali",
	): Promise<PackSummary> {
		return this.#queue.run(async () => {
			const dossier = await this.#dossier();
			const facts = await dossier.listApprovedFacts();
			const pack = buildContentPack(dossier.cantinaId, destination, facts);
			return {
				entries: pack.entries.length,
				namespace: pack.namespace,
				excluded: pack.excluded,
			};
		});
	}

	// ─── Stato ──────────────────────────────────────────────────────────────

	async state(): Promise<OnboardingState> {
		const dossier = await this.#dossier();
		const tutti = await dossier.listFacts();
		const domande = await dossier.questions.list();
		const conta = (s: string) => domande.filter((q) => q.state === s).length;

		return {
			cantinaId: dossier.cantinaId,
			claim: await this.activeClaim(),
			fatti: {
				approvati: tutti.filter((f) => f.state === "approvato").length,
				proposti: tutti.filter((f) => f.state === "proposto").length,
				daConfermare: tutti.filter((f) => f.state === "da_confermare").length,
			},
			anomalieAperte: (await dossier.listOpenIssues()).length,
			domande: {
				bozze: conta("bozza"),
				inviate: conta("inviata"),
				risposte: conta("risposta"),
				escalate: conta("escalata"),
			},
			codaStats: this.#queue.stats,
		};
	}
}

function peso(target: GateTarget): number {
	switch (target) {
		case "profilo":
			return 0;
		case "referenza":
			return 1;
		case "sommelier":
			return 2;
		case "materiali_commerciali":
			return 3;
	}
}

/**
 * Il testo della domanda, in attesa dell'Ambasciatore vero.
 *
 * La formulazione nella lingua del produttore richiede il modello. Finché non
 * c'è, il testo è l'elenco dei motivi: utile a chi collauda, e dichiaratamente
 * non ciò che il produttore dovrebbe leggere.
 */
function formulaTesto(draft: QuestionDraft): string {
	return `[formulazione automatica assente] ${draft.factKey ?? "dato"}: ${draft.reasons.join("; ")}`;
}
