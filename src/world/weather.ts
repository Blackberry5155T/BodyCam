import * as THREE from 'three';
import type { WorldSettings } from './mapFormat.ts';
import type { WorldRig } from './mapLoader.ts';

// Wettersystem: Regen, Nieselregen, Gewitter, Schnee.
//
// Bausteine:
//  - Niederschlag als GPU-Partikel (Regenstreifen, Schneeflocken, Spritzer) in einer Box um die Kamera.
//  - Abdeckungskarte: Höhenbild der Szene von oben (orthografisch). Damit regnet es nicht durch Dächer,
//    und Böden unter Dächern bleiben trocken.
//  - Material-Patch für alle MeshStandardMaterials: Nässe (dunkler, glatter), Pfützen (Wasserfilm mit
//    Regenringen), Schneedecke. Nässe und Pfützen wachsen mit der Zeit und trocknen danach langsam ab.
//  - Spiegelungen: planare Reflexion (Szene gespiegelt an der Bodenhöhe unter der Kamera), Fresnel-
//    gewichtet; außerhalb dieser Ebene Rückfall auf die Himmelsfarbe.
//
// Ablauf pro Frame: update(dt, t, camera) → render(camera) → normales Rendern der Szene.

export type WeatherType = 'klar' | 'niesel' | 'regen' | 'gewitter' | 'schnee';

export const WEATHER_OPTIONS: { value: WeatherType; label: string }[] = [
  { value: 'klar', label: 'Klar / trocken' },
  { value: 'niesel', label: 'Nieselregen' },
  { value: 'regen', label: 'Regen' },
  { value: 'gewitter', label: 'Gewitter' },
  { value: 'schnee', label: 'Schnee' },
];

interface WeatherPreset {
  rain: number;
  snow: number;
  cloud: number;
  lightning: boolean;
}

const PRESETS: Record<WeatherType, WeatherPreset> = {
  klar: { rain: 0, snow: 0, cloud: 0, lightning: false },
  niesel: { rain: 0.3, snow: 0, cloud: 0.5, lightning: false },
  regen: { rain: 1, snow: 0, cloud: 0.75, lightning: false },
  gewitter: { rain: 1.6, snow: 0, cloud: 0.9, lightning: true },
  schnee: { rain: 0, snow: 1, cloud: 0.6, lightning: false },
};

export function isWeatherType(v: unknown): v is WeatherType {
  return typeof v === 'string' && v in PRESETS;
}

/** Spiegelungsqualität: 0 = nur Himmel, 1 = planar mit 1/4 Auflösung, 2 = planar mit 1/2 Auflösung */
export type ReflectionQuality = 0 | 1 | 2;

const OCC_SIZE = 96; // Kantenlänge der Abdeckungskarte (m)
const OCC_RES = 1024;
const OCC_ABOVE = 100; // Kamera der Abdeckungskarte steht so weit über der Spielerkamera
const OCC_BELOW = 40; // tiefer liegende Flächen werden ignoriert
const OCC_INTERVAL = 0.2; // s; fängt auch bewegte Objekte (Türen, Plattformen) ein
const SCAN_INTERVAL = 0.5; // s; neue Objekte/Materialien finden (Modelle laden asynchron)
const PROBE_INTERVAL = 0.15; // s; Bodenhöhe + "steht der Spieler im Freien?"

const RAIN_MAX = 14000;
const SNOW_MAX = 9000;
const SPLASH_MAX = 900;
const RAIN_BOX = new THREE.Vector3(26, 16, 26);
const SNOW_BOX = new THREE.Vector3(30, 16, 30);
const SPLASH_AREA = 18;
const RAIN_SPEED = 9;
const SNOW_SPEED = 1.1;

// Spuren des Spielers
const MAX_PRINTS = 64; // Fußabdrücke im Schnee (Ringpuffer)
const MAX_STEPS = 16; // Wellenringe in Pfützen
const STRIDE = 0.72; // m pro Schritt
const FOOT_SPREAD = 0.11; // seitlicher Abstand eines Fußes zur Mitte
const STEP_RIPPLE_LIFE = 3; // s

// ---------- GLSL ----------

const OCC_GLSL = /* glsl */ `
  uniform sampler2D wOccTex;
  uniform vec2 wOccCenter;
  uniform float wOccSize;
  uniform float wOccBase;
  uniform float wOccOn;
  // Höhe der obersten Fläche über xz (sehr klein = nichts darüber / außerhalb der Karte)
  float wOccTop( vec2 xz ) {
    vec2 uv = vec2( xz.x - wOccCenter.x, wOccCenter.y - xz.y ) / wOccSize + 0.5;
    if ( wOccOn < 0.5 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 ) return -1e4;
    float h = texture2D( wOccTex, uv ).r;
    return h > 0.0 ? h + wOccBase : -1e4;
  }
`;

const HASH_GLSL = /* glsl */ `
  float wHash( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }
`;

