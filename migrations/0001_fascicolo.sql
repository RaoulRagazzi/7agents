-- Fascicolo VinoVeritas — fondamenta comuni (Tranche 2, passo 3).
--
-- Vincoli che portano le invarianti del programma a livello di database:
--  * fact_live        → un solo fatto vivo per (cantina, ambito, chiave)
--  * fact_source      → nessun fatto senza provenienza (verificato in ammissione)
--  * activation_op    → chiave d'operazione unica: ritentare non duplica
--
-- Vedi docs/vinoveritas/02-fascicolo.md

-- ─── Cantine e documenti ──────────────────────────────────────────────────────

CREATE TABLE cantina (
  id            TEXT PRIMARY KEY,
  nome          TEXT NOT NULL,
  lingua_origine TEXT NOT NULL DEFAULT 'it',
  obiettivo     TEXT,                      -- profilo | referenze | sommelier | altro
  created_at    INTEGER NOT NULL
);

CREATE TABLE source_document (
  id            TEXT PRIMARY KEY,
  cantina_id    TEXT NOT NULL REFERENCES cantina(id),
  sha256        TEXT NOT NULL,             -- deduplica per costruzione
  r2_key        TEXT NOT NULL,
  mime          TEXT NOT NULL,
  pages         INTEGER,
  classe        TEXT,                      -- scheda_tecnica | listino | certificazione | foto | ...
  stato         TEXT NOT NULL,             -- caricato | estratto | illeggibile
  uploaded_by   TEXT NOT NULL,
  uploaded_at   INTEGER NOT NULL
);

-- lo stesso contenuto caricato due volte non genera due fonti
CREATE UNIQUE INDEX source_document_dedup
  ON source_document(cantina_id, sha256);

CREATE TABLE source_chunk (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES source_document(id),
  page          INTEGER NOT NULL,
  char_start    INTEGER NOT NULL,
  char_end      INTEGER NOT NULL,
  text          TEXT NOT NULL,
  vector_id     TEXT                       -- riferimento in Vectorize
);

CREATE INDEX source_chunk_doc ON source_chunk(document_id, page);

-- ─── Fatti, provenienza, dipendenze ───────────────────────────────────────────

CREATE TABLE fact (
  id             TEXT PRIMARY KEY,
  cantina_id     TEXT NOT NULL REFERENCES cantina(id),
  scope_type     TEXT NOT NULL,            -- cantina|marchio|sede|vino|annata|lotto|vigneto|territorio
  scope_ref      TEXT NOT NULL,
  key            TEXT NOT NULL,
  value_json     TEXT NOT NULL,
  lang           TEXT,
  state          TEXT NOT NULL,            -- proposto|da_confermare|approvato|superato
  visibility     TEXT NOT NULL,            -- pubblico|commerciale|interno|riservato
  confidence     REAL,
  version        INTEGER NOT NULL,
  supersedes     TEXT REFERENCES fact(id),
  agent          TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  approved_at    INTEGER,
  approved_by    TEXT,
  CHECK (state IN ('proposto','da_confermare','approvato','superato')),
  CHECK (visibility IN ('pubblico','commerciale','interno','riservato')),
  -- un fatto approvato porta sempre chi e quando
  CHECK (state <> 'approvato' OR (approved_at IS NOT NULL AND approved_by IS NOT NULL))
);

-- il vincolo che rende impossibili due fatti vivi contraddittori sulla stessa chiave
CREATE UNIQUE INDEX fact_live
  ON fact(cantina_id, scope_type, scope_ref, key)
  WHERE state IN ('proposto','da_confermare','approvato');

CREATE INDEX fact_lookup   ON fact(cantina_id, state, scope_type, scope_ref);
CREATE INDEX fact_public    ON fact(cantina_id, state, visibility);
CREATE INDEX fact_supersede ON fact(supersedes);

