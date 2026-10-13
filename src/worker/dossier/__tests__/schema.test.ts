/**
 * La migrazione del fascicolo esercitata contro un motore SQLite reale.
 *
 * I vincoli di questo schema non sono documentazione: sono il livello più basso
 * a cui le invarianti del programma vengono imposte, sotto la funzione di
 * ammissione. Se `fact_live` o `activation_op_key` smettessero di mordere, il
 * resto del sistema non lo noterebbe fino alla produzione.
 *
 * Usa `node:sqlite` (Node 22): D1 è SQLite, quindi i vincoli qui provati sono
 * gli stessi che agiranno in produzione. Resta da verificare su D1 vero in
 * Tranche 2 — vedi docs/vinoveritas/STATO.md
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
	join(here, "..", "..", "..", "..", "migrations", "0001_fascicolo.sql"),
	"utf8",
);

let db: DatabaseSync;

beforeEach(() => {
	db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec(MIGRATION);
	db.exec(
		`INSERT INTO cantina (id,nome,lingua_origine,created_at) VALUES ('c1','Cantina Uno','it',0)`,
	);
});

/** Un fatto sull'annata 2021, parametrico su stato e approvatore. */
function insertFact(id: string, state: string, approver: string | null = null) {
	const approved = approver === null ? "NULL, NULL" : `1, '${approver}'`;
	db.exec(
		`INSERT INTO fact (id,cantina_id,scope_type,scope_ref,key,value_json,state,
		                   visibility,version,agent,prompt_version,created_at,
		                   approved_at,approved_by)
		 VALUES ('${id}','c1','annata','w1:2021','gradazione_alcolica','{}','${state}',
		         'pubblico',1,'specialista','specialista@1',0,${approved})`,
	);
}

describe("schema del fascicolo", () => {
	test("la migrazione si applica e crea le tabelle attese", () => {
		const rows = db
			.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
			.all() as { name: string }[];
		const names = rows.map((r) => r.name);
		for (const expected of [
			"fact",
			"fact_source",
			"fact_edge",
			"activation_op",
			"activation_op_fact",
			"agent_run",
			"admission_rejection",
			"issue",
			"question",
			"answer",
			"translation",
			"gate_evaluation",
		]) {
			assert.ok(names.includes(expected), `tabella ${expected} assente`);
		}
	});
});

describe("un solo fatto vivo per chiave", () => {
	test("un secondo fatto vivo sulla stessa chiave è respinto", () => {
		insertFact("f1", "approvato", "orchestratore");
		assert.throws(() => insertFact("f2", "proposto"));
	});

	test("le versioni superate non occupano l'indice", () => {
		insertFact("f1", "approvato", "orchestratore");
		db.exec(`UPDATE fact SET state='superato' WHERE id='f1'`);
		assert.doesNotThrow(() => insertFact("f2", "proposto"));
	});

	test("la stessa chiave in un'altra annata è ammessa", () => {
		insertFact("f1", "approvato", "orchestratore");
		assert.doesNotThrow(() =>
			db.exec(
				`INSERT INTO fact (id,cantina_id,scope_type,scope_ref,key,value_json,state,
				                   visibility,version,agent,prompt_version,created_at)
				 VALUES ('f2','c1','annata','w1:2022','gradazione_alcolica','{}','proposto',
				         'pubblico',1,'s','s@1',0)`,
			),
		);
	});
});

describe("vincoli sui fatti", () => {
	test("un fatto approvato porta sempre chi e quando", () => {
		assert.throws(() => insertFact("f1", "approvato"));
		assert.doesNotThrow(() => insertFact("f2", "approvato", "orchestratore"));
	});

	test("uno stato fuori dall'insieme è respinto", () => {
		assert.throws(() => insertFact("f1", "quasi_approvato"));
	});

	test("una visibilità fuori dall'insieme è respinta", () => {
		assert.throws(() =>
			db.exec(
				`INSERT INTO fact (id,cantina_id,scope_type,scope_ref,key,value_json,state,
				                   visibility,version,agent,prompt_version,created_at)
				 VALUES ('f1','c1','vino','w1','k','{}','proposto','semi_pubblico',1,'s','s@1',0)`,
			),
		);
	});

	test("un fatto su una cantina inesistente è respinto", () => {
		assert.throws(() =>
			db.exec(
				`INSERT INTO fact (id,cantina_id,scope_type,scope_ref,key,value_json,state,
				                   visibility,version,agent,prompt_version,created_at)
				 VALUES ('fx','ignota','vino','w9','k','{}','proposto','pubblico',1,'s','s@1',0)`,
			),
		);
	});
});

describe("provenienza", () => {
	beforeEach(() => {
		insertFact("f1", "proposto");
		db.exec(
			`INSERT INTO source_document (id,cantina_id,sha256,r2_key,mime,stato,uploaded_by,uploaded_at)
			 VALUES ('d1','c1','abc','k1','application/pdf','estratto','u',0)`,
		);
	});

	test("una provenienza documentale senza pagina non è tornabile alla fonte", () => {
		assert.throws(() =>
			db.exec(
				`INSERT INTO fact_source (id,fact_id,kind,document_id) VALUES ('s1','f1','documento','d1')`,
			),
		);
	});

	test("con pagina è ammessa", () => {
		assert.doesNotThrow(() =>
			db.exec(
				`INSERT INTO fact_source (id,fact_id,kind,document_id,page) VALUES ('s1','f1','documento','d1',3)`,
			),
		);
	});

	test("un tipo di provenienza inventato è respinto", () => {
		assert.throws(() =>
			db.exec(`INSERT INTO fact_source (id,fact_id,kind) VALUES ('s1','f1','sentito_dire')`),
		);
	});
});