const SURFACE_PARS = /* glsl */ `
  varying vec3 vWPos;
  varying vec3 vWNrm;
  uniform float wWet;
  uniform float wPuddle;
  uniform float wSnow;
  uniform float wRain;
  uniform float wTime;
  uniform float wFlash;
  uniform sampler2D wReflTex;
  uniform mat4 wReflMatrix;
  uniform float wReflY;
  uniform float wReflOn;
  uniform vec3 wSkyZenith;
  uniform vec3 wSkyHorizon;
  // Fußabdrücke: x, y, z, Packwert (Vorzeichen = Fuß, ganzzahlig = Tiefe, Bruch = Richtung)
  uniform vec4 wPrints[ ${MAX_PRINTS} ];
  uniform int wPrintN;
  // Schritte in Pfützen: x, y, z, Startzeit
  uniform vec4 wSteps[ ${MAX_STEPS} ];
  uniform int wStepN;
  ${OCC_GLSL}
  ${HASH_GLSL}

  float wNoise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = fract( p );
    vec2 u = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( wHash( i ), wHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( wHash( i + vec2( 0.0, 1.0 ) ), wHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
  }

  float wFbm( vec2 p ) {
    float v = 0.0;
    float a = 0.5;
    for ( int i = 0; i < 4; i ++ ) {
      v += a * wNoise( p );
      p = p * 2.03 + 17.1;
      a *= 0.5;
    }
    return v / 0.9375;
  }

  // Anteil "unter freiem Himmel" (0..1), weich über mehrere Proben
  float wExposure( vec3 p, float r ) {
    if ( wOccOn < 0.5 ) return 1.0;
    float y = p.y + 0.2;
    float e = step( wOccTop( p.xz ), y );
    e += step( wOccTop( p.xz + vec2( r, 0.0 ) ), y );
    e += step( wOccTop( p.xz - vec2( r, 0.0 ) ), y );
    e += step( wOccTop( p.xz + vec2( 0.0, r ) ), y );
    e += step( wOccTop( p.xz - vec2( 0.0, r ) ), y );
    return e / 5.0;
  }

  // Regenringe: je Zelle ein Tropfeneinschlag mit Zufallszeit; liefert den Höhengradienten
  vec2 wRippleLayer( vec2 p, float t, float density ) {
    vec2 cell = floor( p );
    vec2 f = fract( p );
    float h = wHash( cell );
    float tt = t * 1.4 + h * 7.0;
    float life = fract( tt );
    float cyc = mod( floor( tt ), 1000.0 );
    float on = step( wHash( cell + cyc * 0.731 ), density );
    vec2 c = vec2( wHash( cell + 1.7 + cyc ), wHash( cell + 5.3 + cyc ) ) * 0.5 + 0.25;
    vec2 d = f - c;
    float dist = length( d ) + 1e-4;
    float x = dist - life * 0.3;
    float env = exp( - x * x * 900.0 ) * ( 1.0 - life ) * ( 1.0 - life );
    float dw = ( 70.0 * cos( 70.0 * x ) - 1800.0 * x * sin( 70.0 * x ) ) * env;
    return d / dist * dw * on;
  }

  vec2 wRipples( vec2 xz ) {
    vec2 g = wRippleLayer( xz * 2.5, wTime, wRain ) + wRippleLayer( xz * 3.3 + 11.3, wTime * 1.13 + 3.1, wRain * 0.8 );
    return g * 0.0035;
  }

  // Sohlenprofil (lokal: x seitlich nach außen, y nach vorn, in m): -1 = voll eingedrückt, + = aufgeschobener Rand
  float wSole( vec2 q ) {
    float ball = length( ( q - vec2( 0.008, 0.05 ) ) / vec2( 0.05, 0.1 ) );
    float heel = length( ( q - vec2( 0.0, - 0.1 ) ) / vec2( 0.043, 0.05 ) );
    float d = min( ball, heel );
    float inside = 1.0 - smoothstep( 0.78, 1.0, d );
    float rim = smoothstep( 0.92, 1.15, d ) * ( 1.0 - smoothstep( 1.15, 1.6, d ) );
    // Querrillen der Profilsohle
    float tread = 0.82 + 0.18 * sin( q.y * 150.0 );
    return - inside * tread + rim * 0.3;
  }

  // Fußabdrücke an p: x = Eindruck 0..1, yz = Höhengradient in Welt-xz (Höhe in Einheiten der Tiefe)
  vec3 wFootprints( vec3 p ) {
    vec3 r = vec3( 0.0 );
    for ( int i = 0; i < ${MAX_PRINTS}; i ++ ) {
      if ( i >= wPrintN ) break;
      vec4 f = wPrints[ i ];
      vec2 d = p.xz - f.xz;
      if ( dot( d, d ) > 0.07 || abs( p.y - f.y ) > 0.3 ) continue;
      float a = abs( f.w );
      float depth = ( floor( a ) - 1.0 ) / 1000.0;
      if ( depth < 0.001 ) continue;
      float yaw = fract( a ) * 6.2831853;
      vec2 fw = vec2( sin( yaw ), cos( yaw ) );
      vec2 rt = vec2( - fw.y, fw.x ) * sign( f.w );
      vec2 q = vec2( dot( d, rt ), dot( d, fw ) );
      const float e = 0.004;
      float h0 = wSole( q );
      vec2 gq = vec2( wSole( q + vec2( e, 0.0 ) ) - h0, wSole( q + vec2( 0.0, e ) ) - h0 ) / e;
      r.x = max( r.x, clamp( - h0, 0.0, 1.0 ) * depth );
      r.yz += ( rt * gq.x + fw * gq.y ) * depth;
    }
    return r;
  }

  // Wellenringe von Schritten in Pfützen (Höhengradient)
  vec2 wStepRipples( vec3 p ) {
    vec2 g = vec2( 0.0 );
    for ( int i = 0; i < ${MAX_STEPS}; i ++ ) {
      if ( i >= wStepN ) break;
      vec4 s = wSteps[ i ];
      float age = wTime - s.w;
      if ( age < 0.0 || age > ${STEP_RIPPLE_LIFE.toFixed(1)} || abs( p.y - s.y ) > 0.3 ) continue;
      vec2 d = p.xz - s.xz;
      float dist = length( d ) + 1e-4;
      if ( dist > age * 0.6 + 0.3 ) continue;
      float fade = 1.0 - age / ${STEP_RIPPLE_LIFE.toFixed(1)};
      float dw = 0.0;
      // drei Ringe, die äußeren laufen schneller
      for ( int k = 0; k < 3; k ++ ) {
        float rr = age * ( 0.55 - float( k ) * 0.15 ) + 0.06;
        float x = dist - rr;
        float env = exp( - x * x * 260.0 ) / ( 1.0 + rr * 2.5 );
        dw += ( 38.0 * cos( 38.0 * x ) - 520.0 * x * sin( 38.0 * x ) ) * env;
      }
      g += d / dist * dw * fade * fade * 0.01;
    }
    return g;
  }

  vec3 wSkyColor( vec3 d ) {
    vec3 c = mix( wSkyHorizon, wSkyZenith, pow( smoothstep( 0.0, 1.0, d.y ), 0.55 ) );
    if ( d.y < 0.0 ) c = wSkyHorizon * 0.35;
    return c * ( 1.0 + wFlash * 3.0 );
  }
`;

const SURFACE_VERTEX = /* glsl */ `
  {
    vec4 wPos4 = vec4( transformed, 1.0 );
    #ifdef USE_BATCHING
      wPos4 = batchingMatrix * wPos4;
    #endif
    #ifdef USE_INSTANCING
      wPos4 = instanceMatrix * wPos4;
    #endif
    vWPos = ( modelMatrix * wPos4 ).xyz;
    vWNrm = inverseTransformDirection( transformedNormal, viewMatrix );
  }
`;

