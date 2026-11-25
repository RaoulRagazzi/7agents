/**
 * Il Coordinatore: un Workflow durevole, non una conversazione.
 *
 * Il programma chiede che *le condizioni di avanzamento siano imposte anche dal
 * software*. Qui lo sono: il percorso è una macchina a passi, ogni passo è
 * ritentabile e idempotente, e il via libera per una destinazione è il
 * risultato di `evaluateGate` — una funzione pura sui fatti approvati e sulle
 * anomalie aperte. Nessun passo può dichiarare aperta una destinazione che la
 * funzione chiude.
 *
 * ## Cosa dà l'esecuzione durevole
 *
 * Una cantina può restare settimane in attesa di una risposta. `step.waitForEvent`
 * sospende il percorso senza consumare nulla, e alla risposta riprende dal
 * punto esatto: i passi già conclusi non si rieseguono, perché il loro esito è
 * registrato. È il requisito «sospendere e riprendere», ottenuto dalla
 * piattaforma invece che da una macchina a stati scritta a mano.
 *
 * ## Cosa non fa
 *
 * Non chiama il modello. Gli specialisti che estraggono i dati richiedono il
 * piano cognitivo, che non è ancora collegato: il passo di analisi lo dichiara
 * e prosegue. Tutto il resto del percorso — rivendicazione, verifica, cancelli,
 * domande, due cicli, escalation, rilascio — è completo ed eseguibile.
 *
 * Vedi docs/vinoveritas/04-flussi.md
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { MAX_CICLI } from "./dossier/ambassador.ts";
import type { CantinaActor } from "./actor.ts";
import type {
	ClaimOutcome,
	GateSummary,
	PackSummary,
	QuestionRound,
	VerificationSummary,
} from "./actor.ts";
import type { GateTarget, TargetRef } from "./dossier/types.ts";

export interface OnboardingParams {
	readonly cantinaId: string;
	/** L'obiettivo dichiarato all'apertura: decide quali cancelli valutare. */
	readonly obiettivo: "profilo" | "referenze" | "sommelier" | "materiali_commerciali";
	readonly lang?: string;
	/**
	 * L'anno corrente, iniettato. La Sentinella non legge l'orologio di
	 * sistema, e il Coordinatore non può introdurre quella dipendenza per lei.
	 */
	readonly currentYear: number;
	/**
	 * Quanto attendere le risposte prima di considerare scaduto un ciclo.
	 * Il tipo è quello del runtime («7 days», «30 minutes»): una stringa
	 * qualunque sarebbe accettata dai tipi e rifiutata in esecuzione.
	 */
	readonly attesaRisposte?: WorkflowSleepDuration;
}

/** Ciò che il produttore manda al percorso sospeso. */
export interface RisposteEvent {
	readonly risposte: readonly {
		readonly questionId: string;
		readonly kind: "testo" | "documento" | "non_disponibile";
		readonly content?: string;
		readonly documentId?: string;
		readonly respondent: string;
	}[];
}

export interface OnboardingResult {
	readonly cantinaId: string;
	readonly obiettivo: string;
	readonly esito: "attivabile" | "sospeso" | "escalato" | "occupato";
	readonly cicli: number;
	readonly cancelli: readonly GateSummary[];
	readonly verifiche: readonly VerificationSummary[];
	readonly giri: readonly QuestionRound[];
	readonly dettaglio: string;
}

/** I cancelli che un obiettivo richiede, in ordine di dipendenza. */
export function gatesFor(obiettivo: OnboardingParams["obiettivo"]): GateTarget[] {
	switch (obiettivo) {
		case "profilo":
			return ["profilo"];
		case "referenze":
			return ["profilo", "referenza"];
		case "sommelier":
			return ["profilo", "referenza", "sommelier"];
		case "materiali_commerciali":
			return ["profilo", "referenza", "materiali_commerciali"];
	}
}

