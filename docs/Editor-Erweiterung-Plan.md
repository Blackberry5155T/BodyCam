# Editor-Erweiterung nach UE5-Vorbild — Umsetzungsplan

Stand: 04.11.2026 · Status: **freigegeben (E1–E4 entschieden), Phase 0 und 1 umgesetzt, wartet auf Rückmeldung zu Phase 1**

Dieser Plan erweitert den Map-Editor (`editor.html`) um Werkzeuge aus der Unreal Engine 5: Landscape, Foliage,
Splines, Geometry-Brushes, Wasser mit Physik, Prefabs und neue Script-Blöcke. Er baut auf dem bestehenden Code auf
(Objekt-/Asset-System in `world/assets.ts`, Editor-Zustand in `editor/state.ts`, Wetter in `world/weather.ts`).

---

## 1. Festgelegte Anforderungen

| Bereich | Entscheidung |
|---|---|
| Features | Landscape, Foliage-Painting, Splines, Geometry-Brushes (CSG), Wasser-Körper, Prefabs/Level Instances, Script-Blöcke |
| Terrain-Größe | Groß: mehrere km |
| Auflösung | Pro Landscape wählbar (z. B. 0,25 / 0,5 / 1 / 2 / 4 m pro Quad) |
| Sculpt-Werkzeuge | Anheben, Senken, Glätten, Abflachen, Rampe, Noise · dazu Erosion, Heightmap-Import/-Export, Löcher, Region-Tools |
| Terrain-Material | Bis 8 Mal-Layer, Auto-Material (Neigung/Höhe), Triplanar an Klippen, Anti-Kachel-Effekt |
| Texturen/Modelle | Bild-Texturen und .glb-Modelle legst **du** ab; ich baue System + Import, bis dahin Platzhalter |
| Foliage | Pinsel (Malen/Radieren), Layer-Gras automatisch, Malen auf Meshes |
| Splines | Straßen/Wege, Zäune/Mauern/Leitplanken, Kabel/Rohre, Flüsse |
| Brushes | CSG mit `three-bvh-csg` |
| Wasser | Wellen & Spritzer, Spieler im Wasser (Waten/Schwimmen/Tauchen/Strömung), schwimmende Objekte, **vorberechnete** Fluid-Simulation |
| Physik | Rapier (`@dimforge/rapier3d-compat`) |
| Gameplay | Oberflächen-Typen, Foliage-Kollision, Wetter-Integration, Gras-Interaktion (Wind + Spieler) |
| Speicher | IndexedDB im Browser + Export als Paket (`map.json` + Binärdateien/PNGs) |
| Performance | Skalierbar über das Grafikmenü, Ziel: **60 FPS auf RX 7800 XT** bei höchster Standardstufe |

---

## 2. Architektur-Überblick

### 2.1 Editor-Modi (wie UE5 „Modes“)

Neuer Modus-Umschalter links in der Toolbar: **Auswahl · Landscape · Foliage · Modeling · Splines · Wasser**.
Jeder Modus bringt ein eigenes Werkzeug-Panel (ersetzt im Modus die Details-Spalte oder liegt als Tab daneben)
und übernimmt die Maus-Eingaben im Viewport. Navigation (rechte Maustaste + WASD, Alt-Orbit, F) bleibt in allen
Modi gleich.

- Neue Datei `editor/modes/` mit einer gemeinsamen Schnittstelle `EditorMode { activate, deactivate, onPointer*, onKey, panel }`.
- `viewport.ts` gibt Pointer-Events an den aktiven Modus weiter, bevor Gizmo/Auswahl sie bekommen.
- Pinsel-Vorschau (Kreis + Falloff-Ring auf der Oberfläche) als gemeinsame Komponente für Landscape und Foliage.
- Tastenkürzel wie UE5: Umschalt+1…6 = Modus, `[`/`]` = Pinselgröße, Strg+Mausrad = Stärke, Umschalt beim Malen = invertieren/glätten.

### 2.2 Map-Format v2 und Speicherung

`MapData.version` wird 2. Einfache Daten bleiben JSON, große Daten werden Binär-Blobs mit eigener ID:

