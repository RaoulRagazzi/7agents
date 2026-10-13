/**
 * Esegue la verifica d'integrazione del fascicolo contro il D1 locale,
 * dentro il runtime del worker.
 *
 * È la stessa suite che `npm test` esegue su `node:sqlite`. Girarla anche qui
 * verifica ciò che un typecheck non può: che `D1Database` soddisfi la porta SQL
 * non solo nei tipi ma in esercizio, e che `batch()` abbia su D1 la semantica
 * transazionale che il codice assume.
 *
 * Presuppone un `vite build` già fatto (lo script npm lo include) perché
 * `wrangler dev` serve il worker compilato in `dist/`, non il sorgente.
 *
 * Uso:  npm run autotest
 */

import { spawn } from "node:child_process";

const PORT = Number(process.env.AUTOTEST_PORT ?? 8831);
const RUN_ID = process.env.AUTOTEST_RUN ?? Date.now().toString(36);
const AVVIO_MS = 60_000;

const dev = spawn(
	"npx",
	["wrangler", "dev", "--port", String(PORT), "--local"],
	{
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
	},
);

let log = "";
dev.stdout.on("data", (c) => (log += c));
dev.stderr.on("data", (c) => (log += c));

const stop = () => {
	if (!dev.killed) dev.kill("SIGTERM");
};
process.on("exit", stop);
process.on("SIGINT", () => {
	stop();
	process.exit(130);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchLocal(path) {
	// --noproxy: il proxy di uscita non deve intercettare 127.0.0.1
	const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
	return { status: res.status, body: await res.json() };
}

async function attendiPronto() {
	const scadenza = Date.now() + AVVIO_MS;
	while (Date.now() < scadenza) {
		try {
			const { body } = await fetchLocal("/api/");
			if (body?.name === "VinoVeritas") return true;
		} catch {
			// il server non ascolta ancora
		}
		await sleep(500);
	}
	return false;
}

const pronto = await attendiPronto();
if (!pronto) {
	console.error("il worker non è diventato pronto entro il tempo concesso");
	console.error(log.split("\n").slice(-20).join("\n"));
	stop();
	process.exit(1);
}

const { status, body } = await fetchLocal(`/api/autotest?run=${RUN_ID}`);
stop();

if (body?.errore !== undefined) {
	console.error(`ERRORE sul motore ${body.engine}: ${body.errore}`);
	if (body.stack) console.error(body.stack.split("\n").slice(0, 8).join("\n"));
	process.exit(1);
}

console.log(`motore: ${body.engine} — esecuzione ${RUN_ID}`);
for (const c of body.checks) {
	console.log(`${c.ok ? "PASS  " : "FAIL  "}${c.name}${c.ok ? "" : `  → ${c.detail ?? ""}`}`);
}
console.log(`\n${body.passed}/${body.total} passati, ${body.failed} falliti`);

process.exit(status === 200 && body.failed === 0 ? 0 : 1);
