# Stato di avanzamento

Aggiornato al 13 ottobre 2026.

Questa cartella contiene un **progetto**: la maggior parte è specifica, non
implementazione. Questa pagina dice esattamente cosa esiste come codice
eseguibile e cosa no, perché un documento che non distingue le due cose fa
prendere decisioni sbagliate.

## Legenda

| | Significato |
|---|---|
| ✅ | Codice presente, typecheck e test verdi |
| 🟡 | Contratto definito nei tipi, comportamento non ancora implementato |
| ⬜ | Solo specifica nei documenti |

## Tranche 2 — Fondamenta comuni

| Componente | Stato | Dove |
|---|---|---|
| Schema del fascicolo (D1) | ✅ due migrazioni, provate a catena su SQLite; non ancora applicate su D1 | [`migrations/`](../../migrations/) |
| Tipi del fascicolo: fatto, ambito, provenienza, anomalia | ✅ | [`src/worker/dossier/types.ts`](../../src/worker/dossier/types.ts) |
| I dieci agenti come dati, con ambiti e strumenti | ✅ | [`src/worker/dossier/agents.ts`](../../src/worker/dossier/agents.ts) |
| Funzione di ammissione (ambito, provenienza, chiavi riservate) | ✅ | [`src/worker/dossier/admission.ts`](../../src/worker/dossier/admission.ts) |
| Transizione di approvazione | ✅ | `admission.ts` → `approveFact` |
| Cancelli dichiarativi e valutatore puro | ✅ | [`src/worker/dossier/gates.ts`](../../src/worker/dossier/gates.ts) |
| Regola di assegnazione agenti 4 / 5 | ✅ | [`src/worker/dossier/assignment.ts`](../../src/worker/dossier/assignment.ts) |
| Invalidazione selettiva lungo il grafo | ✅ | [`src/worker/dossier/invalidation.ts`](../../src/worker/dossier/invalidation.ts) |
| Chiave d'operazione e macchina a stati dell'attivazione | ✅ | [`src/worker/dossier/activation.ts`](../../src/worker/dossier/activation.ts) |
| Confine e-label asserito in CI | ✅ | [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) |
| Tabella di precedenza e risolutore delle fonti contraddittorie | ✅ | [`src/worker/dossier/candidates.ts`](../../src/worker/dossier/candidates.ts) |
| Accesso al fascicolo con `cantina_id` imposto in un unico punto | ✅ | [`src/worker/dossier/repository.ts`](../../src/worker/dossier/repository.ts) |
| Pacchetto di contenuti per il Sommelier, filtrato per visibilità | ✅ | [`src/worker/dossier/pack.ts`](../../src/worker/dossier/pack.ts) |
| Test di isolamento fra cantine | ✅ **criterio di completamento della Tranche 2 soddisfatto** | [`__tests__/isolation.test.ts`](../../src/worker/dossier/__tests__/isolation.test.ts) |
| Ontologia enologica come dato versionato | ✅ seme e forma, reso deterministico per la cache; il caricamento da KV resta da fare | [`src/worker/dossier/ontology.ts`](../../src/worker/dossier/ontology.ts) |
| Kernel d'agente: prefisso stabile, budget, tentativi, registrazione | ✅ | [`src/worker/dossier/kernel.ts`](../../src/worker/dossier/kernel.ts) |
| Porta verso il modello e contabilità del costo | ✅ | [`src/worker/dossier/model.ts`](../../src/worker/dossier/model.ts) |
| Adattatore verso l'API Claude | 🟡 scritto e verificato dai tipi dell'SDK, **mai eseguito** | [`src/worker/dossier/anthropic.ts`](../../src/worker/dossier/anthropic.ts) |

## Tranche 3 — Raccolta specializzata

