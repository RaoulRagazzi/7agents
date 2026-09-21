# 03 — I dieci agenti

Ogni agente è una configurazione del kernel descritto in
[01 — Architettura §3](./01-architettura.md). Qui si definisce il contratto di
ciascuno: cosa legge, cosa può scrivere, con quali strumenti, con quale schema
d'uscita, e quale guardrail lo trattiene.

## Tabella di sintesi

| # | Agente | Sforzo | Ambiti in scrittura | Strumenti | Può approvare |
|---|---|---|---|---|---|
| 1 | Coordinatore | `low` | *nessuno* | leggi stato, pianifica, apri/chiudi attività | no |
| 2 | Anagrafica e dati fiscali | `medium` | cantina, marchio, sede | leggi documenti, proponi fatto, apri anomalia | no |
| 3 | Identità, storia e territorio | `high` | cantina, vigneto, territorio | leggi documenti, ricerca web, proponi fatto | no |
| 4 | Bianchi, spumanti e passiti | `medium` | vino, annata, lotto *(assegnati)* | leggi documenti, proponi fatto, apri anomalia | no |
| 5 | Altre referenze | `medium` | vino, annata, lotto *(assegnati)* | idem agente 4 | no |
| 6 | Sentinella della qualità | `xhigh` | *nessuno* | leggi fatti, leggi documenti originali, apri anomalia | no |
| 7 | Ambasciatore della Cantina | `medium` | *nessuno* | leggi anomalie, cerca risposta esistente, formula domanda | no |
| 8 | Documentalista | `medium` | *nessuno* (scrive fonti, non fatti) | ingerisci, estrai, classifica, collega | no |
| 9 | Responsabile dell'attivazione | `low` | *nessuno* | leggi fatti approvati, prepara/salva/pubblica/verifica | no |
| 10 | Revisore linguistico ed enologico | `high` | traduzioni | leggi fatti approvati, proponi traduzione, marca da riesaminare | no |

La colonna "Può approvare" è `no` per tutti e dieci. L'approvazione è una
transizione del piano di orchestrazione, condizionata ai cancelli e alle
conferme del responsabile della cantina. Nessun agente, nemmeno la Sentinella,
può concederla.

---

## 1 — Coordinatore

**Missione.** Organizzare attività, dipendenze e avanzamento. Emettere il via
libera per ciascun servizio.

**Come è fatto.** Un Workflow durevole, non una conversazione. All'apertura
dell'onboarding identifica l'obiettivo — completare il profilo, inserire vini,
attivare il Sommelier, predisporre altri servizi — e ricostruisce lo stato: quali
documenti sono già stati elaborati, quali risposte già ricevute, quali attività
interrotte. Poi stabilisce quali informazioni servono e attiva **soltanto gli
specialisti necessari**.

Il modello interviene in un solo punto: proporre l'ordine e la priorità delle
attività, in uscita strutturata. Tutto il resto — apertura dei passi, budget,
ritentativi, valutazione dei cancelli — è codice.

**Il guardrail.** Il via libera non è un'affermazione dell'agente. È
`evaluateGate(target, fattiApprovati, anomalieAperte)`, funzione pura in
[`gates.ts`](../../src/worker/dossier/gates.ts). Se esiste un'anomalia bloccante
sulla destinazione, la funzione restituisce `false` e la transizione non avviene,
qualunque cosa il modello abbia concluso. Un test di proprietà verifica
l'implicazione su insiemi generati casualmente: *anomalia bloccante aperta sulla
destinazione ⟹ cancello chiuso*.

**Sospensione e ripresa.** Il Workflow attende gli eventi esterni (risposte del
produttore, completamento di una coda) con attese durevoli. Una cantina ferma tre
settimane riprende dal punto esatto, senza rielaborare ciò che era già fatto.

---

## 2 — Anagrafica e dati fiscali

**Missione.** Identificare correttamente impresa, marchi e sedi.

**Cosa raccoglie.** Ragione sociale, identificativi fiscali, sede legale, sedi
operative, contatti, e la relazione fra impresa e marchi — distinguendo il nome
commerciale della cantina dalla società che la gestisce. È una distinzione che
genera quasi sempre almeno una domanda: `marchio:*/nome_commerciale` e
`cantina/ragione_sociale` sono chiavi diverse in ambiti diversi, e il sistema non
le fonde.