```
map.json                       Objekte, World Settings, Verweise auf Blobs
landscape/<id>/height.r16      Höhen (uint16, little endian), Kachel-Layout siehe 3.1
landscape/<id>/splat0.png      Gewichte Layer 0–3 (RGBA8)
landscape/<id>/splat1.png      Gewichte Layer 4–7
landscape/<id>/holes.png       Löcher-Maske (1 bit, als PNG)
foliage/<typ>.bin              Instanzen je Foliage-Typ, nach Zellen sortiert
fluid/<id>/sim.vat             vorberechnete Fluid-Simulation (Vertex Animation Texture)
textures/…, models/…           importierte Dateien (nur bei „mit Assets exportieren“)
```

> **Umgesetzt (Phase 0):** Die Liste oben beschreibt *welche* Daten Blobs werden, nicht ihre Pfade. Blobs liegen
> inhaltsadressiert als `blobs/<sha256>.bin`; `map.json` verweist mit `"blob:<sha256>"` darauf. So teilen sich Maps
> gleiche Daten, beim Import wird jeder Blob per Prüfsumme kontrolliert, und unbenutzte Blobs räumt der Editor beim
> Start weg (nur wenn kein weiterer Editor-Tab offen ist). Maps liegen in der IndexedDB `bodycam-maps`
> (Stores `maps`, `blobs`); alte localStorage-Maps werden einmalig übernommen, die alten Einträge bleiben stehen.

- **Im Browser:** `map.json` wie bisher, Blobs in IndexedDB (neuer Store neben `modelStore.ts`, gemeinsamer Helfer `world/blobStore.ts`).
- **Export/Import:** `.bcmap` = ZIP (Bibliothek `fflate`). Alte `.json`-Maps lassen sich weiter importieren (Migration v1 → v2).
- **Mitgelieferte Maps:** große Maps liegen als entpackter Ordner unter `public/maps/<id>/` und werden per `fetch` geladen;
  kleine Maps ohne Blobs können wie bisher in `src/maps/*.json` bleiben. `maps/index.ts` bekommt beide Quellen.
- **Spiel-Start über `?map=local:<Name>`** liest künftig auch die Blobs aus IndexedDB.

### 2.3 Undo/Redo für große Daten

Heute speichert `EditorState.commit()` die ganze Map als JSON-Snapshot. Für Heightmaps (bis zu mehreren 100 MB) geht das nicht.

- Ein Undo-Eintrag wird `{ json?: string, deltas?: BlobDelta[] }`.
- `BlobDelta` = betroffene Kacheln (64 × 64 Samples) **vor** und **nach** einem Pinselstrich, komprimiert.
- Speicherbudget für die Historie (z. B. 256 MB); älteste Einträge fallen heraus.
- JSON-Snapshots bleiben für normale Objekt-Änderungen unverändert.

### 2.4 Kollision, Physik und Raycasts

Heute prüft der `PlayerController` linear alle Box-, OBox- und Zylinder-Collider. Für km-Terrain, tausende Bäume und
CSG-Meshes reicht das nicht.

**Empfehlung:** Rapier als gemeinsame Physik-Welt für alles:

- Terrain → Rapier-Heightfield-Collider (pro Landscape-Komponente, Löcher als ausgesparte Zellen).
- Bestehende Box-/Zylinder-Collider → Rapier-Cuboid/-Cylinder (statisch).
- CSG-Brushes, Splines (Zäune, Mauern) → Trimesh-Collider.
- Bäume/Steine → Zylinder/Kapseln, nur in der Nähe des Spielers aktiv (Zellen-Streaming).
- Dynamische Props (Kisten, Fässer, Boote) → Rigid Bodies mit Masse und Auftrieb.
- **Spieler:** Rapier `KinematicCharacterController` statt eigener Box-Kollision. Bewegungsgefühl (Beschleunigung,
  Schritthöhe, Ducken, Lean, Landungs-Stoß) bleibt in `controller.ts`, nur die Kollisionsauflösung wird ersetzt.
  → **E1 entschieden: ja.** Umgesetzt in `physics/physics.ts` + `player/controller.ts`.
- Schüsse (`combat/shooting.ts`): Raycast über Rapier (`castRay`) statt `THREE.Raycaster` auf Meshes. Das ist bei
  großen Szenen deutlich schneller und liefert den Collider, also auch den Oberflächen-Typ.

### 2.5 Rendering bei großen Entfernungen

