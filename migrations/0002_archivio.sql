-- Archivio delle fonti (Tranche 3, passo 5).
--
-- Estende `source_document` con ciò che serve al Documentalista: il nome
-- originale, la dimensione, il motivo di illeggibilità e la fiducia nella
-- classificazione — che è una proposta, non un dato autorevole.
--
-- I collegamenti a cantina, vino e annata vivono in una tabella a parte perché
-- un documento può riguardarne più di uno, e perché un'associazione incerta
-- deve poter restare incerta.
--
-- Vedi docs/vinoveritas/03-agenti.md §8

ALTER TABLE source_document ADD COLUMN filename TEXT;
ALTER TABLE source_document ADD COLUMN size_bytes INTEGER;
ALTER TABLE source_document ADD COLUMN class_confidence REAL;
ALTER TABLE source_document ADD COLUMN illegible_reason TEXT;

CREATE TABLE document_link (
  document_id TEXT NOT NULL REFERENCES source_document(id),
  scope_type  TEXT NOT NULL,
  scope_ref   TEXT NOT NULL,
  confidence  REAL NOT NULL,
  -- un'associazione incerta resta incerta finché il produttore non conferma
  state       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (document_id, scope_type, scope_ref),
  CHECK (state IN ('proposto', 'confermato', 'respinto')),
  CHECK (confidence BETWEEN 0 AND 1)
);

CREATE INDEX document_link_scope ON document_link(scope_type, scope_ref);