| Componente | Stato | Dove |
|---|---|---|
| Archivio delle fonti, per cantina | ✅ | [`src/worker/dossier/archive.ts`](../../src/worker/dossier/archive.ts) |
| Conservazione indirizzata per contenuto e deduplica | ✅ | [`src/worker/dossier/storage.ts`](../../src/worker/dossier/storage.ts) |
| Segmentazione con offset esatti, classificazione, giudizio di leggibilità | ✅ | [`src/worker/dossier/ingest.ts`](../../src/worker/dossier/ingest.ts) |
| Adattatore R2 per la porta degli oggetti | ⬜ poche righe, da scrivere | — |
| Estrazione del testo con citazioni (la metà che richiede il modello) | ⬜ | — |
| Indicizzazione dei frammenti in Vectorize | ⬜ | — |
| Agenti 2–5 all'opera su casi di prova reali | ⬜ richiede la prima chiamata reale | — |

## Tranche 4-6

Interamente specifica: Sentinella, Ambasciatore, Coordinatore come Workflow,
Revisore, livello anticorruzione verso VinoVeritas, pilota.

## Cosa i test verificano oggi

278 test, eseguibili con `npm test` (Node 22, nessuna dipendenza aggiuntiva —
il type stripping nativo esegue i `.ts` direttamente e `node:sqlite` fornisce il
motore: i test del repository girano sullo stesso SQL e sugli stessi vincoli che
agiranno su D1, non su un simulacro).

> Vincolo da conoscere: il type stripping di Node è *strip-only* e rifiuta la
> sintassi che richiede generazione di codice — proprietà di parametro nel
> costruttore, `enum`, `namespace`, decoratori. È il prezzo dello zero
> dipendenze.