- **Sichtweite:** Kamera-`far` war 200 m. Für Landscape bis ca. 4 km nötig, sonst Z-Fighting. **E2 entschieden: ja** →
  Three.js auf r186 aktualisiert, Reversed-Z-Tiefenpuffer (`reversedDepthBuffer`, braucht `EXT_clip_control`) mit
  Float-Tiefentextur. Spiel-`far` vorerst 2000 m, Editor 4000 m; wird mit der Sichtweiten-Option in Phase 1 gekoppelt.
- **Schatten:** War eine einzige Shadow-Map (±25 m). Jetzt `SunLight` aus r186 (2 Kaskaden, je 2048², Distanz pro Map
  einstellbar: „Schattendistanz“, Standard 120 m). Mehr Kaskaden/Stufen kommen mit dem Grafikmenü;
  in der Ferne nur Terrain-Selbstschatten über eine vorberechnete Horizon-Map.
- **Nebel/Distanz-Fade:** Höhen- und Luftperspektiven-Nebel für die Ferne, damit Terrain-LOD-Übergänge nicht auffallen.
- **Präzision:** Bis ca. 8 km reicht float32 (≈ 1 mm). Größere Welten bräuchten Floating Origin, das ist nicht geplant.

---

## 3. Features im Detail

### 3.1 Landscape

**Objekt:** neuer Asset-Typ `landscape` (Kategorie *Landschaft*, mehrere pro Map möglich). Anlegen über einen Dialog
wie in UE5: Größe (Komponenten × Komponenten), Quad-Größe (0,25–4 m), Material-Layer, optional Heightmap-Import.

**Datenmodell**
- Komponenten à 128 × 128 Quads (Kachel für Laden, Undo, GPU-Upload, Kollision).
- Höhe als uint16 mit Skala/Offset pro Landscape (Standard: −256 m … +768 m, 1,6 cm Schritt), im Speicher als Float32 zum Bearbeiten.
- Beispiel 4 km × 4 km bei 1 m: 4096² Samples = 32 MB Höhen + 2 × 64 MB Splatmaps (unkomprimiert), auf der GPU unproblematisch.

**Rendering:** CDLOD (Continuous Distance-Dependent LOD)
- Ein einziges Gitter-Mesh, per Instancing über einen Quadtree verteilt. Der Vertex-Shader liest die Höhe aus einer Textur,
  Morphing zwischen LOD-Stufen ohne Risse.
- Höhen-/Normalen-Textur pro Landscape, beim Malen werden nur geänderte Kacheln hochgeladen.
- Frustum-Culling pro Quadtree-Knoten, Löcher per `discard` im Fragment-Shader.

**Sculpt-Werkzeuge** (alle mit Größe, Stärke, Falloff linear/glatt/kugelförmig/Spitze)
- Anheben/Senken, Glätten, Abflachen (auf Starthöhe oder Zielhöhe, optional nur anheben/nur senken), Rampe (zwei Punkte,
  Breite, Seiten-Falloff), Noise (Frequenz, Seed).
- **Erosion:** hydraulisch (Tropfen-Simulation) und thermisch (Hangabrutschen), als Pinsel oder auf die ganze Fläche/Region.
  Läuft in einem Web Worker, damit der Editor nicht hängt.
- **Löcher:** Sichtbarkeit wegmalen, Kollision dort ebenfalls aus. Dient für Bunker-/Tunnel-Eingänge in Kombination mit Brushes.
- **Region-Tools:** Rechteck auswählen → Kopieren/Einfügen (auch zwischen Landscapes), Spiegeln (X/Z), Drehen um 90°,
  *An Mesh anpassen* (Terrain unter ausgewählten Objekten auf deren Unterkante ziehen, mit Falloff-Rand).
- **Import/Export:** 16-bit PNG (Bibliothek `fast-png`, Browser-Canvas kann nur 8 bit) und RAW `.r16` (Gaea, World Machine, UE).
  Splatmaps als PNG exportier- und importierbar.

**Spiel:** Collider über Rapier-Heightfield, schnelle Höhenabfrage `landscape.heightAt(x, z)` für Spawn, Scripts, Foliage.

