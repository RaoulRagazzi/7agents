import { Hono } from "hono";

import { runSelfTest } from "./dossier/selftest.ts";
import type { SqlDatabase } from "./dossier/sql.ts";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/", (c) => c.json({ name: "VinoVeritas" }));

/**
 * Esegue la verifica d'integrazione del fascicolo contro il D1 di questo
 * ambiente.
 *
 * È la stessa suite che i test eseguono su `node:sqlite`: se un esito
 * divergesse fra i due motori, è qui che si vede. La rotta esiste perché
 * un'interfaccia che combacia nei tipi non è la stessa cosa di un'interfaccia
 * che funziona — e `D1Database` soddisfa la porta SQL strutturalmente, senza
 * adattatore, il che è un'affermazione che va verificata eseguendo.
 *
 * Non è una rotta di esercizio: scrive righe di prova, e va esposta solo dove
 * il database è di prova.
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
		return c.json(
			{
				engine: "cloudflare-d1",
				errore: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			},
			500,
		);
	}
});

export default app;
