import { Hono } from "hono";

import type { OnboardingParams, RisposteEvent } from "./coordinator.ts";
import { runSelfTest } from "./dossier/selftest.ts";
import type { SqlDatabase } from "./dossier/sql.ts";

/**
 * I Durable Object e i Workflow vanno esportati dall'entrypoint del worker: il
 * runtime li risolve da qui, non dal file in cui sono scritti.
 */
export { CantinaActor } from "./actor.ts";
export { OnboardingWorkflow } from "./coordinator.ts";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/", (c) => c.json({ name: "VinoVeritas" }));

/**
 * Esegue la verifica d'integrazione del fascicolo contro il D1 di questo
 * ambiente.
 *
 * È la stessa suite che i test eseguono su `node:sqlite`: se un esito
 * divergesse fra i due motori, è qui che si vede.
 *
 * Non è una rotta di esercizio: scrive righe di prova, e va chiusa dietro un
 * controllo d'accesso prima del primo rilascio pubblico.
 */
app.get("/api/autotest", async (c) => {
	const runId = c.req.query("run") ?? Date.now().toString(36);
	try {
		const report = await runSelfTest(c.env.DB as unknown as SqlDatabase, {
			engine: "cloudflare-d1",
			runId,
			currentYear: 2026,
		});
		return c.json(report, report.failed === 0 ? 200 : 500);
	} catch (error) {
		return c.json({ engine: "cloudflare-d1", errore: messaggio(error) }, 500);
	}
});

/**
 * Semina una cantina con un fascicolo deliberatamente incompleto.
 *
 * Esiste perché il sistema non ha ancora l'ingestione dei materiali: senza una
 * via per creare un fascicolo, il percorso del Coordinatore non si può provare
 * end to end. La cantina seminata ha una referenza con una gradazione
 * impossibile, cioè un'anomalia bloccante e nessuna domanda pregressa — che è
 * la condizione in cui il giro delle domande ha qualcosa da chiedere.
 *
 * Come `/api/autotest`, **non è una rotta di esercizio**: scrive righe di prova
 * e va chiusa dietro un controllo d'accesso prima del primo rilascio pubblico.
 */
app.post("/api/dev/semina", async (c) => {
	const body = await c.req
		.json<{ cantinaId?: string }>()
		.catch((): { cantinaId?: string } => ({}));
	const cantinaId = body.cantinaId;
	if (typeof cantinaId !== "string" || cantinaId.length === 0) {
		return c.json({ errore: "cantinaId richiesto" }, 400);
	}

	const db = c.env.DB;
	const now = Date.now();
	const prov = (factId: string, id: string) =>
		db
			.prepare(
				`INSERT INTO fact_source (id,fact_id,kind,document_id,page) VALUES (?,?,'documento',?,4)`,
			)
			.bind(id, factId, `doc_${cantinaId}`);

	const fatto = (
		id: string,
		scopeType: string,
		scopeRef: string,
		key: string,
		value: unknown,
	) =>
		db
			.prepare(
				`INSERT INTO fact (id,cantina_id,scope_type,scope_ref,key,value_json,state,
				                   visibility,version,agent,prompt_version,created_at,
				                   approved_at,approved_by)
				 VALUES (?,?,?,?,?,?,'approvato','pubblico',1,'semina','semina@1',?,?,'semina')`,
			)
			.bind(id, cantinaId, scopeType, scopeRef, key, JSON.stringify(value), now, now);

	try {
		await db.batch([
			db
				.prepare(`INSERT INTO cantina (id,nome,lingua_origine,created_at) VALUES (?,?,'it',?)`)
				.bind(cantinaId, `Cantina ${cantinaId}`, now),
			db
				.prepare(
					`INSERT INTO source_document (id,cantina_id,sha256,r2_key,mime,stato,uploaded_by,uploaded_at)
					 VALUES (?,?,?,'k','application/pdf','estratto','semina',?)`,
				)
				.bind(`doc_${cantinaId}`, cantinaId, `sha_${cantinaId}`, now),

			// il profilo è completo tranne la storia: il cancello resta chiuso
			fatto(`f_rs_${cantinaId}`, "cantina", cantinaId, "ragione_sociale", {
				kind: "testo",
				text: "Tenuta di Prova S.r.l.",
			}),
			prov(`f_rs_${cantinaId}`, `s_rs_${cantinaId}`),

			fatto(`f_cp_${cantinaId}`, "cantina", cantinaId, "contatto_pubblico", {
				kind: "testo",
				text: "info@example.invalid",
			}),
			prov(`f_cp_${cantinaId}`, `s_cp_${cantinaId}`),

			fatto(`f_nc_${cantinaId}`, "marchio", `m_${cantinaId}`, "nome_commerciale", {
				kind: "testo",
				text: "Tenuta di Prova",
			}),
			prov(`f_nc_${cantinaId}`, `s_nc_${cantinaId}`),

			// una referenza con una gradazione impossibile: anomalia bloccante
			fatto(`f_den_${cantinaId}`, "vino", `w_${cantinaId}`, "denominazione", {
				kind: "testo",
				text: "Soave Classico DOC",
			}),
			prov(`f_den_${cantinaId}`, `s_den_${cantinaId}`),

			fatto(`f_grad_${cantinaId}`, "annata", `w_${cantinaId}:2021`, "gradazione_alcolica", {
				kind: "numero",
				value: 125,
				unit: "%vol",
			}),
			prov(`f_grad_${cantinaId}`, `s_grad_${cantinaId}`),
		]);
	} catch (error) {
		return c.json({ errore: messaggio(error) }, 409);
	}

	return c.json({ cantinaId, seminata: true }, 201);
});

