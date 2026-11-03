# BodyCam-like Game — Master Design Document

Nov 3, 2026 · @Darius Damman

## Vision & Konzept

Ein realistischer, atmosphärischer Multiplayer-Shooter im Browser, der die Bodycam-Ästhetik (verwackelte Egosicht, Linsenverzerrung, Sensorrauschen) mit echter Zerstörung, Feuer und einem dynamischen Wettersystem verbindet.

- Referenzen: BodyCam (Nexus Studio), Unrecord, GTFO (Atmosphäre), Rust (Destruction/Survival)
- Zielgruppe: PC-Spieler mit Mid-Range-Hardware, die kompetitiven oder Koop-Horror/Tactical-Shooter ohne Installation wollen
- Kernfantasie: Du trägst die Kamera am Körper. Jede Begegnung wirkt wie Found-Footage — Rauschen, Autofokus-Wobble, Motion Blur, Nachtsicht/IR-Modus
- Ton: Spannung durch Unsicherheit (Nebel, Dunkelheit, Sounddesign), nicht durch reinen Gore — glaubwürdige, geerdete Welt

## Core Pillars — die geforderten Features verfeinert

| Feature | Kernidee | Verfeinerung |
| --- | --- | --- |
| Bodycam-Effekte | VHS/Helmkamera-Optik als Markenzeichen | Intensität einstellbar (kompetitiv vs. immersiv); chromatische Aberration, Sensorrauschen, Kamera-Wobble bei Bewegung, Autofokus-Puls bei Nahdistanz, REC/Zeitstempel-Overlay, Signal-Glitch bei Treffern als Gameplay-Feedback |
| Realistic Shader | PBR-Rendering, physikalisch korrekte Materialien | Screen-Space Reflections (Raytracing optional, je nach GPU), volumetrisches Licht, Wet-Surface-Shader bei Regen, dynamische Schatten |
| Multiplayer | Echtzeit PvP/PvE direkt im Browser | WebTransport/WebRTC für niedrige Latenz, Client-Side Prediction + Server-Reconciliation, Lobbies 4–16 Spieler je Modus |
| Taschenlampe | Dynamische Lichtquelle | Begrenzte Akkulaufzeit, Flackern bei Nässe, wirft Schatten im Nebel sichtbar, taktisches Risiko — verrät die eigene Position |
| Wettersystem inkl. Nebel | Dynamisches Tag/Nacht- und Wettersystem | Nebeldichte steuert Sichtweite und Sounddesign, Regen nässt Oberflächen (Rutschgefahr, Spiegelungen), Wind beeinflusst Partikel/Rauch/Feuer, Gewitter mit Blitzen als kurze Lichtquelle |
| Waffen-Customization | Modulares Attachment-System | Visier, Lauf, Griff, Magazin, Mündungsaufsatz — jedes Teil verändert Recoil/Sway/Sound messbar; Skins rein kosmetisch, kein Pay-to-Win |
| Umgebungszerstörung | Physikbasierte Zerstörung | Wände, Holz und Glas zerstörbar; Deckung verändert sich während des Gefechts; Chunk-basiertes Destruction-Mesh für Performance-Budget |
| Realistisches Feuer | Dynamische Ausbreitung | Breitet sich auf brennbaren Materialien aus, erzeugt sichtbehindernden Rauch, wird vom Wind getrieben, löschbar durch Wasser/Regen |

## Technische Architektur

Vier Schichten, jeweils an die nächste gereiht:

**Browser Client** (Rendering, Physik; Input, Audio, UI) → **Netzwerk-Layer** (WebTransport/RTC; Client-Prediction) → **Game Server** (Autoritative Sim; Destruction/Feuer) → **Backend** (Matchmaking, Auth; Loadouts, Stats)

Der Game Server hält die autoritative Wahrheit für Physik, Treffer und Zerstörung; ein CDN liefert Assets separat direkt an den Client, und die Backend Services verwalten zusätzlich die Persistenz in einer Datenbank.

## Weitere fixe Features

| Feature | Kernidee | Verfeinerung |
| --- | --- | --- |
| Sound-basiertes Gameplay | Geräusch als Hauptortungsmittel | Schritte, Atmung und Waffenlärm dringen gedämpft durch Nebel/Wände; Richtungshören über Positional Audio entscheidet Gefechte bei schlechter Sicht |
| NVG/Thermal-Attachment | Alternative zur Taschenlampe | Sichtbar für Gegner (Glow-Effekt bei NVG), eigener Akku, Thermal zeigt Wärmequellen (Spieler, Feuer) durch Nebel/Rauch |
| Extraction-Modus | Tarkov-artiger Loot-Run | Loot sammeln und extrahieren, Permadeath verliert die Ausrüstung bei Scheitern, Zeitdruck durch Wetter |
| Horde/Survival-Koop | Koop gegen Wellen von KI-Gegnern | Nebel-Szenario, steigender Schwierigkeitsgrad, gemeinsames Ressourcen-Management |
| PvE-Koop-Variante | Dynamische KI-Kreaturen | "Hunt"-Modus im Nebel, KI reagiert auf Lärm und Licht der Spieler |
| Voice Chat mit räumlichem Audio | Proximity Chat | Post-Launch-Feature; Lautstärke und Richtung abhängig von Distanz und Hindernissen |
| Interaktive Umgebung | Umgebung als taktisches Werkzeug | Türen verriegeln/barrikadieren, Fenster als Fluchtweg, Generatoren für Strom und Licht |
| Replay-System | Matches aufzeichnen | Export/Teilen als "Bodycam-Footage" — passt direkt zum Spielthema |
| Modding/Workshop-Support für Maps | Community-Content | Langfristiges Ziel; eigener Map-Editor oder Workshop-Upload |
| Ragdoll Physics | Physikalisch korrekte Körper bei Tod/Treffern | Trefferreaktion und Ragdoll-Übergänge serverseitig synchronisiert, Interaktion mit Zerstörung und Explosionen |