| Area | Cosa è dimostrato |
|---|---|
| **Cancelli** | Un fascicolo di soli fatti proposti non apre nulla; aggiungere un'anomalia bloccante non può aprire un cancello chiuso; un bloccante su una referenza non chiude le altre; una chiave obbligatoria non è soddisfatta da `non_disponibile`, una facoltativa sì. Le prime tre su 300 casi generati ciascuna |
| **Squadra** | Dieci agenti con id distinti; `canApprove` falso per tutti; `writeScopes ⊆ readScopes`; solo l'agente 9 ha strumenti di attivazione; il Documentalista non ne ha nessuno e non propone fatti; Sentinella, Ambasciatore e Coordinatore non scrivono fatti; gli agenti 4 e 5 condividono prompt, ambiti e strumenti |
| **Confine e-label** | Nessuno strumento di nessun agente corrisponde agli schemi vietati. Verificato anche in negativo: iniettando `aggiorna_e_label` sull'agente 9 il test fallisce con il nome dell'agente e dello strumento |
| **Ammissione** | Provenienza assente respinta; scrittura fuori ambito respinta (Anagrafica → vigneto, specialista → territorio, Identità → vino); stato `approvato` proposto da un agente respinto anche se arriva da un'uscita non tipizzata; dati fiscali respinti se pubblici; `nota_degustazione_agente` vietata mentre `nota_degustazione_produttore` è ammessa |
| **Approvazione** | L'inferenza del modello non raggiunge mai l'approvato — verificato su **tutti** i sottoinsiemi non vuoti delle provenienze non appoggiate; una pagina pubblica da sola non basta; un fatto `da_confermare` richiede la risposta del produttore |
| **Invalidazione** | La chiusura dei dipendenti non risale verso le origini, non tocca i rami indipendenti e tollera i cicli; un aggiornamento alla gradazione 2021 marca tre traduzioni su cinque e una operazione su tre, lasciando intatti il 2020 e la storia della cantina |
| **Attivazione** | La chiave è stabile e indipendente dall'ordine dei fatti, cambia con la versione, e separa cantine, destinazioni e riferimenti; `verificato` è raggiungibile **solo** da `pubblicato` con la rilettura coincidente — verificato esaurendo tutte le coppie stato/evento; una divergenza segnala senza avanzare; un'operazione verificata si salta, una a metà riprende dal punto raggiunto |
| **Assegnazione** | Spumanti e passiti all'agente 4 per ogni colore; bianchi fermi all'agente 4; rossi e rosati fermi all'agente 5; tipologia dubbia al Coordinatore; funzione totale e deterministica su tutte le 20 combinazioni |
| **Isolamento** | Due onboarding contemporanei con stesse denominazioni, stesse annate, nomi quasi uguali e la stessa impronta di documento: nessun fatto, citazione, anomalia o rifiuto attraversa il confine. Il `cantinaId` dichiarato da un agente viene ignorato; un fatto di un'altra cantina non si approva né si supera per id; un pacchetto scarta i fatti altrui anche se glieli si passa; ogni tabella del fascicolo porta `cantina_id` |
| **Atomicità** | `supersede` scrive superamento, nuova versione e provenienze in una sola transazione quando il driver la offre; se una scrittura fallisce il fascicolo resta identico — la chiave continua a essere servita da un fatto vivo, e un cancello valutato in quell'istante non legge un dato assente; senza `batch` il comportamento degradato è definito, non casuale |
| **Repository** | Andata e ritorno di tutte e cinque le varianti di provenienza; il vincolo del fatto vivo diventa un esito tipizzato invece di un'eccezione; una nuova versione porta la precedente a `superato` conservando la storia; un fatto senza provenienza letto dal database solleva `CorruptDossierError` invece di propagarsi |
| **Fonti contraddittorie** | Il caso del programma (scheda 13,5 contro listino 14) apre una contraddizione con entrambe le evidenze e **nessun vincitore**; la tolleranza di un decimo sulla gradazione tiene; "D.O.C." e "DOC" sono la stessa denominazione; una divergenza a livello più basso non apre una contraddizione |
| **Pacchetto** | Nessun fatto `riservato` o `interno` entra in alcun pacchetto, per nessuna destinazione; il Sommelier è la destinazione più restrittiva; un `non_disponibile` non diventa contenuto; ogni fatto scartato è contato in esattamente una categoria |
| **Catena completa** | Dal primo materiale al via libera: il profilo si apre solo a dati completi e si richiude su un'anomalia sopravvenuta; una referenza percorre assegnazione → risoluzione candidati → proposta → approvazione → cancello → pacchetto → chiave d'operazione → quattro stati → verifica; una nuova versione richiude il cancello finché non è approvata e cambia la chiave d'operazione; un'istruzione ostile in un PDF non cambia i permessi, e il tentativo compare nel registro |
| **Costo** | Le tre voci (ingresso, uscita, cache) sono disgiunte e tariffate separatamente; la lettura dalla cache costa un decimo dell'ingresso e la scrittura 1,25 volte, verificato sul listino; un modello senza tariffe è un errore e non un costo zero; la spesa si somma per cantina e non attraversa il confine |
| **Prefisso stabile** | Due compiti del tutto diversi producono un prefisso **identico byte per byte**; il punto di interruzione della cache sta sull'ultimo blocco stabile e solo lì; nessun orario, data con orario o UUID compare nel prefisso; l'ordine degli ambiti non lo cambia; l'ontologia sta nel prefisso e non nella parte variabile |
| **Budget** | Una singola chiamata troppo lunga viene **interrotta** (il segnale raggiunge la richiesta in volo, verificato); la durata residua si riduce fra i tentativi e si esaurisce; tre tentativi dentro il limite di costo possono superarlo insieme, e il controllo lo rileva; il tetto della cantina blocca prima di spendere |
| **Kernel** | Un compito fuori dagli ambiti leggibili non spende alcuna chiamata; una proposta citata diventa provenienza documentale e si approva, una senza citazioni resta `inferenza_modello` e **non** si approva; una proposta fuori ambito è respinta e contata senza fermare le altre; un errore non ritentabile si ferma al primo tentativo, un rifiuto del modello non si ritenta identico; ogni esecuzione è registrata su `agent_run` qualunque sia l'esito, perché un indicatore che conta solo i successi mente |
| **Segmentazione** | Ogni offset è esatto (`page.text.slice(charStart, charEnd) === text`, verificato su ogni frammento); nessun frammento supera il massimo né attraversa una pagina; **ogni carattere non bianco di ogni pagina è coperto**; i frammenti si sovrappongono così che il contesto non si perda al taglio; una parola più lunga della finestra viene tagliata invece di bloccare; un testo di 300 paragrafi termina senza girare a vuoto |
| **Archivio** | Lo stesso contenuto caricato due volte non genera due fonti **né riscrive l'originale**; lo stesso contenuto in due cantine resta separato, con chiavi d'oggetto distinte; un documento altrui non è raggiungibile per id e registrarvi un'estrazione è un errore; un testo illeggibile **non viene segmentato** e si recupera con una nuova estrazione riuscita; un'associazione incerta resta `proposto` con la sua fiducia; i blocchi passati al modello vengono dall'archivio della cantina, quindi un documento di un'altra cantina non può entrare in una richiesta |
| **Conflitti concorrenti** | Due aggiornamenti concorrenti sullo stesso fatto: il secondo è `CONFLITTO_VERSIONE`, non un'eccezione, e non produce una seconda versione 2; se un altro fatto occupa la chiave la transazione si annulla e il precedente resta vivo alla versione 1 |
| **Schema** | Le migrazioni si applicano a catena e su un motore SQLite reale e i suoi vincoli mordono: `fact_live` respinge un secondo fatto vivo sulla stessa chiave e si libera dopo il superamento; un fatto approvato senza approvatore è respinto; una provenienza documentale senza pagina è respinta; lo stesso sha256 nella stessa cantina non genera due fonti ma in un'altra cantina sì; la stessa chiave d'operazione è respinta; il limite di due cicli e le quattro categorie di gravità sono imposti dal database |

