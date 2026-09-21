# 04 — Flussi operativi

## 1. Il percorso completo

```
┌─ ACCOGLIENZA E IDENTIFICAZIONE ─────────────── Coordinatore + Anagrafica ─┐
│  cantina, utente e obiettivo identificati · fascicolo aperto o ripreso    │
└───────────────────────────────┬───────────────────────────────────────────┘
┌─ ACQUISIZIONE DEI MATERIALI ─────────────────────────── Documentalista ───┐
│  R2 + deduplica · estrazione con citazioni · classificazione · indice     │
└───────────────────────────────┬───────────────────────────────────────────┘
┌─ ANALISI SPECIALISTICA ──── Anagrafica · Identità · Specialisti 4 e 5 ────┐
│  fatti PROPOSTI con provenienza · a ventaglio su coda, una referenza      │
│  per messaggio, budget per referenza                                      │
└───────────────────────────────┬───────────────────────────────────────────┘
┌─ PRIMA VERIFICA ───────────────────────────────────────────  Sentinella ──┐
│  controlli deterministici + revisione avversariale sulle fonti originali  │
│  → anomalie classificate nelle quattro categorie                          │
└───────────────────────────────┬───────────────────────────────────────────┘
                     ┌──────────┴──────────┐
              nessuna bloccante      anomalie aperte
                     │                     │
                     │    ┌─ INTEGRAZIONE ─▼──── Ambasciatore + specialisti ─┐
                     │    │  dedup → raggruppa → chiedi → attendi (durevole) │
                     │    │  risposta → specialista → Sentinella             │
                     │    │  2 cicli senza esito → escalation                │
                     │    └──────────┬───────────────────────────────────────┘
                     │               │  (ritorna alla verifica)
                     └──────────┬────┘
┌─ REVISIONE MULTILINGUE ─────────────────────────────────────── Revisore ──┐
│  sui soli contenuti approvati · traduzione legata alla versione sorgente  │
└───────────────────────────────┬───────────────────────────────────────────┘
┌─ PREPARAZIONE DELL'ATTIVAZIONE ─────────── Responsabile dell'attivazione ─┐
│  anteprime + piano delle operazioni · stato: PREPARATO                    │
└───────────────────────────────┬───────────────────────────────────────────┘
┌─ VERIFICA E VIA LIBERA ──────────────────── Sentinella + Coordinatore ────┐
│  controllo finale · cancello valutato · conferma del responsabile cantina │
└───────────────────────────────┬───────────────────────────────────────────┘
┌─ ESECUZIONE E CONTROLLO DELL'ESITO ─────── Responsabile dell'attivazione ─┐
│  SALVATO → PUBBLICATO → VERIFICATO (rilettura da VinoVeritas)             │
└───────────────────────────────────────────────────────────────────────────┘

   E-LABEL ─────────────────────── percorso separato, nessuna modifica automatica
```

Il ciclo fra verifica e integrazione è l'unico anello del percorso, ed è
limitato: due giri, poi escalation.

## 2. I cancelli

Un cancello è una funzione pura da `(fatti approvati, anomalie aperte)` a
`aperto | chiuso(motivi)`. Sono dichiarati in
[`gates.ts`](../../src/worker/dossier/gates.ts), non sparsi nella logica.

| Cancello | Richiede | Sospeso da |
|---|---|---|
| `profilo_pronto` | ragione sociale, sede legale, almeno un contatto, relazione impresa–marchio, storia in lingua d'origine | anomalia bloccante in ambito `cantina`, `marchio`, `sede` |
| `referenza_pronta(vino)` | denominazione, tipologia, vitigni, almeno un'annata con gradazione e provenienza | anomalia bloccante in ambito `vino:{id}` o in una sua annata |
| `sommelier_pronto` | `profilo_pronto` + almeno N referenze pronte + pacchetto contenuti pubblici costruito | qualunque bloccante sulle destinazioni incluse |
| `materiali_commerciali_pronti` | referenze pronte + traduzioni non `stale` per le lingue richieste | bloccante linguistica |

Tre proprietà che i test verificano:

1. **Monotonia rispetto ai blocchi.** Aggiungere un'anomalia bloccante su una
   destinazione non può aprire un cancello che era chiuso.
2. **Impermeabilità al proposto.** Un cancello valutato su fatti `proposto`
   anziché `approvato` dà sempre `chiuso`. Nessun percorso legge lo stato
   sbagliato.
3. **Granularità.** Un bloccante su `vino:X` non chiude `referenza_pronta(Y)`.
   Trenta referenze non si fermano per una.

## 3. Il ciclo delle domande, nel dettaglio