// ─── Coordinatore ───────────────────────────────────────────────────────────

/** Avvia l'onboarding di una cantina. */
const OBIETTIVI = ["profilo", "referenze", "sommelier", "materiali_commerciali"] as const;

type Obiettivo = (typeof OBIETTIVI)[number];

function obiettivoValido(value: unknown): value is Obiettivo {
	return typeof value === "string" && (OBIETTIVI as readonly string[]).includes(value);
}

app.post("/api/onboarding", async (c) => {
	const body = await c.req
		.json<Partial<OnboardingParams>>()
		.catch((): Partial<OnboardingParams> => ({}));

	const cantinaId = body.cantinaId;
	if (typeof cantinaId !== "string" || cantinaId.length === 0) {
		return c.json({ errore: "cantinaId richiesto" }, 400);
	}

	// l'obiettivo arriva da una richiesta: si valida invece di accettarlo. Un
	// valore inatteso deciderebbe quali cancelli valutare, cioè cosa si attiva
	if (body.obiettivo !== undefined && !obiettivoValido(body.obiettivo)) {
		return c.json(
			{ errore: `obiettivo non valido; ammessi: ${OBIETTIVI.join(", ")}` },
			400,
		);
	}

	const anno = body.currentYear;
	if (anno !== undefined && (!Number.isInteger(anno) || anno < 1800 || anno > 3000)) {
		return c.json({ errore: "currentYear fuori intervallo" }, 400);
	}

	const params: OnboardingParams = {
		cantinaId,
		obiettivo: body.obiettivo ?? "profilo",
		lang: typeof body.lang === "string" ? body.lang.slice(0, 16) : "it",
		// iniettato: la Sentinella non legge l'orologio di sistema
		currentYear: anno ?? new Date().getUTCFullYear(),
		attesaRisposte: body.attesaRisposte,
	};

	const instance = await c.env.ONBOARDING.create({ params });
	return c.json({ id: instance.id, status: await instance.status() }, 202);
});

app.get("/api/onboarding/:id", async (c) => {
	try {
		const instance = await c.env.ONBOARDING.get(c.req.param("id"));
		return c.json(await instance.status());
	} catch (error) {
		return c.json({ errore: messaggio(error) }, 404);
	}
});

