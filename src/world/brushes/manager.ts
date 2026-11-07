import * as THREE from 'three';
import type { BrushJob, BrushOp, BrushPart, ClusterJob, ClusterResult, CsgRequest, CsgResponse } from './csg.ts';
import type { ShapeParams } from './shapes.ts';

// Verwaltung der Geometry-Brushes (Phase 5): sammelt alle lebenden Brushes, teilt sie in Gruppen
// sich überlappender Brushes („Cluster“) und lässt nur geänderte Cluster im Worker neu verrechnen.
// Ergebnisse werden je Cluster zwischengespeichert (Rückgängig/Wiederholen ist dadurch sofort da).
// Reihenfolge = Outliner-Reihenfolge (setBrushOrder); ohne Angabe die Reihenfolge der Registrierung.

export interface BrushState extends ShapeParams {
  op: BrushOp;
  /** aktuelle Weltmatrix des Brushes */
  matrix: THREE.Matrix4;
}

export interface LiveBrush {
  /** ID des Map-Objekts (Reihenfolge, Cluster-Abfragen) */
  readonly mapId: string;
  /** aktueller Zustand; null = nimmt (noch) nicht teil */
  state(): BrushState | null;
  /**
   * Neues Ergebnis: Dreiecke in Weltkoordinaten zum Zeitpunkt der Berechnung, `jobMatrix` = damalige Weltmatrix
   * des Brushes (Ergebnisse, die während eines Verschiebens eintreffen, wandern so mit dem Brush mit)
   */
  apply(part: BrushPart | null, jobMatrix: THREE.Matrix4): void;
}

interface Cluster {
  key: string;
  members: LiveBrush[];
  matrices: THREE.Matrix4[];
  job: ClusterJob;
}

const live = new Map<LiveBrush, number>();
let regSeq = 0;
let order = new Map<string, number>();
const cache = new Map<string, ClusterResult>();
/** zuletzt angewendetes Ergebnis je Brush (doppelte Neuaufbauten vermeiden) */
const applied = new WeakMap<LiveBrush, ClusterResult | null>();
/** Map-ID → IDs aller Brushes im selben Cluster (Stand der letzten Verrechnung) */
let clusterOf = new Map<string, string[]>();
const listeners = new Set<() => void>();

let scheduled = false;
let busy = false;
let jobSeq = 0;
let inFlight: { job: number; clusters: Map<string, Cluster> } | null = null;
let worker: Worker | null | undefined;
let lastMs = 0;

export function registerBrush(b: LiveBrush): void {
  live.set(b, regSeq++);
  markBrushesDirty();
}

export function unregisterBrush(b: LiveBrush): void {
  if (!live.delete(b)) return;
  markBrushesDirty();
}

/** Outliner-Reihenfolge (Map-Objekt-IDs); bestimmt die Reihenfolge der Verrechnung */
export function setBrushOrder(ids: string[]): void {
  const next = new Map(ids.map((id, i) => [id, i]));
  let same = next.size === order.size;
  if (same) for (const [id, i] of next) if (order.get(id) !== i) { same = false; break; }
  if (same) return;
  order = next;
  if (live.size) markBrushesDirty();
}

/** Etwas hat sich geändert (Form, Lage, Reihenfolge): nächste Verrechnung einplanen */
export function markBrushesDirty(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(run, 0);
}

/** Nach jedem Übernehmen neuer Ergebnisse (Viewport: Kollision, Auswahl-Umriss, Drahtgitter) */
export function onBrushesUpdated(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Alle Brushes, die mit den angegebenen im selben Cluster liegen (inkl. ihnen selbst) */
export function brushClusterIds(ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) for (const m of clusterOf.get(id) ?? [id]) out.add(m);
  return out;
}

/** Verrechnung läuft oder steht an */
export const brushesBusy = () => busy || scheduled;

/** Dauer der letzten Verrechnung im Worker (ms) */
export const lastBrushMs = () => lastMs;

// ---------- Cluster bilden ----------

const _box = new THREE.Box3();
const UNIT = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

function gather(): Cluster[] {
  const items: { b: LiveBrush; s: BrushState; box: THREE.Box3; sort: number }[] = [];
  for (const [b, seq] of live) {
    const s = b.state();
    if (!s) continue;
    items.push({ b, s, box: _box.copy(UNIT).applyMatrix4(s.matrix).expandByScalar(0.01).clone(), sort: order.get(b.mapId) ?? 1e9 + seq });
  }
  items.sort((a, b) => a.sort - b.sort);

  // Union-Find über überlappende Hüllen
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) if (items[i].box.intersectsBox(items[j].box)) parent[find(j)] = find(i);

  const groups = new Map<number, number[]>();
  items.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  });

  const out: Cluster[] = [];
  for (const idx of groups.values()) {
    const brushes: BrushJob[] = idx.map((i, k) => {
      const s = items[i].s;
      return { id: String(k), shape: s.shape, segments: s.segments, steps: s.steps, op: s.op, matrix: s.matrix.elements.map(r5) };
    });
    out.push({
      key: JSON.stringify(brushes),
      members: idx.map((i) => items[i].b),
      matrices: idx.map((i) => items[i].s.matrix.clone()),
      job: { key: '', brushes },
    });
    out[out.length - 1].job.key = out[out.length - 1].key;
  }
  return out;
}