> **Umgesetzt (Phase 1, 04.11.2026):** Code in `world/landscape/` (Daten, CDLOD-Renderer, Pinsel, Erosion + Worker,
> Heightmap-I/O, Kollision) und `editor/modes/landscape.ts` (Werkzeug-Panel, Umschalt+2).
> - Höhen im Speicher Float32, gespeichert als uint16 mit Min/Max **pro Speichern** (statt fester −256 … +768 m),
>   Delta-kodiert und mit `fflate` komprimiert, als Blob. Löcher als 1 Byte je Quad.
> - CDLOD-Knoten = 32 × 32 Quads (passt zu den Min/Max-Blöcken), LOD-Abstand über die Grafik-Option *Terrain-Detail*
>   (Niedrig/Mittel/Hoch/Ultra = 1,5/2/2,5/3,5 × Knotengröße). Normalen per Pixel aus eigener Textur.
> - Pinsel in Bildwiederholrate, Erosion als Pinsel im Hauptthread (max. 15 Hz), auf Region/ganze Fläche im Worker
>   mit Fortschritt und Abbrechen. *An Mesh anpassen* wirkt auf die ausgewählten Objekte (Strahl je Gitterpunkt, weicher Rand).
> - Import: Dialog liest Min/Max aus dem PNG-Text-Chunk oder dem Dateinamen (`…_h<min>_<max>.png`); Export schreibt beides.
> - Kollision: Rapier-Heightfield je Komponente, Komponenten mit Löchern als Trimesh.
> - Die Map-Sichtweite (World Settings) skaliert jetzt Nebel und Kamera-`far` im Spiel (Basis 60 m = Faktor 1).
> - Gemessen (RX 7800 XT, 1080p, 4096² aus PNG): Import 1,8 s, Editor ~790 FPS, Spiel ~450–510 FPS,
>   Erosion der ganzen Fläche ~55 s im Worker (Editor bleibt flüssig). Benchmark-Map steht noch aus.

### 3.2 Landscape-Material

- **Layer-Bibliothek:** Bild-Texturen aus `public/assets/textures/<name>/` (Dateien `albedo`, `normal`, `roughness`,
  optional `ao`/`height`) erscheinen automatisch im Content Browser (Vite-Plugin wie bei den Modellen). Dazu Import über
  den Content Browser in IndexedDB. Ohne Dateien: farbige Platzhalter mit Raster-Textur.
- **Pro Layer:** Textur, Kachelgröße (m), Oberflächen-Typ (siehe 3.8), Farbton, Rauheit-Multiplikator, Foliage-Gras-Typ (3.3).
- **Bis 8 Layer** über zwei RGBA-Splatmaps. Texturen liegen in `DataArrayTexture`s (eine pro Kanal), damit nur
  wenige Sampler benötigt werden. Höhen-basiertes Blending, sofern eine Height-Textur vorhanden ist.
- **Auto-Material:** Regeln pro Landscape (z. B. *Fels ab 35° Neigung*, *Schnee über 400 m*, *Kies in Senken*),
  werden im Shader ausgewertet und durch gemalte Layer überschrieben.
- **Triplanar:** ab einer einstellbaren Neigung, nur dort (spart Texturzugriffe auf flachen Flächen).
- **Anti-Kachel-Effekt:** Stochastic Sampling (Hex-Tiling) + großflächige Makro-Variation (Helligkeit/Farbe per Noise).
- **Wetter:** gleiche `onBeforeCompile`-Erweiterung wie heute für Böden (Nässe, Pfützen, Schnee), siehe 3.8.

### 3.3 Foliage

**Foliage-Typen** (Content Browser › *Foliage*): Verweis auf ein .glb-Modell (bis zu 3 LOD-Stufen + optional Impostor)
und Einstellungen: Dichte pro 100 m², Skalierung min/max, zufällige Drehung, Ausrichtung zur Fläche (0–100 %),
Neigungs-/Höhenbereich, Mindestabstand, Sichtweite (Cull-Distanz), Schatten an/aus, Kollision (keine/Zylinder/Kapsel),
Sichtblockade (für Büsche), Wind-Stärke. Ohne Modell: einfache prozedurale Platzhalter (Kreuz-Quads, Kegel, Felsbrocken).

**Werkzeuge (Foliage-Modus)**
- Malen, Radieren (nur ausgewählte Typen oder alle), Auswählen (einzelne Instanzen anwählen, verschieben, löschen),
  *Neu anwenden* (Skalierung/Ausrichtung nachträglich ändern), Füllen (ganzes Mesh/Region).
- **Auf Meshes malen:** Raycast gegen Terrain, Brushes und Objekte (Bibliothek `three-mesh-bvh`, kommt mit `three-bvh-csg`).
  Instanzen auf Objekten merken sich das Objekt und bewegen sich mit oder werden beim Löschen mit entfernt.

