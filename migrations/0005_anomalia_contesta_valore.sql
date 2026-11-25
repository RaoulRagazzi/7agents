-- L'anomalia dichiara se contesta il valore presente (Tranche 4).
--
-- La verifica preliminare dell'Ambasciatore salta la domanda quando il dato è
-- già approvato nel fascicolo. È giusto per un dato mancante e rovesciato per
-- un dato contestato: una gradazione di 125 %vol *è* approvata, ed è
-- esattamente ciò di cui va chiesto conto.
--
-- Il campo deve sopravvivere al giro nel database, perché l'Ambasciatore
-- rilegge le anomalie da qui e non le riceve in memoria dalla Sentinella.
--
-- Il valore di difetto è 0 — «segnala un'assenza» — perché è il comportamento
-- precedente: una riga scritta prima di questa migrazione non diventa
-- improvvisamente una contestazione.

ALTER TABLE issue ADD COLUMN contesta_valore INTEGER NOT NULL DEFAULT 0;