CREATE TABLE fact_source (
  id           TEXT PRIMARY KEY,
  fact_id      TEXT NOT NULL REFERENCES fact(id),
  kind         TEXT NOT NULL,              -- documento|dichiarazione|pagina_pubblica|derivato|inferenza_modello
  document_id  TEXT REFERENCES source_document(id),
  page         INTEGER,
  char_start   INTEGER,
  char_end     INTEGER,
  url          TEXT,
  retrieved_at INTEGER,
  snapshot_key TEXT,
  answer_id    TEXT,
  respondent   TEXT,
  rule         TEXT,
  prompt_version TEXT,
  run_id       TEXT,
  CHECK (kind IN ('documento','dichiarazione','pagina_pubblica','derivato','inferenza_modello')),
  -- una provenienza documentale senza pagina non è tornabile alla fonte
  CHECK (kind <> 'documento' OR (document_id IS NOT NULL AND page IS NOT NULL))
);

CREATE INDEX fact_source_fact ON fact_source(fact_id);
CREATE INDEX fact_source_doc  ON fact_source(document_id);

CREATE TABLE fact_edge (
  derived_fact_id TEXT NOT NULL REFERENCES fact(id),
  source_fact_id  TEXT NOT NULL REFERENCES fact(id),
  rule            TEXT NOT NULL,
  PRIMARY KEY (derived_fact_id, source_fact_id)
);

CREATE INDEX fact_edge_source ON fact_edge(source_fact_id);

