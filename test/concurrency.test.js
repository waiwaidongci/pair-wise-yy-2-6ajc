import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("并发报名只保留首次结果", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pigeon-db-"));
  process.env.PIGEON_DB = join(dir, "db.json");
  const store = await import("../lib/store.js");
  const entries = await import("../lib/entries.js");
  const [a, b] = await Promise.all([
    store.transact(db => entries.enterRace(db, "EVT-1", { ringNo: "CHN-2022-188", owner: "育种棚" })),
    store.transact(db => entries.enterRace(db, "EVT-1", { ringNo: "CHN-2022-188", owner: "育种棚" }))
  ]);
  assert.equal(a.entry.id, b.entry.id);
  assert.equal(a.deduped, false);
  assert.equal(b.deduped, true);
  const db = await store.readDb();
  assert.equal(db.entries.length, 1);
});
