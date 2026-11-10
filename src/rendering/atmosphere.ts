import * as THREE from 'three';

// Atmosphäre: ersetzt den linearen three.js-Distanznebel in ALLEN Materialien (Standard-, Shader-, Wetter-,
// Wasser- und Volumen-Materialien) durch ein physikalisch plausibleres Modell:
//
//  - Distanznebel als Exponential-Quadrat-Kurve: nah klar, zur Sichtweite hin dicht (bei fogFar ≈ 96 %).
//    Bis zur halben Sichtweite deckt er etwa wie der frühere lineare Nebel, läuft dahinter aber weich aus.
//    Gemessen wird die echte Entfernung zur Kamera, nicht die Tiefe entlang der Blickachse – der Nebel
//    „atmet“ deshalb nicht mehr, wenn man die Kamera dreht.
//  - Höhennebel: analytisch integrierte Schicht mit exponentiellem Dichteabfall nach oben (Bodennebel,
//    Talnebel). Ersetzt die frühere halbtransparente Nebel-Plane.
//  - Einstreuung der Sonne: Richtung Sonne hellt der Nebel in Sonnenfarbe auf (Mie-Vorwärtsstreuung).
//  - Blitze hellen den Nebel kurz auf.
//
// Technik: die fog-Chunks von three werden überschrieben; die drei zusätzlichen Uniforms hängt
// Material.prototype.onBeforeCompile in jedes Material (Materialien mit eigenem onBeforeCompile rufen
// injectAtmosphere() selbst auf). Fehlen die Uniforms, sind sie 0 → reiner Distanznebel, nichts bricht.

const uniforms = {
  /** x = Basishöhe (Welt-Y), y = 1/Skalenhöhe, z = Dichte an der Basis (1/m), w = Aufhellung (Blitz) */
  bcFogA: { value: new THREE.Vector4(0, 1, 0, 0) },
  bcFogSunDir: { value: new THREE.Vector3(0, 1, 0) },
  bcFogSunCol: { value: new THREE.Color(0, 0, 0) },
};

/** Uniform-Deklarationen + Nebelfunktionen; erwartet fogColor und (fogNear, fogFar) bzw. fogDensity */
export const ATMOSPHERE_GLSL = /* glsl */ `
  uniform vec4 bcFogA;
  uniform vec3 bcFogSunDir;
  uniform vec3 bcFogSunCol;

  // optische Tiefe der Höhennebel-Schicht entlang ray (Weltkoordinaten, ab Kamera)
  float bcHeightTau( vec3 ray ) {
    if ( bcFogA.z <= 0.0 ) return 0.0;
    float h0 = max( ( cameraPosition.y - bcFogA.x ) * bcFogA.y, - 1.0 );
    float h1 = max( ( cameraPosition.y + ray.y - bcFogA.x ) * bcFogA.y, - 1.0 );
    float dh = h1 - h0;
    float k = abs( dh ) > 1e-3 ? ( exp( - h0 ) - exp( - h1 ) ) / dh : exp( - h0 );
    return bcFogA.z * length( ray ) * k;
  }

  // Nebelanteil 0..1 für einen Punkt bei cameraPosition + ray
  float bcFogFactor( vec3 ray ) {
    float d = length( ray );
    #ifdef FOG_EXP2
      float x = fogDensity * d;
      float tau = x * x;
    #else
      float x = max( d - fogNear, 0.0 ) / max( fogFar - fogNear, 1e-3 );
      float tau = 3.2 * x * x;
    #endif
    return 1.0 - exp( - ( tau + bcHeightTau( ray ) ) );
  }

  // Nebelfarbe in Blickrichtung: Grundfarbe + Einstreuung Richtung Sonne
  vec3 bcFogColor( vec3 ray ) {
    float c = max( dot( normalize( ray ), bcFogSunDir ), 0.0 );
    float c2 = c * c;
    float c8 = c2 * c2 * c2 * c2;
    return fogColor * ( 1.0 + bcFogA.w ) + bcFogSunCol * ( c2 * c2 * 0.35 + c8 * c8 * 0.65 );
  }
`;

THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogRay;
#endif
`;

// v * M = transpose( M ) * v: View-Vektor zurück in Weltachsen (Strahl Kamera → Punkt)
THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogRay = mvPosition.xyz * mat3( viewMatrix );
#endif
`;

THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogRay;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  ${ATMOSPHERE_GLSL}
#endif
`;

THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  gl_FragColor.rgb = mix( gl_FragColor.rgb, bcFogColor( vFogRay ), bcFogFactor( vFogRay ) );
#endif
`;

/** Atmosphären-Uniforms per Referenz in einen Shader hängen (für Materialien mit eigenem onBeforeCompile) */
export function injectAtmosphere(shader: { uniforms: Record<string, THREE.IUniform> }): void {
  shader.uniforms.bcFogA = uniforms.bcFogA;
  shader.uniforms.bcFogSunDir = uniforms.bcFogSunDir;
  shader.uniforms.bcFogSunCol = uniforms.bcFogSunCol;
}

// Standard für alle Materialien ohne eigenes onBeforeCompile
THREE.Material.prototype.onBeforeCompile = function (shader) {
  injectAtmosphere(shader);
};

const _c = new THREE.Color();

class Atmosphere {
  readonly uniforms = uniforms;
  /** Nebel insgesamt an (Einstellung „Nebel“) */
  private on = true;
  /** z. B. unter Wasser: nur noch der Distanznebel des Wassers */
  private suppressed = false;
  private layerOn = false;
  private layerOpacity = 0;
  private layerHeight = 0.4;
  private layerBase = 0;
  private sunColor = new THREE.Color();
  private sunIntensity = 0;
  private overcast = 0;
  private flash = 0;

  /** Bodennebel-Schicht aus den World Settings: opacity ≈ Deckung beim Blick von oben, height = Dicke (m) */
  setLayer(on: boolean, opacity: number, height: number, base = 0): void {
    this.layerOn = on;
    this.layerOpacity = THREE.MathUtils.clamp(opacity, 0, 0.98);
    this.layerHeight = Math.max(0.05, height);
    this.layerBase = base;
    this.refresh();
  }

  /** Sonne: dir zeigt zur Sonne (normiert) */
  setSun(dir: THREE.Vector3, color: THREE.Color, intensity: number): void {
    uniforms.bcFogSunDir.value.copy(dir).normalize();
    this.sunColor.copy(color);
    this.sunIntensity = Math.max(0, intensity);
    this.refresh();
  }

  /** Wetter: Bewölkung 0..1 dämpft die Einstreuung, Blitz hellt den Nebel auf */
  setWeather(overcast: number, flash: number): void {
    if (overcast === this.overcast && flash === this.flash) return;
    this.overcast = overcast;
    this.flash = flash;
    this.refresh();
  }

  setEnabled(on: boolean): void {
    this.on = on;
    this.refresh();
  }

  setSuppressed(v: boolean): void {
    if (v === this.suppressed) return;
    this.suppressed = v;
    this.refresh();
  }

  private refresh(): void {
    const a = uniforms.bcFogA.value;
    const active = this.on && !this.suppressed;
    // Skalenhöhe: die Schicht ist etwa „height“ dick, läuft darüber weich aus
    const scale = Math.max(0.2, this.layerHeight * 1.25);
    // senkrecht von oben durch die ganze Schicht geschaut ≈ halbe eingestellte Deckung
    // (flach geschaut summiert sich deutlich mehr auf – so wirkt Bodennebel)
    const density = active && this.layerOn ? -Math.log(1 - this.layerOpacity * 0.5) / scale : 0;
    a.set(this.layerBase, 1 / scale, density, active ? this.flash * 2 : 0);
    const clear = 1 - this.overcast;
    const up = THREE.MathUtils.smoothstep(uniforms.bcFogSunDir.value.y, -0.06, 0.1);
    const k = active ? Math.min(this.sunIntensity, 8) * 0.12 * clear * clear * up : 0;
    uniforms.bcFogSunCol.value.copy(_c.copy(this.sunColor).multiplyScalar(k));
  }
}

export const atmosphere = new Atmosphere();