**Laufzeit**
- Instanzen in 64 m-Zellen, pro Zelle und LOD ein `InstancedMesh`-Abschnitt (Batching über `BatchedMesh` oder eigene
  Instanz-Puffer). GPU-seitiges Distanz-Culling, Bäume in der Ferne als Impostor (im Editor vorberechnet).
- **Layer-Gras automatisch:** Wo ein Layer mit Gras-Typ gemalt ist, entsteht zur Laufzeit Gras um die Kamera herum
  (Ring aus Kacheln, Dichte aus Splatmap-Gewicht, wird nicht gespeichert). Ausblendung über Distanz.
- **Gras-Interaktion:** Wind aus dem Wetter-Objekt (Richtung/Stärke, Böen-Noise) im Vertex-Shader. Spieler und
  Physik-Objekte schreiben in eine kleine „Biege-Textur“ um die Kamera, die Gras wegdrückt und langsam zurückfedert.
- **Kollision:** Bäume/Steine als Rapier-Collider, nur für Zellen in Spielernähe aktiv. Büsche blockieren Kugeln nicht,
  aber die Sicht (für spätere KI relevant, Flag im Foliage-Typ).
- **Zerstörung:** Instanzen sind einzeln adressierbar (Typ + Index), damit Scripts/Explosionen sie entfernen können.

### 3.4 Splines

**Objekt:** `spline` mit Kontrollpunkten (Position, Tangente, Breite, Roll). Bearbeitung im Splines-Modus:
Klick = Punkt anhängen, Alt+Ziehen an einem Punkt = neuen Punkt einfügen (wie UE5), Tangenten-Griffe ziehen,
*An Terrain einrasten*. Kurventyp Catmull-Rom oder Bézier, gleichmäßige Abtastung nach Bogenlänge.

**Spline-Typen (Details › Typ)**
- **Straße/Weg:** Band-Mesh mit Textur (Länge in Metern gekachelt), Seitenränder, Bordsteine optional. Formt das Terrain
  darunter (Abflachen mit Seiten-Falloff) und malt optional einen Layer (z. B. Kies-Rand). Die Terrain-Änderung ist
  nicht-destruktiv, wird also neu berechnet, wenn die Spline bewegt wird (eigener Höhen-Layer über der gemalten Höhe).
- **Mesh entlang Spline (Zaun/Mauer/Leitplanke):** ein Asset/Modell wird wiederholt oder verformt (Deform entlang der
  Kurve). Optional Pfosten an den Punkten, Abstand, zufällige Variation, Kollision als Trimesh.
- **Kabel/Rohr:** Röhren-Mesh mit Radius, Kabel hängen durch (Kettenlinie mit einstellbarem Durchhang zwischen Punkten),
  optional an Objekte gebunden (Masten bewegen → Kabel folgt).
- **Fluss:** erzeugt einen Wasser-Körper (3.6) mit Fließrichtung entlang der Kurve, gräbt ein Flussbett ins Terrain
  (Tiefe/Breite pro Punkt) und malt Ufer-Layer.

### 3.5 Geometry-Brushes (CSG)

- **Objekt:** `brush` mit Form (Box, Zylinder, Keil, Treppe, Kugel) und Modus **Addieren/Abziehen**, wie BSP-Brushes in UE.
- Brushes werden in Outliner-Reihenfolge verrechnet, das Ergebnis wird live neu berechnet (`three-bvh-csg`), im Hintergrund,
  während des Ziehens mit Vorschau als Drahtgitter.
- Material pro Brush-Fläche, Welt-UVs wie bei den bestehenden Boxen (`worldUV`).
- *In statisches Mesh umwandeln* (Bake) für fertige Geometrie, spart Rechenzeit beim Laden.
- Kollision: Trimesh-Collider über Rapier (nur mit E1 sinnvoll, sonst grobe Box-Zerlegung).
- Wetter: Regen-/Schnee-Verdeckung (Dächer) funktioniert wie bei normalen Objekten.

### 3.6 Wasser

**Wasser-Körper** (Modus *Wasser* / Content Browser): **See** (Fläche aus Umriss-Spline), **Meer** (unendliche Fläche mit
Wellen), **Fluss** (aus Spline, siehe 3.4). Einstellungen: Farbe/Trübung, Sichttiefe, Wellenhöhe, Strömung, Schaum.

