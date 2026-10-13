/**
 * I dieci agenti come dati.
 *
 * Gli agenti non sono dieci basi di codice: sono dieci configurazioni di un
 * unico kernel. Le proprietà difensive del programma sono qui verificabili per
 * ispezione e per test, invece di essere sparse nei prompt:
 *
 *  - `canApprove` è false per tutti e dieci;
 *  - `writeScopes` è sempre un sottoinsieme di `readScopes`;
 *  - chi legge contenuto non fidato (agente 8) non ha strumenti di attivazione;
 *  - nessun agente possiede uno strumento che tocchi la e-label.
 *
 * Vedi docs/vinoveritas/03-agenti.md
 */

import type { AgentSpec, ScopeType } from "./types.ts";

/**
 * Catalogo chiuso degli strumenti. È un'unione, non `string`: aggiungere una
 * capacità richiede di dichiararla qui, dove è visibile in revisione.
 */
export type ToolName =
	// lettura del fascicolo
	| "leggi_stato_fascicolo"
	| "leggi_fatti"
	| "leggi_fatti_approvati"
	| "leggi_anomalie"
	| "leggi_documenti"
	| "leggi_passaggio_documento"
	// proposta (mai approvazione)
	| "proponi_fatto"
	| "proponi_promozione_ambito"
	| "proponi_traduzione"
	| "apri_anomalia"
	| "marca_da_riesaminare"
	// pianificazione
	| "pianifica_attivita"
	| "apri_attivita"
	| "chiudi_attivita"
	// dialogo con la cantina
	| "cerca_risposta_esistente"
	| "formula_domanda"
	// documentale
	| "ingerisci_documento"
	| "estrai_testo_con_citazioni"
	| "classifica_documento"
	| "proponi_collegamento"
	| "indicizza_frammenti"
	// ricerca esterna
	| "ricerca_web"
	// attivazione — esclusive dell'agente 9
	| "prepara_operazione"
	| "salva_operazione"
	| "pubblica_operazione"
	| "verifica_operazione";

/** Gli strumenti che scrivono verso VinoVeritas. Solo l'agente 9 li possiede. */
export const ACTIVATION_TOOLS: readonly ToolName[] = [
	"prepara_operazione",
	"salva_operazione",
	"pubblica_operazione",
	"verifica_operazione",
];

/**
 * Il confine e-label. Nessuno strumento può corrispondere a questi schemi:
 * un'asserzione in integrazione continua fallisce la build se ne comparisse uno.
 * La pagina normativa mantiene il proprio percorso separato.
 */
export const FORBIDDEN_TOOL_PATTERNS: readonly RegExp[] = [
	/e[-_]?label/i,
	/etichetta[-_]?elettronica/i,
	/pagina[-_]?normativa/i,
];

export interface VinoVeritasAgentSpec extends AgentSpec {
	readonly numero: number;
	readonly nome: string;
	readonly tools: readonly ToolName[];
	readonly readScopes: readonly ScopeType[];
	readonly writeScopes: readonly ScopeType[];
}

const MODEL = "claude-opus-5";

const ALL_SCOPES: readonly ScopeType[] = [
	"cantina",
	"marchio",
	"sede",
	"vino",
	"annata",
	"lotto",
	"vigneto",
	"territorio",
];

