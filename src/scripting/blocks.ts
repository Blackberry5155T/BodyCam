import * as Blockly from 'blockly';
import { javascriptGenerator, Order } from 'blockly/javascript';
import * as De from 'blockly/msg/de';
import { registerFieldColour, colourPicker } from '@blockly/field-colour';

// Scratch-ähnliche Blöcke für Map-Objekte (nur im Editor geladen).
// Jeder Ereignis-Block ("Wenn ...") wird zu  api.on('<event>', async () => { ... }, <arg>);
// Die Runtime (runtime.ts) stellt die api-Funktionen bereit.

export const CATEGORY_COLOURS = {
  events: '#FFBF00',
  motion: '#4C97FF',
  looks: '#9966FF',
  light: '#E6A700',
  control: '#FFAB19',
  sensing: '#5CB1D6',
  operators: '#59C059',
  variables: '#FF8C1A',
  world: '#FF6680',
};

const KEY_OPTIONS: [string, string][] = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => [c, `Key${c}`] as [string, string]),
  ...'0123456789'.split('').map((c) => [c, `Digit${c}`] as [string, string]),
  ['Leertaste', 'Space'],
  ['Pfeil hoch', 'ArrowUp'],
  ['Pfeil runter', 'ArrowDown'],
  ['Pfeil links', 'ArrowLeft'],
  ['Pfeil rechts', 'ArrowRight'],
  ['Enter', 'Enter'],
  ['Shift', 'ShiftLeft'],
  ['Strg', 'ControlLeft'],
];
const AXIS: [string, string][] = [
  ['x', 'x'],
  ['y', 'y'],
  ['z', 'z'],
];
const ON_OFF: [string, string][] = [
  ['an', 'true'],
  ['aus', 'false'],
];

type Json = Record<string, unknown>;
const num = (name: string): Json => ({ type: 'input_value', name, check: 'Number' });
const bool = (name: string): Json => ({ type: 'input_value', name, check: 'Boolean' });
const any = (name: string): Json => ({ type: 'input_value', name });
const colour = (name: string, value = '#ff4040'): Json => ({ type: 'field_colour', name, colour: value });

const hat = (type: string, message: string, args: Json[], tooltip: string): Json => ({
  type,
  message0: message,
  args0: args,
  nextStatement: null,
  colour: CATEGORY_COLOURS.events,
  tooltip,
});
const stmt = (type: string, colourKey: keyof typeof CATEGORY_COLOURS, message: string, args: Json[] = [], tooltip = ''): Json => ({
  type,
  message0: message,
  args0: args,
  previousStatement: null,
  nextStatement: null,
  colour: CATEGORY_COLOURS[colourKey],
  tooltip,
  inputsInline: true,
});
const reporter = (type: string, colourKey: keyof typeof CATEGORY_COLOURS, message: string, args: Json[] = [], output = 'Number', tooltip = ''): Json => ({
  type,
  message0: message,
  args0: args,
  output,
  colour: CATEGORY_COLOURS[colourKey],
  tooltip,
  inputsInline: true,
});