```
                       ┌──────────────────────────┐
  anomalia aperta ────▶│ la risposta è nel         │──sì──▶ chiudi anomalia
                       │ fascicolo? (incluso       │        (nessuna domanda)
                       │ "non_disponibile")        │
                       └────────────┬──────────────┘
                                    │ no
                       ┌────────────▼──────────────┐
                       │ chiave semantica già       │──sì──▶ collega all'esistente
                       │ chiesta?                   │
                       └────────────┬──────────────┘
                                    │ no
                       ┌────────────▼──────────────┐
                       │ metti in cartella          │
                       │ raggruppata per argomento  │
                       │ e interlocutore            │
                       └────────────┬──────────────┘
                                    │
             rilascio quando: cancello bloccato ∨ finestra scaduta ∨ soglia
                                    │
                       ┌────────────▼──────────────┐
                       │ il produttore risponde     │
                       │ testo · documento ·        │
                       │ "non disponibile"          │
                       └────────────┬──────────────┘
                                    │
                    fatto PROPOSTO, provenienza = dichiarazione
                                    │
                    specialista competente ──▶ Sentinella ──▶ …
```

Il ramo `non_disponibile` è quello che garantisce la terminazione: produce un
fatto approvato che rende la domanda inammissibile per sempre.

## 4. Attivazione idempotente

```
per ogni destinazione con cancello aperto:

  1. PREPARA
     carico = costruisci(fatti approvati, visibilità ammessa per la destinazione)
     chiave = sha256(cantina, destinazione, riferimento,
                     [(fattoId, versione) ordinati])
     se esiste operazione con quella chiave in stato verificato → salta
     registra operazione: stato = preparato
     mostra anteprima al produttore

  2. CONFERMA DEL RESPONSABILE DELLA CANTINA          ← punto previsto dal percorso

  3. SALVA
     chiamata autorizzata al livello anticorruzione (con la chiave come
     intestazione di idempotenza verso VinoVeritas dove supportata)
     → stato = salvato, idEsterno registrato

  4. PUBBLICA
     → stato = pubblicato

  5. VERIFICA
     rileggi da VinoVeritas · confronta con l'impronta attesa
     coincide  → stato = verificato
     diverge   → anomalia bloccante "DIVERGENZA_POST_SALVATAGGIO"
                 (non si ritenta alla cieca: si segnala)
```

Un errore a qualunque punto lascia l'operazione nel suo stato con `tentativi`
incrementato. La ripresa riparte dal punto raggiunto: la chiave impedisce di
rifare ciò che è già riuscito.

Il passo 5 che diverge **non** ritenta automaticamente. Una divergenza fra ciò
che abbiamo scritto e ciò che rileggiamo significa che qualcosa non abbiamo
capito: ritentare la amplificherebbe.

## 5. Sospensione, ripresa, interruzioni

Il programma chiede esplicitamente la possibilità di sospendere e riprendere, e
che i casi di prova includano interruzioni e risposte tardive.

| Evento | Comportamento |
|---|---|
| Il produttore chiude il browser a metà caricamento | I documenti già in R2 restano; la coda continua; al rientro trova l'elaborazione avanzata |
| Nessuna risposta per settimane | Il Workflow dorme; nessun costo maturato; alla risposta riprende dal passo esatto |
| Risposta tardiva dopo l'escalation | La risposta viene accettata: genera un fatto proposto, riapre l'anomalia escalata, il Coordinatore rivaluta il cancello |
| Errore del fornitore del modello | Ritentativo con attesa crescente fino al limite di tentativi; poi coda degli scarti e anomalia operativa visibile all'operatore |
| Budget di costo della cantina esaurito | Le attività non essenziali si sospendono; i cancelli già aperti restano aperti; l'operatore riceve una segnalazione |
| Documento sostituito dal produttore | Nuovo sha256 → nuova fonte; i fatti che citavano la vecchia entrano in riesame lungo il grafo; le altre parti non si toccano |

## 6. Riuso dei dati approvati

L'obiettivo del programma — *riutilizzare i dati approvati per profilo,
referenze, Sommelier e materiali commerciali* — si realizza qui, e senza alcuna
seconda raccolta.

```
                    ┌─────────────────────────────┐
                    │  fatti APPROVATI del         │
                    │  fascicolo (una sola volta)  │
                    └──────────────┬───────────────┘
        ┌──────────────┬───────────┼────────────┬──────────────────┐
        ▼              ▼           ▼            ▼                  ▼
   Profilo        Referenze    Pacchetto    Materiali          Traduzioni
   cantina        (bozze)      Sommelier    commerciali        (agente 10)
        │              │           │            │                  │
   visibilità     visibilità   SOLO           visibilità       legate alla
   pubblico +     pubblico     approvato+     commerciale      versione
   commerciale                 pubblico                        sorgente
```

Il pacchetto per il Sommelier merita una nota: è costruito filtrando su
`approvato` **e** `pubblico`, versionato, e indicizzato nello spazio dei nomi
della cantina. Il Sommelier quindi non può, strutturalmente, citare un dato non
approvato, un dato riservato, o un dato di un'altra cantina. Non perché gli sia
stato chiesto di non farlo, ma perché quei contenuti non sono nel suo indice.
