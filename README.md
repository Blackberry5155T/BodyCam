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
- **Testen:** *Simulieren* (Alt+S) führt Scripts im Editor aus: Kamera = Spieler, Klick = Benutzen, Shift+Klick = Treffer.
  *Spielen* (Alt+P) speichert und öffnet die Map im Spiel (`/?map=local:<Name>`). Erneutes Speichern lädt den Spiel-Tab neu.
- **Speichern:** Maps liegen im Browser (localStorage). *Datei › Als JSON exportieren / importieren* für Dateien.
  Importierte .glb-Modelle liegen in IndexedDB desselben Browsers und sind nicht in der exportierten JSON enthalten.
- **Mitgelieferte Map ändern:** im Editor exportieren und die Datei als `src/maps/<name>.json` ablegen
  (z. B. `start.json` ersetzen), neue Maps in `src/maps/index.ts` eintragen. Aufruf: `/?map=<id>`.

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
    index.ts              Map-Register
    start.json            Startmap mit Menü-Terminal
  world/                  Bausteine für Maps
    mapFormat.ts          JSON-Format (Objekte, World Settings)
    mapLoader.ts          Baut die Szene aus MapData (Spiel + Editor), Collider, Sonne/Himmel
    assets.ts             Asset-Registry: alle Objekttypen, Eigenschaften, Content-Browser-Presets
    materials.ts          Benannte Materialien (prozedurale Texturen)
    volumetrics.ts        Nebelvolumen (Raymarching), Lichtkegel, Staubpartikel
    modelStore.ts         GLB laden (Projekt-Ordner + im Browser importiert)
    mapStore.ts           Maps im Browser speichern, Export/Import
    collision.ts          Collider-Typen (Box, gedrehte Box, Zylinder) + Referenzmaßstab (SCALE)
    builder.ts            Älterer MapBuilder für Code-Maps (derzeit ungenutzt)
    props/                Interaktive Objekte (terminal.ts = Menü-Bildschirm)
  scripting/
    blocks.ts             Block-Definitionen + Code-Generator (nur Editor)
    runtime.ts            Führt Objekt-Scripts aus (Spiel + Simulieren im Editor)
  editor/                 Map-Editor: Viewport, Outliner, Details, Content Browser, Script-Fenster
  player/
    controller.ts         Bewegung, Kollision, Kamera (Wippen, Rückstoß, Autopilot)
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