const BLOCKS: Json[] = [
  // Ereignisse
  hat('bc_when_start', 'Wenn das Spiel startet', [], 'Läuft einmal beim Start der Map.'),
  hat('bc_when_tick', 'Jeden Frame', [], 'Läuft in jedem Frame (wartet, bis der vorige Durchlauf fertig ist).'),
  hat('bc_when_interact', 'Wenn Spieler mich benutzt, Hinweis %1', [{ type: 'field_input', name: 'TEXT', text: 'Benutzen' }], 'Spieler schaut das Objekt an und drückt die Benutzen-Taste (E). Der Hinweis erscheint am Bildschirm.'),
  hat('bc_when_hit', 'Wenn ich getroffen werde', [], 'Ein Schuss trifft dieses Objekt.'),
  hat('bc_when_enter', 'Wenn Spieler meinen Bereich betritt', [], 'Spieler betritt das Objekt (ideal mit Trigger-Volumen).'),
  hat('bc_when_leave', 'Wenn Spieler meinen Bereich verlässt', [], 'Spieler verlässt das Objekt (ideal mit Trigger-Volumen).'),
  hat('bc_when_near', 'Wenn Spieler näher als %1 m kommt', [{ type: 'field_number', name: 'DIST', value: 3, min: 0 }], 'Löst einmal aus, wenn der Spieler die Entfernung unterschreitet.'),
  hat('bc_when_key', 'Wenn Taste %1 gedrückt wird', [{ type: 'field_dropdown', name: 'KEY', options: KEY_OPTIONS }], ''),
  hat('bc_when_message', 'Wenn ich Nachricht %1 empfange', [{ type: 'field_input', name: 'MSG', text: 'Nachricht1' }], 'Reagiert auf "sende Nachricht" von beliebigen Objekten.'),
  stmt('bc_broadcast', 'events', 'sende Nachricht %1', [{ type: 'field_input', name: 'MSG', text: 'Nachricht1' }], 'Alle Objekte mit "Wenn ich Nachricht empfange" reagieren.'),

  // Bewegung
  stmt('bc_move_by', 'motion', 'ändere Position um x %1 y %2 z %3', [num('X'), num('Y'), num('Z')]),
  stmt('bc_move_to', 'motion', 'gehe zu x %1 y %2 z %3', [num('X'), num('Y'), num('Z')]),
  stmt('bc_move_forward', 'motion', 'gehe %1 m vorwärts', [num('D')], 'In Blickrichtung des Objekts (lokal -Z).'),
  stmt('bc_glide_by', 'motion', 'gleite in %1 Sek. um x %2 y %3 z %4', [num('S'), num('X'), num('Y'), num('Z')], 'Bewegt sich weich und wartet, bis es angekommen ist.'),
  stmt('bc_glide_to', 'motion', 'gleite in %1 Sek. zu x %2 y %3 z %4', [num('S'), num('X'), num('Y'), num('Z')]),
  stmt('bc_rotate_by', 'motion', 'drehe um x %1° y %2° z %3°', [num('X'), num('Y'), num('Z')]),
  stmt('bc_turn_by', 'motion', 'drehe in %1 Sek. um x %2° y %3° z %4°', [num('S'), num('X'), num('Y'), num('Z')], 'Weiche Drehung, z. B. für Türen.'),
  stmt('bc_set_rotation', 'motion', 'setze Drehung auf x %1° y %2° z %3°', [num('X'), num('Y'), num('Z')]),
  stmt('bc_set_scale', 'motion', 'setze Größe auf x %1 y %2 z %3', [num('X'), num('Y'), num('Z')]),
  reporter('bc_pos', 'motion', 'Position %1', [{ type: 'field_dropdown', name: 'AXIS', options: AXIS }]),
  reporter('bc_rot', 'motion', 'Drehung %1', [{ type: 'field_dropdown', name: 'AXIS', options: AXIS }]),

  // Aussehen
  stmt('bc_show', 'looks', 'zeige dich'),
  stmt('bc_hide', 'looks', 'verstecke dich', [], 'Nur unsichtbar — Kollision bleibt (siehe "setze Kollision").'),
  stmt('bc_set_color', 'looks', 'setze Farbe auf %1', [colour('C', '#ff4040')]),
  stmt('bc_set_glow', 'looks', 'leuchte in %1 mit Stärke %2', [colour('C', '#3fc4ff'), num('V')]),
  stmt('bc_collision', 'looks', 'setze Kollision %1', [{ type: 'field_dropdown', name: 'ON', options: ON_OFF }]),

  // Licht
  stmt('bc_light_set', 'light', 'Licht %1', [{ type: 'field_dropdown', name: 'MODE', options: [['einschalten', 'on'], ['ausschalten', 'off'], ['umschalten', 'toggle']] }], 'Nur für Licht-Objekte.'),
  stmt('bc_light_intensity', 'light', 'setze Lichtintensität auf %1', [num('V')]),
  stmt('bc_light_change', 'light', 'ändere Lichtintensität um %1', [num('V')]),
  stmt('bc_light_color', 'light', 'setze Lichtfarbe auf %1', [colour('C', '#ffd8a0')]),
  stmt('bc_light_flicker', 'light', 'setze Flackern %1', [{ type: 'field_dropdown', name: 'ON', options: ON_OFF }]),
  reporter('bc_light_is_on', 'light', 'Licht ist an?', [], 'Boolean'),

  // Steuerung
  stmt('bc_wait', 'control', 'warte %1 Sek.', [num('S')]),
  {
    type: 'bc_forever',
    message0: 'wiederhole fortlaufend %1 %2',
    args0: [{ type: 'input_dummy' }, { type: 'input_statement', name: 'DO' }],
    previousStatement: null,
    colour: CATEGORY_COLOURS.control,
  },
  stmt('bc_wait_until', 'control', 'warte bis %1', [bool('COND')]),
  { ...stmt('bc_stop', 'control', 'stoppe dieses Script'), nextStatement: undefined },

  // Fühlen
  reporter('bc_distance', 'sensing', 'Entfernung zum Spieler'),
  reporter('bc_player_pos', 'sensing', 'Spieler-Position %1', [{ type: 'field_dropdown', name: 'AXIS', options: AXIS }]),
  reporter('bc_player_inside', 'sensing', 'Spieler in meinem Bereich?', [], 'Boolean'),
  reporter('bc_key_down', 'sensing', 'Taste %1 gedrückt?', [{ type: 'field_dropdown', name: 'KEY', options: KEY_OPTIONS }], 'Boolean'),
  reporter('bc_time', 'sensing', 'Zeit seit Start'),
  reporter('bc_obj_pos', 'sensing', 'Position %1 von Objekt %2', [{ type: 'field_dropdown', name: 'AXIS', options: AXIS }, { type: 'field_input', name: 'NAME', text: 'Objektname' }]),

  // Welt
  stmt('bc_teleport', 'world', 'teleportiere Spieler zu x %1 y %2 z %3', [num('X'), num('Y'), num('Z')], 'Fußposition des Spielers.'),
  stmt('bc_show_text', 'world', 'zeige Text %1 für %2 Sek.', [any('TEXT'), num('S')], 'Text in der Bildschirmmitte.'),
  stmt('bc_obj_show', 'world', '%1 Objekt %2', [{ type: 'field_dropdown', name: 'SHOW', options: [['zeige', 'true'], ['verstecke', 'false']] }, { type: 'field_input', name: 'NAME', text: 'Objektname' }]),
  stmt('bc_log', 'world', 'schreibe ins Log %1', [any('V')], 'Ausgabe in der Editor-Statusleiste / Browser-Konsole.'),
];

