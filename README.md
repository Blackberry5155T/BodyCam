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
  (Plan: `docs/Editor-Erweiterung-Plan.md`; alle sechs Modi sind fertig).
- **Landscape** (Modus Umschalt+2, wie UE5): *Neue Landscape…* (Komponenten à 128 Quads, Quad-Größe, optional aus Heightmap)
  oder *Aus Heightmap…* (16-bit PNG oder RAW `.r16`; Min/Max-Höhe im Dialog). Werkzeuge 1–8: Formen (Umschalt = senken),
  Glätten, Abflachen, Rampe (zwei Klicks, Enter), Noise, Erosion (hydraulisch/thermisch; als Pinsel oder im Hintergrund auf
  Region/ganze Fläche), Löcher (Modus *Loch malen* / *Loch füllen*, Umschalt = umkehren; Lochstellen sind mit dem
  Pinsel treffbar, beim Füllen zeigt eine Schraffur die Fläche; *Loch-Auflösung* 1 / 2×2 / 4×4 / 8×8 Zellen je Quad, je nach
  Landscape-Größe begrenzt, rückgängig machbar), Region (Rechteck ziehen → Kopieren/Einfügen, Spiegeln, Drehen 90°,
  *An Mesh anpassen* für die ausgewählten Objekte). `[`/`]` oder Strg+Mausrad = Pinselgröße (ab 0,1 m),
  Strg+Umschalt+Mausrad = Stärke (0 … 2).
  **Material** (Werkzeug 9 *Malen*): bis zu 8 Layer je Landscape (Textur, Kachelgröße, Farbton, Rauheit, Normalen-Stärke,
  Oberfläche). Gemaltes ersetzt die Auto-Regeln (Neigung/Höhe/Noise je Layer, z. B. Fels ab 36°); Umschalt = radieren,
  Modus *Auf Auto zurücksetzen*. Gewichtsmasken als ZIP mit einer Graustufen-PNG je Layer exportieren/importieren
  (Dateiname = Layer-Name, z. B. aus World Machine/Gaea). Der Shader mischt nach Höhe, kachelt ohne sichtbare
  Wiederholung (Hex-Tiling + Makro-Variation), nimmt an Steilhängen Triplanar-Projektion und bekommt Nässe/Pfützen/Schnee
  vom Wetter. Die Oberfläche je Layer bestimmt Schrittgeräusche und Einschlag-Effekte im Spiel (nasse Erde → Schlamm,
  Schneedecke → Schnee). Textur-Qualität (512/1024 px, 2–3 Layer je Pixel) folgt Grafik › *Terrain-Detail*.
- **Foliage** (Modus Umschalt+3): Typen anlegen über *Neu* (Platzhalter Laubbaum, Nadelbaum, Busch, Fels, Grasbüschel
  oder ein glb-Modell; LOD-Stufen über Knotennamen `LOD0/LOD1/LOD2`, Impostor wird automatisch gebacken). Je Typ:
  Dichte je 100 m², Skalierung min/max, zufällige Drehung, Ausrichtung zur Fläche (0–100 %), Neigungs-/Höhenbereich,
  Mindestabstand, Einsinken, LOD-/Impostor-/Sichtweite, Schatten, Kollision (keine/Stamm/voll), Sichtschutz (KI),
  Wind, Oberfläche (Treffer-Effekt). Werkzeuge 1–5: Malen (Umschalt = radieren), Radieren (nur aktive Typen oder alle),
  Auswählen (Klick, Umschalt = hinzufügen, Ziehen = Pinsel, Entf = löschen), Neu anwenden (Höhe, Ausrichtung,
  Skalierung, Filter nachträglich), Füllen (alle Landscapes, läuft im Hintergrund, ein Undo-Schritt). Die Checkbox
  in der Typenliste bestimmt, was gemalt/gefüllt wird. Optional *Auf Meshes malen* je Typ. Das Foliage-Objekt wird
  beim ersten Typ angelegt; die Instanzen liegen als Blob in der Map (64-m-Zellen).
  **Layer-Gras:** im Landscape-Layer *Gras* (Wiese, kurz, hoch, trocken) und *Gras-Dichte* wählen — dann wächst Gras
  nach Layer-Gewicht um die Kamera, bewegt sich im Wind des Wetters und weicht Spieler/NPCs aus. Im Foliage-Modus
  lässt sich das Gras mit dem Pinsel radieren (Radieren oder Umschalt+Malen) und mit Malen wiederherstellen; der
  Eintrag *Layer-Gras* in der Typenliste schaltet das an/aus, *Zurücksetzen* stellt alles wieder her. Die Gras-Maske
  wird mit der Landscape gespeichert.
  Grafik-Menü: *Foliage-Dichte*, *Foliage-Weite*, *Gras* an/aus.
