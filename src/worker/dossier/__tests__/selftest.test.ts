import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runSelfTest } from "../selftest.ts";
import { SqliteDatabase } from "./sqlite-adapter.ts";

describe("verifica d'integrazione su node:sqlite", () => {
	test("tutti i controlli passano", async () => {
		const report = await runSelfTest(new SqliteDatabase(), {
			engine: "node:sqlite",
			runId: "t1",
			currentYear: 2026,
		});

		const falliti = report.checks.filter((c) => !c.ok);
		assert.deepEqual(
			falliti.map((c) => `${c.name}: ${c.detail ?? ""}`),
			[],
			`${report.failed}/${report.total} falliti`,
		);
		assert.ok(report.total >= 12, `troppi pochi controlli: ${report.total}`);
	});

	test("due esecuzioni nello stesso database non collidono", async () => {
		// gli identificativi sono intitolati al runId: la suite deve poter
		// girare più volte sullo stesso D1, che è persistente
		const db = new SqliteDatabase();
		const a = await runSelfTest(db, { engine: "x", runId: "a", currentYear: 2026 });
		const b = await runSelfTest(db, { engine: "x", runId: "b", currentYear: 2026 });
		assert.equal(a.failed, 0, JSON.stringify(a.checks.filter((c) => !c.ok)));
		assert.equal(b.failed, 0, JSON.stringify(b.checks.filter((c) => !c.ok)));
	});
});