// ---------- Ergebnisse übernehmen ----------

function applyCluster(c: Cluster, res: ClusterResult, force = false): boolean {
  let changed = false;
  c.members.forEach((b, i) => {
    if (!live.has(b)) return;
    if (!force && applied.get(b) === res) return;
    applied.set(b, res);
    b.apply(res.parts.find((p) => p.id === String(i)) ?? null, c.matrices[i]);
    changed = true;
  });
  return changed;
}

function emit(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
}

function run(): void {
  scheduled = false;
  // läuft schon eine Berechnung: nach deren Ende wird ohnehin neu geprüft
  if (busy) return;
  const clusters = gather();
  clusterOf = new Map();
  for (const c of clusters) {
    const ids = c.members.map((b) => b.mapId);
    for (const id of ids) clusterOf.set(id, ids);
  }

  let changed = false;
  const inCluster = new Set<LiveBrush>();
  const todo = new Map<string, Cluster>();
  for (const c of clusters) {
    for (const b of c.members) inCluster.add(b);
    const hit = cache.get(c.key);
    if (hit) {
      // nach vorn schieben (zuletzt benutzt)
      cache.delete(c.key);
      cache.set(c.key, hit);
      changed = applyCluster(c, hit) || changed;
    } else if (!c.job.brushes.some((b) => b.op === 'add')) {
      // nur Abziehen/Schnitt ohne etwas davor: kein Ergebnis
      const empty: ClusterResult = { key: c.key, parts: [], ms: 0 };
      cache.set(c.key, empty);
      changed = applyCluster(c, empty) || changed;
    } else todo.set(c.key, c);
  }
  for (const b of live.keys()) {
    if (inCluster.has(b) || applied.get(b) === null) continue;
    applied.set(b, null);
    b.apply(null, new THREE.Matrix4());
    changed = true;
  }

  // Cache begrenzen: aktuelle Cluster behalten, sonst die ältesten verwerfen
  if (cache.size > 160) {
    const keep = new Set(clusters.map((c) => c.key));
    for (const k of cache.keys()) {
      if (cache.size <= 120) break;
      if (!keep.has(k)) cache.delete(k);
    }
  }

  if (changed) emit();
  if (todo.size) send(todo);
}

function send(clusters: Map<string, Cluster>): void {
  busy = true;
  const job = ++jobSeq;
  inFlight = { job, clusters };
  const req: CsgRequest = { job, clusters: [...clusters.values()].map((c) => c.job) };
  const w = getWorker();
  if (w) w.postMessage(req);
  else
    void import('./csg.ts')
      .then((m) => receive({ job, clusters: req.clusters.map(m.evaluateCluster) }))
      .catch((e) => fail(String(e)));
}

function receive(res: CsgResponse): void {
  if (!inFlight || res.job !== inFlight.job) return;
  const sent = inFlight.clusters;
  inFlight = null;
  busy = false;
  let changed = false;
  let ms = 0;
  for (const r of res.clusters) {
    ms += r.ms;
    if (r.error) console.warn(`CSG-Fehler: ${r.error}`);
    cache.set(r.key, r);
    const c = sent.get(r.key);
    // auch veraltete Ergebnisse übernehmen (Vorschau beim Ziehen); die nächste Runde rechnet nach
    if (c) changed = applyCluster(c, r, true) || changed;
  }
  lastMs = ms;
  if (changed) emit();
  // nächste Runde: Geändertes nachrechnen, sonst passt alles aus dem Cache
  markBrushesDirty();
}

function fail(msg: string): void {
  console.error(`CSG-Worker: ${msg}`);
  const sent = inFlight?.clusters;
  inFlight = null;
  busy = false;
  if (sent)
    for (const c of sent.values()) {
      const empty: ClusterResult = { key: c.key, parts: [], ms: 0, error: msg };
      applyCluster(c, empty, true);
    }
  emit();
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./csg.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<CsgResponse>) => receive(e.data);
    worker.onerror = (e) => {
      e.preventDefault();
      worker?.terminate();
      worker = null; // ab jetzt im Hauptthread
      const sent = inFlight;
      if (sent) {
        inFlight = null;
        busy = false;
        send(sent.clusters);
      }
    };
  } catch {
    worker = null;
  }
  return worker;
}