-- candidati scartati dalla tabella di precedenza: restano registrati, non vivi
CREATE TABLE fact_candidate (
  id          TEXT PRIMARY KEY,
  cantina_id  TEXT NOT NULL REFERENCES cantina(id),
  scope_type  TEXT NOT NULL,
  scope_ref   TEXT NOT NULL,
  key         TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  precedence  INTEGER NOT NULL,            -- minore = più autorevole
  source_kind TEXT NOT NULL,
  agent       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX fact_candidate_key
  ON fact_candidate(cantina_id, scope_type, scope_ref, key, precedence);

-- ─── Anomalie, domande, risposte ──────────────────────────────────────────────

CREATE TABLE issue (
  id         TEXT PRIMARY KEY,
  cantina_id TEXT NOT NULL REFERENCES cantina(id),
  severity   TEXT NOT NULL,                -- bloccante|da_confermare|miglioramento|superato
  code       TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_ref  TEXT NOT NULL,
  fact_key   TEXT,
  evidence_json TEXT NOT NULL,
  targets_json  TEXT NOT NULL,             -- [{target, ref}] — sospensione mirata
  state      TEXT NOT NULL,                -- aperta|in_domanda|risolta|accettata
  cycle      INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  CHECK (severity IN ('bloccante','da_confermare','miglioramento','superato')),
  CHECK (state IN ('aperta','in_domanda','risolta','accettata')),
  CHECK (cycle BETWEEN 1 AND 2)
);

CREATE INDEX issue_open ON issue(cantina_id, state, severity);

CREATE TABLE question (
  id            TEXT PRIMARY KEY,
  cantina_id    TEXT NOT NULL REFERENCES cantina(id),
  issue_ids_json TEXT NOT NULL,
  topic         TEXT NOT NULL,
  audience      TEXT NOT NULL,             -- enologo|amministrazione|marketing|titolare
  lang          TEXT NOT NULL,
  body          TEXT NOT NULL,
  semantic_key  TEXT NOT NULL,             -- impronta per la deduplica
  state         TEXT NOT NULL,             -- bozza|inviata|risposta|scaduta|escalata
  cycle         INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  sent_at       INTEGER
);

-- una domanda con la stessa chiave semantica non si emette due volte
CREATE UNIQUE INDEX question_dedup ON question(cantina_id, semantic_key);

CREATE TABLE answer (
  id          TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES question(id),
  kind        TEXT NOT NULL,               -- testo|documento|non_disponibile
  content     TEXT,
  document_id TEXT REFERENCES source_document(id),
  respondent  TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  CHECK (kind IN ('testo','documento','non_disponibile'))
);

-- ─── Traduzioni ───────────────────────────────────────────────────────────────

CREATE TABLE translation (
  id             TEXT PRIMARY KEY,
  cantina_id     TEXT NOT NULL REFERENCES cantina(id),
  fact_id        TEXT NOT NULL REFERENCES fact(id),
  lang           TEXT NOT NULL,
  text           TEXT NOT NULL,
  -- il legame con la versione sorgente: quando cambia, la traduzione è stale
  source_version INTEGER NOT NULL,
  state          TEXT NOT NULL,            -- fresca|stale|approvata
  reviewed_at    INTEGER,
  CHECK (state IN ('fresca','stale','approvata'))
);

CREATE UNIQUE INDEX translation_unique ON translation(fact_id, lang);
CREATE INDEX translation_stale ON translation(cantina_id, state);

-- ─── Attivazione ──────────────────────────────────────────────────────────────

CREATE TABLE activation_op (
  id            TEXT PRIMARY KEY,
  cantina_id    TEXT NOT NULL REFERENCES cantina(id),
  target        TEXT NOT NULL,             -- profilo|referenza|sommelier|materiali_commerciali
  target_ref    TEXT,
  operation_key TEXT NOT NULL,             -- l'idempotenza vive qui
  payload_hash  TEXT NOT NULL,
  state         TEXT NOT NULL,             -- preparato|salvato|pubblicato|verificato|fallito
  external_id   TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  verified_at   INTEGER,
  CHECK (state IN ('preparato','salvato','pubblicato','verificato','fallito'))
);

CREATE UNIQUE INDEX activation_op_key ON activation_op(operation_key);
CREATE INDEX activation_op_cantina ON activation_op(cantina_id, state);

-- i fatti (e le versioni) che un'operazione ha usato: serve a rilevare
-- quali operazioni tornano rieseguibili quando un fatto cambia versione
CREATE TABLE activation_op_fact (
  op_id        TEXT NOT NULL REFERENCES activation_op(id),
  fact_id      TEXT NOT NULL REFERENCES fact(id),
  fact_version INTEGER NOT NULL,
  PRIMARY KEY (op_id, fact_id)
);

CREATE INDEX activation_op_fact_fact ON activation_op_fact(fact_id);

-- ─── Osservabilità ────────────────────────────────────────────────────────────

-- la fonte degli indicatori: senza questa tabella il costo per cantina è un'opinione
CREATE TABLE agent_run (
  id                TEXT PRIMARY KEY,
  cantina_id        TEXT NOT NULL REFERENCES cantina(id),
  agent             TEXT NOT NULL,
  workflow_id       TEXT,
  model             TEXT NOT NULL,
  prompt_version    TEXT NOT NULL,
  effort            TEXT NOT NULL,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  outcome           TEXT NOT NULL,         -- ok|rifiutato|limite_superato|errore
  started_at        INTEGER NOT NULL
);

CREATE INDEX agent_run_cost ON agent_run(cantina_id, started_at);

-- ogni scrittura fuori ambito respinta compare qui invece di riuscire
CREATE TABLE admission_rejection (
  id          TEXT PRIMARY KEY,
  cantina_id  TEXT NOT NULL,
  agent       TEXT NOT NULL,
  run_id      TEXT,
  code        TEXT NOT NULL,
  detail      TEXT NOT NULL,
  scope_type  TEXT,
  scope_ref   TEXT,
  key         TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX admission_rejection_cantina
  ON admission_rejection(cantina_id, created_at);

CREATE TABLE gate_evaluation (
  id            TEXT PRIMARY KEY,
  cantina_id    TEXT NOT NULL REFERENCES cantina(id),
  target        TEXT NOT NULL,
  target_ref    TEXT,
  open          INTEGER NOT NULL,
  reasons_json  TEXT NOT NULL,
  evaluated_at  INTEGER NOT NULL
);

CREATE INDEX gate_evaluation_cantina ON gate_evaluation(cantina_id, evaluated_at);
