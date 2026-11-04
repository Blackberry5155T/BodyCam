import * as THREE from 'three';

// Schatten für Punkt-/Spotlichter (Lampen, Feuer, Taschenlampe).
// Seit three r18x vergleichen Punkt- und Spot-Schatten die *perspektivische* (nichtlineare) Tiefe.
// shadow.bias wirkt deshalb je nach Entfernung völlig unterschiedlich: der alte Wert -0.003 entsprach
// bei 3 m ≈ 0.3 m, bei 6 m > 1 m Versatz – die Schatten verschwanden praktisch.
// Darum: nur ein winziger Tiefen-Bias, die eigentliche Akne-Vermeidung über normalBias (in Metern, konstant).

export function setupLightShadow(light: THREE.PointLight | THREE.SpotLight, size = 512): void {
  light.castShadow = true;
  light.shadow.mapSize.set(size, size);
  light.shadow.bias = -0.00002;
  // ≈ 1–2 Texel der Schattenkarte auf typische Raumdistanzen; dünner als übliche Wände (kein Lichtleck)
  light.shadow.normalBias = light instanceof THREE.PointLight ? 0.035 : 0.02;
  light.shadow.radius = 3;
  light.shadow.camera.near = 0.1;
}
