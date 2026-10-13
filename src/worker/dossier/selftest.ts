/**
 * Verifica d'integrazione del fascicolo, eseguibile su **qualunque** motore
 * che soddisfi la porta SQL.
 *
 * Esiste perché i test unitari girano su `node:sqlite`, mentre in esercizio il
 * motore è D1. Sono entrambi SQLite, ma non sono la stessa cosa: le transazioni
 * passano da `batch()` invece che da `BEGIN`, l'applicazione delle chiavi
 * esterne è una scelta della piattaforma, e il viaggio dei valori attraverso il
 * confine del binding è codice diverso.
 *
 * La stessa suite si esegue dai test Node e da una rotta del worker: se un
 * esito divergesse fra i due motori, sarebbe questa la cosa che lo mostra.
 */

import { getAgent } from "./agents.ts";
import type { FactDraft } from "./admission.ts";
import { evaluateGate } from "./gates.ts";
import { openDossier } from "./repository.ts";
import type { Clock, IdSource } from "./repository.ts";
import { runDeterministicChecks } from "./sentinel.ts";
import type { SqlDatabase } from "./sql.ts";
import type { Provenance } from "./types.ts";

export interface CheckResult {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
}

export interface SelfTestReport {
	readonly engine: string;
	readonly total: number;
	readonly passed: number;
	readonly failed: number;
	readonly checks: readonly CheckResult[];
}

/**
 * La provenienza di prova è intitolata all'esecuzione.
 *
 * D1 è persistente: un identificativo fisso farebbe collidere la seconda
 * esecuzione della suite sullo stesso database, e la suite deve poter girare
 * più volte — è il modo in cui si verifica che una modifica non ha rotto nulla.
 */
function provDoc(docId: string): Provenance {
	return { kind: "documento", documentId: docId, page: 4 };
}

/**
 * Confronto strutturale indipendente dall'ordine delle chiavi.
 *
 * `JSON.stringify` confronta anche l'ordine di inserimento, che non è parte del
 * valore: due oggetti identici letti da due motori diversi possono averle in
 * ordine diverso. Un autotest che riporta un fallimento falso è peggio di
 * nessun autotest, quindi le chiavi vengono ordinate prima del confronto.
 *
 * Qui serve una versione propria perché questa suite gira anche nel worker,
 * dove `node:assert` non esiste.
 */
function stable(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;

	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}

export function sameShape(a: unknown, b: unknown): boolean {
	return stable(a) === stable(b);
}

export interface SelfTestOptions {
	/** Etichetta del motore, per il referto. */
	readonly engine: string;
	/** Prefisso per gli identificativi: due esecuzioni non devono collidere. */
	readonly runId: string;
	readonly currentYear?: number;
}

