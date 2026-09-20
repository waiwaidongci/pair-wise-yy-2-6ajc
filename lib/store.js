import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.PIGEON_DB || join(__dirname, "..", "data", "pigeons.json");

const seed = {
  counters: { event: 1, entry: 0 },
  pigeons: [
    {
      ringNo: "CHN-2026-001", owner: "北岸棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚",
      vaccines: [{ date: "2026-04-01", name: "新城疫" }],
      transfers: [{ date: "2026-04-15", from: "育种棚", to: "北岸棚" }],
      races: [{ date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 }],
      medications: [{ date: "2026-09-10", name: "呼吸道合剂", withdrawalDays: 30, recordedBy: "兽医小李", lift: null }],
      pedigree: { status: "confirmed", confirmedBy: "登记员王姐", confirmedAt: "2026-04-20", version: 1 },
      version: 1
    },
    { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], races: [], medications: [], pedigree: { status: "unconfirmed", confirmedBy: null, confirmedAt: null, version: 0 }, version: 1 },
    { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", vaccines: [], transfers: [], races: [], medications: [], pedigree: { status: "unconfirmed", confirmedBy: null, confirmedAt: null, version: 0 }, version: 1 }
  ],
  events: [
    { id: "EVT-1", name: "300公里资格赛", date: "2026-10-05", capacity: 2, version: 1, createdAt: "2026-09-20" }
  ],
  entries: []
};

function normalize(db) {
  db.counters = db.counters || { event: 0, entry: 0 };
  db.events = db.events || [];
  db.entries = db.entries || [];
  for (const p of db.pigeons || []) {
    p.vaccines = p.vaccines || [];
    p.transfers = p.transfers || [];
    p.races = p.races || [];
    p.medications = p.medications || [];
    p.pedigree = p.pedigree || { status: "unconfirmed", confirmedBy: null, confirmedAt: null, version: 0 };
    p.version = p.version || 1;
  }
  for (const e of db.events) {
    e.capacity = e.capacity || 1;
    e.version = e.version || 1;
  }
  return db;
}

let cache = null;
let queue = Promise.resolve();

async function loadFromDisk() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
    return structuredClone(seed);
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}

export async function readDb() {
  if (!cache) cache = normalize(await loadFromDisk());
  return cache;
}

async function persist(db) {
  await mkdir(dirname(dbPath), { recursive: true });
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

// 所有写操作串行执行：同一羽同一赛事的并发报名只会留下首次结果。
// 事务抛错时丢弃内存缓存，避免半提交状态。
export function transact(fn) {
  const result = queue.then(async () => {
    const db = await readDb();
    let out;
    try {
      out = await fn(db);
    } catch (error) {
      cache = null;
      throw error;
    }
    await persist(db);
    return out;
  });
  queue = result.catch(() => {});
  return result;
}