- **Modeling** (Modus Umschalt+4, Geometry-Brushes wie BSP in UE): unter *Neu* eine Form wählen (Quader, Wand, Boden,
  Zylinder, Rampe, Treppe, Kugel, Türloch, Fensterloch, Tunnel) und in die Szene klicken — auf Böden steht der Brush auf
  der Fläche, an Wänden liegt er an, *Abziehen*-Brushes (Tür, Fenster) sitzen mittig in der Wand (Umschalt = mehrere
  setzen, Esc bricht ab). Brushes werden in Outliner-Reihenfolge verrechnet: *Addieren* füllt, *Abziehen* schneidet
  Löcher, *Schnitt* behält nur die Überlappung (*Nach vorn/hinten* ändert die Reihenfolge). Maße = Skalierung in Metern
  (Gizmo oder Felder), Treppe mit Stufenhöhe, Zylinder/Kugel mit Segmenten. *Hohl* setzt einen Abziehen-Brush mit der
  eingestellten Wandstärke hinein. Material, Farbe und Textur-Skalierung je Brush und je Fläche (*Flächen im Viewport
  wählen*: Klick, Umschalt+Klick = weitere). Das Ergebnis rechnet im Hintergrund (Web Worker) nach, nur überlappende
  Gruppen werden neu verrechnet. Kollision als Trimesh, Dächer halten Regen/Schnee ab. *In statisches Mesh umwandeln*
  backt die gewählten Brushes (samt überlappender) zu einem Objekt *Statisches Mesh* (Blob in der Map, Strg+Z geht).
  Tunnel durch Gelände: Brushes durch den Hügel legen und an den Portalen Löcher in die Landscape malen.
- **3D-Modeler** (eigener Tab neben dem Level, wie ein Asset-Editor in UE5; Polygon-Modeling wie in Blender):
  öffnen über *Neues Modell* im Content Browser, den **+**-Tab oder *Datei › Neues 3D-Modell*; eigene Modelle per
  Doppelklick (oder Rechtsklick › *Im Modeler bearbeiten*). Das Level pausiert, solange der Modeler-Tab aktiv ist.
  **Objektmodus:** Grundkörper hinzufügen (Umschalt+A: Würfel, Ebene, Raster, Kreis, Zylinder, Kegel, UV-/Ico-Kugel, Torus,
  Parameter im Redo-Panel unten links), verschieben/drehen/skalieren (G/R/S oder Gizmos links, X/Y/Z sperrt
  die Achse, Zahl tippen = exakter Wert, Strg = Raster), Umschalt+D duplizieren, Strg+J verbinden, Strg+A Transform
  anwenden, **Boolean** (zwei Objekte wählen, das zuletzt geklickte wird bearbeitet: Abziehen/Vereinigen/Schnitt).
  **Bearbeitungsmodus** (Tab): 1/2/3 = Punkte/Kanten/Flächen, Klick/Umschalt+Klick/Rahmen, A alles, Alt+A nichts,
  Strg+I umkehren, Strg+L verbunden, Alt+Z Röntgen. Werkzeuge: **E** Extrudieren, **I** Inset (I im Werkzeug = einzeln),
  **Strg+B** Abschrägen (Bevel), **Strg+R** Loop Cut (über Kante fahren, klicken; Anzahl/Position im Redo-Panel),
  F Fläche füllen, M Zusammenführen, Unterteilen, Glätten (Subdivision), Trennen (P), Löschen/Auflösen (X),
  Spiegeln/Symmetrisieren, Normalen umdrehen/neu berechnen (Umschalt+N). Jede Operation lässt sich direkt danach im
  Redo-Panel nachjustieren. Ansichten über Ziffernblock (1/3/7, 5 = ortho, Strg = Gegenseite, , = auf Auswahl),
  Navigation wie Blender (mittlere oder rechte Maus drehen, mit Umschalt verschieben, Rad zoomen) oder mit dem Achsen-Würfel.
  **Material je Fläche:** Material-Slots (Material aus der Bibliothek, Farbe, Textur-Maßstab, Rauheit/Metall); im
  Bearbeitungsmodus Flächen wählen und *Zuweisen*. UVs per Box-Projektion (kein UV-Unwrap).
  **Modell:** Kollision (*Quader (Umriss)*, *Konvexe Hülle*, *Exakt (Dreiecke)*, *Keine*; *Kollision zeigen* als Vorschau) und
  Ursprung (*Boden-Mitte*, *Mitte*, *Auswahl*) — der Ursprung ist im Level der Drehpunkt.
  **Speichern** (Strg+S, *Speichern unter* = Umschalt+Strg+S) legt das Modell als .glb im Content Browser unter
  *Modelle › Eigene* ab (IndexedDB) — Bearbeitungsstand (Polygone, Slots, Einstellungen) steckt im glb, beim erneuten
  Öffnen geht es also verlustfrei weiter. Platzierte Instanzen aktualisieren sich beim Speichern. *Im Level platzieren*
  wechselt zum Level und setzt das Modell (Kollision *Wie im Modell*). *Import* übernimmt fremde .glb/.gltf als
  bearbeitbare Objekte, *Export* lädt das Modell als .glb herunter (auch per Rechtsklick im Content Browser).
