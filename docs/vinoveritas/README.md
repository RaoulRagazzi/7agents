# VinoVeritas — Programma dei 10 Agenti

Progetto di un sistema che accompagna la cantina dall'inserimento dei primi
materiali fino all'attivazione verificata dei servizi.

**Obiettivo operativo:** raccogliere una volta le informazioni, verificarle,
chiedere soltanto le integrazioni necessarie e riutilizzare i dati approvati per
profilo, referenze, Sommelier e materiali commerciali.

> Questo è il programma progettuale della squadra. L'attivazione operativa
> richiede l'integrazione con le funzionalità già presenti in VinoVeritas:
> nessun documento di questa cartella autorizza scritture dirette sui dati di
> produzione, e **la e-label mantiene il proprio percorso separato**.

## Indice

| # | Documento | Contenuto |
|---|-----------|-----------|
| 00 | [Sintesi e decisioni](./00-sintesi.md) | La tesi del progetto, le sei decisioni strutturali, cosa cambia rispetto a un onboarding classico |
| 01 | [Architettura](./01-architettura.md) | I cinque piani del sistema, le piattaforme scelte, le alternative scartate e perché |
| 02 | [Il fascicolo](./02-fascicolo.md) | Modello dati, ciclo di vita del fatto, ambiti, provenienza, invalidazione selettiva |
| 03 | [I dieci agenti](./03-agenti.md) | Contratto di ciascun agente: ambito, strumenti, schema, modello, guardrail |
| 04 | [Flussi operativi](./04-flussi.md) | Percorso end-to-end, cancelli, ciclo delle domande, attivazione idempotente, ripresa |
| 05 | [Piano di realizzazione](./05-piano.md) | I dodici passi, le sei tranche, casi di prova, indicatori, costi |
| — | **[Stato di avanzamento](./STATO.md)** | **Cosa è codice eseguibile e cosa è ancora soltanto specifica** |

## Ancoraggio nel codice

Le fondamenta comuni (Tranche 2) non vivono solo come prosa. Lo
[stato di avanzamento](./STATO.md) dice con precisione cosa è implementato.

- [`migrations/`](../../migrations/) — schema D1: i vincoli che portano le invarianti a livello di database
- [`src/worker/dossier/types.ts`](../../src/worker/dossier/types.ts) — tipi del fascicolo: ambito, fatto, provenienza, anomalia, operazione di attivazione
- [`src/worker/dossier/agents.ts`](../../src/worker/dossier/agents.ts) — i dieci agenti come dati: ambiti, strumenti, budget, `canApprove: false`
- [`src/worker/dossier/admission.ts`](../../src/worker/dossier/admission.ts) — la funzione di ammissione e la transizione di approvazione
- [`src/worker/dossier/repository.ts`](../../src/worker/dossier/repository.ts) — il fascicolo di **una** cantina: `cantina_id` imposto in un unico punto, e nessun metodo che lo accetti come argomento
- [`src/worker/dossier/candidates.ts`](../../src/worker/dossier/candidates.ts) — risoluzione delle fonti contraddittorie per tabella di precedenza
- [`src/worker/dossier/pack.ts`](../../src/worker/dossier/pack.ts) — il pacchetto per il Sommelier: il punto in cui il confine di visibilità viene tracciato
- [`src/worker/dossier/kernel.ts`](../../src/worker/dossier/kernel.ts) — il kernel d'agente: prefisso stabile per la cache, budget di durata/costo/tentativi, registrazione di ogni esecuzione
- [`src/worker/dossier/model.ts`](../../src/worker/dossier/model.ts) — la porta verso il modello e il listino con cui il costo si calcola in un unico punto
- [`src/worker/dossier/ontology.ts`](../../src/worker/dossier/ontology.ts) — l'ontologia enologica versionata, resa deterministica perché la cache ripaghi
- [`src/worker/dossier/archive.ts`](../../src/worker/dossier/archive.ts) — l'archivio delle fonti di una cantina: deduplica, estrazione, collegamenti incerti
- [`src/worker/dossier/ingest.ts`](../../src/worker/dossier/ingest.ts) — segmentazione con offset esatti, classificazione proposta, giudizio di leggibilità
- [`src/worker/dossier/anthropic.ts`](../../src/worker/dossier/anthropic.ts) — l'unico file che conosce l'SDK
- [`src/worker/dossier/gates.ts`](../../src/worker/dossier/gates.ts) — cancelli dichiarativi e valutatore puro: il "via libera" è una funzione, non una frase del modello
- [`src/worker/dossier/invalidation.ts`](../../src/worker/dossier/invalidation.ts) — invalidazione selettiva lungo il grafo delle dipendenze
- [`src/worker/dossier/activation.ts`](../../src/worker/dossier/activation.ts) — chiave d'operazione idempotente e macchina a stati dell'attivazione
- [`src/worker/dossier/assignment.ts`](../../src/worker/dossier/assignment.ts) — regola deterministica di assegnazione fra agente 4 e agente 5

```bash
npm test        # 278 test, nessuna dipendenza aggiuntiva (Node 22)
npx tsc -b      # typecheck
```

## Le tre invarianti

Tutto il resto del progetto discende da queste. Se una di esse cade, il sistema
non è più affidabile:

1. **Nessun dato senza provenienza.** Ogni valore nel fascicolo porta con sé da
   dove viene: documento e pagina, dichiarazione e interlocutore, pagina
   pubblica e data di lettura, oppure derivazione da altri fatti.
2. **Nessuna attivazione senza approvazione.** Il livello di attivazione legge
   esclusivamente fatti in stato *approvato*. Un dato proposto non raggiunge mai
   il profilo pubblico, il Sommelier o i materiali commerciali.
3. **Nessuna domanda già risposta.** Prima di rivolgersi al produttore il
   sistema verifica di non conoscere già la risposta — inclusa la risposta
   "non disponibile", che è essa stessa un dato approvato.

A queste se ne aggiunge una quarta, di natura difensiva:

4. **Nessuna scrittura fuori ambito.** Un agente può scrivere soltanto negli
   ambiti che gli sono stati concessi. Una caratteristica del territorio non può
   diventare una caratteristica del vigneto per errore di prompt: glielo impedisce
   lo schema, non l'istruzione.