export const AGENTS: readonly VinoVeritasAgentSpec[] = [
	{
		numero: 1,
		nome: "Coordinatore",
		id: "coordinatore",
		promptVersion: "coordinatore@2026-03-11",
		model: MODEL,
		// il lavoro è già codice: lo sforzo basso non costa qualità
		effort: "low",
		readScopes: ALL_SCOPES,
		// non scrive fatti: apre attività e legge cancelli
		writeScopes: [],
		tools: [
			"leggi_stato_fascicolo",
			"leggi_anomalie",
			"pianifica_attivita",
			"apri_attivita",
			"chiudi_attivita",
		],
		budget: {
			maxDurationMs: 60_000,
			maxCostUsd: 0.5,
			maxAttempts: 3,
			taskBudgetTokens: 20_000,
		},
		canApprove: false,
	},
	{
		numero: 2,
		nome: "Anagrafica e dati fiscali",
		id: "anagrafica",
		promptVersion: "anagrafica@2026-03-11",
		model: MODEL,
		effort: "medium",
		readScopes: ["cantina", "marchio", "sede"],
		writeScopes: ["cantina", "marchio", "sede"],
		tools: [
			"leggi_documenti",
			"leggi_passaggio_documento",
			"proponi_fatto",
			"apri_anomalia",
		],
		budget: {
			maxDurationMs: 120_000,
			maxCostUsd: 1,
			maxAttempts: 3,
			taskBudgetTokens: 30_000,
		},
		canApprove: false,
	},
	{
		numero: 3,
		nome: "Identità, storia e territorio",
		id: "identita",
		promptVersion: "identita@2026-03-11",
		model: MODEL,
		// la distinzione fra fatto, dichiarazione, territorio e narrazione
		// richiede giudizio: qui lo sforzo alto si ripaga
		effort: "high",
		readScopes: ["cantina", "vigneto", "territorio", "marchio"],
		writeScopes: ["cantina", "vigneto", "territorio"],
		tools: [
			"leggi_documenti",
			"leggi_passaggio_documento",
			"ricerca_web",
			"proponi_fatto",
			"proponi_promozione_ambito",
			"apri_anomalia",
		],
		budget: {
			maxDurationMs: 180_000,
			maxCostUsd: 1.5,
			maxAttempts: 3,
			taskBudgetTokens: 40_000,
		},
		canApprove: false,
	},
	{
		numero: 4,
		nome: "Bianchi, spumanti e passiti",
		id: "specialista_bianchi_spumanti_passiti",
		promptVersion: "specialista_referenze@2026-03-11",
		model: MODEL,
		effort: "medium",
		readScopes: ["vino", "annata", "lotto", "territorio", "vigneto"],
		writeScopes: ["vino", "annata", "lotto"],
		tools: [
			"leggi_documenti",
			"leggi_passaggio_documento",
			"proponi_fatto",
			"apri_anomalia",
		],
		budget: {
			maxDurationMs: 120_000,
			maxCostUsd: 2,
			maxAttempts: 3,
			taskBudgetTokens: 30_000,
		},
		canApprove: false,
	},
	{
		numero: 5,
		nome: "Altre referenze",
		id: "specialista_altre_referenze",
		// stesso prompt dell'agente 4: condividere lo schema non è una
		// convenzione da rispettare, è la stessa definizione
		promptVersion: "specialista_referenze@2026-03-11",
		model: MODEL,
		effort: "medium",
		readScopes: ["vino", "annata", "lotto", "territorio", "vigneto"],
		writeScopes: ["vino", "annata", "lotto"],
		tools: [
			"leggi_documenti",
			"leggi_passaggio_documento",
			"proponi_fatto",
			"apri_anomalia",
		],
		budget: {
			maxDurationMs: 120_000,
			maxCostUsd: 2,
			maxAttempts: 3,
			taskBudgetTokens: 30_000,
		},
		canApprove: false,
	},
	{
		numero: 6,
		nome: "Sentinella della qualità",
		id: "sentinella",
		promptVersion: "sentinella@2026-03-11",
		model: MODEL,
		// la revisione avversariale è il controllo che si ripaga di più
		effort: "xhigh",
		readScopes: ALL_SCOPES,
		// classifica, non corregge: nessun ambito in scrittura
		writeScopes: [],
		tools: [
			"leggi_fatti",
			"leggi_documenti",
			// controlla le fonti originali, non i riepiloghi degli altri agenti
			"leggi_passaggio_documento",
			"apri_anomalia",
		],
		budget: {
			maxDurationMs: 300_000,
			maxCostUsd: 2,
			maxAttempts: 3,
			taskBudgetTokens: 60_000,
		},
		canApprove: false,
	},
	{
		numero: 7,
		nome: "Ambasciatore della Cantina",
		id: "ambasciatore",
		promptVersion: "ambasciatore@2026-03-11",
		model: MODEL,
		effort: "medium",
		readScopes: ALL_SCOPES,
		// non approva ciò che raccoglie: instrada
		writeScopes: [],
		tools: [
			"leggi_anomalie",
			"cerca_risposta_esistente",
			"formula_domanda",
		],
		budget: {
			maxDurationMs: 120_000,
			maxCostUsd: 1,
			maxAttempts: 3,
			taskBudgetTokens: 30_000,
		},
		canApprove: false,
	},
	{
		numero: 8,
		nome: "Documentalista",
		id: "documentalista",
		promptVersion: "documentalista@2026-03-11",
		model: MODEL,
		effort: "medium",
		// è l'agente che legge contenuto non fidato: l'insieme di strumenti
		// più povero del sistema, e nessun ambito in scrittura
		readScopes: [],
		writeScopes: [],
		tools: [
			"ingerisci_documento",
			"estrai_testo_con_citazioni",
			"classifica_documento",
			"proponi_collegamento",
			"indicizza_frammenti",
			"apri_anomalia",
		],
		budget: {
			maxDurationMs: 180_000,
			maxCostUsd: 1.5,
			maxAttempts: 3,
			taskBudgetTokens: 40_000,
		},
		canApprove: false,
	},
	{
		numero: 9,
		nome: "Responsabile dell'attivazione",
		id: "attivazione",
		promptVersion: "attivazione@2026-03-11",
		model: MODEL,
		// non costruisce chiamate: sceglie fra operazioni già definite
		effort: "low",
		// legge fatti approvati, non testo grezzo di documenti
		readScopes: ALL_SCOPES,
		writeScopes: [],
		tools: [
			"leggi_fatti_approvati",
			"prepara_operazione",
			"salva_operazione",
			"pubblica_operazione",
			"verifica_operazione",
		],
		budget: {
			maxDurationMs: 120_000,
			maxCostUsd: 1,
			maxAttempts: 3,
			taskBudgetTokens: 20_000,
		},
		canApprove: false,
	},
	{
		numero: 10,
		nome: "Revisore linguistico ed enologico",
		id: "revisore",
		promptVersion: "revisore@2026-03-11",
		model: MODEL,
		effort: "high",
		readScopes: ALL_SCOPES,
		writeScopes: [],
		tools: [
			"leggi_fatti_approvati",
			"proponi_traduzione",
			"marca_da_riesaminare",
			"apri_anomalia",
		],
		budget: {
			maxDurationMs: 180_000,
			maxCostUsd: 1.5,
			maxAttempts: 3,
			taskBudgetTokens: 40_000,
		},
		canApprove: false,
	},
];

export function getAgent(id: string): VinoVeritasAgentSpec | undefined {
	return AGENTS.find((a) => a.id === id);
}
