import { h, numberField } from '../ui.ts';
import type { EditorMode, ModeContext } from './types.ts';
import { createSplinesMode, type SplineModeConfig } from './splines.ts';
import { SPLINE_TYPES } from '../../world/splines/asset.ts';
import { LAKE_TYPE, OCEAN_TYPE, RIVER_TYPE, SOURCE_TYPE, WATER_PRESETS, WATER_TYPES, waterMinPoints } from '../../world/water/asset.ts';
import { sourceStateNote } from '../../world/water/source.ts';

// Wasser-Modus (Phase 6, wie UE5 Water Body Lake/River/Ocean) — nutzt das Spline-Werkzeug:
//  - See/Teich: Umriss klicken (geschlossen, flach); Wasserspiegel = tiefster geklickter Uferpunkt, danach im Panel
//  - Fluss/Bach: Mittellinie klicken (Höhe je Punkt = Wasserspiegel); gräbt sein Bett ins Gelände, Breite je Punkt
//  - Meer: ein Klick setzt die unendliche Fläche (eins pro Map), Höhe im Panel
//  - Wasserquelle: ein Klick setzt die Quelle; „Simulation berechnen“ lässt das Wasser (Flachwasser-Simulation)
//    über das Gelände laufen — es bildet selbst Bäche, füllt Mulden zu Seen und fließt am Gebietsrand ab

const row = (label: string, ...el: (Node | string)[]) => h('div', { class: 'prop-row' }, h('label', { title: label }, label), h('div', { class: 'value' }, ...el));

export const WATER_CONFIG: SplineModeConfig = {
  id: 'water',
  label: 'Wasser',
  icon: 'water',
  types: WATER_TYPES,
  presets: WATER_PRESETS,
  skip: new Set([...SPLINE_TYPES, ...WATER_TYPES]),
  minPoints: waterMinPoints,
  closed: (o) => o.type === LAKE_TYPE,
  flat: (t) => t === LAKE_TYPE,
  pointWidth: (t) => t === RIVER_TYPE,
  pointRoll: () => false,
  relevant: (_o, p) => !p.hidden,
  placedNote: (t) => (t === SOURCE_TYPE ? 'Gebiet einstellen, dann „Simulation berechnen“' : 'Höhe im Panel einstellen'),
  objectRows(o, set) {
    if (o.type === SOURCE_TYPE) return [h('div', { class: 'mode-note dim' }, sourceStateNote(o))];
    // See/Meer: Wasserspiegel = Objekthöhe; Fluss: verschiebt alle Punkte
    const label = o.type === RIVER_TYPE ? 'Höhe (alle Punkte)' : 'Wasserspiegel (m)';
    return [
      row(
        label,
        numberField({
          value: Math.round(o.pos[1] * 100) / 100,
          step: 0.05,
          onChange: (v, live) => set(() => (o.pos[1] = v), !live),
        }),
      ),
      o.type === OCEAN_TYPE && h('div', { class: 'mode-note dim' }, 'Das Meer füllt alles unterhalb des Spiegels. Für Küsten den unendlichen Boden (Welt) ausschalten oder tiefer legen.'),
    ];
  },
  drawNote: 'See: Umriss klicken. Fluss: Mittellinie in Fließrichtung klicken. Quelle/Meer: ein Klick. Enter oder Esc beendet.',
  emptyNote: 'Wasserfläche im Viewport anklicken (Umriss/Linie) oder oben eine neue anlegen. Eine Wasserquelle simuliert echtes, fließendes Wasser.',
  help: [
    'Punkt ziehen: verschieben (folgt dem Gelände)',
    'Umschalt + Ziehen: Höhe eines Fluss-Punkts ändern',
    'Klick auf die Linie: Punkt einfügen · Strg + Klick: anhängen',
    'Entf: Punkt löschen · Esc: Punkt abwählen',
    'Fluss fließt in Zeichenrichtung („Umkehren“ dreht die Strömung)',
    'Fluss gräbt sein Bett (Tiefe/Ufer unter „Fluss“)',
    'Wasserquelle: „Simulation berechnen“ rechnet den Wasserlauf vor (wird mit der Map gespeichert); am Gebietsrand fließt das Wasser ab',
    'Wasserquelle „Live“: läuft bei Simulieren (Alt+S) und im Spiel weiter',
  ],
};

export function createWaterMode(ctx: ModeContext): EditorMode {
  return createSplinesMode(ctx, WATER_CONFIG);
}
