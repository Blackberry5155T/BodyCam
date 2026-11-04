# BodyCam — Browser-Prototyp

```
npm install
npm run dev      # Spiel:      http://localhost:5173            (Chrome/Edge, wegen Pointer Lock)
                 # Map-Editor: http://localhost:5173/editor.html
npm run build
```

## Map-Editor (editor.html)

Aufbau angelehnt an Unreal Engine 5: Viewport mit Gizmo, Outliner und Details/World Settings rechts,
Content Browser unten. **Hilfe › Tastenkürzel** im Editor listet alle Kürzel.

- **Platzieren:** Asset aus dem Content Browser in den Viewport ziehen (setzt es auf die Fläche unter der Maus)
  oder doppelklicken (landet in der Bildmitte).
- **Navigation:** rechte Maustaste halten + WASD/Q/E fliegen, Mausrad = vor/zurück
  (mit gedrückter rechter Maustaste: Geschwindigkeit), mittlere Maustaste = schieben, Alt + linke Maustaste = kreisen, F = fokussieren.
- **Bearbeiten:** W/E/R = Verschieben/Drehen/Skalieren, Snapping oben rechts im Viewport, Alt + Gizmo ziehen = duplizieren,
  Ende = auf den Boden setzen, Strg+Z/Y = Rückgängig/Wiederholen.
- **Scripts:** Objekt auswählen → Details › *Script hinzufügen*. Scratch-ähnliche Blöcke (Blockly): Ereignisse
  (Start, Benutzen [E], Getroffen, Trigger betreten/verlassen, Nähe, Taste, Nachricht), Bewegung, Aussehen, Licht,
  Steuerung, Fühlen, Operatoren, Variablen, Welt.
- **Himmel & Sonne:** Die Sonne ist ein Objekt (*Licht › Sonne*, wie Directional Light in UE5): **drehen = Sonnenstand**
  (Pfeil = Lichtrichtung, Position egal), Details = Farbe, Intensität, Sonnenscheibe, Schatten. Scripts können sie drehen.
  Strg+L halten + Maus bewegen dreht sie direkt. Ohne Sonnen-Objekt gelten die Werte aus den World Settings
  (dort: *Sonnen-Objekt anlegen*). World Settings › *Stimmung* (Bewölkt/Tag/Abend/Nacht) setzt Himmel, Licht und Nebel auf einmal.
- **Wetter:** Objekt *Volumetrik › Wetter* (wie die Sonne, eins pro Map): **drehen = Windrichtung** (Pfeil), Details = Wettertyp
  (Klar, Niesel, Regen, Gewitter, Schnee), Stärke, Wind, Nässe, Pfützen. Ohne Objekt gelten World Settings › *Wetter*. Bei Regen wird der Boden mit
  der Zeit nass, danach bilden sich Pfützen mit Spiegelungen (planar + Fresnel, Regenringe); unter Dächern bleibt es trocken,
  ohne Regen trocknet alles langsam ab. Schnee bleibt auf ebenen Flächen liegen. Der Spieler hinterlässt Fußabdrücke im
Schnee (füllen sich bei Schneefall langsam wieder) und Wellenringe in Pfützen. *Anfangsnässe/-Schnee* = Zustand beim
  Kartenstart, *Zeitfaktor* beschleunigt das (0 = eingefroren). Scripts: *Welt › setze Wetter*. Spiegelungsqualität im
  Spiel-Menü (Grafik › Spiegelungen).
- **Testen:** *Simulieren* (Alt+S) führt Scripts im Editor aus: Kamera = Spieler, Klick = Benutzen, Shift+Klick = Treffer.
  *Spielen* (Alt+P) speichert und öffnet die Map im Spiel (`/?map=local:<Name>`). Erneutes Speichern lädt den Spiel-Tab neu.
- **Modi:** Knopf links in der Toolbar bzw. Umschalt+1…6 — Auswahl, Landscape, Foliage, Modeling, Splines, Wasser
  (Plan: `docs/Editor-Erweiterung-Plan.md`; Auswahl und Landscape sind fertig, die übrigen Modi zeigen vorerst nur, was geplant ist).
- **Landscape** (Modus Umschalt+2, wie UE5): *Neue Landscape…* (Komponenten à 128 Quads, Quad-Größe, optional aus Heightmap)
  oder *Aus Heightmap…* (16-bit PNG oder RAW `.r16`; Min/Max-Höhe im Dialog). Werkzeuge 1–8: Formen (Umschalt = senken),
  Glätten, Abflachen, Rampe (zwei Klicks, Enter), Noise, Erosion (hydraulisch/thermisch; als Pinsel oder im Hintergrund auf
  Region/ganze Fläche), Löcher (Umschalt = füllen), Region (Rechteck ziehen → Kopieren/Einfügen, Spiegeln, Drehen 90°,
  *An Mesh anpassen* für die ausgewählten Objekte). `[`/`]` oder Strg+Mausrad = Pinselgröße, Strg+Umschalt+Mausrad = Stärke.
  Export als PNG 16-bit oder `.r16` (Min/Max stehen im Dateinamen). Im Spiel: begehbar und beschießbar (Rapier-Heightfield);
  LOD-Abstand über Grafik › *Terrain-Detail*. Beim Anlegen wird die *Sichtweite* (World Settings) passend erhöht.
