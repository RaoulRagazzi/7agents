# 06 — Ambiente Cloudflare: locale e remoto

## 1. Cosa funziona senza alcun account

Wrangler emula D1, R2, KV, Durable Objects e Workflows **in locale**, con le
implementazioni reali del runtime (`workerd`), senza autenticazione e senza
account. È il motivo per cui il fascicolo è già verificato contro D1 vero e non
soltanto contro un surrogato.

```bash
npm test               # 536 test su node:sqlite, nessuna dipendenza aggiuntiva
npm run autotest       # la stessa verifica d'integrazione, su D1 reale nel worker
npm run coordinatore   # il percorso completo: Durable Object e Workflow veri
npm run d1:migrate     # applica le migrazioni al D1 locale
npm run d1:reset       # azzera il D1 locale e riapplica le migrazioni
```

`autotest` e `coordinatore` applicano le migrazioni da sé. Non è una comodità:
dimenticarle produceva una cascata di fallimenti che nascondeva la causa unica —
una colonna mancante — dietro dieci sintomi.

Lo stato locale vive in `.wrangler/state/`, escluso dal repository, **e sparisce
quando il container viene ricostruito**. Al primo comando in una sessione nuova,
`npm install` e `npm run d1:migrate` vanno rifatti; `npm test` funziona comunque
perché usa solo moduli nativi di Node, e questo nasconde il problema fino al
primo `tsc`.

Lo stato locale vive in `.wrangler/state/` ed è escluso dal repository.

### La stessa suite su due motori

[`selftest.ts`](../../src/worker/dossier/selftest.ts) si esegue sia dai test
Node (su `node:sqlite`) sia dalla rotta `/api/autotest` del worker (su D1). Sono
entrambi SQLite ma non sono la stessa cosa: le transazioni passano da `batch()`
invece che da `BEGIN`, l'applicazione delle chiavi esterne è una scelta della
piattaforma, e il viaggio dei valori attraverso il confine del binding è codice
diverso. **Se un esito divergesse fra i due motori, è questa la cosa che lo
mostrerebbe.**

### Il Coordinatore e l'attore, provati nel runtime

`npm run coordinatore` esegue 24 controlli su un percorso vero, e verifica ciò
che nessun test unitario può:

| Verifica | Esito |
|---|---|
| Il Workflow si sospende su `waitForEvent` | ✅ |
| Un secondo percorso sulla stessa cantina ottiene «occupato», e dichiara chi la tiene | ✅ |
| Le risposte consegnate al percorso sospeso lo riprendono | ✅ |
| Il percorso si conclude e rilascia la cantina | ✅ |
| Le domande aperte riguardano il **dato contestato**, non un dato mancante | ✅ |
| Il limite di due cicli è rispettato | ✅ |
| La coda dell'attore serializza e si svuota | ✅ |

### Un'insidia di `wrangler dev`

La vite plugin scrive `.wrangler/deploy/config.json`, che punta `wrangler dev`
al worker **già compilato** in `dist/` invece che al sorgente. Senza un
`vite build` prima, si collauda il codice precedente credendo di collaudare
quello attuale — è successo, e lo script `autotest` include quindi il build.

## 2. Cosa è stato verificato su D1 reale

| Verifica | Esito |
|---|---|
| Le quattro migrazioni si applicano in sequenza | ✅ |
| `fact_live`: un secondo fatto vivo sulla stessa chiave è respinto | ✅ |
| I `CHECK` mordono (stato, visibilità, ciclo, approvatore, pagina) | ✅ |
| Le **chiavi esterne** sono applicate | ✅ |
| `activation_op_key`: la stessa chiave d'operazione è respinta | ✅ |
| `question_dedup`: la stessa chiave semantica è respinta | ✅ |
| `D1Database` soddisfa la porta SQL senza adattatore | ✅ |
| **`batch()` annulla la transazione su errore** | ✅ — era il punto dichiarato da riverificare |
| I valori numerici attraversano il binding intatti | ✅ |
| Tutte e cinque le provenienze si rileggono identiche | ✅ |
| La suite è rieseguibile sullo stesso D1 persistente | ✅ — tre esecuzioni indipendenti |

## 3. Cosa serve per il remoto

Il container di questa sessione **non può autenticarsi**: `wrangler login`
richiede un flusso OAuth nel browser, e non esiste un connettore Cloudflare.
Il passaggio al remoto richiede una delle due cose, dalla tua parte.

### Opzione A — un token API nell'ambiente

La più adatta all'automazione. Crea un token su
*Cloudflare dashboard → My Profile → API Tokens* con i permessi:

| Permesso | Perché |
|---|---|
| `Workers Scripts: Edit` | distribuire il worker |
| `D1: Edit` | creare il database e applicare le migrazioni |
| `Workers R2 Storage: Edit` | l'archivio degli originali |
| `Workers KV Storage: Edit` | l'ontologia versionata |
| `Account Settings: Read` | risolvere l'id dell'account |

Poi, come variabili d'ambiente della sessione:

```
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
```

> Un token con questi permessi può creare e cancellare risorse sull'account.
> Conviene un token dedicato a questo progetto, con scadenza, revocabile — non
> un token globale.

### Opzione B — i comandi dalla tua macchina

Se preferisci non consegnare un token, i comandi sono pochi e li puoi eseguire
tu; io preparo la configurazione e tu riporti gli identificativi.

```bash
wrangler login
wrangler d1 create vinoveritas-fascicolo       # → restituisce database_id
wrangler r2 bucket create vinoveritas-originali
wrangler kv namespace create ONTOLOGIA         # → restituisce id
```

Gli identificativi vanno in `wrangler.json`, dove oggi c'è il segnaposto
`DA_SOSTITUIRE_PER_IL_REMOTO`.

### Dopo, in entrambi i casi

```bash
npm run d1:migrate:remote    # le migrazioni sul D1 remoto
npm run deploy               # il worker
```

**La rotta `/api/autotest` non va esposta in esercizio**: scrive righe di prova.
Va rimossa o chiusa dietro un controllo d'accesso prima del primo rilascio
pubblico — è annotato in [STATO.md](./STATO.md).

## 4. Cosa resta fuori anche con l'account

Il piano di orchestrazione e la persistenza sono ora costruiti e provati in
locale. Un account remoto aggiunge l'esercizio reale, non le funzioni. Resta
fuori:

- **La chiave `ANTHROPIC_API_KEY`** resta necessaria per l'estrazione con
  citazioni, la revisione avversariale del significato e la formulazione delle
  domande — e per sostituire le stime di costo con numeri.
- **L'accesso a VinoVeritas** resta il blocco della Tranche 1, a monte di tutto
  il piano di attivazione.
