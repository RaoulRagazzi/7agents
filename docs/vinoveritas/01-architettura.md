# 01 — Architettura

## 1. I cinque piani

Il sistema si legge come cinque piani sovrapposti. Ogni piano parla solo con
quello immediatamente sotto, e nessun piano superiore può scavalcare il fascicolo
per raggiungere l'attivazione.

```
┌───────────────────────────────────────────────────────────────────────────┐
│  PIANO DI INTERAZIONE                                    React + Workers  │
│  Portale cantina: materiali · domande raggruppate · anteprime · approvazioni│
└───────────────────────────────┬───────────────────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────────────────┐
│  PIANO DI ORCHESTRAZIONE                 Cloudflare Workflows + Durable Obj│
│  Coordinatore come macchina a stati durevole · cancelli dichiarativi       │
│  budget (durata/costo/tentativi) · sospensione e ripresa · attesa risposte │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────────────────┐
│  PIANO COGNITIVO                          AI Gateway → Claude (Anthropic)  │
│  Un solo kernel d'agente: prompt versionato + strumenti ristretti +        │
│  schema d'uscita rigido + budget + tracciamento. I 10 agenti sono          │
│  dieci configurazioni dello stesso kernel.                                 │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │   (propone fatti · non approva mai)
┌───────────────────────────────▼───────────────────────────────────────────┐
│  PIANO DEL FASCICOLO                        D1 + R2 + Vectorize + Queues   │
│  Fatti versionati con ambito, provenienza, stato, visibilità               │
│  Documenti originali immutabili · indice semantico · grafo delle dipendenze│
└───────────────────────────────┬───────────────────────────────────────────┘
                                │   (solo fatti approvati)
┌───────────────────────────────▼───────────────────────────────────────────┐
│  PIANO DI ATTIVAZIONE                    Livello anticorruzione → VinoVeritas│
│  Operazioni idempotenti · preparato → salvato → pubblicato → verificato    │
│  E-LABEL: confine chiuso, nessuna operazione disponibile                   │
└───────────────────────────────────────────────────────────────────────────┘

        ╔═══════════════════════════════════════════════════════════════╗
        ║  OSSERVABILITÀ trasversale: registro d'audit per ogni fatto,   ║
        ║  costo e durata per esecuzione d'agente, indicatori di programma║
        ╚═══════════════════════════════════════════════════════════════╝
```

La freccia importante è quella fra piano cognitivo e piano del fascicolo: è
**unidirezionale e filtrata**. Un agente propone; una funzione di ammissione
verifica ambito, provenienza e schema; solo allora il fatto entra. Non esiste un
percorso per cui un'uscita del modello raggiunga l'attivazione senza attraversare
il fascicolo e senza passare dallo stato approvato.

## 2. Le piattaforme

Il repository è già un'applicazione **React + Vite + Hono su Cloudflare
Workers**. La scelta naturale è restare dentro quella piattaforma, che offre
tutti i mattoni necessari senza aggiungere infrastruttura da gestire.

### Stack operativo

| Esigenza del programma | Piattaforma | Perché proprio questa |
|---|---|---|
| API e portale cantina | **Cloudflare Workers + Hono + React** | Già in uso nel repository; un solo artefatto di distribuzione per front-end e back-end |
| Coordinatore durevole, sospendibile, ripartibile | **Cloudflare Workflows** | Esecuzione durevole nativa: passi con ritentativo, `sleep` lunghi, attesa di eventi esterni. Una cantina può restare ferma tre settimane in attesa di una risposta e riprendere esattamente dal punto in cui si era interrotta, senza un orchestratore da ospitare |
| Serializzazione delle scritture per cantina, stato di sessione | **Durable Objects** | Un oggetto per cantina: elimina le corse fra agenti concorrenti sullo stesso fascicolo e dà un punto naturale per l'isolamento fra clienti |
| Fascicolo: fatti, versioni, provenienza, anomalie, operazioni | **D1** (SQLite) | Relazionale, transazionale, interrogabile. Il grafo delle dipendenze e i vincoli di unicità per idempotenza vogliono un database, non un archivio chiave-valore |
| Documenti originali, immagini | **R2** | Conservazione immutabile indirizzata per contenuto (SHA-256): la deduplica che il Documentalista deve fare è una conseguenza della chiave, non un algoritmo |
| Ricerca semantica sulle fonti, recupero per il Sommelier | **Vectorize** | Spazio dei nomi per cantina: il Sommelier non può recuperare frammenti di un'altra cantina né contenuti non approvati |
| Lavorazione asincrona, ritentativi, coda degli scarti | **Queues** | Ingestione documenti ed estrazione per referenza sono naturalmente a ventaglio; i tentativi e la coda degli scarti sono il limite di tentativi richiesto dal programma |
| Configurazione, versioni dei prompt, interruttori | **Workers KV** | Lettura frequente, scrittura rara |
| Incorporamenti, riconoscimento testo di ripiego | **Workers AI** | Vicino ai dati, costo marginale per la vettorializzazione |
| Governo delle chiamate al modello | **AI Gateway** | Registro di ogni chiamata, tetto di spesa, limitazione di frequenza, cache: è il punto in cui *costo per cantina attivata* diventa misurabile invece che stimato |
| Ragionamento degli agenti | **Claude — API Anthropic** | Vedi sotto |
| Identità, anagrafica cliente, referenze, Sommelier | **VinoVeritas esistente** | Raggiunto solo attraverso il livello anticorruzione |

