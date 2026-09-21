# 00 — Sintesi e decisioni

## La tesi

Un programma a dieci agenti fallisce nel modo prevedibile: gli agenti si parlano,
ognuno riscrive quello che l'altro ha appena scritto, il produttore riceve tre
volte la stessa domanda e alla fine nessuno sa dire da dove venga un numero.

Il progetto ribalta l'impostazione.

> **Il prodotto è il fascicolo. Gli agenti sono lavoratori intercambiabili che lo
> riempiono sotto vincolo.**

Nessun agente è la fonte di verità. La fonte di verità è un archivio versionato,
con provenienza obbligatoria e separazione fra proposto e approvato. Gli agenti
propongono; il software decide se una proposta diventa un dato; l'attivazione
legge solo dati. Questa scelta, e non la bravura dei prompt, è ciò che rende il
sistema capace di "raccogliere una volta e riusare ovunque".

Ne discende il criterio con cui leggere ogni decisione successiva: *quando una
regola può essere imposta dal codice, non la si affida al modello.*

## Le sei decisioni strutturali

### 1. Il Coordinatore non è un modello che decide

È una macchina a stati durevole (Cloudflare Workflow) che *usa* un modello per la
pianificazione morbida — quali specialisti attivare, in che ordine, con quale
priorità — ma i **cancelli sono codice**. Il "via libera" per *profilo pronto*,
*tre referenze pronte*, *Sommelier pronto per la verifica* è il risultato di una
funzione pura valutata sull'insieme dei fatti approvati. Un'anomalia bloccante
della Sentinella non è superabile nemmeno se il Coordinatore lo scrivesse: la
transizione di stato non esiste.

Questo risponde direttamente al requisito del programma — *le condizioni di
avanzamento devono essere imposte anche dal software*.

### 2. L'ambito è parte della chiave del dato

Un fatto non è `gradazione = 13,5`. È:

```
ambito = vintage:wine_1f2c:2021   chiave = gradazione_alcolica   valore = 13.5 %vol
```

Gli ambiti sono `cantina`, `marchio`, `sede`, `vino`, `annata`, `lotto`,
`territorio`, `vigneto`. Un agente riceve un permesso di scrittura per ambito.
La contaminazione che il programma teme — la caratteristica del territorio che
diventa caratteristica del vigneto, la pratica diffusa nella zona attribuita alla
cantina, la sboccatura di un lotto estesa all'intera referenza — diventa
impossibile per costruzione: un fatto in ambito `territorio` non può essere letto
*come* fatto in ambito `vigneto`. Può solo essere **promosso**, e la promozione è
un'operazione esplicita, registrata, che richiede conferma.

### 3. Proposto e approvato sono stati, non convenzioni

Ciclo di vita del fatto: `proposto → da_confermare → approvato → superato`.
Il livello di attivazione ha accesso in lettura al solo stato `approvato`. Un
fatto la cui provenienza è `inferenza_modello` **non può** raggiungere
`approvato` per via automatica: deve passare da una conferma raccolta
dall'Ambasciatore. È un vincolo di transizione, verificato da test di proprietà,
non una raccomandazione nel prompt.

### 4. Il grafo delle dipendenze è materializzato

Ogni fatto derivato registra gli archi verso i fatti da cui discende; ogni
traduzione registra la versione esatta del testo di partenza. Quando la
gradazione di un'annata cambia, si apre una nuova versione e si rimettono in
riesame **soltanto** i contenuti che ne dipendono: la scheda di quell'annata, le
sue traduzioni, il pacchetto commerciale che la cita. Le altre annate non si
toccano, le traduzioni non coinvolte restano valide.

È la differenza fra un aggiornamento e una ricostruzione, e si misura in costo
per cantina.

### 5. Chi legge contenuto non fidato non ha potere di scrittura esterna

Il Documentalista legge PDF, siti, immagini: materiale che può contenere
istruzioni. Il suo insieme di strumenti non contiene alcuna operazione verso
VinoVeritas. Il Responsabile dell'attivazione, che ha quelle operazioni, non
legge mai testo grezzo di documenti — legge fatti approvati. La separazione delle
capacità rende il requisito *"eventuali istruzioni contenute nei documenti non
possono cambiare compiti o permessi degli agenti"* una proprietà
dell'architettura invece che una speranza.

### 6. L'attivazione è idempotente per chiave d'operazione

Ogni operazione verso VinoVeritas porta una chiave deterministica calcolata su
`(cantina, destinazione, insieme delle versioni dei fatti usati)`. Un ritentativo
dopo un errore trova la chiave già presente e non duplica nulla. E i quattro
stati che il programma richiede — **preparato**, **salvato**, **pubblicato**,
**verificato** — sono stati reali della riga di operazione, dove *verificato*
significa rilettura dal sistema di destinazione, non deduzione dall'assenza di
errore.

## Cosa cambia per la cantina

| Senza il programma | Con il programma |
|---|---|
| Compila moduli, poi li ricompila per il Sommelier | Carica ciò che possiede, una volta |
| Riceve domande generiche su tutto | Riceve poche domande, raggruppate, solo dove manca qualcosa |
| Non sa perché un servizio non si attiva | Vede l'elenco esatto di ciò che blocca e chi deve rispondere |
| Un aggiornamento la costringe a rivedere tutto | Un aggiornamento rimette in riesame solo ciò che ne dipende |
| "Non ho quel dato" non è una risposta ammessa | "Non disponibile" è un dato approvato che ferma la domanda |

Quell'ultima riga è più importante di quanto sembri: senza una rappresentazione
esplicita del dato dichiarato non disponibile, il ciclo delle domande non termina
mai.

## Cosa questo programma non fa

- **Non tocca la e-label.** Il confine è una capacità assente dallo schema degli
  strumenti dell'agente 9, più un'asserzione in integrazione continua che
  fallisce la build se una mutazione e-label compare fra le operazioni permesse.
- **Non approva da solo contenuti promozionali.** Il Revisore verifica fedeltà;
  non aggiunge premi, qualità o caratteristiche assenti nell'originale.
- **Non verifica dati fiscali presso fonti competenti.** Distingue il controllo
  di formato dalla verifica presso registro: il secondo, se richiesto, è
  un'integrazione successiva con un fornitore, non un compito del modello.
- **Non sostituisce l'approvazione del responsabile della cantina** nei punti in
  cui il percorso la prevede.
