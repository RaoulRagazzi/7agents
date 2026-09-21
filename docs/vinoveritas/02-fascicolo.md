# 02 — Il fascicolo versionato

Il fascicolo è la base comune su cui lavorano tutti gli agenti, ciascuno con
accessi limitati al proprio compito. Questo documento ne definisce la forma.

## 1. L'unità elementare: il fatto

```
Fatto {
  id
  cantinaId
  ambito        { tipo, riferimento }     -- vintage:wine_1f2c:2021
  chiave        "gradazione_alcolica"
  valore        { numero: 13.5, unita: "%vol" }
  lingua        "it"                      -- lingua di origine del valore testuale
  stato         proposto | da_confermare | approvato | superato
  visibilita    pubblico | commerciale | interno | riservato
  fiducia       0.0 – 1.0
  versione      3
  supersede     <id del fatto precedente>
  agente        "specialista_bianchi"
  promptVersion "specialista_bianchi@2026-03-11"
  provenienza   [ Provenienza, ... ]      -- almeno una, sempre
  creatoIl · approvatoIl · approvatoDa
}
```

Due cose meritano attenzione.

**La chiave da sola non identifica nulla.** L'identità è `(cantinaId, ambito,
chiave)`. È ciò che impedisce alla gradazione dell'annata 2021 di collidere con
quella del 2022, e alla resa per ettaro di un vigneto di sovrascrivere quella
dichiarata per la denominazione.

**`provenienza` non è mai vuota.** È un vincolo di schema, verificato dalla
funzione di ammissione. Un fatto senza provenienza viene rifiutato prima di
toccare il database.

## 2. Gli ambiti

| Tipo | Riferimento | Esempi di chiavi |
|---|---|---|
| `cantina` | id cantina | ragione sociale, filosofia produttiva, anno di fondazione |
| `marchio` | id marchio | nome commerciale, relazione con la società |
| `sede` | id sede | sede legale, sede operativa, contatti |
| `vino` | id vino | denominazione, vitigni, tipologia, nome della referenza |
| `annata` | id vino + anno | gradazione, vinificazione, affinamento, note di degustazione |
| `lotto` | id lotto | sboccatura, dosaggio, numero di bottiglie |
| `vigneto` | id vigneto | esposizione, altitudine, suolo, anno d'impianto |
| `territorio` | denominazione | clima, suoli caratteristici, usi produttivi della zona |

### La regola di non contaminazione

Gli ambiti formano una gerarchia di specificità: `territorio ⊃ vigneto`,
`vino ⊃ annata ⊃ lotto`. La regola è asimmetrica e va enunciata con precisione:

> **Un fatto in ambito più ampio non è automaticamente vero nell'ambito più
> stretto. Un fatto in ambito più stretto non si estende automaticamente a quello
> più ampio.**

Il primo verso copre il caso del programma: *una caratteristica del territorio
non diventa una caratteristica del singolo vigneto*, e *una pratica produttiva
non viene attribuita alla cantina perché è comune nella zona*. Il secondo copre
l'altro: *informazioni su lotto, sboccatura e annata restano nel loro ambito*.

L'attraversamento è possibile, ma solo come operazione esplicita:

```
promuovi(fattoOrigine, ambitoDestinazione, motivazione)
  → crea un fatto nuovo in ambitoDestinazione
  → stato = da_confermare          (mai approvato d'ufficio)
  → provenienza = derivato(da: [fattoOrigine], regola: "promozione_ambito")
  → genera una domanda per l'Ambasciatore
```

Così la promozione è visibile, tracciata, e costa una conferma. Il sistema non
può farla di nascosto.

## 3. La provenienza

Unione discriminata. Ogni variante porta ciò che serve a tornare alla fonte.

| Tipo | Campi | Può portare all'approvazione automatica? |
|---|---|---|
| `documento` | id documento, pagina, intervallo di caratteri, riquadro | Sì, se il controllo di formato passa |
| `dichiarazione` | id risposta, interlocutore, data | Sì — è il produttore che parla |
| `pagina_pubblica` | url, data di lettura, istantanea in R2 | No — richiede conferma |
| `derivato` | fatti di origine, regola applicata | Eredita lo stato più debole fra le origini |
| `inferenza_modello` | versione prompt, id esecuzione | **Mai** |

L'ultima riga è la regola che tiene in piedi l'invariante 2. Ciò che il modello
ha dedotto senza un appoggio documentale o dichiarativo non raggiunge mai
`approvato` da solo. È il confine fra *proposta* e *dato*, ed è applicato da un
vincolo sulla transizione di stato, non dal buon senso di un prompt.

### Fonti contraddittorie

Quando più fonti propongono valori diversi per la stessa `(ambito, chiave)`, il
sistema non sceglie in base alla fiducia dichiarata dal modello. Applica una
**tabella di precedenza deterministica**:

```
documento ufficiale  >  dichiarazione del produttore  >  documento commerciale
                     >  sito della cantina  >  fonte terza  >  inferenza
```

- Se il valore di testa è isolato: diventa proposto, gli altri restano candidati
  registrati.
- Se i primi due candidati sono a pari livello di precedenza e i valori
  divergono oltre la tolleranza della chiave: si apre un'anomalia
  **da confermare**, con entrambe le evidenze allegate, e il fatto resta fuori
  dall'attivazione.
- Se la divergenza riguarda una chiave necessaria a un cancello: l'anomalia è
  **bloccante** per la sola destinazione interessata.

La tolleranza è per chiave: la gradazione ammette ±0,1 %vol fra due fonti;
la denominazione non ammette varianti; il nome del vino si confronta
normalizzato.

## 4. Il grafo delle dipendenze e l'invalidazione selettiva

Due tabelle di archi bastano:

```
fact_edge(fattoDerivato, fattoOrigine, regola)
translation(contenuto, lingua, versioneSorgente, stato)
```

Quando un fatto passa di versione:

```
1. il fatto precedente → superato   (non cancellato: la storia resta)
2. si calcola la chiusura transitiva dei dipendenti lungo fact_edge
3. ogni dipendente → da_riesaminare
4. ogni traduzione con versioneSorgente ora obsoleta → stale
5. ogni operazione di attivazione già verificata che cita un fatto toccato
   → marcata rieseguibile (non eseguita: il Coordinatore decide quando)
6. i cancelli che dipendono da quei fatti si rivalutano
```

Il punto 2 è tutto il valore: *si rimette in riesame soltanto ciò che dipende*.
Cambiare la gradazione dell'annata 2021 tocca la scheda 2021, le sue traduzioni e
il paragrafo commerciale che la cita. Non tocca il 2020, non tocca il profilo
della cantina, non invalida le traduzioni della storia aziendale.

Senza il grafo, l'unica alternativa sicura sarebbe ricostruire tutto a ogni
modifica — e il costo per cantina crescerebbe con il numero di aggiornamenti
invece che con il numero di referenze.

## 5. Anomalie

La Sentinella produce anomalie, non correzioni applicate.

```
Anomalia {
  id · cantinaId · ambito
  gravita   bloccante | da_confermare | miglioramento | superato
  codice    "DENOMINAZIONE_ASSENTE" | "CONTRADDIZIONE_GRADAZIONE" | ...
  evidenze  [ riferimenti a fatti e a passaggi di documento ]
  datoInteressato  <chiave del fatto>
  destinazioni  [ "profilo", "referenza:wine_1f2c", "sommelier" ]
  stato     aperta | in_domanda | risolta | accettata
  ciclo     1 | 2
}
```

Il campo `destinazioni` è ciò che permette la sospensione mirata richiesta dal
programma: un'anomalia bloccante sospende **la destinazione interessata**, non
l'intero onboarding. Una referenza incompleta non deve impedire l'attivazione del
profilo, né bloccare le altre ventinove referenze.

Ogni anomalia dichiara tre cose, come richiesto: **il problema**, **le evidenze**,
**il dato interessato**.

## 6. Domande e risposte

```
Domanda {
  id · cantinaId
  anomalie[]            -- una domanda può risolverne più d'una
  argomento             -- raggruppamento per tema
  interlocutore         -- enologo, amministrazione, marketing, titolare
  lingua                -- quella scelta dal produttore
  testo                 -- formulato dall'Ambasciatore, comprensibile
  chiaveSemantica       -- impronta per la deduplica
  stato  bozza | inviata | risposta | scaduta | escalata
  ciclo  1 | 2
}

Risposta {
  id · domandaId
  tipo   testo | documento | non_disponibile
  contenuto · allegatoR2 · rispondente · ricevutaIl
}
```

Tre meccanismi impediscono la duplicazione delle domande:

1. **Verifica preliminare.** Prima di formulare, l'Ambasciatore interroga il
   fascicolo: se il fatto esiste già approvato, l'anomalia si chiude senza
   domanda.
2. **Chiave semantica.** Ogni domanda porta un'impronta calcolata su
   `(ambito, chiave, tipo di richiesta)`. Una domanda con chiave già presente fra
   quelle inviate o risposte non viene emessa una seconda volta.
3. **`non_disponibile` è un fatto.** Una risposta di quel tipo genera un fatto
   approvato con valore `non_disponibile` e provenienza `dichiarazione`. Da quel
   momento nessun agente ripropone la domanda, e la Sentinella declassa
   l'anomalia da bloccante a miglioramento facoltativo dove le regole lo
   consentono.

Dopo **due cicli** senza soluzione, la domanda passa a `escalata` e il
Coordinatore propone gestione manuale o rinvio della parte interessata.

## 7. Operazioni di attivazione

```
OperazioneAttivazione {
  id · cantinaId
  destinazione     profilo | referenza | sommelier | anteprima | collegamenti
  chiaveOperazione UNIQUE   -- sha256(cantinaId, destinazione, riferimento,
                            --        insieme ordinato di (fattoId, versione))
  impronta         hash del carico utile
  stato            preparato | salvato | pubblicato | verificato | fallito
  idEsterno        identificativo restituito da VinoVeritas
  tentativi · ultimoErrore · verificatoIl
}
```

La chiave d'operazione include **le versioni dei fatti usati**. Ne seguono due
proprietà:

- **Ritentare è gratuito.** Stessa chiave, operazione già presente: non si
  duplica nulla. Il requisito *"ogni operazione deve poter essere ripetuta dopo
  un errore senza duplicare dati"* è soddisfatto da un vincolo di unicità.
- **Aggiornare è distinguibile.** Se un fatto cambia versione, la chiave cambia:
  la nuova operazione è riconoscibilmente diversa dalla precedente e può
  aggiornare invece di creare.

Lo stato `verificato` si raggiunge **solo** rileggendo il dato da VinoVeritas e
confrontandolo con l'impronta attesa. L'assenza di errore in scrittura non è una
verifica.

## 8. Schema relazionale (D1)

```sql
CREATE TABLE fact (
  id TEXT PRIMARY KEY,
  cantina_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_ref  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  lang       TEXT,
  state      TEXT NOT NULL,       -- proposto|da_confermare|approvato|superato
  visibility TEXT NOT NULL,       -- pubblico|commerciale|interno|riservato
  confidence REAL,
  version    INTEGER NOT NULL,
  supersedes TEXT REFERENCES fact(id),
  agent      TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  approved_by TEXT
);

-- un solo fatto vivo per (cantina, ambito, chiave)
CREATE UNIQUE INDEX fact_live ON fact(cantina_id, scope_type, scope_ref, key)
  WHERE state IN ('proposto','da_confermare','approvato');

CREATE INDEX fact_lookup ON fact(cantina_id, state, scope_type, scope_ref);

CREATE TABLE fact_source (
  fact_id TEXT NOT NULL REFERENCES fact(id),
  kind TEXT NOT NULL,             -- documento|dichiarazione|pagina_pubblica|derivato|inferenza_modello
  document_id TEXT, page INTEGER, char_start INTEGER, char_end INTEGER,
  url TEXT, retrieved_at INTEGER,
  answer_id TEXT, rule TEXT
);

CREATE TABLE fact_edge (
  derived_fact_id TEXT NOT NULL REFERENCES fact(id),
  source_fact_id  TEXT NOT NULL REFERENCES fact(id),
  rule TEXT NOT NULL,
  PRIMARY KEY (derived_fact_id, source_fact_id)
);

CREATE TABLE activation_op (
  id TEXT PRIMARY KEY,
  cantina_id TEXT NOT NULL,
  target TEXT NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,   -- l'idempotenza vive qui
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  external_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  verified_at INTEGER
);

CREATE TABLE agent_run (
  id TEXT PRIMARY KEY,
  cantina_id TEXT NOT NULL, agent TEXT NOT NULL, workflow_id TEXT,
  model TEXT NOT NULL, prompt_version TEXT NOT NULL, effort TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
  cost_usd REAL, duration_ms INTEGER, outcome TEXT, started_at INTEGER
);
```

L'indice parziale `fact_live` è il vincolo che rende impossibile, a livello di
database, avere due fatti vivi contraddittori per la stessa chiave nello stesso
ambito. Le versioni superate restano, ma fuori dall'indice.

La tabella `agent_run` non è strumentazione accessoria: è la fonte degli
indicatori del programma. Senza di essa *costo per cantina attivata* resta
un'opinione.