export const EVENT_BLOCKS: Record<string, { event: string; arg?: (b: Blockly.Block) => string }> = {
  bc_when_start: { event: 'start' },
  bc_when_tick: { event: 'tick' },
  bc_when_interact: { event: 'interact', arg: (b) => JSON.stringify(b.getFieldValue('TEXT') || 'Benutzen') },
  bc_when_hit: { event: 'hit' },
  bc_when_enter: { event: 'enter' },
  bc_when_leave: { event: 'leave' },
  bc_when_near: { event: 'near', arg: (b) => String(Number(b.getFieldValue('DIST')) || 0) },
  bc_when_key: { event: 'key', arg: (b) => JSON.stringify(b.getFieldValue('KEY')) },
  bc_when_message: { event: 'message', arg: (b) => JSON.stringify(b.getFieldValue('MSG')) },
};

let installed = false;

export function installBlocks(): void {
  if (installed) return;
  installed = true;
  Blockly.setLocale(De as unknown as { [key: string]: string });
  registerFieldColour();
  colourPicker.installBlock({ javascript: javascriptGenerator });
  Blockly.common.defineBlocksWithJsonArray(BLOCKS);

  const g = javascriptGenerator;
  // Wie in Scratch: jede Schleife gibt pro Durchlauf einen Frame ab → keine Endlosschleifen-Hänger
  g.INFINITE_LOOP_TRAP = 'await api.frame();\n';

  const v = (b: Blockly.Block, name: string, fallback = '0') => g.valueToCode(b, name, Order.COMMA) || fallback;
  const f = (b: Blockly.Block, name: string) => JSON.stringify(b.getFieldValue(name));
  const xyz = (b: Blockly.Block) => `${v(b, 'X')}, ${v(b, 'Y')}, ${v(b, 'Z')}`;
  const def = (type: string, fn: (b: Blockly.Block) => string | [string, Order]) => {
    g.forBlock[type] = fn as (typeof g.forBlock)[string];
  };

  // Ereignis-Blöcke: nachfolgende Blöcke werden zum Rumpf des Handlers
  for (const [type, ev] of Object.entries(EVENT_BLOCKS)) {
    def(type, (b) => {
      const next = b.getNextBlock();
      const body = next ? g.blockToCode(next) : '';
      const code = typeof body === 'string' ? body : body[0];
      const arg = ev.arg ? `, ${ev.arg(b)}` : '';
      return `api.on('${ev.event}', async () => {\n${g.prefixLines(code, g.INDENT)}}${arg});\n`;
    });
  }
  const origScrub = g.scrub_.bind(g);
  g.scrub_ = (block, code, thisOnly) => (EVENT_BLOCKS[block.type] ? code : origScrub(block, code, thisOnly));

  def('bc_broadcast', (b) => `api.broadcast(${f(b, 'MSG')});\n`);
  def('bc_move_by', (b) => `api.moveBy(${xyz(b)});\n`);
  def('bc_move_to', (b) => `api.moveTo(${xyz(b)});\n`);
  def('bc_move_forward', (b) => `api.moveForward(${v(b, 'D')});\n`);
  def('bc_glide_by', (b) => `await api.glideBy(${xyz(b)}, ${v(b, 'S', '1')});\n`);
  def('bc_glide_to', (b) => `await api.glideTo(${xyz(b)}, ${v(b, 'S', '1')});\n`);
  def('bc_rotate_by', (b) => `api.rotateBy(${xyz(b)});\n`);
  def('bc_turn_by', (b) => `await api.turnBy(${xyz(b)}, ${v(b, 'S', '1')});\n`);
  def('bc_set_rotation', (b) => `api.setRotation(${xyz(b)});\n`);
  def('bc_set_scale', (b) => `api.setScale(${xyz(b)});\n`);
  def('bc_pos', (b) => [`api.pos(${f(b, 'AXIS')})`, Order.FUNCTION_CALL]);
  def('bc_rot', (b) => [`api.rot(${f(b, 'AXIS')})`, Order.FUNCTION_CALL]);

  def('bc_show', () => 'api.show();\n');
  def('bc_hide', () => 'api.hide();\n');
  def('bc_set_color', (b) => `api.setColor(${f(b, 'C')});\n`);
  def('bc_set_glow', (b) => `api.setGlow(${f(b, 'C')}, ${v(b, 'V', '1')});\n`);
  def('bc_collision', (b) => `api.setCollision(${b.getFieldValue('ON') === 'true'});\n`);

  def('bc_light_set', (b) => `api.lightSet(${f(b, 'MODE')});\n`);
  def('bc_light_intensity', (b) => `api.lightIntensity(${v(b, 'V')});\n`);
  def('bc_light_change', (b) => `api.lightChangeIntensity(${v(b, 'V')});\n`);
  def('bc_light_color', (b) => `api.lightColor(${f(b, 'C')});\n`);
  def('bc_light_flicker', (b) => `api.lightFlicker(${b.getFieldValue('ON') === 'true'});\n`);
  def('bc_light_is_on', () => ['api.lightIsOn()', Order.FUNCTION_CALL]);

  def('bc_wait', (b) => `await api.wait(${v(b, 'S', '1')});\n`);
  def('bc_forever', (b) => `while (true) {\n${g.statementToCode(b, 'DO')}${g.INDENT}await api.frame();\n}\n`);
  def('bc_wait_until', (b) => `while (!(${g.valueToCode(b, 'COND', Order.LOGICAL_NOT) || 'false'})) {\n${g.INDENT}await api.frame();\n}\n`);
  def('bc_stop', () => 'api.stop();\n');

  def('bc_distance', () => ['api.distanceToPlayer()', Order.FUNCTION_CALL]);
  def('bc_player_pos', (b) => [`api.playerPos(${f(b, 'AXIS')})`, Order.FUNCTION_CALL]);
  def('bc_player_inside', () => ['api.playerInside()', Order.FUNCTION_CALL]);
  def('bc_key_down', (b) => [`api.keyDown(${f(b, 'KEY')})`, Order.FUNCTION_CALL]);
  def('bc_time', () => ['api.time()', Order.FUNCTION_CALL]);
  def('bc_obj_pos', (b) => [`api.objPos(${f(b, 'NAME')}, ${f(b, 'AXIS')})`, Order.FUNCTION_CALL]);

  def('bc_teleport', (b) => `api.teleportPlayer(${xyz(b)});\n`);
  def('bc_show_text', (b) => `api.showText(${v(b, 'TEXT', "''")}, ${v(b, 'S', '2')});\n`);
  def('bc_obj_show', (b) => `api.objShow(${f(b, 'NAME')}, ${b.getFieldValue('SHOW') === 'true'});\n`);
  def('bc_log', (b) => `api.log(${v(b, 'V', "''")});\n`);
}

