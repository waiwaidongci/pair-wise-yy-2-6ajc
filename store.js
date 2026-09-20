import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const defaultDbPath = join(__dirname, "data", "pigeons.json");

export const seed = {
  pigeons: [
    {
      ringNo: "CHN-2026-001",
      owner: "北岸棚",
      fatherRing: "CHN-2022-188",
      motherRing: "CHN-2023-512",
      color: "灰",
      loft: "北岸A棚",
      bloodlineConfirmed: true,
      bloodlineConfirmedBy: "裁判甲",
      vaccines: [{ date: "2026-04-01", name: "新城疫" }],
      transfers: [{ date: "2026-04-15", from: "育种棚", to: "北岸棚" }],
      races: [{ date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 }],
      medications: []
    },
    { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", bloodlineConfirmed: false, vaccines: [], transfers: [], races: [], medications: [] },
    { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", bloodlineConfirmed: false, vaccines: [], transfers: [], races: [], medications: [] }
  ],
  events: [
    { id: "evt-1", name: "秋季300公里联赛", date: "2026-10-18", distance: 300, quota: 2, finalized: false }
  ],
  registrations: [],
  seq: { event: 2, registration: 1, medication: 1 }
};

function migrate(db) {
  db.pigeons ??= [];
  db.events ??= JSON.parse(JSON.stringify(seed.events));
  db.registrations ??= [];
  db.seq ??= { event: db.events.length + 1, registration: 1, medication: 1 };
  db.seq.event ??= db.events.length + 1;
  db.seq.registration ??= 1;
  db.seq.medication ??= 1;
  for (const pigeon of db.pigeons) {
    pigeon.vaccines ??= [];
    pigeon.transfers ??= [];
    pigeon.races ??= [];
    pigeon.medications ??= [];
    if (pigeon.bloodlineConfirmed === undefined) {
      const parentsKnown =
        Boolean(pigeon.fatherRing) &&
        Boolean(pigeon.motherRing) &&
        db.pigeons.some(item => item.ringNo === pigeon.fatherRing) &&
        db.pigeons.some(item => item.ringNo === pigeon.motherRing);
      pigeon.bloodlineConfirmed = parentsKnown;
      if (parentsKnown) pigeon.bloodlineConfirmedBy = pigeon.bloodlineConfirmedBy || "系统补认";
    }
  }
  return db;
}

export function createStore(dbPath = defaultDbPath) {
  let queue = Promise.resolve();

  async function load() {
    if (!existsSync(dbPath)) {
      await mkdir(dirname(dbPath), { recursive: true });
      await writeFile(dbPath, JSON.stringify(seed, null, 2));
    }
    return migrate(JSON.parse(await readFile(dbPath, "utf8")));
  }

  async function save(db) {
    const tmp = `${dbPath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, dbPath);
  }

  return {
    dbPath,
    read: load,
    // 所有写操作串行执行：读-改-写在同一临界区内，并发报名不会产生重复记录。
    mutate(fn) {
      const result = queue.then(async () => {
        const db = await load();
        const output = await fn(db);
        await save(db);
        return output;
      });
      queue = result.then(() => {}, () => {});
      return result;
    },
    nextId(db, kind, prefix) {
      const n = db.seq[kind]++;
      return `${prefix}-${n}`;
    }
  };
}