// Nach den Normal-Maps: Albedo/Rauheit/Normalen anpassen
const SURFACE_FRAGMENT = /* glsl */ `
  // Landscape: Vertex-Normale ist dort immer "oben", die echte Geländenormale kommt aus dem Terrain-Shader
  #ifdef W_CUSTOM_NORMAL
    vec3 wN = normalize( W_CUSTOM_NORMAL );
  #else
    vec3 wN = normalize( vWNrm );
  #endif
  #ifdef DOUBLE_SIDED
    wN *= faceDirection;
  #endif
  float wWetAmt = 0.0;
  float wPud = 0.0;
  vec3 wWaterN = wN;
  float wPrintAmt = 0.0;
  vec2 wPrintG = vec2( 0.0 );
  if ( wWet + wSnow + wPuddle > 0.001 ) {
    float wUp = smoothstep( 0.6, 0.95, wN.y );
    float wExpo = wExposure( vWPos + wN * ( 0.2 - 0.1 * wUp ), 0.25 * wUp );
    // Böden voll, Wände etwas weniger, Unterseiten kaum
    float wFace = clamp( wN.y * 0.6 + 0.55, 0.0, 1.0 );
    wWetAmt = wWet * wExpo * wFace;
    if ( wUp < 0.5 ) {
      // Rinnspuren an Wänden, laufen bei Regen nach unten
      float hc = dot( vWPos.xz, vec2( - wN.z, wN.x ) );
      wWetAmt *= mix( 0.55, 1.0, wNoise( vec2( hc * 7.0, vWPos.y * 0.6 + wTime * wRain * 0.7 ) ) );
    }
    float wCover = 0.0;
    if ( wSnow > 0.001 ) {
      float sn = wNoise( vWPos.xz * 1.3 ) * 0.65 + wNoise( vWPos.xz * 7.0 ) * 0.35;
      wCover = smoothstep( sn - 0.06, sn + 0.06, wSnow * 1.12 ) * smoothstep( 0.25, 0.7, wN.y ) * wExpo;
      if ( wPrintN > 0 && wCover > 0.001 ) {
        vec3 fp = wFootprints( vWPos );
        wPrintAmt = fp.x;
        // Tiefe in m: dünner Schnee gibt wenig nach
        wPrintG = fp.yz * ( 0.012 + 0.04 * wSnow );
        // dünne Schneedecke: Abdruck reicht bis auf den Boden, dort bleibt nasser Matsch
        float through = wPrintAmt * ( 1.0 - smoothstep( 0.3, 0.85, wSnow ) );
        wWetAmt = max( wWetAmt, through * wExpo * wUp );
        wCover *= 1.0 - through * 0.85;
      }
    }
    if ( wPuddle > 0.001 && wUp > 0.0 ) {
      float n = wFbm( vWPos.xz * 0.32 );
      #ifdef W_TERRAIN
        // Layer bestimmen mit: Erde/Mulden sammeln Wasser, Kies/Kuppen kaum
        n += lsPudBias;
      #endif
      float th = 0.12 + 0.42 * wPuddle;
      wPud = ( 1.0 - smoothstep( th - 0.035, th, n ) ) * wUp * wExpo;
      // dunkler, nasser Saum um jede Pfütze
      float rim = ( 1.0 - smoothstep( th, th + 0.1, n ) ) * wUp * wExpo;
      wWetAmt = max( wWetAmt, rim * clamp( wWet + wPuddle, 0.0, 1.0 ) );
    }
    wPud *= 1.0 - wCover;
    wWetAmt *= 1.0 - wCover;

    // Nässe: poröse Stoffe dunkeln stark nach, Wasser füllt feine Unebenheiten
    float wPor = 1.0 - metalnessFactor * 0.85;
    #ifdef W_TERRAIN
      wPor *= lsPor;
    #endif
    diffuseColor.rgb *= mix( 1.0, 0.42, wWetAmt * wPor );
    roughnessFactor = mix( roughnessFactor, min( roughnessFactor, 0.28 ), wWetAmt );
    normal = normalize( mix( normal, wGeoN, wWetAmt * 0.45 ) );

    if ( wPud > 0.001 ) {
      vec2 g = wRain > 0.001 ? wRipples( vWPos.xz ) : vec2( 0.0 );
      if ( wStepN > 0 ) g += wStepRipples( vWPos );
      wWaterN = normalize( vec3( - g.x, 1.0, - g.y ) );
      diffuseColor.rgb *= mix( 1.0, 0.55, wPud );
      roughnessFactor = mix( roughnessFactor, 0.035, wPud );
      metalnessFactor = mix( metalnessFactor, 0.0, wPud );
      normal = normalize( mix( normal, normalize( ( viewMatrix * vec4( wWaterN, 0.0 ) ).xyz ), wPud ) );
    }
    if ( wCover > 0.001 ) {
      // festgetretener Schnee im Abdruck: dichter, etwas dunkler und bläulicher
      vec3 wSnowCol = mix( vec3( 0.82, 0.85, 0.9 ), vec3( 0.58, 0.63, 0.72 ), wPrintAmt * 0.85 );
      diffuseColor.rgb = mix( diffuseColor.rgb, wSnowCol, wCover );
      roughnessFactor = mix( roughnessFactor, mix( 0.75, 0.55, wPrintAmt ), wCover );
      metalnessFactor = mix( metalnessFactor, 0.0, wCover );
      normal = normalize( mix( normal, wGeoN, wCover * 0.85 ) );
      if ( wPrintN > 0 ) normal = normalize( normal + ( viewMatrix * vec4( - wPrintG.x, 0.0, - wPrintG.y, 0.0 ) ).xyz * wCover );
    }
  }
`;

// Vor der Ausgabe: Spiegelung (Fresnel nach Schlick, F0 von Wasser)
const REFLECT_FRAGMENT = /* glsl */ `
  float wReflAmt = max( wPud, wWetAmt * 0.4 );
  if ( wReflAmt > 0.002 ) {
    vec3 wNr = normalize( mix( wN, wWaterN, wPud ) );
    vec3 wV = normalize( cameraPosition - vWPos );
    vec3 wR = reflect( - wV, wNr );
    float wF = 0.02 + 0.98 * pow( 1.0 - clamp( dot( wNr, wV ), 0.0, 1.0 ), 5.0 );
    vec3 wRefl = wSkyColor( wR );
    if ( wReflOn > 0.5 && wN.y > 0.7 ) {
      vec4 rc = wReflMatrix * vec4( vWPos, 1.0 );
      vec2 ruv = rc.xy / rc.w + wNr.xz * 0.05 + ( normal.xy - wGeoN.xy ) * 0.04 * ( 1.0 - wPud );
      vec2 re = min( ruv, 1.0 - ruv );
      float ok = smoothstep( 0.0, 0.04, min( re.x, re.y ) ) * ( 1.0 - smoothstep( 0.06, 0.3, abs( vWPos.y - wReflY ) ) );
      // nasse Flächen spiegeln unscharf, Pfützen klar
      vec3 pl = textureLod( wReflTex, ruv, ( 1.0 - wPud ) * 4.0 ).rgb;
      wRefl = mix( wRefl, pl, ok );
    }
    outgoingLight = mix( outgoingLight, wRefl, clamp( wF * wReflAmt, 0.0, 1.0 ) );
  }
`;