**Darstellung**
- Reflexion (bestehende planare Spiegelung aus dem Pfützen-System wiederverwenden, sonst Screen-Space + Himmel),
  Brechung, Tiefen-Färbung, Ufer-Schaum über die Terrain-Tiefe, Flow-Map bei Flüssen.
- Großflächige Wellen: Gerstner-Wellen (Meer), analytisch, damit CPU und GPU dieselbe Höhe kennen.

**Interaktion**
- **Wellen & Spritzer:** GPU-Wellensimulation (Höhenfeld, Ping-Pong-Render-Target ca. 64 × 64 m um die Kamera, 512²).
  Impulse von Spieler-Schritten, Kugeleinschlägen, Physik-Objekten und Scripts. Spritzer/Tropfen über `world/particles.ts`.
  Wellen brechen am Ufer (Tiefe aus Terrain).
- **Spieler im Wasser:** Waten ab Knöchel-/Kniehöhe (langsamer, Geräusch, nasse Hose in `player/body.ts`), Schwimmen ab
  Brusthöhe, Tauchen (Atem-Anzeige), Strömung treibt ab. Unterwasser-Effekt im Bodycam-Pass (`postfx/bodycam.ts`):
  Farbverschiebung, Unschärfe, Linsentropfen beim Auftauchen.
- **Schwimmende Objekte:** Physik-Props bekommen Auftrieb an mehreren Messpunkten (Wasserhöhe inkl. Wellen), Wasserwiderstand,
  Strömung. Im Details-Panel: *Physik › Simuliert, Masse, Auftrieb*.
- **Vorberechnete Fluid-Simulation:** neues Objekt *Fluid-Volumen*. Im Editor: Volumen, Quelle (Füllstand/Zufluss),
  Hindernisse (Brushes/Terrain/Objekte in der Box), Dauer → *Simulation berechnen* (FLIP in einem Web Worker,
  Fortschrittsanzeige, abbrechbar). Ergebnis: Oberflächen-Mesh pro Frame, gespeichert als Vertex Animation Texture.
  Im Spiel: Abspielen per Script (z. B. „Damm bricht“, „Raum läuft voll“), danach optional Übergang in einen statischen
  Wasser-Körper mit Endfüllstand. Spieler/Objekte reagieren nur auf den Füllstand, nicht auf jedes Partikel.

### 3.7 Prefabs / Level Instances

- Auswahl → *Als Prefab speichern* (Name, Pivot). Prefabs erscheinen im Content Browser (*Prefabs*), liegen in IndexedDB
  und im Export-Paket.
- Platzierte Instanz = ein Objekt `prefab` mit Verweis + Overrides (geänderte Props einzelner Unterobjekte).
- *Bearbeiten* (in-place, restliche Szene ausgegraut), Änderungen gelten für alle Instanzen. *Auflösen* macht wieder
  normale Objekte daraus.
- Scripts in Prefabs adressieren ihre Geschwister relativ, damit mehrere Instanzen sich nicht stören.
- Foliage auf Prefab-Meshes und Splines in Prefabs werden mitgenommen.

### 3.8 Gameplay-Integration

- **Oberflächen-Typen:** Tabelle (Erde, Gras, Kies, Fels, Asphalt, Schlamm, Schnee, Holz, Metall, Wasser …) mit
  Schritt-Sound, Einschuss-Effekt (Partikel + Decal), Reibung. Zuordnung: Terrain-Layer (stärkstes Gewicht an der
  Trefferstelle), Material (`world/materials.ts` bekommt ein Feld `surface`), Foliage-Typ.
- **Wetter:** Pfützen bevorzugt in Senken (aus Terrain-Krümmung berechnet, statt nur per Noise), Nässe/Schnee auf dem
  Terrain-Shader, Schnee bleibt an steilen Hängen nicht liegen, Fußspuren auch im Schlamm (Layer-abhängig), Regen macht
  Erd-Layer zu Schlamm (höhere Rutschigkeit). Wind des Wetter-Objekts treibt Foliage und Wasserwellen.
- **Foliage-Kollision:** siehe 3.3.
- **Gras-Interaktion:** siehe 3.3.

### 3.9 Script-Blöcke (Blockly)