**Il guardrail.** Tre regole:

- **Non inventa.** Il valore assente resta assente; la mancanza diventa anomalia,
  non un valore plausibile.
- **Distingue formato da verifica.** Un identificativo fiscale sintatticamente
  valido è `proposto` con provenienza documentale. La verifica presso una fonte
  competente è un'operazione diversa, oggi non implementata: il fatto porta
  `verificaEsterna: non_eseguita` e la Sentinella lo riflette invece di fingere.
- **Nasce riservato.** Identificativi fiscali, sede legale e contatti
  amministrativi hanno visibilità `riservato`: non entrano nei pacchetti del
  Sommelier né negli incorporamenti.

**Discrepanze.** Quando due materiali riportano dati diversi, apre un'anomalia
`da_confermare` con entrambe le evidenze, senza scegliere.

---

## 3 — Identità, storia e territorio

**Missione.** Ricostruire il patrimonio della cantina: storia aziendale,
persone, vigneti, luoghi, filosofia produttiva, pratiche dichiarate.

**Il cuore del contratto.** Questo agente lavora su quattro registri che devono
restare **distinti nel fascicolo, non solo nella prosa**:

| Registro | Come è rappresentato |
|---|---|
| Fatti sostenuti da documenti | fatto con provenienza `documento` |
| Dichiarazioni attribuite alla cantina | fatto con provenienza `dichiarazione`, e la chiave porta il suffisso `_dichiarato` |
| Informazioni generali sul territorio | fatto in ambito `territorio` — mai in ambito `vigneto` o `cantina` |
| Testi narrativi elaborati | contenuto derivato, con archi verso i fatti di origine |

Il quarto registro è la trappola classica: il testo narrativo *sembra* un dato ed
è invece una derivazione. Qui è un contenuto con `fact_edge` verso ogni fatto che
utilizza — il che significa che quando uno di quei fatti cambia, il testo si
marca automaticamente da riesaminare.