- **Splines** (Modus Umschalt+5): oben eine Vorlage wählen (Straße, Feldweg, Leitplanke, Zaun, Mauer, Modell,
  Stromkabel, Rohr), dann Punkte in den Viewport klicken (sie folgen dem Gelände); Enter oder Esc beendet.
  Bearbeiten: Spline anklicken, Punkt ziehen (Umschalt + Ziehen = Höhe), Klick auf die Kurve fügt einen Punkt ein,
  Strg + Klick hängt einen an, Entf löscht den gewählten Punkt. Im Panel: Position, Breite und Querneigung je Punkt,
  *Umkehren*, *Aufs Gelände*, dazu die Einstellungen des Typs.
  **Straße/Feldweg:** Breite, Belag (Asphalt, Kies, Erde, Sand, Schlamm), Mittel-/Randlinien, Bordsteine, Kollision.
  *Gelände anpassen* zieht die Landscape unter der Straße auf Straßenhöhe (mit *Böschung* zur Seite); das passiert
  nicht-destruktiv: Straße verschieben oder löschen stellt das Gelände wieder her, die Sculpt-Pinsel arbeiten darunter
  weiter. Layer-Gras wächst nicht auf der Straße, Schritte klingen nach dem Belag.
  **Spline-Mesh:** Leitplanke, Maschendrahtzaun, Mauer oder ein eigenes glb-Modell, das entlang der Kurve verbogen
  wird; seitlicher Versatz, Höhe, Pfostenabstand, Kollision.
  **Kabel/Rohr:** Kabel hängen zwischen den Punkten durch (*Durchhang* in % der Spannweite), Rohre folgen der Kurve.
  Neues Asset *Props › Strommast* (auch als Telefonmast): einen Kabel-Punkt auf den Mast klicken, dann rastet er am
  Isolator ein und wandert mit, wenn der Mast verschoben oder gedreht wird (*Lösen* im Panel hebt das auf).
- **Wasser** (Modus Umschalt+6, wie UE5 Water Bodies): oben *See*, *Teich (trüb)*, *Fluss*, *Bach*, *Meer* oder *Wasserquelle* wählen.
  See: Umriss in den Viewport klicken (Enter oder Esc beendet, der Umriss schließt sich selbst), der Wasserspiegel liegt am tiefsten Uferpunkt und ist im
  Panel über die Höhe einstellbar. Fluss: Mittellinie klicken, Höhe und Breite je Punkt, *Strömung* in m/s in
  Kurvenrichtung; *Gelände anpassen* gräbt das Bett (Tiefe, Böschung) nicht-destruktiv in die Landscape. Meer: ein
  Klick, eins pro Map, unendliche Fläche. Einstellungen: Farbe, Trübung, Sichttiefe, Schaum, Wellenhöhe/-länge/-richtung.
  Darstellung: Gerstner-Wellen, Brechung, Tiefenfärbung, Uferschaum, Spiegelung (Grafik › *Spiegelungen*), Flow-Map bei
  Flüssen, Wellenringe (GPU-Simulation um die Kamera) und Spritzer bei Schritten, Schüssen und Objekten.
  **Wasserquelle** (echte Wasser-Simulation): ein Klick setzt die Quelle, im Panel *Zufluss* (m³/s), *Quellradius* und das
  *Gebiet* (Breite/Länge/Versatz/Zellgröße) einstellen, dann *Simulation › Simulation berechnen*. Das Wasser läuft
  (Flachwasser-Simulation im Web Worker, Fortschritt am Knopf) über Landscape, Brushes und Objekte, sucht sich selbst
  seinen Weg, bildet Bäche, füllt Mulden zu Seen und fließt am Gebietsrand ab. *Vorlauf* = vorgerechnete Sekunden,
  *Reibung*, *Versickerung*. Der Zustand wird mit der Map gespeichert (Undo-fähig); *Im Spiel weiterrechnen* lässt das
  Wasser beim Simulieren (Alt+S) und im Spiel live weiterfließen. Die Ufer sind abgerundet (keine Zellen-Treppen),
  schmale Rinnsale bleiben sichtbar. Waten, Schwimmen, Strömung und treibende Objekte
  funktionieren wie bei See/Fluss. Nach Verschieben der Quelle oder Ändern des Gebiets neu berechnen; *Wasser entfernen*
  löscht den Zustand.
  **Im Spiel:** Waten ab Knöchelhöhe (langsamer, Platschen, Kleidung wird bis zur Wasserlinie nass und trocknet langsam),
  Schwimmen ab Brusthöhe (W/A/S/D, Umschalt schneller, Leertaste hoch/aus dem Wasser), Tauchen mit Strg bzw. nach unten
  schauen. Unter Wasser: Atemluft-Leiste (30 s), Nebel in Wasserfarbe, gedämpfter Ton, Linsentropfen beim Auftauchen;
  ohne Luft gibt es Schaden (Training) bzw. Neustart am Spawn. Strömung treibt Spieler und Objekte ab.
  **Simulierte Props:** im Details-Panel *Physik › Simuliert*, *Masse*, *Auftrieb* (Content Browser: *Props › Fass*,
  *Kiste (simuliert)*). Sie fallen, rollen, lassen sich schieben und anschießen und schwimmen im Wasser (Auftrieb an
  8 Punkten mit Wellenhöhe, Wasserwiderstand, Strömung). Im Editor bleiben sie statisch.