/**
 * Erzeugt den Script-Code eines Workspaces. Nur Ereignis-Blöcke (und was daran hängt) werden übernommen,
 * lose Blöcke ignoriert — wie in Scratch.
 */
export function generateCode(ws: Blockly.Workspace): string {
  const g = javascriptGenerator;
  g.init(ws);
  let code = '';
  for (const block of ws.getTopBlocks(true)) {
    if (!EVENT_BLOCKS[block.type] || !block.isEnabled()) continue;
    const c = g.blockToCode(block);
    code += typeof c === 'string' ? c : c[0];
  }
  code = g.finish(code);
  return code.trim() ? code : '';
}

/** Anzahl der Ereignis-Blöcke (für die Anzeige im Details-Panel) */
export function countEvents(blocksJson: unknown): number {
  const blocks = (blocksJson as { blocks?: { blocks?: { type: string }[] } })?.blocks?.blocks ?? [];
  return blocks.filter((b) => EVENT_BLOCKS[b.type]).length;
}

const sh = (type: string, fields: Json) => ({ shadow: { type, fields } });
const n = (v: number) => sh('math_number', { NUM: v });
const t = (v: string) => sh('text', { TEXT: v });
const block = (type: string, inputs?: Json, extra: Json = {}) => ({ kind: 'block', type, ...(inputs ? { inputs } : {}), ...extra });