| Kategorie | Neue Blöcke |
|---|---|
| Welt › Terrain | Terrain-Höhe an (x, z) · Oberflächen-Typ unter Spieler/Objekt · Höhe bei Position anheben/absenken (Krater) |
| Welt › Foliage | Foliage im Radius entfernen (Typ optional) · Anzahl Foliage im Radius |
| Bewegung › Spline | folge Spline (Geschwindigkeit, Schleife/Pendeln, ausrichten) · Position bei Anteil 0–1 · stoppe |
| Wasser | setze Wasserstand (über Zeit) · erzeuge Welle an Position · spiele Fluid-Simulation ab · ist im Wasser? |
| Physik | Impuls/Kraft anwenden · Physik an/aus · Masse setzen · Ereignis *bei Kollision* |
| Ereignisse | *Spieler betritt Wasser* · *Spieler schwimmt* · *Oberfläche wechselt* |

Die Runtime (`scripting/runtime.ts`) bekommt dafür Schnittstellen zu Landscape, Foliage, Spline, Wasser und Physik.

### 3.10 Grafikmenü (Spiel)

Neue Optionen in `core/settings.ts`, jeweils mit Stufen Niedrig/Mittel/Hoch/Episch:
Sichtweite · Terrain-Detail (LOD-Abstand) · Foliage-Dichte · Foliage-Sichtweite · Gras an/aus · Schatten-Kaskaden ·
Wasser-Qualität (Reflexion, Wellensim-Auflösung) · Physik-Detail (aktive Objekte, Auftriebspunkte).

**Budget auf RX 7800 XT bei „Hoch“** (**E3 entschieden: 1080p**), 16,6 ms pro Frame:

| Posten | Ziel |
|---|---|
| Terrain (CDLOD + Material, 8 Layer) | ≤ 2,5 ms |
| Foliage + Gras | ≤ 4 ms |
| Schatten (Kaskaden) | ≤ 2,5 ms |
| Wasser (Reflexion + Wellensim) | ≤ 2 ms |
| Bestehendes (Volumetrik, Wetter, Post-FX) | ≤ 4 ms |
| Physik + Spiel-Logik (CPU) | ≤ 4 ms, parallel zur GPU |

Messung pro Phase mit einer festen Test-Map (`public/maps/benchmark/`, 4 km², Wald, Fluss, Dorf) und einer
Kameraflug-Strecke. Phase gilt erst als fertig, wenn das Budget eingehalten ist.

---

## 4. Phasen und Reihenfolge

Jede Phase endet mit einem testbaren Stand im Editor **und** im Spiel. Nach jeder Phase: deine Rückmeldung, dann weiter.
Aufwand als grobe Größe (S < M < L < XL).

| # | Phase | Inhalt | Fertig, wenn … | Aufwand |
|---|---|---|---|---|
| 0 | **Fundament** | Editor-Modi, Map-Format v2, Blob-Store + `.bcmap`-Export, Delta-Undo, Rapier-Welt, Spieler auf Rapier-Charakter (E1), Reversed-Z/Sichtweite (E2), CSM | Bestehende `start.json` läuft unverändert und fühlt sich gleich an; Export/Import mit Blobs funktioniert | L |
| 1 | **Landscape: Form** | Landscape-Objekt, CDLOD, Sculpt-Werkzeuge, Löcher, Region-Tools, Heightmap Import/Export, Erosion, Kollision | 4 × 4 km bei 1 m flüssig formbar; Spieler läuft darauf, Schüsse treffen | XL |
| 2 | **Landscape: Material** | Textur-Bibliothek, 8 Layer malen, Auto-Material, Triplanar, Anti-Kachel, Oberflächen-Typen, Wetter auf Terrain | Mit eigenen Texturen sieht der Boden aus nächster Nähe und aus 1 km gut aus; Schritt-Sounds/Einschüsse je Layer | L |
| 3 | **Foliage** | Foliage-Typen, Pinsel, Malen auf Meshes, Layer-Gras, Wind + Biegen, Kollision, Impostors | Wald mit 100 000+ Bäumen und dichtem Gras im Budget | XL |
| 4 | **Splines** | Spline-Editor, Straße (Terrain formen), Mesh entlang Spline, Kabel/Rohre | Straße über Hügel, Leitplanke mit Kollision, Stromleitung zwischen Masten | L |
| 5 | **Brushes** | CSG-Brushes, Materialien, Bake, Trimesh-Kollision | Bunker mit Fenster-/Türlöchern aus Brushes, begehbar, Tunnel durch Landscape-Loch | M |
| 6 | **Wasser** | See/Meer/Fluss, Darstellung, Wellensim, Spieler im Wasser, Physik-Props + Auftrieb | Fluss mit Strömung, treibende Fässer, Waten/Schwimmen/Tauchen | XL |
| 7 | **Fluid-Bake** | Fluid-Volumen, FLIP-Worker, VAT-Speicher, Abspielen | „Raum läuft voll“ als Script-Ereignis abspielbar | L |
| 8 | **Prefabs** | Speichern, Instanzen, Overrides, In-Place-Bearbeitung | Haus-Prefab 10× platziert, einmal geändert → alle aktualisiert | M |
| 9 | **Script-Blöcke + Grafikmenü** | Blöcke aus 3.9, Grafikoptionen aus 3.10, README/Hilfe | Alle Blöcke dokumentiert; Grafikstufen messbar unterschiedlich | M |