/** Consegna le risposte del produttore al percorso sospeso. */
app.post("/api/onboarding/:id/risposte", async (c) => {
	const body = await c.req.json<RisposteEvent>().catch(() => null);
	if (body === null || !Array.isArray(body.risposte)) {
		return c.json({ errore: "elenco di risposte richiesto" }, 400);
	}

	try {
		const instance = await c.env.ONBOARDING.get(c.req.param("id"));
		await instance.sendEvent({ type: "risposte", payload: body });
		return c.json({ consegnate: body.risposte.length });
	} catch (error) {
		return c.json({ errore: messaggio(error) }, 404);
	}
});

// ─── Materiali ──────────────────────────────────────────────────────────────

/** Oltre questa dimensione il materiale non viene accettato. */
const LIMITE_BYTE = 20 * 1024 * 1024;

/**
 * Carica un materiale nell'archivio della cantina.
 *
 * Il corpo è il file grezzo; nome e tipo arrivano dalle intestazioni. Una
 * fonte testuale viene anche estratta subito: il contenuto **è** il testo.
 */
app.put("/api/cantina/:id/documenti", async (c) => {
	const cantinaId = c.req.param("id");
	const filename = c.req.header("x-filename") ?? "senza-nome";
	const mime = c.req.header("content-type") ?? "application/octet-stream";
	const uploadedBy = c.req.header("x-caricato-da") ?? "produttore";

	const buffer = await c.req.arrayBuffer();
	if (buffer.byteLength === 0) {
		return c.json({ errore: "corpo vuoto" }, 400);
	}
	if (buffer.byteLength > LIMITE_BYTE) {
		return c.json(
			{ errore: `materiale oltre il limite di ${LIMITE_BYTE} byte` },
			413,
		);
	}

	const attore = c.env.CANTINA.get(c.env.CANTINA.idFromName(cantinaId));
	try {
		const legato = await attore.bind(cantinaId);
		if (!legato.ok) return c.json({ errore: legato.detail }, 409);

		const esito = await attore.ingestDocument({
			bytes: new Uint8Array(buffer),
			// il nome arriva da fuori: si accorcia e si ripulisce invece di
			// fidarsi, perché finisce nei metadati dell'oggetto e nei referti
			filename: filename.replace(/[\u0000-\u001f]/g, "").slice(0, 200),
			mime: mime.split(";")[0]!.trim().slice(0, 100),
			uploadedBy: uploadedBy.slice(0, 100),
		});
		return c.json(esito, esito.status === "nuovo" ? 201 : 200);
	} catch (error) {
		return c.json({ errore: messaggio(error) }, 500);
	}
});

/** I materiali di una cantina. */
app.get("/api/cantina/:id/documenti", async (c) => {
	const cantinaId = c.req.param("id");
	const attore = c.env.CANTINA.get(c.env.CANTINA.idFromName(cantinaId));
	try {
		const legato = await attore.bind(cantinaId);
		if (!legato.ok) return c.json({ errore: legato.detail }, 409);
		return c.json({ documenti: await attore.listDocuments() });
	} catch (error) {
		return c.json({ errore: messaggio(error) }, 500);
	}
});

/** Le domande di una cantina, per chi deve rispondere. */
app.get("/api/cantina/:id/domande", async (c) => {
	const cantinaId = c.req.param("id");
	const attore = c.env.CANTINA.get(c.env.CANTINA.idFromName(cantinaId));
	try {
		const legato = await attore.bind(cantinaId);
		if (!legato.ok) return c.json({ errore: legato.detail }, 409);
		return c.json({ domande: await attore.listQuestions() });
	} catch (error) {
		return c.json({ errore: messaggio(error) }, 500);
	}
});

/** Lo stato del fascicolo di una cantina, visto dal suo attore. */
app.get("/api/cantina/:id/stato", async (c) => {
	const cantinaId = c.req.param("id");
	const attore = c.env.CANTINA.get(c.env.CANTINA.idFromName(cantinaId));

	try {
		const legato = await attore.bind(cantinaId);
		if (!legato.ok) return c.json({ errore: legato.detail }, 409);
		return c.json(await attore.state());
	} catch (error) {
		return c.json({ errore: messaggio(error) }, 500);
	}
});

function messaggio(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default app;