## Cosa i test **non** verificano

Perché non c'è ancora nulla da verificare, non perché sia stato trascurato:

- Nessuna chiamata reale a Claude, quindi nessuna misura di qualità di
  estrazione, di costo o di tasso di riuso della cache. Le stime in
  [05 §5](./05-piano.md#5-costo-ordine-di-grandezza) restano stime.
- Nessuna query su **D1**. Il repository e lo schema sono esercitati contro
  `node:sqlite` in memoria: D1 è SQLite e la porta SQL ha la forma di D1 — un
  `D1Database` la soddisfa strutturalmente, senza adattatore — ma restano da
  verificare il comportamento delle migrazioni su D1, i limiti di dimensione,
  la latenza reale. L'atomicità è coperta: la porta espone un `batch`
  opzionale con la stessa firma di `D1Database.batch`, `supersede` lo usa, e
  un test prova che una scrittura fallita non lascia nulla applicato — ma su
  D1 va riverificato, perché la semantica transazionale del driver non è
  quella di `node:sqlite`.
- Nessuna concorrenza reale: la serializzazione delle scritture per cantina è
  affidata al Durable Object, che non esiste ancora. I test di isolamento
  provano la separazione dei dati, non l'assenza di corse.
- **Nessuna chiamata reale all'API è mai stata eseguita.** L'adattatore è
  scritto e i suoi tipi combaciano con quelli dell'SDK installato — che è una
  verifica reale della forma della richiesta, non una congettura — ma nessuna
  risposta vera lo ha mai attraversato. Quindi restano non misurati: la qualità
  dell'estrazione, il tasso di riuso della cache, il costo effettivo, il
  comportamento di `task_budget` e delle citazioni sul campo. Le stime in
  [05 §5](./05-piano.md#5-costo-ordine-di-grandezza) restano stime, e la prima
  chiamata reale è il prossimo passo che le sostituisce con numeri.
- L'ontologia è un seme di cinque denominazioni, non il catalogo completo, e non
  viene ancora caricata da KV.
- Nessuna integrazione con VinoVeritas: il livello anticorruzione non esiste, e
  la Tranche 1 deve ancora accertare se le scritture esposte sono idempotenti.
- Nessuna prova di isolamento fra cantine, che è il criterio di completamento
  della Tranche 2 e richiede D1 attivo.