Abhängigkeiten: 0 → 1 → 2 → 3. Splines (4) brauchen 1, Flüsse aus 4 brauchen 6. Brushes (5) und Prefabs (8) können
nach Phase 0 jederzeit vorgezogen werden. Script-Blöcke entstehen jeweils mit ihrem Feature, Phase 9 räumt nur auf.

---

## 5. Neue Abhängigkeiten

| Paket | Zweck | Lizenz |
|---|---|---|
| `@dimforge/rapier3d-compat` | Physik, Kollision, Charakter-Controller, Raycasts | Apache-2.0 |
| `three-bvh-csg` + `three-mesh-bvh` | CSG-Brushes, schnelle Raycasts beim Malen auf Meshes | MIT |
| `fflate` | ZIP für `.bcmap`-Export/-Import, Kompression der Undo-Deltas | MIT |
| `fast-png` | 16-bit-PNG lesen/schreiben (Heightmaps) | MIT |

Three.js ist auf 0.186 aktualisiert (E2); Volumetrik, Himmel, Spiegelungen und Lampen-Schatten sind an Reversed-Z
angepasst. Weitere Pakete werden beim Einbau auf Kompatibilität mit `three@0.186` geprüft.

---

## 6. Entscheidungen (03.11.2026)

- **E1: Spieler-Kollision auf Rapier umstellen?** → **Ja.** Empfohlen, weil sonst Heightfield, Trimesh (Brushes/Splines) und
  dynamische Objekte doppelt implementiert werden müssten. Risiko: Das Bewegungsgefühl muss nachjustiert werden.
  Alternative: eigene Kollision behalten und nur um Heightfield + Trimesh mit Spatial Grid erweitern.
- **E2: Three.js aktualisieren** → **Ja (r186, Reversed-Z).** für Reversed-Z (saubere Tiefe bis km-Entfernung) oder bei 0.169 bleiben und
  `logarithmicDepthBuffer` nutzen (einfacher, etwas langsamer, verträgt sich schlechter mit Volumetrik/Tiefen-Effekten).
- **E3: Zielauflösung** für das 60-FPS-Ziel auf der RX 7800 XT → **1080p.**
- **E4: Größte Landscape-Größe** → **8 × 8 km bei 1 m bzw. 16 × 16 km bei 2 m** (wie vorgeschlagen).
  Darüber würde Streaming nötig, das ist nicht eingeplant.

---

## 7. Risiken

- **Browser-Speicher:** IndexedDB-Kontingent ist meist großzügig (Prozent des freien Speichers), kann aber vom Browser
  geräumt werden → Editor fordert `navigator.storage.persist()` an und erinnert an den Export.
- **WebGL2-Grenzen:** keine Compute-Shader. Wellensim und Gras laufen über Render-Targets/Vertex-Shader, Fluid-Bake auf
  der CPU im Worker (langsamer, deshalb vorberechnet).
- **Ladezeiten:** große Maps → Lade-Fortschritt, Splatmaps/Heightmaps komprimiert im Paket, Foliage-Zellen erst bei Bedarf aufbauen.
- **Bestehende Systeme:** Wetter, Volumetrik und Spiegelungen sind auf kleine Innen-/Außenbereiche ausgelegt. Jede Phase
  enthält einen Regressionstest mit `start.json`.
