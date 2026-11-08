import { h, toast } from './ui.ts';
import { icon } from './icons.ts';
import type { EditorState } from './state.ts';
import type { Viewport } from './viewport.ts';
import type { PropDef } from '../world/assets.ts';
import type { MapObjectData } from '../world/mapFormat.ts';

// Knopf-Eigenschaften (PropType 'action', z. B. „Simulation berechnen“ der Wasserquelle) für Details-Panel und
// Modus-Panels. Ruft AssetInstance.action() auf, zeigt den Fortschritt am Knopf und übernimmt die gelieferten
// Eigenschaften als Undo-Schritt. Laufende Aufträge überleben das Neuzeichnen der Panels.

interface Host {
  state: EditorState;
  viewport: Viewport;
  status(msg: string, error?: boolean): void;
}

interface Job {
  f: number;
  text: string;
  running: boolean;
  views: Set<View>;
}

interface View {
  el: HTMLElement;
  paint(): void;
}

let host: Host | null = null;
const jobs = new Map<string, Job>();

export function setActionHost(h: Host): void {
  host = h;
}

const ICONS: Record<string, string> = { bake: 'play', clear: 'trash' };

export function actionButton(o: MapObjectData, p: PropDef): HTMLElement {
  const id = `${o.id}|${p.key}`;
  const btn = h('button', { class: `btn action${p.key === 'clear' ? ' danger' : ' primary'}` }) as HTMLButtonElement;
  const bar = h('i');
  const meter = h('div', { class: 'action-meter' }, bar);
  const note = h('div', { class: 'action-note dim' });
  const wrap = h('div', { class: 'action-row' }, btn, meter, note);
  const paint = () => {
    const j = jobs.get(id);
    const run = !!j?.running;
    btn.innerHTML = `${icon(ICONS[p.key] ?? 'play')}${run ? `${p.label} … ${Math.round((j?.f ?? 0) * 100)} %` : p.label}`;
    btn.disabled = run;
    meter.style.display = run ? 'block' : 'none';
    bar.style.width = `${Math.round((j?.f ?? 0) * 100)}%`;
    note.textContent = j?.text ?? '';
    note.style.display = j?.text ? 'block' : 'none';
  };
  const view: View = { el: wrap, paint };
  const job = jobs.get(id);
  if (job) {
    // Ansichten verworfener Panels (nicht mehr im DOM) entfernen
    for (const v of [...job.views]) if (!v.el.isConnected) job.views.delete(v);
    job.views.add(view);
  }
  paint();
  btn.addEventListener('click', () => void run(o.id, p, view));
  return wrap;
}

async function run(objId: string, p: PropDef, view: View): Promise<void> {
  if (!host) return;
  const { state, viewport, status } = host;
  const inst = viewport.nodeById(objId)?.instance;
  if (!inst?.action) {
    toast('Objekt ist noch nicht bereit', 'error');
    return;
  }
  const id = `${objId}|${p.key}`;
  if (jobs.get(id)?.running) return;
  const job: Job = { f: 0, text: '', running: true, views: new Set([view]) };
  jobs.set(id, job);
  const notify = () => {
    for (const v of job.views) v.paint();
  };
  notify();
  try {
    const res = await inst.action(p.key, (f, text) => {
      job.f = Math.max(0, Math.min(1, f));
      if (text) job.text = text;
      notify();
      if (text) status(`${p.label}: ${text}`);
    });
    job.running = false;
    notify();
    if (res && Object.keys(res).length) {
      const o = state.get(objId);
      if (o) state.update(() => Object.assign(o.props, res));
    }
    if (job.text) status(job.text);
  } catch (e) {
    job.running = false;
    job.text = (e as Error).message;
    notify();
    toast((e as Error).message, 'error');
  }
}