export class OnboardingWorkflow extends WorkflowEntrypoint<Env, OnboardingParams> {
	async run(
		event: WorkflowEvent<OnboardingParams>,
		step: WorkflowStep,
	): Promise<OnboardingResult> {
		const { cantinaId, obiettivo, currentYear } = event.payload;
		const lang = event.payload.lang ?? "it";
		const attesa = event.payload.attesaRisposte ?? "7 days";
		const workflowId = event.instanceId;

		const attore = this.#attore(cantinaId);
		const verifiche: VerificationSummary[] = [];
		const giri: QuestionRound[] = [];

		// ─── 1. Accoglienza: un solo onboarding per cantina ──────────────────
		const rivendicazione = await step.do<ClaimOutcome>("rivendica", async () => {
			const legato = await attore.bind(cantinaId);
			if (!legato.ok) throw new Error(legato.detail ?? "attore non legabile");
			return attore.claim(workflowId);
		});

		if (!rivendicazione.ok) {
			// non è un errore: è un secondo percorso che non deve partire
			return {
				cantinaId,
				obiettivo,
				esito: "occupato",
				cicli: 0,
				cancelli: [],
				verifiche: [],
				giri: [],
				dettaglio: `onboarding già in corso (${rivendicazione.heldBy.workflowId})`,
			};
		}

		try {
			// ─── 2. Analisi specialistica ─────────────────────────────────────
			await step.do("analisi-specialistica", async () => {
				// Il piano cognitivo non è collegato: gli specialisti che
				// estraggono i dati dai documenti richiedono il modello. Il passo
				// esiste e dichiara la propria assenza invece di fingere.
				const stato = await attore.state();
				return {
					saltato: "piano cognitivo non collegato",
					fattiPresenti: stato.fatti,
				};
			});

			// ─── 3-5. Verifica, cancelli, integrazione: al massimo due cicli ──
			let ciclo: 1 | 2 = 1;
			let cancelli: GateSummary[] = [];

			for (;;) {
				const verifica = await step.do<VerificationSummary>(
					`verifica-ciclo-${ciclo}`,
					() => attore.verify(currentYear, ciclo),
				);
				verifiche.push(verifica);

				cancelli = await step.do<GateSummary[]>(`cancelli-ciclo-${ciclo}`, () =>
					attore.gates(targetsFor(obiettivo)),
				);

				if (cancelli.every((g) => g.open)) break;

				// qualcosa blocca: si chiede, non si insiste
				const giro = await step.do<QuestionRound>(`domande-ciclo-${ciclo}`, () =>
					attore.askRound(lang),
				);
				giri.push(giro);

				if (giro.aperte === 0 && giro.rilasciate === 0) {
					// nessuna domanda da fare e i cancelli restano chiusi: il
					// percorso non può sbloccarsi da solo
					return this.#chiudi(attore, workflowId, {
						cantinaId,
						obiettivo,
						esito: "sospeso",
						cicli: ciclo,
						cancelli,
						verifiche,
						giri,
						dettaglio:
							"nessuna domanda può sbloccare le destinazioni chiuse: " +
							cancelli
								.filter((g) => !g.open)
								.map((g) => `${g.target}${g.ref ? `:${g.ref}` : ""}`)
								.join(", "),
					});
				}

				// ─── attesa durevole: qui il percorso dorme ───────────────────
				const risposte = await step
					.waitForEvent<RisposteEvent>(`risposte-ciclo-${ciclo}`, {
						type: "risposte",
						timeout: attesa,
					})
					.catch(() => null);

				if (risposte !== null) {
					await step.do(`registra-risposte-ciclo-${ciclo}`, async () => {
						let registrate = 0;
						for (const r of risposte.payload.risposte) {
							const esito = await attore.recordAnswer(r.questionId, {
								kind: r.kind,
								content: r.content,
								documentId: r.documentId,
								respondent: r.respondent,
							});
							if ((esito as { ok?: boolean }).ok === true) registrate += 1;
						}
						return { registrate };
					});
				} else {
					// nessuna risposta entro il tempo: le domande scadono, e una
					// domanda scaduta è riproponibile al ciclo successivo
					await step.do(`scadenza-ciclo-${ciclo}`, () => attore.expireQuestions(0));
				}

				if (ciclo >= MAX_CICLI) {
					return this.#chiudi(attore, workflowId, {
						cantinaId,
						obiettivo,
						esito: "escalato",
						cicli: ciclo,
						cancelli,
						verifiche,
						giri,
						dettaglio: `${MAX_CICLI} cicli senza soluzione: gestione manuale o rinvio`,
					});
				}

				ciclo = (ciclo + 1) as 1 | 2;
			}

			// ─── 6. Preparazione dell'attivazione ─────────────────────────────
			const pacchetto = await step.do<PackSummary>("prepara-attivazione", () =>
				attore.buildPack(destinazionePacchetto(obiettivo)),
			);

			// ─── 7. Verifica finale: i cancelli si rivalutano ─────────────────
			const finali = await step.do<GateSummary[]>("via-libera", () =>
				attore.gates(targetsFor(obiettivo)),
			);

			const tuttiAperti = finali.every((g) => g.open);
			return this.#chiudi(attore, workflowId, {
				cantinaId,
				obiettivo,
				esito: tuttiAperti ? "attivabile" : "sospeso",
				cicli: ciclo,
				cancelli: finali,
				verifiche,
				giri,
				dettaglio: tuttiAperti
					? `${pacchetto.entries} contenuti pronti in ${pacchetto.namespace}`
					: "un cancello si è richiuso fra la preparazione e il via libera",
			});
		} catch (errore) {
			// il rilascio non va perso per un errore: senza, la cantina resta
			// rivendicata da un percorso morto e nessun altro può ripartire
			await step.do("rilascia-dopo-errore", async () => {
				const esito = await attore.release(workflowId);
				// il passo restituisce dati semplici: un risultato RPC porta un
				// involucro che non attraversa il confine di un passo
				return { rilasciato: esito.released };
			});
			throw errore;
		}
	}

	#attore(cantinaId: string) {
		return this.env.CANTINA.get(this.env.CANTINA.idFromName(cantinaId));
	}

	async #chiudi(
		attore: DurableObjectStub<CantinaActor>,
		workflowId: string,
		risultato: OnboardingResult,
	): Promise<OnboardingResult> {
		await attore.release(workflowId);
		return risultato;
	}
}

function targetsFor(obiettivo: OnboardingParams["obiettivo"]): TargetRef[] {
	return gatesFor(obiettivo).map((target) => ({ target }));
}

function destinazionePacchetto(
	obiettivo: OnboardingParams["obiettivo"],
): "sommelier" | "profilo" | "materiali_commerciali" {
	return obiettivo === "sommelier"
		? "sommelier"
		: obiettivo === "materiali_commerciali"
			? "materiali_commerciali"
			: "profilo";
}