describe("deduplica dei documenti", () => {
	const insert = (id: string, cantina: string, sha: string) =>
		db.exec(
			`INSERT INTO source_document (id,cantina_id,sha256,r2_key,mime,stato,uploaded_by,uploaded_at)
			 VALUES ('${id}','${cantina}','${sha}','k_${id}','application/pdf','caricato','u',0)`,
		);

	test("lo stesso contenuto caricato due volte non genera due fonti", () => {
		insert("d1", "c1", "abc");
		assert.throws(() => insert("d2", "c1", "abc"));
	});

	test("la stessa impronta in un'altra cantina è ammessa", () => {
		insert("d1", "c1", "abc");
		db.exec(`INSERT INTO cantina (id,nome,lingua_origine,created_at) VALUES ('c2','Due','it',0)`);
		assert.doesNotThrow(() => insert("d2", "c2", "abc"));
	});
});

describe("idempotenza dell'attivazione", () => {
	const insert = (id: string, key: string) =>
		db.exec(
			`INSERT INTO activation_op (id,cantina_id,target,operation_key,payload_hash,state,created_at)
			 VALUES ('${id}','c1','referenza','${key}','h','preparato',0)`,
		);

	test("la stessa chiave d'operazione è respinta: ritentare non duplica", () => {
		insert("o1", "K");
		assert.throws(() => insert("o2", "K"));
	});

	test("una chiave diversa, dopo un cambio di versione, è ammessa", () => {
		insert("o1", "K");
		assert.doesNotThrow(() => insert("o2", "K2"));
	});

	test("uno stato di attivazione fuori dai quattro più fallito è respinto", () => {
		assert.throws(() =>
			db.exec(
				`INSERT INTO activation_op (id,cantina_id,target,operation_key,payload_hash,state,created_at)
				 VALUES ('o9','c1','referenza','K9','h','quasi_pubblicato',0)`,
			),
		);
	});
});

describe("domande e anomalie", () => {
	test("una domanda con la stessa chiave semantica non si emette due volte", () => {
		const insert = (id: string, key: string, state: string) =>
			db.exec(
				`INSERT INTO question (id,cantina_id,issue_ids_json,topic,audience,lang,body,semantic_key,state,created_at)
				 VALUES ('${id}','c1','[]','gradazione','enologo','it','?','${key}','${state}',0)`,
			);
		insert("q1", "SK", "inviata");
		assert.throws(() => insert("q2", "SK", "bozza"));
		assert.doesNotThrow(() => insert("q3", "SK2", "bozza"));
	});

	test("il limite di due cicli è imposto dallo schema", () => {
		const insert = (id: string, cycle: number) =>
			db.exec(
				`INSERT INTO issue (id,cantina_id,severity,code,scope_type,scope_ref,evidence_json,targets_json,state,cycle,created_at)
				 VALUES ('${id}','c1','bloccante','X','vino','w1','[]','[]','aperta',${cycle},0)`,
			);
		assert.doesNotThrow(() => insert("i1", 1));
		assert.doesNotThrow(() => insert("i2", 2));
		assert.throws(() => insert("i3", 3));
	});

	test("una gravità fuori dalle quattro categorie è respinta", () => {
		assert.throws(() =>
			db.exec(
				`INSERT INTO issue (id,cantina_id,severity,code,scope_type,scope_ref,evidence_json,targets_json,state,cycle,created_at)
				 VALUES ('i9','c1','grave_ma_non_troppo','X','vino','w1','[]','[]','aperta',1,0)`,
			),
		);
	});

	test("un tipo di risposta inventato è respinto; 'non_disponibile' è ammesso", () => {
		db.exec(
			`INSERT INTO question (id,cantina_id,issue_ids_json,topic,audience,lang,body,semantic_key,state,created_at)
			 VALUES ('q1','c1','[]','t','enologo','it','?','SK','inviata',0)`,
		);
		assert.throws(() =>
			db.exec(
				`INSERT INTO answer (id,question_id,kind,respondent,received_at) VALUES ('a1','q1','forse','u',0)`,
			),
		);
		assert.doesNotThrow(() =>
			db.exec(
				`INSERT INTO answer (id,question_id,kind,respondent,received_at) VALUES ('a2','q1','non_disponibile','u',0)`,
			),
		);
	});
});

describe("traduzioni", () => {
	beforeEach(() => insertFact("f1", "approvato", "orchestratore"));

	test("una sola traduzione per fatto e lingua", () => {
		const insert = (id: string, lang: string) =>
			db.exec(
				`INSERT INTO translation (id,cantina_id,fact_id,lang,text,source_version,state)
				 VALUES ('${id}','c1','f1','${lang}','t',1,'fresca')`,
			);
		insert("t1", "en");
		assert.throws(() => insert("t2", "en"));
		assert.doesNotThrow(() => insert("t3", "de"));
	});

	test("uno stato di traduzione inventato è respinto", () => {
		assert.throws(() =>
			db.exec(
				`INSERT INTO translation (id,cantina_id,fact_id,lang,text,source_version,state)
				 VALUES ('t9','c1','f1','en','t',1,'quasi_fresca')`,
			),
		);
	});
});