### Perché Claude, e come

Il modello predefinito è **`claude-opus-5`** per tutti e dieci gli agenti, con
pensiero adattivo (`thinking: { type: "adaptive" }`). La differenziazione fra
agenti non passa dal modello ma dallo **sforzo** (`output_config.effort`), che è
la prima leva di costo e si regola per rotta.

Quattro capacità della piattaforma Claude mappano quasi uno a uno sui requisiti
del programma:

1. **Citazioni sui documenti** (`citations: { enabled: true }`). La risposta
   torna spezzata in blocchi, e i blocchi che citano portano `page_location` con
   pagina iniziale e finale. Il requisito del Documentalista — *conserva il
   riferimento alla pagina o alla sezione da cui proviene ciascuna informazione* —
   diventa un campo della risposta, non una richiesta al modello di ricordarsene.
   La Sentinella usa lo stesso meccanismo per **controllare le fonti originali**
   invece dei riepiloghi degli altri agenti.

2. **Uscite strutturate rigide** (`output_config.format`, e `strict: true` sugli
   strumenti). Ogni agente emette fatti conformi a uno schema validato dal
   server. Un'estrazione che non rispetta lo schema non esiste: non c'è un passo
   intermedio in cui interpretare prosa.

3. **Cache dei prompt.** Il prefisso stabile di ciascun agente — istruzioni
   versionate, ontologia enologica, definizione degli strumenti — viene messo in
   cache con durata di un'ora; la porzione variabile (fetta di fascicolo,
   documenti) sta dopo l'ultimo punto di interruzione. Su un catalogo di trenta
   referenze la stessa ontologia viene riletta trenta volte: in cache costa un
   decimo.

4. **API Batch** per i carichi non sensibili alla latenza — traduzioni dell'agente
   10 e riestrazioni massive su cataloghi grandi — a metà prezzo.

A queste si aggiungono, sul piano del controllo: `task_budget` per dare
all'agente un tetto di token di cui è consapevole (si conclude con ordine invece
di essere troncato), e i messaggi di sistema a metà conversazione come canale
dell'operatore resistente all'iniezione di istruzioni.

#### Un vincolo dell'API che cambia il progetto

Le citazioni sui documenti e `output_config.format` **non si possono usare
insieme**: l'API restituisce 400. E le citazioni non sono negoziabili — la
provenienza con pagina e intervallo è un requisito del fascicolo.

La conseguenza è che l'uscita strutturata di ogni agente **non** è un formato di
risposta ma uno **strumento con `strict: true`**, che garantisce argomenti
conformi allo schema e convive con le citazioni. È anche più coerente col resto
dell'impostazione: `proponi_fatto` è già uno strumento del catalogo, non un
formato. Lo strumento si invoca con `tool_choice: auto` più un'istruzione
esplicita, invece di forzarlo: i modelli più recenti rifiutano `tool_choice`
forzato.

### Alternative valutate e scartate

