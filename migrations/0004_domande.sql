-- Ambito e chiave della domanda (Tranche 4).
--
-- La chiave semantica resta l'identità della domanda — è su quella che vive
-- l'indice unico — ma non è un contenitore da cui ricavare l'ambito: un
-- riferimento che contenesse il separatore romperebbe il giro di ritorno.
-- Ambito e chiave sono dati, e stanno in colonne.
--
-- Serve anche a instradare la risposta: lo specialista competente si determina
-- dall'ambito, e ricavarlo da una stringa composta sarebbe un modo fragile di
-- decidere chi lavora.

ALTER TABLE question ADD COLUMN scope_type TEXT;
ALTER TABLE question ADD COLUMN scope_ref TEXT;
ALTER TABLE question ADD COLUMN fact_key TEXT;
ALTER TABLE question ADD COLUMN blocking INTEGER NOT NULL DEFAULT 0;
ALTER TABLE question ADD COLUMN released_at INTEGER;

CREATE INDEX question_state ON question(cantina_id, state, blocking);
CREATE INDEX question_scope ON question(cantina_id, scope_type, scope_ref);
