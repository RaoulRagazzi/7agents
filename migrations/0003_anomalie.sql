-- Il testo dell'anomalia (Tranche 4).
--
-- Una `Finding` della Sentinella porta il motivo in chiaro, con la motivazione
-- dell'intervallo o l'elenco dei valori ammessi. È il testo da cui l'Ambasciatore
-- formula la domanda: salvare l'anomalia perdendolo costringerebbe a ricostruirlo,
-- e una ricostruzione non è la stessa cosa dell'originale.

ALTER TABLE issue ADD COLUMN detail TEXT;