| Alternativa | Perché no |
|---|---|
| **Temporal / AWS Step Functions** per l'orchestrazione | Esecuzione durevole eccellente, ma introduce una seconda piattaforma da gestire e da mettere in sicurezza accanto a Workers. Workflows copre ciò che serve: passi, ritentativi, attesa d'eventi, ripresa |
| **LangGraph / framework a grafo di agenti** | Portano un runtime Python accanto al worker e, soprattutto, incoraggiano a esprimere i cancelli come nodi del grafo guidati dal modello. Qui i cancelli devono essere codice verificabile con test di proprietà |
| **Managed Agents** (Anthropic ospita il ciclo dell'agente) | Ottimo dove si vuole che il ciclo e il contenitore siano gestiti. Qui il ciclo *è* la logica di business — cancelli, budget, idempotenza, isolamento fra cantine — e deve restare nostro e ispezionabile. Resta candidato per un uso circoscritto: analisi esplorativa di cataloghi molto grandi in sessione dedicata |
| **Una squadra di agenti che si parlano liberamente** | È il modo prevedibile di fallire: nessuna provenienza, domande duplicate, approvazioni improprie. Gli agenti qui non si parlano: scrivono nel fascicolo e leggono dal fascicolo |
| **Postgres gestito al posto di D1** | Sensato se il volume crescesse oltre i limiti di D1; da rivalutare alla Tranche 6 con i numeri del pilota. Il modello dati è progettato per essere portabile (SQL semplice, nessuna estensione) |
| **Archivio documentale esterno** | R2 con chiave per contenuto copre conservazione e deduplica; un sistema documentale completo aggiungerebbe superficie senza risolvere il problema vero, che è la provenienza riga per riga |

## 3. Il kernel d'agente

I dieci agenti non sono dieci basi di codice. Sono dieci **configurazioni** di un
unico kernel, e questo è ciò che rende il programma realizzabile da una squadra
piccola e mantenibile nel tempo.

```
AgentSpec {
  id                 // "sentinella"
  promptVersion      // "sentinella@2026-03-11" — versionato, in KV, mai in linea nel codice
  model              // "claude-opus-5"
  effort             // "low" | "medium" | "high" | "xhigh" | "max"
  readScopes         // ambiti leggibili
  writeScopes        // ambiti scrivibili — insieme sempre minore o uguale a readScopes
  tools              // insieme chiuso e narrow: nessuno strumento "generico"
  outputSchema       // schema rigido dei fatti / anomalie / domande emessi
  budget             // { maxDurationMs, maxCostUsd, maxAttempts, taskBudgetTokens }
  canApprove         // false per nove agenti su dieci — vedi sotto
}
```

Tre proprietà del kernel valgono più di qualunque prompt:

- **`canApprove` è falso per tutti gli agenti.** Nessun agente approva, nemmeno
  la Sentinella: la Sentinella *classifica*, e l'approvazione è una transizione
  eseguita dal piano di orchestrazione quando i cancelli sono soddisfatti e le
  conferme previste sono state raccolte. L'Ambasciatore, in particolare, non
  approva ciò che raccoglie: lo instrada.
- **`writeScopes ⊆ readScopes`, e la verifica è a valle.** Ogni fatto proposto
  passa dalla funzione di ammissione, che rifiuta le scritture fuori ambito
  registrando l'evento. Se un prompt venisse manipolato, il tentativo compare nel
  registro invece di riuscire.
- **Ogni esecuzione è una riga.** `agent_run` registra modello, versione del
  prompt, sforzo, token in ingresso/uscita/in cache, costo, durata, esito. Il
  costo per cantina attivata è una somma, non una stima.

## 4. Isolamento fra cantine

Requisito non negoziabile di una piattaforma multi-cantina, e criterio di
completamento della Tranche 2.

- Ogni riga del fascicolo porta `cantina_id`; nessuna interrogazione applicativa
  è scritta senza quel predicato, e il livello d'accesso lo impone in un unico
  punto invece di ripeterlo in ogni chiamata.
- Lo spazio dei nomi di Vectorize è per cantina: un recupero semantico non può
  attraversare il confine.
- Il Durable Object è per cantina: le scritture concorrenti si serializzano
  naturalmente.
- La prova è un test che esegue due onboarding contemporanei con dati
  deliberatamente simili — stesse denominazioni, stesse annate, nomi di vino
  quasi uguali — e verifica che nessun fatto, nessuna citazione, nessun
  frammento recuperato passi da una cantina all'altra.

## 5. Visibilità e dati riservati

Il programma chiede che *le informazioni amministrative riservate restino
separate dai contenuti pubblici*. Nel fascicolo la visibilità è un campo del
fatto con quattro valori: `pubblico`, `commerciale`, `interno`, `riservato`.

Le conseguenze sono meccaniche:

- Identificativi fiscali, sede legale e contatti amministrativi nascono
  `riservato`.
- Il costruttore del pacchetto di contenuti per il Sommelier filtra su
  `approvato` **e** `pubblico`. Un test verifica che nessun fatto `riservato`
  compaia mai in un pacchetto o in un incorporamento: è il tipo di errore che non
  si può scoprire in produzione.
- Le anteprime mostrate al produttore dichiarano la visibilità di ciò che
  mostrano, così che l'approvazione sia informata.
