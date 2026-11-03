# BodyCam-like Game — Entwicklungsplan

Nov 3, 2026 · @Darius Damman

Dieser Plan führt vom spielbaren Blockout bis zum Launch in fünf Meilensteinen — 3D-Assets starten als Platzhalter (Download/KI-generiert) und werden später durch eigene Modelle ersetzt.

**Roadmap:** 1. Blockout & Core-Tech → *(Gate: Core-Loop spielbar)* → 2. Gameplay-Systeme (Playable Prototype) → *(Gate: Gameplay steht fest)* → 3. Platzhalter-Art & Bodycam-Pass (Vertical Slice) → *(Gate: Vertical Slice genehmigt)* → 4. Multiplayer-Infrastruktur (Alpha) → *(Gate: Netcode stabil)* → 5. Custom-Art, Testing & Launch (Beta)

## Phase 1 — Blockout / Box-Leveling

- Level-Layout ausschließlich mit Primitiven (Boxen, Zylindern) bauen — keine finalen Assets, nur Maße und Sichtlinien
- Spielbaren Core-Loop auf dem Blockout testen: Movement, Kollision, grundlegendes Schießen
- Maßstab (Charaktergröße, Türbreiten, Deckungshöhen) anhand von Platzhalter-Würfeln validieren
- Nebel-/Sichtweiten-Mechanik bereits im Blockout grob simulieren (Fog-Plane + Distanz-Fade)
- Erst wenn das Blockout spielerisch funktioniert, wird in Content investiert — jede spätere Asset-Investition baut auf einem geprüften Layout auf

## Phase 2 — Core-Tech & Gameplay-Systeme

- Rendering-Pipeline aufsetzen: WebGPU als Ziel, WebGL2 als Fallback
- Netcode-Grundgerüst: Client-Side Prediction, Server-Reconciliation, Lobby-/Matchmaking-Grundfunktion
- Physik-Engine einbinden (z. B. Rapier oder Jolt via WASM) für Kollision, später Destruction & Ragdoll
- Gameplay-Systeme nacheinander auf dem Blockout implementieren: Schießen/Hit-Detection → Waffen-Customization → Taschenlampe → Umgebungszerstörung → Feuer → Wetter/Nebel
- Ziel dieser Phase: ein spielbarer Prototyp mit allen Kernmechaniken, noch ohne finale Optik

## Phase 3 — 3D-Assets: von Platzhaltern zu eigenen Modellen

1. Platzhalter-Phase (parallel zu Phase 1–2): kostenlose/lizenzierte Asset-Packs (Kenney.nl, Quaternius, Sketchfab CC0) für Waffen, Props, Umgebung
2. KI-generierte Modelle für schnelle Iteration (z. B. Meshy, Luma AI, Tripo) — schneller Ersatz für generische Blockout-Objekte, Qualität reicht für die Vertical Slice
3. Platzhalter-Texturen aus PBR-Material-Bibliotheken (Poly Haven, ambientCG) für den Shader-Pass
4. Erst wenn das Gameplay steht und die Vertical Slice genehmigt ist: eigene Modelle in Blender (oder durch beauftragte Artists) für Kernobjekte — Waffen, Charaktere, Signature-Props
5. Platzhalter werden Stück für Stück ausgetauscht, nie alle gleichzeitig — so bleibt das Spiel durchgehend testbar
6. Für den Browser: LOD-Stufen, Draco-Kompression, Texturatlanten zur Reduktion der Ladezeiten

## Phase 4 — Bodycam-Effekte & Shader-Pass

- Post-Processing-Pipeline: Sensorrauschen, chromatische Aberration, Motion Blur, Autofokus-Puls, REC-Overlay
- Realistic-Shader-Pass: PBR-Materialien, Screen-Space Reflections, volumetrisches Licht, Wet-Surface bei Regen
- Intensität der Bodycam-Effekte als Einstellung (kompetitiv vs. immersiv) von Anfang an einbauen, nicht nachträglich
- Dieser Pass läuft auf den Platzhalter-Assets aus Phase 3 — zeigt früh, wie das fertige Spiel wirken wird

## Phase 5 — Multiplayer-Infrastruktur & Backend

- Dedizierte Game-Server-Instanzen (autoritative Simulation, Hit-Validation, Destruction-/Fire-Sync)
- Matchmaking- und Lobby-Service, Skalierung für mehrere gleichzeitige Matches
- Backend für Accounts, Loadouts, Statistiken — Persistenz in einer Datenbank
- Serverseitige Anti-Cheat-Validierung (Lag-Compensation, Hit-Checks), da der Browser keinen Kernel-Zugriff erlaubt
- Erste echte Multiplayer-Tests mit 4–8 Spielern parallel zu dieser Phase

## Phase 6 — Testing, Balancing & Launch-Vorbereitung

- Playtests in wachsender Gruppengröße (4 → 8 → 16 Spieler), Fokus auf Netcode-Stabilität und Performance im Browser
- Balancing von Waffen-Attachments, Zerstörung und Feuerausbreitung anhand der Playtest-Daten
- Finaler Austausch verbleibender Platzhalter-Assets gegen Custom-Modelle
- Performance-Profiling browserspezifisch (Chrome/Firefox/Safari), WebGPU- und WebGL2-Pfade einzeln testen
- Release-Vorbereitung: Monitoring, Analytics, Live-Ops-Plan für Season-Content nach Launch