- **Texturen** (Content Browser › Texturen): prozedurale Sets, Projekt-Sets aus `public/assets/textures/<Name>/` und im
  Browser importierte Sets. Dateien werden am Namen erkannt (Poly Haven, ambientCG, Quixel: `albedo`/`basecolor`/`diff`,
  `normal`/`nor_gl` (DirectX-Normalen `_dx` werden umgerechnet), `rough`, `ao`, `height`/`disp`, `arm`).
  Doppelklick weist ein Set dem gewählten Layer zu.
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
  textures/               Textur-Sets für Landscape-Layer: je Set ein Ordner (Albedo, Normal, Roughness, AO, Height)
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
                          Heightmap-Import/-Export (PNG 16-bit, .r16), Kollision (Heightfields), Asset-Typ,
                          Material-Layer (layers.ts), Malen + Gewichtsmasken (paint.ts), Textur-Bibliothek (textures.ts)
    foliage/              Foliage: Typen + Platzhalter (types.ts), Instanzen in 64-m-Zellen (data.ts), Meshes/LOD/
                          Impostor-Backen (meshes.ts), Instanz-Renderer + Kollision (render.ts), Layer-Gras (grass.ts)
    water/                Wasser: Assets See/Fluss/Meer (asset.ts), Gerstner-Wellen CPU = GPU (waves.ts), Abfrage
                          Höhe/Strömung + Ereignisse (registry.ts), Material + WaterPass (material.ts, system.ts),
                          Wellenringe (ripples.ts), Spritzer (splash.ts), Wasserquelle mit Flachwasser-Simulation
                          (source.ts, Löser shallow.ts, Web Worker shallow.worker.ts)
    surfaces.ts           Oberflächen-Typen (Gras, Erde, Fels …): Schritt-Klang, Einschlag, Nässe-Verhalten
  scripting/
    blocks.ts             Block-Definitionen + Code-Generator (nur Editor)
    runtime.ts            Führt Objekt-Scripts aus (Spiel + Simulieren im Editor)
  editor/                 Map-Editor: Viewport, Outliner, Details, Content Browser, Script-Fenster
    modeler/              3D-Modeler-Tab: Polygon-Netz (mesh.ts), Operationen (ops.ts), Boolean, Ansicht, glb-Ein-/Ausgabe
    modes/                Editor-Modi (Auswahl, Landscape, Foliage …) mit eigenem Werkzeug-Panel
    history.ts            Delta-Undo für große Raster (Heightmaps/Splatmaps), kachelweise komprimiert
  physics/
    physics.ts            Rapier-Physikwelt: Map-Collider abgleichen, Charakter-Kapsel, Abfragen
    dynamicProps.ts       Simulierte Props: dynamische Körper, Auftrieb/Widerstand/Strömung im Wasser, Kugel-Impulse
  player/
    controller.ts         Bewegung, Kollision (Rapier-Charakter-Controller), Kamera (Wippen, Rückstoß, Autopilot)
    body.ts               Würfel-Körper mit Gelenk-Rig + prozeduralen Animationen
  combat/                 Schießen, Treffer, Effekte (Einschläge je Oberfläche)
  audio/                  Synthetische Sounds (WebAudio): Schritte je Oberfläche
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