**Il guardrail.** La regola di non contaminazione di
[02 §2](./02-fascicolo.md#la-regola-di-non-contaminazione) è applicata dagli
ambiti: l'agente *può* scrivere in `territorio` e *può* scrivere in `vigneto`, ma
un fatto scritto in uno non è leggibile come fatto dell'altro. Per attraversare
serve `promuovi()`, che genera una conferma.

---

## 4 e 5 — Gli specialisti delle referenze

**Missione.** Analizzare le referenze assegnate e produrre schede tecniche per
vino e annata.

**La regola di assegnazione è codice, non prompt.**

```
agente 4  ←  tutti gli spumanti, tutti i passiti (indipendentemente dal colore),
             più i bianchi fermi
agente 5  ←  tutto il resto, inclusi rossi e rosati fermi
Coordinatore  ←  tipologia non determinabile
```

È implementata in [`assignment.ts`](../../src/worker/dossier/assignment.ts) come
funzione totale: ogni referenza ha **un unico responsabile**, e il caso dubbio ha
una destinazione esplicita invece di un comportamento implicito. Le tipologie
dubbie vengono sottoposte al Coordinatore **prima** dell'assegnazione, non dopo
un'estrazione andata male.

**Schema condiviso.** I due agenti usano lo stesso schema dati, lo stesso
vocabolario, le stesse unità di misura e le stesse regole per distinguere
prodotto, annata e formato. Sono la stessa configurazione del kernel con due
predicati di assegnazione diversi: condividere lo schema non è una convenzione da
rispettare, è la stessa definizione.

**Controlli specifici** (agente 4, quando pertinenti): metodo di
spumantizzazione, permanenza sui lieviti, tecnica e durata dell'appassimento,
dosaggio, data di sboccatura.

**Due guardrail.**

- **Ambito del lotto.** Sboccatura, dosaggio e numero di bottiglie vivono in
  ambito `lotto`. Non si estendono all'annata né alla referenza. Lo schema
  d'uscita non offre nemmeno il campo per farlo.
- **Attribuzione delle note sensoriali.** Una nota di degustazione del produttore
  è un fatto con provenienza `dichiarazione` e chiave `nota_degustazione_produttore`.
  Non esiste una chiave `nota_degustazione_agente`: l'agente non degusta, e lo
  schema non gli permette di presentare come propria una descrizione altrui.

**Annate omonime.** Il caso di prova più insidioso: due referenze con nome simile
e stessa annata. La disambiguazione è su `(denominazione, formato, codice
interno)`; se restano indistinguibili, l'estrazione si ferma e apre
un'anomalia `da_confermare` invece di indovinare.

---

## 6 — Sentinella della qualità

**Missione.** Verificare completezza, coerenza e provenienza. Classificare, non
correggere.

**Come lavora.** In due passaggi, e l'ordine conta.

1. **Controlli deterministici** (codice): campi obbligatori per destinazione,
   unità di misura, intervalli plausibili, coerenza fra vitigni e denominazione,
   presenza di provenienza, assenza di fatti `inferenza_modello` in stato
   approvato, annate duplicate, riferimenti orfani.
2. **Revisione avversariale** (modello, sforzo `xhigh`): incongruenze di
   significato che nessuna regola cattura — un affinamento in barrique dichiarato
   per un vino che il resto della scheda descrive come acciaio, una storia
   aziendale che colloca la fondazione dopo l'impianto del vigneto più vecchio.

Le regole esatte vanno al software perché lì sono affidabili e gratuite; il
significato va al modello perché lì le regole non arrivano.

**Controlla le fonti originali.** Questo è il punto che distingue la Sentinella da
un revisore di riepiloghi: per ogni fatto sotto esame recupera il passaggio
citato nel documento — pagina e intervallo dalla provenienza — e verifica che
dica davvero quello. Non legge la scheda prodotta dall'agente 4: legge il PDF.

**Uscita.** Anomalie nelle quattro categorie del programma:

| Esito | Conseguenza nel sistema |
|---|---|
| **Bloccante** | `destinazioni` sospese; il cancello corrispondente non può aprirsi |
| **Da confermare** | genera una domanda mirata per l'Ambasciatore |
| **Miglioramento facoltativo** | registrata; non blocca l'attivazione minima |
| **Superato** | il passaggio successivo è consentito |

Ogni anomalia indica il problema, le evidenze e il dato interessato. La Sentinella
**non modifica fatti**: non ha ambiti in scrittura.

---

## 7 — Ambasciatore della Cantina

**Missione.** Trasformare le segnalazioni in domande comprensibili, nella lingua
scelta dal produttore, e riportare le risposte a chi di dovere.

**Il ciclo.**

```
anomalie aperte
   → verifica preliminare: la risposta è già nel fascicolo?        (se sì: chiudi)
   → verifica chiave semantica: l'ho già chiesto?                  (se sì: non riemettere)
   → raggruppa per argomento e interlocutore
   → formula nella lingua del produttore
   → attendi (il Workflow dorme)
   → risposta → allo specialista competente → alla Sentinella
```

**Rilascio a lotti.** Le domande non partono una alla volta. Si accumulano in una
cartella e vengono rilasciate quando si verifica una di tre condizioni: un
cancello è bloccato, la finestra di attesa scade, oppure si supera una soglia di
domande pendenti. È la misura che tiene basso l'indicatore *minuti richiesti al
produttore*: meglio sei domande insieme che sei interruzioni.

**Tre modi di rispondere.** Rispondere, allegare un documento, oppure dichiarare
che il dato non è disponibile. Il terzo genera un fatto approvato con valore
`non_disponibile` — ed è ciò che permette al ciclo di terminare.

**I guardrail.**

- **Non approva ciò che raccoglie.** Una risposta diventa un fatto `proposto` con
  provenienza `dichiarazione`; torna allo specialista, poi alla Sentinella. La
  catena non si accorcia.
- **Due cicli.** Dopo due giri senza soluzione, escalation al Coordinatore, che
  propone gestione manuale o rinvio della parte interessata. Il limite è un
  contatore, non una valutazione.

---

## 8 — Documentalista

**Missione.** Acquisire, leggere e classificare i materiali. Preparare le fonti
per tutti gli altri.

**Pipeline.**

```
caricamento → R2 con chiave sha256 (deduplica per costruzione)
           → estrazione con citazioni attive (pagina e intervallo per ogni passaggio)
           → riconoscimento testo di ripiego per gli scansionati
           → classificazione: scheda tecnica, listino, certificazione, foto,
             rassegna stampa, documento amministrativo
           → proposta di collegamento a cantina / vino / annata
           → segmentazione e indicizzazione in Vectorize (spazio della cantina)
```

**Cosa produce.** Non fatti: **fonti**. Il Documentalista prepara il materiale
citabile; sono gli agenti 2–5 a proporre fatti a partire da esso. La separazione
evita che un errore di classificazione diventi direttamente un dato.

**Segnala invece di indovinare.** Testi illeggibili e associazioni incerte
diventano anomalie: un documento che l'OCR non riesce a leggere è una riga con
stato `illeggibile` e una domanda per il produttore, non un'estrazione a bassa
fiducia che inquina il fascicolo.

**Il guardrail difensivo.** È l'agente che legge contenuto non fidato, e ha
l'insieme di strumenti più povero del sistema: nessuna operazione verso
VinoVeritas, nessuna scrittura di fatti, nessun accesso agli ambiti. Il testo dei
documenti entra nella richiesta come blocco `document`, mai nelle istruzioni di
sistema. Le istruzioni contenute in un documento restano quindi ciò che sono —
testo in un documento — perché anche se il modello le seguisse, gli strumenti per
eseguirle non esistono.

---

## 9 — Responsabile dell'attivazione

**Missione.** Rendere utilizzabile il lavoro: confrontare i dati approvati con
ciò che è già presente in VinoVeritas e preparare le operazioni necessarie.

**Cosa prepara.** Completamento del profilo; creazione o aggiornamento delle
bozze delle referenze; contenuti pubblici per il Sommelier; anteprime e
collegamenti; verifica del risultato dopo il salvataggio.

**I quattro stati, distinti sempre.**

| Stato | Significato | Come si raggiunge |
|---|---|---|
| **preparato** | carico utile costruito e mostrato in anteprima | funzione pura sui fatti approvati |
| **salvato** | scritto in VinoVeritas | chiamata autorizzata riuscita |
| **pubblicato** | visibile nei servizi | operazione di pubblicazione riuscita |
| **verificato** | riletto e confronto riuscito | rilettura da VinoVeritas + confronto d'impronta |

L'agente dichiara conclusa un'attività **soltanto** sulla base dell'esito
effettivo. `verificato` non si deduce dall'assenza di errore: si ottiene
rileggendo.

**Il livello anticorruzione.** Tutte le modifiche passano da funzioni software
autorizzate, che traducono i fatti del fascicolo nel formato di VinoVeritas. Il
modello non costruisce chiamate: sceglie fra operazioni già definite, con
argomenti validati.

**Idempotenza.** Ogni operazione porta la chiave deterministica di
[02 §7](./02-fascicolo.md#7--operazioni-di-attivazione). Ritentare dopo un errore
non duplica.

**Il confine e-label.** Lo schema degli strumenti di questo agente **non contiene**
alcuna operazione che tocchi la pagina normativa. Non è una regola nel prompt: è
un'assenza, più un'asserzione in integrazione continua che fallisce la build se
un'operazione e-label comparisse nell'elenco delle capacità.

---

## 10 — Revisore linguistico ed enologico

**Missione.** Rendere affidabile il multilingue, lavorando sui contenuti
approvati nella lingua di origine.

**Cosa verifica.** Terminologia enologica, fedeltà del significato, nomi propri,
denominazioni, valori numerici e unità di misura. Distingue la traduzione tecnica
dall'adattamento promozionale e tratta i due casi con criteri diversi.

**Il guardrail più importante.** Non aggiunge premi, qualità o caratteristiche
assenti nell'originale. È verificabile meccanicamente: un controllo confronta
l'insieme delle entità numeriche e delle denominazioni presenti nella traduzione
con quelle dell'originale; un'aggiunta non giustificata è un'anomalia bloccante
per la destinazione linguistica.

**Il legame con la versione.** Ogni traduzione registra la versione esatta del
testo di partenza. Quando quella cambia, la traduzione si marca `stale` —
automaticamente, per via del grafo delle dipendenze — e viene rimessa in coda.
È il meccanismo che evita il caso descritto nel programma: un aggiornamento alla
gradazione di un'annata che lascia le traduzioni incoerenti.

**Economia.** Le traduzioni sono il carico ideale per l'API Batch: non sensibili
alla latenza, a metà prezzo. Su un catalogo di trenta referenze in tre lingue la
differenza è sostanziale.
