/**
 * Prova il Coordinatore nel runtime: Durable Object e Workflow veri.
 *
 * Verifica ciò che nessun test unitario può: che il percorso si sospenda su
 * `waitForEvent`, riprenda alla risposta, che due percorsi sulla stessa cantina
 * non partano insieme, e che il rilascio avvenga.
 *
 * Uso:  npm run coordinatore
 */

import { spawn } from "node:child_process";

import { createServer } from "node:net";

/**
 * Una porta libera scelta a runtime.
 *
 * Una porta fissa collide con un `wrangler dev` rimasto da una prova
 * precedente, e il collaudo finisce per interrogare il server vecchio — che
 * serve il codice vecchio. È successo.
 */
async function portaLibera() {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.once("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const porta = s.address().port;
			s.close(() => resolve(porta));
		});
	});
}

const PORT = Number(process.env.COORD_PORT ?? (await portaLibera()));
const SUFFIX = Date.now().toString(36);

const dev = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--local"], {
	stdio: ["ignore", "pipe", "pipe"],
	env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
let log = "";
dev.stdout.on("data", (c) => (log += c));
dev.stderr.on("data", (c) => (log += c));
const stop = () => !dev.killed && dev.kill("SIGTERM");
process.on("exit", stop);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${PORT}`;

async function call(path, init) {
	const res = await fetch(base + path, init);
	const text = await res.text();
	try {
		return { status: res.status, body: JSON.parse(text) };
	} catch {
		return { status: res.status, body: text };
	}
}
const post = (path, data) =>
	call(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(data),
	});

const esiti = [];
const check = (nome, ok, dettaglio) => {
	esiti.push({ nome, ok, dettaglio });
	console.log(`${ok ? "PASS  " : "FAIL  "}${nome}${ok ? "" : `  → ${dettaglio ?? ""}`}`);
};

// ─── avvio ──────────────────────────────────────────────────────────────────
const scadenza = Date.now() + 60_000;
let pronto = false;
while (Date.now() < scadenza) {
	try {
		const { body } = await call("/api/");
		if (body?.name === "VinoVeritas") {
			pronto = true;
			break;
		}
	} catch {
		/* non ascolta ancora */
	}
	await sleep(500);
}
if (!pronto) {
	console.error("il worker non è diventato pronto");
	console.error(log.split("\n").slice(-20).join("\n"));
	process.exit(1);
}

// ─── una cantina con un fascicolo incompleto ────────────────────────────────
const inesistente = `c_mai_${SUFFIX}`;
const { body: statoIniziale } = await call(`/api/cantina/${inesistente}/stato`);
check(
	"una cantina senza fascicolo dà errore, non uno stato vuoto",
	statoIniziale?.errore !== undefined,
	JSON.stringify(statoIniziale).slice(0, 80),
);

// una cantina con un'anomalia bloccante e nessuna domanda pregressa
const cantinaViva = `c_coord_${SUFFIX}`;
const { status: seminata } = await post("/api/dev/semina", { cantinaId: cantinaViva });
check("la cantina di prova si semina", seminata === 201, `status=${seminata}`);
const { body: stato } = await call(`/api/cantina/${cantinaViva}/stato`);
check(
	"l'attore riporta lo stato del fascicolo",
	stato?.cantinaId === cantinaViva && typeof stato?.fatti?.approvati === "number",
	JSON.stringify(stato).slice(0, 120),
);
check(
	"l'attore riporta le statistiche della propria coda",
	typeof stato?.codaStats?.completate === "number",
	JSON.stringify(stato?.codaStats),
);


// ─── archivio: caricamento, deduplica, estrazione testuale ─────────────────
const SCHEDA = `Soave Classico DOC 2021. Gradazione dodici virgola cinque per cento in volume.
Affinamento in acciaio per sei mesi, poi tre mesi in bottiglia prima della vendita.
Il vigneto si trova a trecento metri di altitudine, con esposizione a sud-est.`;

async function carica(nome, tipo, corpo) {
	const res = await fetch(`${base}/api/cantina/${cantinaViva}/documenti`, {
		method: "PUT",
		headers: { "content-type": tipo, "x-filename": nome },
		body: corpo,
	});
	return { status: res.status, body: await res.json().catch(() => null) };
}

const { status: s1, body: d1 } = await carica("scheda-tecnica-soave.txt", "text/plain", SCHEDA);
check(
	"un materiale testuale si carica ed è estratto subito",
	s1 === 201 && d1?.status === "nuovo" && d1?.estratto === true && d1?.frammenti > 0,
	JSON.stringify(d1),
);
check(
	"la classe è proposta dal nome del file",
	d1?.classe === "scheda_tecnica" && d1?.daConfermare === false,
	`classe=${d1?.classe} daConfermare=${d1?.daConfermare}`,
);

const { status: s2, body: d2 } = await carica("copia-della-scheda.txt", "text/plain", SCHEDA);
check(
	"lo stesso contenuto non genera una seconda fonte",
	s2 === 200 && d2?.status === "duplicato" && d2?.documentId === d1?.documentId,
	JSON.stringify(d2),
);

const { body: d3 } = await carica("scansione.pdf", "application/pdf", "%PDF-1.4 finto");
check(
	"un PDF resta caricato e dichiara perché l'estrazione è rinviata",
	d3?.status === "nuovo" && d3?.estratto === false && /modello/.test(d3?.dettaglio ?? ""),
	JSON.stringify(d3),
);

const { body: d4 } = await carica("sporco.txt", "text/plain", "~|#@^¬ł€¶•ªº–≠«∑€®†¥øπ å∫ç∂´ƒ©");
check(
	"un testo illeggibile non viene segmentato e lo dice",
	d4?.estratto === false && /alfabetico|breve/.test(d4?.dettaglio ?? ""),
	JSON.stringify(d4),
);

const { status: vuoto } = await carica("vuoto.txt", "text/plain", "");
check("un corpo vuoto è respinto", vuoto === 400, `status=${vuoto}`);

const { body: elenco } = await call(`/api/cantina/${cantinaViva}/documenti`);
// verifica per nome, non per conteggio: la rotta di semina lascia un proprio
// documento, e un'asserzione sul totale si rompe a ogni cosa che se ne aggiunge
const statoDi = (nome) =>
	(elenco?.documenti ?? []).find((d) => d.filename === nome)?.status;
check(
	"l'elenco dei materiali riflette lo stato di ciascuno",
	statoDi("scheda-tecnica-soave.txt") === "estratto" &&
		statoDi("scansione.pdf") === "caricato" &&
		statoDi("sporco.txt") === "illeggibile",
	JSON.stringify((elenco?.documenti ?? []).map((d) => [d.filename, d.status])),
);
check(
	"il documento estratto porta il numero di pagine e la dimensione",
	(() => {
		const d = (elenco?.documenti ?? []).find((x) => x.filename === "scheda-tecnica-soave.txt");
		return d?.pages === 1 && typeof d?.sizeBytes === "number" && d.sizeBytes > 0;
	})(),
	JSON.stringify((elenco?.documenti ?? []).find((x) => x.filename === "scheda-tecnica-soave.txt")),
);
check(
	"il documento illeggibile porta il motivo",
	typeof (elenco?.documenti ?? []).find((x) => x.filename === "sporco.txt")?.illegibleReason ===
		"string",
	JSON.stringify((elenco?.documenti ?? []).find((x) => x.filename === "sporco.txt")),
);

// ─── il percorso, con un'attesa lunga: si deve sospendere ───────────────────
const { status: avviato, body: istanza } = await post("/api/onboarding", {
	cantinaId: cantinaViva,
	obiettivo: "profilo",
	currentYear: 2026,
	// lunga: il percorso resta sospeso finché non arrivano le risposte
	attesaRisposte: "10 minutes",
});
check(
	"il percorso parte e restituisce un'istanza",
	avviato === 202 && typeof istanza?.id === "string",
	JSON.stringify(istanza).slice(0, 100),
);

// ─── validazione dell'ingresso ──────────────────────────────────────────────
const { status: senzaCantina } = await post("/api/onboarding", {});
check("senza cantinaId il percorso non parte", senzaCantina === 400);
const { status: obiettivoFinto } = await post("/api/onboarding", {
	cantinaId: cantinaViva,
	obiettivo: "qualunque_cosa",
});
check("un obiettivo non valido è respinto", obiettivoFinto === 400);
const { status: annoFinto } = await post("/api/onboarding", {
	cantinaId: cantinaViva,
	currentYear: 99999,
});
check("un anno fuori intervallo è respinto", annoFinto === 400);

// ─── il percorso si sospende sull'attesa delle risposte ─────────────────────
let domande = [];
for (let i = 0; i < 40; i++) {
	await sleep(500);
	({ body: { domande = [] } = {} } = await call(`/api/cantina/${cantinaViva}/domande`));
	if (domande.length > 0) break;
}
check("il giro ha aperto una domanda sul fascicolo", domande.length > 0, JSON.stringify(domande).slice(0, 150));
check(
	"la domanda riguarda il dato contestato, non un dato mancante",
	domande.some((d) => d.factKey === "gradazione_alcolica"),
	JSON.stringify(domande.map((d) => d.factKey)),
);
check(
	"la domanda è stata rilasciata al produttore",
	domande.some((d) => d.state === "inviata"),
	JSON.stringify(domande.map((d) => d.state)),
);

const { body: sospeso } = await call(`/api/onboarding/${istanza.id}`);
check(
	"il percorso è sospeso in attesa, non concluso",
	sospeso?.status === "running" || sospeso?.status === "waiting" || sospeso?.status === "waitingForPause",
	`status=${sospeso?.status}`,
);

// ─── un solo onboarding per cantina, mentre il primo è sospeso ──────────────
const { body: secondo } = await post("/api/onboarding", {
	cantinaId: cantinaViva,
	obiettivo: "profilo",
	currentYear: 2026,
});
let statoSecondo = null;
for (let i = 0; i < 30; i++) {
	await sleep(500);
	({ body: statoSecondo } = await call(`/api/onboarding/${secondo.id}`));
	if (statoSecondo?.status === "complete" || statoSecondo?.status === "errored") break;
}
check(
	"un secondo percorso non parte mentre il primo tiene la cantina",
	statoSecondo?.output?.esito === "occupato",
	`esito=${statoSecondo?.output?.esito} status=${statoSecondo?.status}`,
);
check(
	"e dice chi la tiene",
	String(statoSecondo?.output?.dettaglio ?? "").includes(istanza.id),
	String(statoSecondo?.output?.dettaglio ?? "").slice(0, 120),
);

// ─── la risposta riprende il percorso ───────────────────────────────────────
const daRispondere = domande.filter((d) => d.state === "inviata");
const { status: consegna, body: consegnate } = await post(
	`/api/onboarding/${istanza.id}/risposte`,
	{
		risposte: daRispondere.map((d) => ({
			questionId: d.id,
			kind: "non_disponibile",
			respondent: "titolare",
		})),
	},
);
check(
	"le risposte si consegnano al percorso sospeso",
	consegna === 200 && consegnate?.consegnate === daRispondere.length,
	`status=${consegna} ${JSON.stringify(consegnate)}`,
);

let statoPrimo = null;
for (let i = 0; i < 60; i++) {
	await sleep(1_000);
	({ body: statoPrimo } = await call(`/api/onboarding/${istanza.id}`));
	if (statoPrimo?.status === "complete" || statoPrimo?.status === "errored") break;
}
check(
	"il percorso riprende dalla risposta e si conclude",
	statoPrimo?.status === "complete",
	`status=${statoPrimo?.status} error=${JSON.stringify(statoPrimo?.error ?? "").slice(0, 200)}`,
);

const out = statoPrimo?.output ?? null;
check(
	"l'esito dichiara quanti cicli e quali cancelli",
	out !== null && typeof out.cicli === "number" && Array.isArray(out.cancelli),
	JSON.stringify(out).slice(0, 200),
);
check(
	"il percorso ha eseguito una verifica per ciclo",
	Array.isArray(out?.verifiche) && out.verifiche.length === out.cicli,
	`verifiche=${out?.verifiche?.length} cicli=${out?.cicli}`,
);
check(
	"la verifica ha trovato l'anomalia del fascicolo seminato",
	(out?.verifiche?.[0]?.codici ?? []).includes("VALORE_IMPOSSIBILE"),
	JSON.stringify(out?.verifiche?.[0]?.codici),
);
check("il limite di due cicli è rispettato", (out?.cicli ?? 99) <= 2, `cicli=${out?.cicli}`);
check(
	"le domande sono raggruppate per argomento e interlocutore",
	Array.isArray(out?.giri?.[0]?.lotti) && out.giri[0].lotti.length > 0,
	JSON.stringify(out?.giri?.[0]?.lotti),
);
check(
	"un percorso concluso rilascia la cantina",
	(await call(`/api/cantina/${cantinaViva}/stato`)).body?.claim === null,
	JSON.stringify((await call(`/api/cantina/${cantinaViva}/stato`)).body?.claim),
);

const { body: statoFinale } = await call(`/api/cantina/${cantinaViva}/stato`);
check(
	"la risposta è registrata sulla domanda",
	(statoFinale?.domande?.risposte ?? 0) > 0,
	JSON.stringify(statoFinale?.domande),
);
check(
	"la coda dell'attore ha serializzato le operazioni",
	(statoFinale?.codaStats?.completate ?? 0) > 0 && (statoFinale?.codaStats?.inCoda ?? -1) === 0,
	JSON.stringify(statoFinale?.codaStats),
);

stop();
const falliti = esiti.filter((e) => !e.ok);
console.log(`\n${esiti.length - falliti.length}/${esiti.length} passati, ${falliti.length} falliti`);
if (falliti.length > 0) {
	console.error("\n--- ultime righe del log del worker ---");
	console.error(log.split("\n").slice(-25).join("\n"));
}
process.exit(falliti.length === 0 ? 0 : 1);
