import { h } from '../ui.ts';
import { icon } from '../icons.ts';
import type { EditorMode, ModeId } from './types.ts';

// Modi, deren Werkzeuge in späteren Phasen kommen (siehe docs/Editor-Erweiterung-Plan.md, Abschnitt 4).
// Bis dahin zeigt das Panel, was geplant ist; die linke Maustaste wählt weiter Objekte aus.

interface PlannedInfo {
  id: Exclude<ModeId, 'select'>;
  label: string;
  icon: string;
  phase: string;
  tools: string[];
}

export const PLANNED: PlannedInfo[] = [
  {
    id: 'landscape',
    label: 'Landscape',
    icon: 'mountain',
    phase: 'Phase 1 (Form) und 2 (Material)',
    tools: ['Landscape anlegen (Größe, Auflösung pro Quad)', 'Anheben/Senken, Glätten, Abflachen, Rampe, Noise', 'Erosion (hydraulisch/thermisch)', 'Löcher, Region-Tools (Kopieren, Verschieben)', 'Heightmap Import/Export (16-bit PNG/RAW)', 'Bis 8 Mal-Layer, Auto-Material, Triplanar'],
  },
  {
    id: 'modeling',
    label: 'Modeling',
    icon: 'brush',
    phase: 'Phase 5',
    tools: ['CSG-Brushes: Würfel, Zylinder, Treppe, Keil', 'Addieren, Abziehen, Schnitt', 'Material pro Fläche', 'Bake zu Mesh + Trimesh-Kollision'],
  },
  {
    id: 'splines',
    label: 'Splines',
    icon: 'spline',
    phase: 'Phase 4',
    tools: ['Punkte setzen/verschieben, Tangenten', 'Straßen/Wege (formen das Terrain)', 'Zäune, Mauern, Leitplanken (Mesh entlang Spline)', 'Kabel und Rohre (durchhängend)', 'Flüsse (mit Wasser aus Phase 6)'],
  },
  {
    id: 'water',
    label: 'Wasser',
    icon: 'water',
    phase: 'Phase 6 und 7',
    tools: ['See, Meer, Fluss (Strömung)', 'Wellen und Spritzer', 'Spieler im Wasser: Waten, Schwimmen, Tauchen', 'Schwimmende Objekte mit Auftrieb', 'Vorberechnete Fluid-Simulation (Bake)'],
  },
];

export function createPlannedMode(info: PlannedInfo): EditorMode {
  const panel = h(
    'div',
    { class: 'mode-panel-body' },
    h('div', { class: 'mode-head', html: `${icon(info.icon)}<span>${info.label}</span>` }),
    h('div', { class: 'mode-note' }, `Die Werkzeuge dieses Modus kommen in ${info.phase}. Geplant:`),
    h('ul', { class: 'mode-list' }, ...info.tools.map((t) => h('li', {}, t))),
    h('div', { class: 'mode-note dim' }, 'Umschalt+1 kehrt zum Auswahl-Modus zurück.'),
  );
  return {
    id: info.id,
    label: info.label,
    icon: info.icon,
    panel,
    allowsSelection: true,
    activate() {},
    deactivate() {},
  };
}