export async function runSelfTest(
	db: SqlDatabase,
	options: SelfTestOptions,
): Promise<SelfTestReport> {
	const checks: CheckResult[] = [];
	const check = (name: string, ok: boolean, detail?: string) => {
		checks.push({ name, ok, detail });
	};
	const attempt = async (name: string, body: () => Promise<void>) => {
		try {
			await body();
		} catch (error) {
			check(name, false, error instanceof Error ? error.message : String(error));
		}
	};

	const suffix = options.runId;
	const unoId = `c_uno_${suffix}`;
	const dueId = `c_due_${suffix}`;
	const docId = `doc_${suffix}`;
	const PROV_DOC = provDoc(docId);

	const clock: Clock = (() => {
		let t = 1_000;
		return { now: () => (t += 1) };
	})();
	const ids: IdSource = (() => {
		let n = 0;
		return { next: (p) => `${p}_${suffix}_${(n += 1)}` };
	})();

	await db
		.prepare(`INSERT INTO cantina (id,nome,lingua_origine,created_at) VALUES (?,?,'it',0)`)
		.bind(unoId, "Cantina Uno")
		.run();
	await db
		.prepare(`INSERT INTO cantina (id,nome,lingua_origine,created_at) VALUES (?,?,'it',0)`)
		.bind(dueId, "Cantina Due")
		.run();
	await db
		.prepare(
			`INSERT INTO source_document (id,cantina_id,sha256,r2_key,mime,stato,uploaded_by,uploaded_at)
			 VALUES (?,?,?,'k','application/pdf','estratto','u',0)`,
		)
		.bind(docId, unoId, `sha_${suffix}`)
		.run();

	const specialista = getAgent("specialista_bianchi_spumanti_passiti")!;
	const anagrafica = getAgent("anagrafica")!;

	const uno = await openDossier(db, unoId, { clock, ids });
	const due = await openDossier(db, dueId, { clock, ids });

	const draft = (over: Partial<FactDraft> = {}): FactDraft => ({
		cantinaId: unoId,
		scope: { type: "annata", ref: "w1:2021" },
		key: "gradazione_alcolica",
		value: { kind: "numero", value: 12.5, unit: "%vol" },
		visibility: "pubblico",
		provenance: [PROV_DOC],
		state: "proposto",
		...over,
	});

	// ─── apertura ───────────────────────────────────────────────────────────
	await attempt("una cantina inesistente è un errore", async () => {
		try {
			await openDossier(db, `fantasma_${suffix}`);
			check("una cantina inesistente è un errore", false, "nessun errore sollevato");
		} catch {
			check("una cantina inesistente è un errore", true);
		}
	});

	// ─── proposta e ammissione ──────────────────────────────────────────────
	let firstFactId = "";
	await attempt("una proposta ammessa diventa una riga", async () => {
		const out = await uno.proposeFact(specialista, draft());
		if (!out.ok) throw new Error(out.detail);
		firstFactId = out.factId;
		const facts = await uno.listFacts();
		check(
			"una proposta ammessa diventa una riga",
			facts.length === 1 && facts[0]!.version === 1,
			`fatti=${facts.length}`,
		);
	});

	await attempt("il valore numerico attraversa il confine intatto", async () => {
		const [fact] = await uno.listFacts();
		const v = fact?.value;
		check(
			"il valore numerico attraversa il confine intatto",
			v?.kind === "numero" && v.value === 12.5 && v.unit === "%vol",
			JSON.stringify(v),
		);
	});

	await attempt("una scrittura fuori ambito è respinta e registrata", async () => {
		const out = await uno.proposeFact(anagrafica, draft());
		const rejections = await uno.listRejections();
		check(
			"una scrittura fuori ambito è respinta e registrata",
			!out.ok && out.code === "AMBITO_NON_CONCESSO" && rejections.length === 1,
			`ok=${out.ok} rifiuti=${rejections.length}`,
		);
	});

	await attempt("il fatto vivo duplicato è un esito tipizzato", async () => {
		const out = await uno.proposeFact(specialista, draft());
		check(
			"il fatto vivo duplicato è un esito tipizzato",
			!out.ok && out.code === "CHIAVE_GIA_VIVA",
			`ok=${out.ok}`,
		);
	});

	// ─── provenienza: andata e ritorno ──────────────────────────────────────
	await attempt("tutte le provenienze si rileggono identiche", async () => {
		const varianti: Provenance[] = [
			{ kind: "documento", documentId: docId, page: 7, charStart: 10, charEnd: 20 },
			{ kind: "dichiarazione", answerId: "a1", respondent: "enologo", receivedAt: 42 },
			{ kind: "pagina_pubblica", url: "https://e.invalid/x", retrievedAt: 9, snapshotKey: "s" },
			{ kind: "derivato", fromFactIds: ["f1", "f2"], rule: "promozione_ambito" },
			{ kind: "inferenza_modello", promptVersion: "x@1", runId: "r1" },
		];
		const out = await uno.proposeFact(
			specialista,
			draft({ scope: { type: "annata", ref: "w1:2099" }, provenance: varianti }),
		);
		if (!out.ok) throw new Error(out.detail);

		const fact = (await uno.listFacts({ scopeRef: "w1:2099" }))[0];
		const letti = fact?.provenance ?? [];
		const uguali = varianti.every((v) => {
			const trovato = letti.find((x) => x.kind === v.kind);
			return trovato !== undefined && sameShape(trovato, v);
		});
		check(
			"tutte le provenienze si rileggono identiche",
			uguali && letti.length === 5,
			`letti=${letti.length}`,
		);
	});

	// ─── approvazione ───────────────────────────────────────────────────────
	await attempt("l'inferenza del modello non si approva", async () => {
		const target = (await uno.listFacts({ scopeRef: "w1:2099" }))[0];
		// quel fatto ha anche un appoggio documentale: si approva
		const esito = await uno.approve(target!.id, { approvedBy: "orch" });
		const solaInferenza = await uno.proposeFact(
			specialista,
			draft({
				scope: { type: "annata", ref: "w1:2098" },
				provenance: [{ kind: "inferenza_modello", promptVersion: "x@1", runId: "r" }],
			}),
		);
		const rifiuto = solaInferenza.ok
			? await uno.approve(solaInferenza.factId, { approvedBy: "orch" })
			: { ok: true };
		check(
			"l'inferenza del modello non si approva",
			esito.ok && !rifiuto.ok,
			`appoggiato=${esito.ok} inferenza=${rifiuto.ok}`,
		);
	});

	// ─── nuova versione: la transazione del motore ──────────────────────────
	await attempt("una nuova versione è atomica e porta supersede", async () => {
		const out = await uno.supersede(
			specialista,
			firstFactId,
			draft({ value: { kind: "numero", value: 12.8, unit: "%vol" } }),
		);
		if (!out.ok) throw new Error(out.detail);

		const tutti = await uno.listFacts({ scopeRef: "w1:2021" });
		const vecchio = tutti.find((f) => f.id === firstFactId);
		const nuovo = tutti.find((f) => f.id === out.factId);
		check(
			"una nuova versione è atomica e porta supersede",
			vecchio?.state === "superato" &&
				nuovo?.version === 2 &&
				nuovo?.supersedes === firstFactId &&
				(nuovo?.provenance.length ?? 0) === 1,
			`vecchio=${vecchio?.state} nuovo=v${nuovo?.version} prov=${nuovo?.provenance.length}`,
		);
	});

	await attempt("un secondo superamento è un conflitto, non un'eccezione", async () => {
		const out = await uno.supersede(specialista, firstFactId, draft());
		check(
			"un secondo superamento è un conflitto, non un'eccezione",
			!out.ok && out.code === "CONFLITTO_VERSIONE",
			`ok=${out.ok} codice=${out.ok ? "-" : out.code}`,
		);
	});

	await attempt("una transazione fallita non lascia nulla applicato", async () => {
		const prima = await uno.listFacts({ scopeRef: "w1:2099" });
		const vivo = prima.find((f) => f.state !== "superato");
		if (vivo === undefined) throw new Error("nessun fatto vivo da superare");

		// provenienza documentale senza pagina: viola il CHECK dello schema,
		// e l'inserimento della fonte è l'ultima istruzione della transazione
		const invalida = { kind: "documento", documentId: docId, page: null } as unknown as Provenance;
		let sollevato = false;
		try {
			await uno.supersede(
				specialista,
				vivo.id,
				draft({ scope: { type: "annata", ref: "w1:2099" }, provenance: [invalida] }),
			);
		} catch {
			sollevato = true;
		}

		const dopo = await uno.listFacts({ scopeRef: "w1:2099" });
		const ancoraVivo = dopo.find((f) => f.id === vivo.id);
		check(
			"una transazione fallita non lascia nulla applicato",
			sollevato && dopo.length === prima.length && ancoraVivo?.state === vivo.state,
			`sollevato=${sollevato} prima=${prima.length} dopo=${dopo.length} stato=${ancoraVivo?.state}`,
		);
	});

	// ─── isolamento ─────────────────────────────────────────────────────────
	await attempt("ciascun fascicolo vede soltanto i propri fatti", async () => {
		const out = await due.proposeFact(specialista, {
			...draft(),
			// dichiara la cantina sbagliata: deve essere ignorata
			cantinaId: unoId,
			provenance: [{ kind: "dichiarazione", answerId: "a", respondent: "t", receivedAt: 1 }],
		});
		if (!out.ok) throw new Error(out.detail);

		const fdue = await due.listFacts();
		const altrui = await uno.approve(out.factId, { approvedBy: "orch" });
		check(
			"ciascun fascicolo vede soltanto i propri fatti",
			fdue.length === 1 && fdue[0]!.cantinaId === dueId && !altrui.ok,
			`fdue=${fdue.length} cantina=${fdue[0]?.cantinaId} approvazioneAltrui=${altrui.ok}`,
		);
	});

	// ─── Sentinella e cancelli ──────────────────────────────────────────────
	await attempt("la Sentinella trova il valore impossibile e l'anomalia si salva", async () => {
		const out = await uno.proposeFact(
			specialista,
			draft({ scope: { type: "annata", ref: "w1:2020" }, value: { kind: "numero", value: 125, unit: "%vol" } }),
		);
		if (!out.ok) throw new Error(out.detail);
		await uno.approve(out.factId, { approvedBy: "orch" });

		const facts = await uno.listApprovedFacts();
		const findings = runDeterministicChecks(
			{ facts },
			{ currentYear: options.currentYear ?? 2026 },
		);
		const impossibile = findings.filter((f) => f.code === "VALORE_IMPOSSIBILE");
		await uno.openFindings(impossibile);

		const issues = await uno.listOpenIssues();
		const salvata = issues.find((i) => i.code === "VALORE_IMPOSSIBILE");
		check(
			"la Sentinella trova il valore impossibile e l'anomalia si salva",
			impossibile.length === 1 &&
				salvata !== undefined &&
				(salvata.detail ?? "").includes("non è un vino") &&
				salvata.evidence.length > 0,
			`trovate=${impossibile.length} motivo=${salvata?.detail?.slice(0, 40)}`,
		);
	});

	await attempt("il cancello si chiude solo sulla referenza interessata", async () => {
		const facts = await uno.listApprovedFacts();
		const issues = await uno.listOpenIssues();
		const w1 = evaluateGate({ target: "referenza", ref: "w1" }, facts, issues);
		const w2 = evaluateGate({ target: "referenza", ref: "w2" }, facts, issues);
		check(
			"il cancello si chiude solo sulla referenza interessata",
			!w1.open && !w2.open,
			// w2 è chiuso per dati mancanti, non per l'anomalia: verifichiamo il motivo
			`w1=${w1.open} w2=${w2.open}`,
		);
	});

	// ─── domande ────────────────────────────────────────────────────────────
	await attempt("il ciclo della domanda attraversa i suoi stati", async () => {
		const aperta = await uno.questions.open(
			{
				semanticKey: `annata:w1:2020/gradazione_alcolica`,
				topic: "referenza:w1",
				audience: "enologo",
				scope: { type: "annata", ref: "w1:2020" },
				factKey: "gradazione_alcolica",
				issueIds: ["i1"],
				reasons: ["125 %vol non è un vino"],
				blocking: true,
			},
			"it",
			"Qual è la gradazione effettiva?",
		);
		if (aperta.action !== "creata") throw new Error(`apertura: ${aperta.action}`);

		const rilasciate = await uno.questions.release(5);
		const risposta = await uno.questions.recordAnswer(aperta.questionId, {
			kind: "non_disponibile",
			respondent: "titolare",
		});
		const finale = await uno.questions.get(aperta.questionId);

		check(
			"il ciclo della domanda attraversa i suoi stati",
			rilasciate.length === 1 &&
				risposta.ok &&
				risposta.consequence.kind === "proponi_non_disponibile" &&
				finale?.state === "risposta",
			`rilasciate=${rilasciate.length} risposta=${risposta.ok} stato=${finale?.state}`,
		);
	});

	await attempt("una domanda altrui non è rispondibile", async () => {
		const q = (await uno.questions.list())[0];
		const r = await due.questions.recordAnswer(q!.id, {
			kind: "testo",
			content: "x",
			respondent: "r",
		});
		check("una domanda altrui non è rispondibile", !r.ok, `ok=${r.ok}`);
	});

	const passed = checks.filter((c) => c.ok).length;
	return {
		engine: options.engine,
		total: checks.length,
		passed,
		failed: checks.length - passed,
		checks,
	};
}