- **Speichern:** Maps liegen im Browser (IndexedDB, Map-Format v2; Maps aus der alten localStorage-Ablage werden beim
  ersten Start übernommen). Große Binär-Daten (Heightmaps usw.) liegen als eigene Blobs daneben.
  *Datei › Als Paket exportieren* erzeugt eine `.bcmap` (ZIP: `map.json` + `blobs/`), *Importieren* liest `.bcmap` und `.json`.
  Importierte .glb-Modelle liegen in IndexedDB desselben Browsers und sind nicht im Export enthalten.
- **Mitgelieferte Map ändern:** kleine Maps ohne Binär-Daten: *Als JSON exportieren*, Datei als `src/maps/<name>.json`
  ablegen (z. B. `start.json` ersetzen) und in `src/maps/index.ts` eintragen. Große Maps: `.bcmap` nach
  `public/maps/<id>/` entpacken (kein Eintrag nötig). Aufruf: `/?map=<id>`.

## Ordnerstruktur

```
docs/                     Design-Dokument, Entwicklungsplan
public/assets/            Statische Dateien, werden unverändert ausgeliefert (/assets/...)
  models/                 3D-Modelle (.glb), erscheinen automatisch im Content Browser (Modelle › Projekt)
  textures/               Bild-Texturen (Albedo/Normal/Roughness)
  audio/                  Sounds, Musik
editor.html               Map-Editor
src/
  main.ts                 Spiel-Einstieg: Renderer, Post-Processing, Game-Loop, Map + Scripts laden
  core/                   Systeme ohne Spielinhalt
    settings.ts           Persistente Einstellungen + Tastenbelegung
    input.ts              Tastatur über Aktionen (statt fester Tasten)
  maps/                   Mitgelieferte Maps als JSON (Format: world/mapFormat.ts)
    index.ts              Map-Register (src/maps + public/maps/<id>/)
    start.json            Startmap mit Menü-Terminal
  world/                  Bausteine für Maps
    mapFormat.ts          JSON-Format (Objekte, World Settings)
    mapLoader.ts          Baut die Szene aus MapData (Spiel + Editor), Collider, Sonne/Himmel
    sky.ts                Himmelskuppel mit Verlauf und sichtbarer Sonnenscheibe
    sun.ts                Sonnen-Objekt ↔ Sonnenstand (Drehung → Richtung/Höhe)
    weather.ts            Wetter: Regen/Schnee-Partikel, Nässe, Pfützen + Spiegelungen, Blitze (Material-Patch)
    weatherObject.ts      Wetter-Objekt ↔ World Settings (Drehung → Windrichtung)
    assets.ts             Asset-Registry: alle Objekttypen, Eigenschaften, Content-Browser-Presets
    materials.ts          Benannte Materialien (prozedurale Texturen)
    volumetrics.ts        Nebelvolumen (Raymarching), Lichtkegel, Staubpartikel
    modelStore.ts         GLB laden (Projekt-Ordner + im Browser importiert)
    mapStore.ts           Maps im Browser speichern (IndexedDB), .bcmap/.json Export/Import
    blobStore.ts          Binär-Daten der Maps (inhaltsadressiert, IndexedDB / public/maps)
    collision.ts          Collider-Typen (Box, gedrehte Box, Zylinder) + Referenzmaßstab (SCALE)
    builder.ts            Älterer MapBuilder für Code-Maps (derzeit ungenutzt)
    props/                Interaktive Objekte (terminal.ts = Menü-Bildschirm)
    landscape/            Landscape: Daten (Höhen, Löcher, Min/Max), CDLOD-Renderer, Pinsel, Erosion (+ Worker),
                          Heightmap-Import/-Export (PNG 16-bit, .r16), Kollision (Heightfields), Asset-Typ
  scripting/
    blocks.ts             Block-Definitionen + Code-Generator (nur Editor)
    runtime.ts            Führt Objekt-Scripts aus (Spiel + Simulieren im Editor)
  editor/                 Map-Editor: Viewport, Outliner, Details, Content Browser, Script-Fenster
    modes/                Editor-Modi (Auswahl, Landscape, Foliage …) mit eigenem Werkzeug-Panel
    history.ts            Delta-Undo für große Raster (Heightmaps/Splatmaps), kachelweise komprimiert
  physics/
    physics.ts            Rapier-Physikwelt: Map-Collider abgleichen, Charakter-Kapsel, Abfragen
  player/
    controller.ts         Bewegung, Kollision (Rapier-Charakter-Controller), Kamera (Wippen, Rückstoß, Autopilot)
    body.ts               Würfel-Körper mit Gelenk-Rig + prozeduralen Animationen
  combat/                 Schießen, Treffer, Effekte
  textures/               Prozedurale Texturen (Canvas-generiert)
  rendering/postfx/       Post-Processing-Shader (Bodycam-Linse)
  ui/                     Canvas-UI-Toolkit für In-World-Bildschirme
```

## Konventionen

- Neuer Objekttyp für Maps: Eintrag in `ASSETS` (world/assets.ts) + Preset in `PRESETS` für den Content Browser.
- Neuer Script-Block: Definition + Generator in `scripting/blocks.ts`, passende Funktion in der `api` von `scripting/runtime.ts`.
- Neues interaktives Objekt mit eigener Logik: `src/world/props/`.
- Echte Assets kommen nach `public/assets/...` und werden per Pfad `/assets/...` geladen.
- Spielerfigur-Modell: `player/body.ts` ersetzt die Würfel; die Animationsdaten kommen
  unverändert aus `PlayerController.getAnimState()`.
