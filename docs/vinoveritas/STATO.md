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
| Schema del fascicolo (D1) | ✅ migrazione scritta e provata su SQLite; non ancora applicata su D1 | [`migrations/0001_fascicolo.sql`](../../migrations/0001_fascicolo.sql) |
| Tipi del fascicolo: fatto, ambito, provenienza, anomalia | ✅ | [`src/worker/dossier/types.ts`](../../src/worker/dossier/types.ts) |
| I dieci agenti come dati, con ambiti e strumenti | ✅ | [`src/worker/dossier/agents.ts`](../../src/worker/dossier/agents.ts) |
| Funzione di ammissione (ambito, provenienza, chiavi riservate) | ✅ | [`src/worker/dossier/admission.ts`](../../src/worker/dossier/admission.ts) |
| Transizione di approvazione | ✅ | `admission.ts` → `approveFact` |
| Cancelli dichiarativi e valutatore puro | ✅ | [`src/worker/dossier/gates.ts`](../../src/worker/dossier/gates.ts) |
| Regola di assegnazione agenti 4 / 5 | ✅ | [`src/worker/dossier/assignment.ts`](../../src/worker/dossier/assignment.ts) |
| Invalidazione selettiva lungo il grafo | ✅ | [`src/worker/dossier/invalidation.ts`](../../src/worker/dossier/invalidation.ts) |
| Chiave d'operazione e macchina a stati dell'attivazione | ✅ | [`src/worker/dossier/activation.ts`](../../src/worker/dossier/activation.ts) |
| Confine e-label asserito in CI | ✅ | [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) |
| Tabella di precedenza e tolleranze per chiave | 🟡 valori dichiarati, risolutore dei candidati da scrivere | `admission.ts` → `PRECEDENZA`, `TOLLERANZA` |
| Accesso a D1 con `cantina_id` imposto in un unico punto | ⬜ | — |
| Test di isolamento fra cantine | ⬜ | — |
| Ontologia enologica versionata in KV | ⬜ | — |
| Kernel d'agente (invocazione, budget, registrazione su `agent_run`) | ⬜ | — |

## Tranche 3-6

Interamente specifica: Documentalista e pipeline di ingestione, agenti 2–5,
Sentinella, Ambasciatore, Coordinatore come Workflow, Revisore, livello
anticorruzione verso VinoVeritas, pilota.

## Cosa i test verificano oggi

105 test, eseguibili con `npm test` (Node 22, nessuna dipendenza aggiuntiva —
il type stripping nativo esegue i `.ts` direttamente e `node:sqlite` fornisce il
motore per le prove sullo schema).

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
| **Schema** | La migrazione si applica su un motore SQLite reale e i suoi vincoli mordono: `fact_live` respinge un secondo fatto vivo sulla stessa chiave e si libera dopo il superamento; un fatto approvato senza approvatore è respinto; una provenienza documentale senza pagina è respinta; lo stesso sha256 nella stessa cantina non genera due fonti ma in un'altra cantina sì; la stessa chiave d'operazione è respinta; il limite di due cicli e le quattro categorie di gravità sono imposti dal database |

## Cosa i test **non** verificano

Perché non c'è ancora nulla da verificare, non perché sia stato trascurato:

- Nessuna chiamata reale a Claude, quindi nessuna misura di qualità di
  estrazione, di costo o di tasso di riuso della cache. Le stime in
  [05 §5](./05-piano.md#5-costo-ordine-di-grandezza) restano stime.
- Nessuna query su **D1**. I vincoli dello schema sono esercitati, ma contro
  `node:sqlite` in memoria: D1 è SQLite, quindi i vincoli provati sono gli
  stessi che agiranno, però restano da verificare il comportamento delle
  migrazioni su D1, i limiti di dimensione e la latenza reale.
- Nessun accesso applicativo al fascicolo: le funzioni sono pure e non c'è
  ancora il livello che impone `cantina_id` in un unico punto.
- Nessuna integrazione con VinoVeritas: il livello anticorruzione non esiste, e
  la Tranche 1 deve ancora accertare se le scritture esposte sono idempotenti.
- Nessuna prova di isolamento fra cantine, che è il criterio di completamento
  della Tranche 2 e richiede D1 attivo.