export const TOOLBOX = {
  kind: 'categoryToolbox',
  contents: [
    {
      kind: 'category',
      name: 'Ereignisse',
      colour: CATEGORY_COLOURS.events,
      contents: [
        block('bc_when_start'),
        block('bc_when_interact'),
        block('bc_when_hit'),
        block('bc_when_enter'),
        block('bc_when_leave'),
        block('bc_when_near'),
        block('bc_when_key'),
        block('bc_when_tick'),
        block('bc_when_message'),
        block('bc_broadcast'),
      ],
    },
    {
      kind: 'category',
      name: 'Bewegung',
      colour: CATEGORY_COLOURS.motion,
      contents: [
        block('bc_move_by', { X: n(0), Y: n(1), Z: n(0) }),
        block('bc_move_to', { X: n(0), Y: n(0), Z: n(0) }),
        block('bc_move_forward', { D: n(1) }),
        block('bc_glide_by', { S: n(1), X: n(0), Y: n(2), Z: n(0) }),
        block('bc_glide_to', { S: n(1), X: n(0), Y: n(0), Z: n(0) }),
        block('bc_rotate_by', { X: n(0), Y: n(15), Z: n(0) }),
        block('bc_turn_by', { S: n(1), X: n(0), Y: n(90), Z: n(0) }),
        block('bc_set_rotation', { X: n(0), Y: n(0), Z: n(0) }),
        block('bc_set_scale', { X: n(1), Y: n(1), Z: n(1) }),
        block('bc_pos'),
        block('bc_rot'),
      ],
    },
    {
      kind: 'category',
      name: 'Aussehen',
      colour: CATEGORY_COLOURS.looks,
      contents: [block('bc_show'), block('bc_hide'), block('bc_set_color'), block('bc_set_glow', { V: n(4) }), block('bc_collision')],
    },
    {
      kind: 'category',
      name: 'Licht',
      colour: CATEGORY_COLOURS.light,
      contents: [
        block('bc_light_set'),
        block('bc_light_intensity', { V: n(10) }),
        block('bc_light_change', { V: n(2) }),
        block('bc_light_color'),
        block('bc_light_flicker'),
        block('bc_light_is_on'),
      ],
    },
    {
      kind: 'category',
      name: 'Steuerung',
      colour: CATEGORY_COLOURS.control,
      contents: [
        block('bc_wait', { S: n(1) }),
        block('controls_repeat_ext', { TIMES: n(10) }),
        block('bc_forever'),
        block('controls_if'),
        block('controls_if', undefined, { extraState: { hasElse: true } }),
        block('bc_wait_until'),
        block('controls_whileUntil'),
        block('bc_stop'),
      ],
    },
    {
      kind: 'category',
      name: 'Fühlen',
      colour: CATEGORY_COLOURS.sensing,
      contents: [
        block('bc_distance'),
        block('bc_player_inside'),
        block('bc_player_pos'),
        block('bc_key_down'),
        block('bc_time'),
        block('bc_obj_pos'),
      ],
    },
    {
      kind: 'category',
      name: 'Operatoren',
      colour: CATEGORY_COLOURS.operators,
      contents: [
        block('math_arithmetic', { A: n(1), B: n(1) }),
        block('math_random_int', { FROM: n(1), TO: n(10) }),
        block('logic_compare', { A: n(0), B: n(0) }),
        block('logic_operation'),
        block('logic_negate'),
        block('logic_boolean'),
        block('math_number'),
        block('math_round', { NUM: n(3.1) }),
        block('math_modulo', { DIVIDEND: n(10), DIVISOR: n(3) }),
        block('text'),
        block('text_join'),
        block('colour_picker'),
      ],
    },
    { kind: 'category', name: 'Variablen', colour: CATEGORY_COLOURS.variables, custom: 'VARIABLE' },
    {
      kind: 'category',
      name: 'Welt',
      colour: CATEGORY_COLOURS.world,
      contents: [
        block('bc_show_text', { TEXT: t('Hallo!'), S: n(2) }),
        block('bc_teleport', { X: n(0), Y: n(0), Z: n(0) }),
        block('bc_obj_show'),
        block('bc_log', { V: t('Test') }),
      ],
    },
  ],
};

export const BLOCKLY_THEME = (): Blockly.Theme =>
  Blockly.Theme.defineTheme('bodycam-ue', {
    name: 'bodycam-ue',
    base: Blockly.Themes.Classic,
    startHats: true,
    componentStyles: {
      workspaceBackgroundColour: '#1b1b1b',
      toolboxBackgroundColour: '#242424',
      toolboxForegroundColour: '#d0d0d0',
      flyoutBackgroundColour: '#2c2c2c',
      flyoutForegroundColour: '#d0d0d0',
      flyoutOpacity: 0.96,
      scrollbarColour: '#555555',
      scrollbarOpacity: 0.6,
      insertionMarkerColour: '#ffffff',
      insertionMarkerOpacity: 0.3,
      cursorColour: '#0070e0',
    },
    fontStyle: { family: 'Segoe UI, Roboto, sans-serif', weight: '600', size: 11 },
  });