// Höhenbild für die Abdeckungskarte: Welt-Y relativ zu einer Basis (0 = nichts)
const heightMaterial = new THREE.ShaderMaterial({
  uniforms: { base: { value: 0 } },
  vertexShader: /* glsl */ `
    uniform float base;
    varying float vH;
    void main() {
      vec4 wp = vec4( position, 1.0 );
      #ifdef USE_INSTANCING
        wp = instanceMatrix * wp;
      #endif
      wp = modelMatrix * wp;
      vH = wp.y - base;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: /* glsl */ `
    varying float vH;
    void main() { gl_FragColor = vec4( max( vH, 0.0 ), 0.0, 0.0, 1.0 ); }
  `,
  side: THREE.DoubleSide,
});

// Gemeinsamer Teil der Partikel-Shader: Licht (Himmel + Taschenlampenkegel)
const PARTICLE_LIGHT_GLSL = /* glsl */ `
  uniform vec3 uLight;
  uniform vec3 uLampPos;
  uniform vec3 uLampDir;
  uniform vec3 uLampColor;
  uniform float uLampOn;
  float lampAmount( vec3 p ) {
    vec3 d = p - uLampPos;
    float dist = length( d ) + 1e-3;
    return uLampOn * smoothstep( 0.86, 0.96, dot( d / dist, uLampDir ) ) / ( 1.0 + dist * dist * 0.12 );
  }
`;

const rainVertex = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  ${OCC_GLSL}
  ${PARTICLE_LIGHT_GLSL}
  attribute vec4 aSeed;
  uniform vec3 uCenter;
  uniform vec3 uBox;
  uniform vec3 uOffset;
  uniform vec3 uVel;
  uniform float uAmount;
  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vUv = position.xy;
    if ( aSeed.w > uAmount ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); return; }
    vec3 boxMin = uCenter - uBox * 0.5;
    vec3 p = mod( aSeed.xyz * uBox + uOffset - boxMin, uBox ) + boxMin;
    vec3 axis = normalize( uVel );
    vec3 toCam = cameraPosition - p;
    float dist = length( toCam );
    vec3 side = normalize( cross( axis, toCam / dist ) );
    // ferne Tropfen breiter und blasser, damit sie nicht flimmern
    float width = 0.006 + dist * 0.0012;
    float len = 0.35 + aSeed.w * 0.35;
    vec3 wp = p - axis * position.y * len + side * position.x * width;
    float lamp = lampAmount( p );
    vColor = uLight + uLampColor * lamp * 2.5;
    vAlpha = ( 0.22 + lamp * 0.6 ) * ( 0.006 / width + 0.25 )
      * smoothstep( 0.4, 1.2, dist ) * ( 1.0 - smoothstep( uBox.x * 0.32, uBox.x * 0.5, length( p.xz - uCenter.xz ) ) );
    // unter Dächern regnet es nicht
    if ( p.y < wOccTop( p.xz ) ) vAlpha = 0.0;
    vec4 mvPosition = viewMatrix * vec4( wp, 1.0 );
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const rainFragment = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float a = vAlpha * ( 1.0 - pow( abs( vUv.x * 2.0 ), 2.0 ) ) * ( 1.0 - smoothstep( 0.3, 1.0, vUv.y ) ) * smoothstep( 0.0, 0.1, vUv.y );
    if ( a < 0.002 ) discard;
    gl_FragColor = vec4( vColor, a );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

const snowVertex = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  ${OCC_GLSL}
  ${PARTICLE_LIGHT_GLSL}
  attribute vec4 aSeed;
  uniform vec3 uCenter;
  uniform vec3 uBox;
  uniform vec3 uOffset;
  uniform float uTime;
  uniform float uAmount;
  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vUv = position.xy;
    if ( aSeed.w > uAmount ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); return; }
    vec3 boxMin = uCenter - uBox * 0.5;
    vec3 p = mod( aSeed.xyz * uBox + uOffset * ( 0.8 + aSeed.w * 0.4 ) - boxMin, uBox ) + boxMin;
    // Taumeln
    p.x += sin( uTime * ( 0.9 + aSeed.y ) + aSeed.w * 40.0 ) * 0.25;
    p.z += cos( uTime * ( 0.7 + aSeed.x ) + aSeed.z * 30.0 ) * 0.25;
    vec3 camRight = vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] );
    vec3 camUp = vec3( viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ] );
    float size = 0.018 + aSeed.w * 0.02;
    vec3 wp = p + ( camRight * ( position.x ) + camUp * ( position.y - 0.5 ) ) * size;
    float dist = length( cameraPosition - p );
    float lamp = lampAmount( p );
    vColor = uLight * 1.6 + uLampColor * lamp * 2.0;
    vAlpha = 0.85 * smoothstep( 0.25, 0.8, dist ) * ( 1.0 - smoothstep( uBox.x * 0.3, uBox.x * 0.5, length( p.xz - uCenter.xz ) ) );
    if ( p.y < wOccTop( p.xz ) ) vAlpha = 0.0;
    vec4 mvPosition = viewMatrix * vec4( wp, 1.0 );
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const snowFragment = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float r = length( vec2( vUv.x, vUv.y - 0.5 ) * 2.0 );
    float a = vAlpha * ( 1.0 - smoothstep( 0.2, 1.0, r ) );
    if ( a < 0.002 ) discard;
    gl_FragColor = vec4( vColor, a );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

const splashVertex = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  ${OCC_GLSL}
  ${HASH_GLSL}
  ${PARTICLE_LIGHT_GLSL}
  attribute vec4 aSeed;
  uniform vec3 uCenter;
  uniform float uTime;
  uniform float uArea;
  uniform float uAmount;
  varying vec2 vUv;
  varying float vLife;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vUv = position.xy;
    if ( aSeed.w > uAmount ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); return; }
    float period = 0.35 + aSeed.z * 0.3;
    float tt = uTime / period + aSeed.x;
    float cyc = mod( floor( tt ), 1000.0 );
    vLife = fract( tt );
    vec2 rnd = vec2( wHash( vec2( cyc, aSeed.y * 91.7 ) ), wHash( vec2( aSeed.y * 13.1, cyc + 4.2 ) ) );
    vec2 xz = uCenter.xz + ( rnd - 0.5 ) * uArea;
    float top = wOccTop( xz );
    if ( top < -1e3 ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); return; }
    vec3 p = vec3( xz.x, top + 0.004, xz.y );
    vec3 toCam = cameraPosition - p;
    float dist = length( toCam );
    vec3 right = normalize( cross( vec3( 0.0, 1.0, 0.0 ), toCam ) );
    float size = 0.12 * ( 0.6 + aSeed.z * 0.7 );
    vec3 wp = p + right * position.x * size + vec3( 0.0, position.y * size * 0.7, 0.0 );
    float lamp = lampAmount( p );
    vColor = uLight * 1.3 + uLampColor * lamp * 2.0;
    vAlpha = ( 0.35 + lamp ) * ( 1.0 - smoothstep( uArea * 0.3, uArea * 0.5, length( xz - uCenter.xz ) ) );
    vec4 mvPosition = viewMatrix * vec4( wp, 1.0 );
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const splashFragment = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  varying vec2 vUv;
  varying float vLife;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    // Krone aus fünf Tröpfchen auf Wurfparabeln
    float a = 0.0;
    float l = vLife;
    for ( int i = 0; i < 5; i ++ ) {
      float k = ( float( i ) - 2.0 ) / 2.0;
      vec2 c = vec2( k * l * 0.42, 4.0 * l * ( 1.0 - l ) * ( 0.75 - abs( k ) * 0.3 ) );
      a += 1.0 - smoothstep( 0.02, 0.07, length( vUv - c ) );
    }
    // flacher Ring am Boden zu Beginn
    a += ( 1.0 - smoothstep( 0.0, 0.06, abs( vUv.y ) ) ) * smoothstep( 0.0, 0.05, 0.5 * l - abs( abs( vUv.x ) - 0.5 * l ) ) * 0.5;
    a = min( a, 1.0 ) * vAlpha * ( 1.0 - l );
    if ( a < 0.002 ) discard;
    gl_FragColor = vec4( vColor, a );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

function quadGeometry(count: number, yFrom: number): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry();
  const y0 = yFrom;
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, y0, 0, 0.5, y0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geo.instanceCount = count;
  return geo;
}

type Uniforms = Record<string, THREE.IUniform>;

function particleMaterial(vertexShader: string, fragmentShader: string, uniforms: Uniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...uniforms },
    transparent: true,
    depthWrite: false,
    fog: true,
    side: THREE.DoubleSide,
  });
}

function particleMesh(geo: THREE.BufferGeometry, mat: THREE.Material, order: number): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  mesh.raycast = () => {};
  mesh.userData.noPick = true;
  mesh.userData.noShot = true;
  return mesh;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Vector4();
const _plane = new THREE.Plane();
const _clip = new THREE.Vector4();
const _size = new THREE.Vector2();
const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);

export class Weather {
  /** Partikel; gehört direkt in die Szene (nicht in die Map-Gruppe, damit Raycasts sie nicht sehen) */
  readonly group = new THREE.Group();

  /** 0..1 aktuelle Werte (lesbar für HUD/Debug) */
  wetness = 0;
  puddleFill = 0;
  snowCover = 0;
  /** Regentropfen auf der Bodycam-Linse (0..1), für den Post-Pass */
  lensRain = 0;
  /** steht die Kamera unter freiem Himmel? */
  exposed = true;

  private readonly u = {
    wWet: { value: 0 },
    wPuddle: { value: 0 },
    wSnow: { value: 0 },
    wRain: { value: 0 },
    wTime: { value: 0 },
    wFlash: { value: 0 },
    wOccTex: { value: null as THREE.Texture | null },
    wOccCenter: { value: new THREE.Vector2() },
    wOccSize: { value: OCC_SIZE },
    wOccBase: { value: 0 },
    wOccOn: { value: 0 },
    wReflTex: { value: null as THREE.Texture | null },
    wReflMatrix: { value: new THREE.Matrix4() },
    wReflY: { value: 0 },
    wReflOn: { value: 0 },
    wSkyZenith: { value: new THREE.Color() },
    wSkyHorizon: { value: new THREE.Color() },
    wPrints: { value: Array.from({ length: MAX_PRINTS }, () => new THREE.Vector4()) },
    wPrintN: { value: 0 },
    wSteps: { value: Array.from({ length: MAX_STEPS }, () => new THREE.Vector4()) },
    wStepN: { value: 0 },
  };
  private readonly lightU = {
    uLight: { value: new THREE.Color() },
    uLampPos: { value: new THREE.Vector3() },
    uLampDir: { value: new THREE.Vector3(0, 0, -1) },
    uLampColor: { value: new THREE.Color() },
    uLampOn: { value: 0 },
  };
  private readonly dummy: THREE.DataTexture;

  private rain: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private snow: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private splash: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private rainOffset = new THREE.Vector3();
  private snowOffset = new THREE.Vector3();

  // Einstellungen
  private typeNow: WeatherType = 'klar';
  private preset = PRESETS.klar;
  private intensity = 1;
  private wind = new THREE.Vector3();
  private timeScale = 1;
  private puddleAmount = 0.5;
  private applied: WorldSettings | null = null;

  // weich überblendete Ist-Werte
  private rainNow = 0;
  private snowNow = 0;
  private cloudNow = 0;
  private flash = 0;
  private boltTimer = 4;
  private bolt: { t: number; pulses: [number, number][] } | null = null;

  // Abdeckungskarte
  private occTarget: THREE.WebGLRenderTarget;
  private occCamera = new THREE.OrthographicCamera(-OCC_SIZE / 2, OCC_SIZE / 2, OCC_SIZE / 2, -OCC_SIZE / 2, 0.1, OCC_ABOVE + OCC_BELOW + 10);
  private occTimer = 0;

  // Spiegelung
  private quality: ReflectionQuality = 2;
  private reflTarget: THREE.WebGLRenderTarget | null = null;
  private reflCamera = new THREE.PerspectiveCamera();
  private groundY = 0;

  // Szenen-Inventar
  private scanTimer = 0;
  private probeTimer = 0;
  private solids: THREE.Mesh[] = [];
  /** in Abdeckungs- und Spiegelungs-Pass ausgeblendet (Himmel, Nebel, Helfer, Spielerkörper …) */
  private nonSolids: THREE.Object3D[] = [];
  private noWeather: THREE.Object3D[] = [];
  private patched = new WeakSet<THREE.Material>();
  private raycaster = new THREE.Raycaster();
  private lamp: THREE.SpotLight | null = null;

  // Spuren: Fußabdrücke (Ringpuffer) und Schrittwellen
  private prints: { x: number; y: number; z: number; yaw: number; side: number; depth: number }[] = [];
  private printHead = 0;
  private stepHead = 0;
  private stepCount = 0;
  private time = 0;
  private lastFoot = new THREE.Vector3();
  private hasFoot = false;
  private airborne = false;
  private stride = 0;
  private footSide = 1;
  private walkDir = new THREE.Vector2(0, 1);

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private rig: WorldRig | null,
  ) {
    this.dummy = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    this.dummy.needsUpdate = true;
    this.u.wOccTex.value = this.dummy;
    this.u.wReflTex.value = this.dummy;

    this.occTarget = new THREE.WebGLRenderTarget(OCC_RES, OCC_RES, {
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });
    this.occCamera.up.set(0, 0, -1);

    const occ = {
      wOccTex: this.u.wOccTex,
      wOccCenter: this.u.wOccCenter,
      wOccSize: this.u.wOccSize,
      wOccBase: this.u.wOccBase,
      wOccOn: this.u.wOccOn,
    };
    this.rain = particleMesh(
      quadGeometry(RAIN_MAX, 0),
      particleMaterial(rainVertex, rainFragment, {
        ...occ,
        ...this.lightU,
        uCenter: { value: new THREE.Vector3() },
        uBox: { value: RAIN_BOX.clone() },
        uOffset: { value: new THREE.Vector3() },
        uVel: { value: new THREE.Vector3(0, -RAIN_SPEED, 0) },
        uAmount: { value: 0 },
      }),
      900,
    ) as typeof this.rain;
    this.snow = particleMesh(
      quadGeometry(SNOW_MAX, 0),
      particleMaterial(snowVertex, snowFragment, {
        ...occ,
        ...this.lightU,
        uCenter: { value: new THREE.Vector3() },
        uBox: { value: SNOW_BOX.clone() },
        uOffset: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uAmount: { value: 0 },
      }),
      900,
    ) as typeof this.snow;
    this.splash = particleMesh(
      quadGeometry(SPLASH_MAX, 0),
      particleMaterial(splashVertex, splashFragment, {
        ...occ,
        ...this.lightU,
        uCenter: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uArea: { value: SPLASH_AREA },
        uAmount: { value: 0 },
      }),
      901,
    ) as typeof this.splash;
    this.group.name = 'Weather';
    this.group.userData.noPick = true;
    this.group.userData.noShot = true;
    this.group.add(this.rain, this.snow, this.splash);
    scene.add(this.group);
  }

  get type(): WeatherType {
    return this.typeNow;
  }

  /** aktueller Wind (m/s, Weltkoordinaten) – für Rauch, Feuer, Nebel */
  get windVector(): THREE.Vector3 {
    return this.wind;
  }

  /** aktuelle Regenstärke 0..1 */
  get rainAmount(): number {
    return this.rainNow;
  }

  /** Taschenlampe: beleuchtet Regen und Schnee im Lichtkegel */
  setLamp(lamp: THREE.SpotLight | null): void {
    this.lamp = lamp;
  }

  setReflectionQuality(q: ReflectionQuality): void {
    this.quality = q;
    if (q === 0) {
      this.reflTarget?.dispose();
      this.reflTarget = null;
    }
  }

  /** World Settings übernehmen. Anfangswerte (Nässe, Schnee) werden nur bei Änderung neu gesetzt. */
  apply(w: WorldSettings): void {
    const first = !this.applied;
    const prev = this.applied;
    const typeChanged = first || prev!.weather !== w.weather || prev!.weatherIntensity !== w.weatherIntensity;
    // nur bei Änderung übernehmen: sonst würde ein erneutes apply() (z. B. Sonne dreht sich) Script-Wetter überschreiben
    if (typeChanged) {
      this.typeNow = isWeatherType(w.weather) ? w.weather : 'klar';
      this.preset = PRESETS[this.typeNow];
      this.intensity = Math.max(0, w.weatherIntensity);
    }
    const az = THREE.MathUtils.degToRad(w.windDirection);
    this.wind.set(Math.sin(az), 0, Math.cos(az)).multiplyScalar(Math.max(0, w.windStrength));
    this.timeScale = Math.max(0, w.weatherTimeScale);
    this.puddleAmount = THREE.MathUtils.clamp(w.puddles, 0, 1);
    if (first || prev!.wetness !== w.wetness) {
      this.wetness = THREE.MathUtils.clamp(w.wetness, 0, 1);
      this.puddleFill = this.wetness;
    }
    if (first || prev!.snowCover !== w.snowCover) this.snowCover = THREE.MathUtils.clamp(w.snowCover, 0, 1);
    if (typeChanged) {
      // Kartenstart / Editor-Änderung: sofort im Zielwetter statt langsam einblenden
      this.rainNow = this.targetRain();
      this.snowNow = this.targetSnow();
      this.cloudNow = this.targetCloud();
    }
    this.applied = { ...w };
  }

  /** Wetter zur Laufzeit wechseln (Scripts); blendet weich über */
  setWeather(type: WeatherType, intensity = this.intensity): void {
    if (!isWeatherType(type)) return;
    this.typeNow = type;
    this.preset = PRESETS[type];
    this.intensity = Math.max(0, intensity);
  }

  /** Bodenhöhe unter der Kamera (aus dem letzten Abtasten) */
  get groundHeight(): number {
    return this.groundY;
  }

  /**
   * Füße des Spielers verfolgen (jeden Frame): erzeugt abwechselnd linke/rechte Fußabdrücke im Schnee
   * und Wellenringe in Pfützen. grounded = false in der Luft (bei der Landung entstehen beide Füße).
   */
  trackFeet(feet: THREE.Vector3, grounded: boolean): void {
    if (!grounded) {
      if (this.hasFoot) this.airborne = true;
      return;
    }
    if (!this.hasFoot) {
      this.lastFoot.copy(feet);
      this.hasFoot = true;
      return;
    }
    const dx = feet.x - this.lastFoot.x;
    const dz = feet.z - this.lastFoot.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 3 || Math.abs(feet.y - this.lastFoot.y) > 1.5) {
      // Teleport: keine Spur quer durch die Map
      this.lastFoot.copy(feet);
      this.stride = 0;
      this.airborne = false;
      return;
    }
    if (dist > 1e-4) this.walkDir.lerp(_v2d.set(dx / dist, dz / dist), Math.min(1, dist * 4)).normalize();
    const yaw = Math.atan2(this.walkDir.x, this.walkDir.y);
    if (this.airborne) {
      // Landung: beide Füße nebeneinander
      this.airborne = false;
      this.footstep(feet, yaw, 1);
      this.footstep(feet, yaw, -1);
      this.stride = 0;
    } else {
      this.stride += dist;
      if (this.stride >= STRIDE) {
        this.stride = Math.min(this.stride - STRIDE, STRIDE);
        this.footstep(feet, yaw, this.footSide);
        this.footSide = -this.footSide;
      }
    }
    this.lastFoot.copy(feet);
  }

  /** Alle Spuren entfernen (z. B. am Ende der Simulation im Editor) */
  clearTracks(): void {
    this.prints = [];
    this.printHead = 0;
    this.stepCount = 0;
    this.u.wPrintN.value = 0;
    this.u.wStepN.value = 0;
    this.hasFoot = false;
  }

  private footstep(feet: THREE.Vector3, yaw: number, side: number): void {
    // seitlich versetzt; der Fuß setzt etwas vor der Körpermitte auf
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const x = feet.x - fz * FOOT_SPREAD * side + fx * 0.1;
    const z = feet.z + fx * FOOT_SPREAD * side + fz * 0.1;
    if (this.snowCover > 0.02) {
      const p = { x, y: feet.y, z, yaw, side, depth: 1 };
      if (this.prints.length < MAX_PRINTS) this.prints.push(p);
      else {
        this.prints[this.printHead] = p;
        this.printHead = (this.printHead + 1) % MAX_PRINTS;
      }
    }
    if (this.puddleFill * this.puddleAmount > 0.02) {
      this.u.wSteps.value[this.stepHead].set(x, feet.y, z, this.time);
      this.stepHead = (this.stepHead + 1) % MAX_STEPS;
      this.stepCount = Math.min(MAX_STEPS, this.stepCount + 1);
    }
  }

  /** Abdrücke füllen sich bei Schneefall langsam wieder, Regen und Tauwetter lassen sie verschwinden */
  private updateTracks(s: number, snow: number, rain: number): void {
    const u = this.u;
    const fill = s * (snow / 70 + rain / 25 + (this.snowCover < 0.02 ? 1 : 0));
    let n = 0;
    for (const p of this.prints) {
      p.depth = Math.max(0, p.depth - fill);
      if (p.depth < 0.002) continue;
      const yaw01 = (((p.yaw / (Math.PI * 2)) % 1) + 1) % 1;
      const packed = 1 + Math.floor(p.depth * 1000) + Math.min(yaw01, 0.999);
      u.wPrints.value[n++].set(p.x, p.y, p.z, packed * p.side);
    }
    if (n < this.prints.length) {
      // verblasste Abdrücke aus dem Puffer werfen (Reihenfolge ist egal)
      this.prints = this.prints.filter((p) => p.depth >= 0.002);
      this.printHead = 0;
    }
    u.wPrintN.value = this.snowCover > 0.001 ? n : 0;
    u.wStepN.value = this.stepCount;
  }

  private targetRain() {
    return this.preset.rain * this.intensity;
  }
  private targetSnow() {
    return this.preset.snow * this.intensity;
  }
  private targetCloud() {
    return Math.min(1, this.preset.cloud * Math.min(1.2, 0.4 + this.intensity * 0.6));
  }

  update(dt: number, t: number, camera: THREE.Camera): void {
    // --- Wetter überblenden ---
    const k = 1 - Math.exp(-dt / 4);
    this.rainNow += (this.targetRain() - this.rainNow) * k;
    this.snowNow += (this.targetSnow() - this.snowNow) * k;
    this.cloudNow += (this.targetCloud() - this.cloudNow) * k;
    const rain = this.rainNow > 0.01 ? this.rainNow : 0;
    const snow = this.snowNow > 0.01 ? this.snowNow : 0;

    // --- Nässe, Pfützen, Schnee entwickeln sich mit der Zeit ---
    const s = dt * this.timeScale;
    if (rain > 0) {
      this.wetness += (s * rain) / 20;
      if (this.wetness > 0.5) this.puddleFill += (s * rain) / 75;
      this.snowCover -= (s * rain) / 40;
    } else {
      // Pfützen halten den Boden länger nass
      this.wetness -= (s / 240) * (1 - 0.7 * this.puddleFill);
      this.puddleFill -= s / 400;
    }
    if (snow > 0 && rain === 0) this.snowCover += (s * snow) / 90;
    else if (snow === 0 && this.snowCover > 0) {
      const melt = s / 500;
      this.snowCover -= melt;
      this.wetness += melt * 2;
    }
    this.wetness = THREE.MathUtils.clamp(this.wetness, 0, 1);
    this.puddleFill = THREE.MathUtils.clamp(this.puddleFill, 0, 1);
    this.snowCover = THREE.MathUtils.clamp(this.snowCover, 0, 1);
    this.time = t;
    this.updateTracks(s, snow, rain);

    // --- Blitze ---
    this.updateLightning(dt, rain);
    this.rig?.setWeather(this.cloudNow, this.flash);

    // --- Szene prüfen, Boden suchen ---
    this.scanTimer -= dt;
    if (this.scanTimer <= 0) {
      this.scanTimer = SCAN_INTERVAL;
      this.scan();
    }
    const cam = camera.getWorldPosition(_v);
    this.probeTimer -= dt;
    if (this.probeTimer <= 0) {
      this.probeTimer = PROBE_INTERVAL;
      this.probe(cam);
    }

    // Linse: Tropfen sammeln sich im Regen, trocknen langsam ab
    const lensTarget = this.exposed ? Math.min(1, rain) : 0;
    this.lensRain += (lensTarget - this.lensRain) * (1 - Math.exp(-dt / (lensTarget > this.lensRain ? 3 : 12)));

    // --- Uniforms ---
    const u = this.u;
    u.wWet.value = this.wetness;
    u.wPuddle.value = this.puddleFill * this.puddleAmount;
    u.wSnow.value = this.snowCover;
    u.wRain.value = Math.min(1, rain);
    u.wTime.value = t;
    u.wFlash.value = this.flash;
    if (this.rig) {
      const su = this.rig.sky.mesh.material.uniforms;
      const grey = (c: THREE.Color, out: THREE.Color) => {
        const l = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
        out.copy(c).lerp(_c.setRGB(l * 0.75, l * 0.78, l * 0.82), this.cloudNow * 0.7);
      };
      grey(su.zenith.value, u.wSkyZenith.value);
      grey(su.horizon.value, u.wSkyHorizon.value);
      const h = this.rig.hemi;
      const sun = this.rig.sun;
      this.lightU.uLight.value
        .copy(h.color)
        .multiplyScalar(h.intensity * 0.35)
        .add(_c.copy(sun.color).multiplyScalar(sun.intensity * 0.12));
    } else {
      u.wSkyZenith.value.set(0x506070);
      u.wSkyHorizon.value.set(0x8090a0);
      this.lightU.uLight.value.setScalar(0.2);
    }
    const lamp = this.lamp;
    if (lamp && lamp.visible && lamp.intensity > 0) {
      lamp.getWorldPosition(this.lightU.uLampPos.value);
      lamp.target.getWorldPosition(_v2);
      this.lightU.uLampDir.value.copy(_v2).sub(this.lightU.uLampPos.value).normalize();
      this.lightU.uLampColor.value.copy(lamp.color).multiplyScalar(Math.min(1.5, lamp.intensity / 20));
      this.lightU.uLampOn.value = 1;
    } else this.lightU.uLampOn.value = 0;

    // --- Partikel ---
    const ru = this.rain.material.uniforms;
    const vel = ru.uVel.value.set(this.wind.x, -RAIN_SPEED, this.wind.z);
    this.rainOffset.addScaledVector(vel, dt);
    wrap(this.rainOffset, RAIN_BOX);
    ru.uOffset.value.copy(this.rainOffset);
    ru.uCenter.value.copy(cam).add(_v2.set(0, 3, 0));
    ru.uAmount.value = Math.min(1, rain / 1.8);
    this.rain.visible = rain > 0;

    const su = this.snow.material.uniforms;
    this.snowOffset.addScaledVector(_v2.set(this.wind.x * 0.8, -SNOW_SPEED, this.wind.z * 0.8), dt);
    wrap(this.snowOffset, SNOW_BOX);
    su.uOffset.value.copy(this.snowOffset);
    su.uCenter.value.copy(cam).add(_v2.set(0, 3, 0));
    su.uTime.value = t;
    su.uAmount.value = Math.min(1, snow / 1.5);
    this.snow.visible = snow > 0;

    const pu = this.splash.material.uniforms;
    pu.uCenter.value.copy(cam);
    pu.uTime.value = t;
    pu.uAmount.value = Math.min(1, rain / 1.6);
    this.splash.visible = rain > 0 && u.wOccOn.value > 0;
  }

  private updateLightning(dt: number, rain: number): void {
    if (this.preset.lightning && rain > 0.4) {
      this.boltTimer -= dt;
      if (this.boltTimer <= 0) {
        this.boltTimer = 6 + Math.random() * 16;
        const pulses: [number, number][] = [[0, 0.6 + Math.random() * 0.4]];
        const extra = Math.floor(Math.random() * 3);
        for (let i = 0; i < extra; i++) pulses.push([0.08 + i * 0.12 + Math.random() * 0.1, 0.4 + Math.random() * 0.6]);
        this.bolt = { t: 0, pulses };
      }
    }
    this.flash = 0;
    if (this.bolt) {
      this.bolt.t += dt;
      for (const [start, amp] of this.bolt.pulses) {
        const x = this.bolt.t - start;
        if (x >= 0) this.flash += amp * Math.exp(-x * 14);
      }
      if (this.bolt.t > 1.5) this.bolt = null;
    }
  }

  // ---------- Szene ----------

  /** Neue Meshes finden, Materialien patchen, Listen für die Zusatz-Passes aktualisieren */
  private scan(): void {
    this.solids = [];
    this.nonSolids = [];
    this.noWeather = [];
    const visit = (o: THREE.Object3D, excluded: boolean) => {
      if (o === this.group) return;
      const ex = excluded || !!o.userData.noWeather;
      const r = o as THREE.Mesh;
      if (r.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite) {
        const mats = (Array.isArray(r.material) ? r.material : [r.material]) as THREE.Material[];
        const standard = r.isMesh && mats.every((m) => (m as THREE.MeshStandardMaterial).isMeshStandardMaterial);
        if (ex) this.noWeather.push(o);
        else if (standard && o.layers.isEnabled(0) && mats.every((m) => m.colorWrite)) {
          this.solids.push(r);
          for (const m of mats) this.patch(m as THREE.MeshStandardMaterial);
        } else this.nonSolids.push(o);
      }
      for (const c of o.children) visit(c, ex);
    };
    visit(this.scene, false);
  }

  private patch(mat: THREE.MeshStandardMaterial): void {
    if (this.patched.has(mat) || mat.userData.noWeather) return;
    this.patched.add(mat);
    const u = this.u;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
      prev.call(mat, shader, renderer);
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
        .replace('#include <project_vertex>', `#include <project_vertex>\n${SURFACE_VERTEX}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${SURFACE_PARS}`)
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nvec3 wGeoN = normal;')
        // Materialien mit eigener Normalen (Landscape) markieren die Stelle statt des Standard-Chunks
        .replace('/*NORMAL_BEGIN*/', 'vec3 wGeoN = nonPerturbedNormal;')
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${SURFACE_FRAGMENT}`)
        .replace('#include <opaque_fragment>', `${REFLECT_FRAGMENT}\n#include <opaque_fragment>`);
    };
    // Standard-Schlüssel ist onBeforeCompile.toString() – der wäre nach dem Patchen für alle gleich.
    // Daher den bisherigen Schlüssel jetzt festhalten (bzw. eine eigene Methode weiter aufrufen).
    const ownKey = mat.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey;
    const prevKey = ownKey ? mat.customProgramCacheKey.bind(mat) : null;
    const prevStr = prev.toString();
    mat.customProgramCacheKey = () => (prevKey ? prevKey() : prevStr) + '|weather1';
    mat.needsUpdate = true;
  }

  /** Bodenhöhe unter der Kamera (Spiegelebene) und ob die Kamera im Freien steht */
  private probe(cam: THREE.Vector3): void {
    const rc = this.raycaster;
    rc.far = 50;
    rc.set(cam, DOWN);
    const hits = rc.intersectObjects(this.solids, false);
    for (const h of hits) {
      if (!h.face) continue;
      _n.copy(h.face.normal).transformDirection(h.object.matrixWorld);
      if (_n.y > 0.7) {
        this.groundY = h.point.y;
        break;
      }
    }
    rc.set(cam, UP);
    rc.far = 80;
    this.exposed = rc.intersectObjects(this.solids, false).length === 0;
  }

  // ---------- Zusatz-Passes ----------

  /** Vor dem eigentlichen Rendern aufrufen */
  render(camera: THREE.PerspectiveCamera, dt: number): void {
    const active = this.wetness + this.puddleFill + this.snowCover + this.rainNow + this.snowNow > 0.002;
    this.u.wOccOn.value = active ? this.u.wOccOn.value : 0;
    if (!active) {
      this.u.wReflOn.value = 0;
      return;
    }
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    const prevShadow = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    r.autoClear = false;

    this.occTimer -= dt;
    const cam = camera.getWorldPosition(_v);
    const c = this.u.wOccCenter.value;
    if (this.occTimer <= 0 || Math.abs(cam.x - c.x) > OCC_SIZE * 0.2 || Math.abs(cam.z - c.y) > OCC_SIZE * 0.2 || this.u.wOccOn.value === 0) {
      this.occTimer = OCC_INTERVAL;
      this.renderOcclusion(cam);
    }
    this.renderReflection(camera);

    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    r.shadowMap.autoUpdate = prevShadow;
  }

  private hideForPass(list: THREE.Object3D[], states: boolean[]): void {
    for (const o of list) {
      states.push(o.visible);
      o.visible = false;
    }
  }

  private restore(list: THREE.Object3D[], states: boolean[]): void {
    list.forEach((o, i) => (o.visible = states[i]));
  }

  private renderOcclusion(cam: THREE.Vector3): void {
    const r = this.renderer;
    const texel = OCC_SIZE / OCC_RES;
    const cx = Math.round(cam.x / texel) * texel;
    const cz = Math.round(cam.z / texel) * texel;
    const base = cam.y - OCC_BELOW;
    this.occCamera.position.set(cx, cam.y + OCC_ABOVE, cz);
    this.occCamera.lookAt(cx, cam.y, cz);
    this.occCamera.updateMatrixWorld();
    heightMaterial.uniforms.base.value = base;

    const hidden = [...this.nonSolids, ...this.noWeather, this.group];
    const states: boolean[] = [];
    this.hideForPass(hidden, states);
    const bg = this.scene.background;
    const fog = this.scene.fog;
    const override = this.scene.overrideMaterial;
    this.scene.background = null;
    this.scene.fog = null;
    this.scene.overrideMaterial = heightMaterial;
    const prevClear = r.getClearColor(_c).clone();
    const prevAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    // Ein Material, das diese Karte liest, darf nicht gleichzeitig ins Ziel schreiben
    this.u.wOccTex.value = this.dummy;

    r.setRenderTarget(this.occTarget);
    r.clear();
    r.render(this.scene, this.occCamera);

    r.setClearColor(prevClear, prevAlpha);
    this.scene.overrideMaterial = override;
    this.scene.background = bg;
    this.scene.fog = fog;
    this.restore(hidden, states);

    this.u.wOccTex.value = this.occTarget.texture;
    this.u.wOccCenter.value.set(cx, cz);
    this.u.wOccBase.value = base;
    this.u.wOccOn.value = 1;
  }

  private renderReflection(camera: THREE.PerspectiveCamera): void {
    const u = this.u;
    u.wReflOn.value = 0;
    if (this.quality === 0 || this.puddleFill * this.puddleAmount + this.wetness < 0.02) return;

    // Zielgröße nach Qualität
    const r = this.renderer;
    r.getDrawingBufferSize(_size);
    const f = this.quality === 2 ? 0.5 : 0.25;
    const w = Math.max(64, Math.round(_size.x * f));
    const h = Math.max(64, Math.round(_size.y * f));
    if (!this.reflTarget) {
      this.reflTarget = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
      });
    } else if (this.reflTarget.width !== w || this.reflTarget.height !== h) this.reflTarget.setSize(w, h);

    // Spiegelkamera (wie three.js Reflector): Position, Blickziel und Up an der Ebene y = groundY spiegeln
    const planeY = this.groundY;
    camera.updateMatrixWorld();
    const camPos = _v.setFromMatrixPosition(camera.matrixWorld);
    if (camPos.y <= planeY + 0.01) return;
    const rot = _m.extractRotation(camera.matrixWorld);
    const look = _v2.set(0, 0, -1).applyMatrix4(rot).add(camPos);
    const vc = this.reflCamera;
    vc.position.set(camPos.x, 2 * planeY - camPos.y, camPos.z);
    vc.up.set(0, 1, 0).applyMatrix4(rot);
    vc.up.y = -vc.up.y;
    vc.lookAt(look.x, 2 * planeY - look.y, look.z);
    vc.far = camera.far;
    vc.near = camera.near;
    vc.updateMatrixWorld();
    // Projektion kommt fertig von der Kamera; three darf sie nicht neu aufbauen (sonst wäre die Clip-Ebene weg)
    const reversed = camera.reversedDepth;
    (vc as unknown as { _reversedDepth: boolean })._reversedDepth = reversed;
    vc.projectionMatrix.copy(camera.projectionMatrix);

    u.wReflMatrix.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    u.wReflMatrix.value.multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);

    // Schräge Near-Plane: nichts unterhalb der Spiegelebene zeichnen
    _plane.setFromNormalAndCoplanarPoint(UP, _n.set(0, planeY, 0)).applyMatrix4(vc.matrixWorldInverse);
    _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
    const p = vc.projectionMatrix.elements;
    if (reversed) {
      // Reversed-Z (Tiefe 1 = Near, 0 = Far): Zeile 3 = Zeile 4 − a·C, so dass z/w auf der Ebene 1 ist
      // und die gegenüberliegende Frustum-Ecke Q auf der Far-Ebene (z = 0) liegt.
      _q.set(Math.sign(_clip.x), Math.sign(_clip.y), 0, 1).applyMatrix4(vc.projectionMatrixInverse.copy(vc.projectionMatrix).invert());
      const a = -_q.z / _clip.dot(_q);
      p[2] = -a * _clip.x;
      p[6] = -a * _clip.y;
      p[10] = -1 - a * _clip.z + 0.003; // wie unten: minimal unter die Ebene zeichnen (keine Lücke am Rand)
      p[14] = -a * _clip.w;
    } else {
      _q.set((Math.sign(_clip.x) + p[8]) / p[0], (Math.sign(_clip.y) + p[9]) / p[5], -1, (1 + p[10]) / p[14]);
      _clip.multiplyScalar(2 / _clip.dot(_q));
      p[2] = _clip.x;
      p[6] = _clip.y;
      p[10] = _clip.z + 1 - 0.003;
      p[14] = _clip.w;
    }
    vc.projectionMatrixInverse.copy(vc.projectionMatrix).invert();

    const hidden = [...this.noWeather, this.group];
    const states: boolean[] = [];
    this.hideForPass(hidden, states);
    u.wReflTex.value = this.dummy;
    r.setRenderTarget(this.reflTarget);
    r.clear();
    r.render(this.scene, vc);
    this.restore(hidden, states);

    u.wReflTex.value = this.reflTarget.texture;
    u.wReflY.value = planeY;
    u.wReflOn.value = 1;
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const m of [this.rain, this.snow, this.splash]) {
      m.geometry.dispose();
      m.material.dispose();
    }
    this.occTarget.dispose();
    this.reflTarget?.dispose();
    this.dummy.dispose();
  }
}

const _c = new THREE.Color();
const _v2d = new THREE.Vector2();

function wrap(v: THREE.Vector3, box: THREE.Vector3): void {
  v.set(((v.x % box.x) + box.x) % box.x, ((v.y % box.y) + box.y) % box.y, ((v.z % box.z) + box.z) % box.z);
}
