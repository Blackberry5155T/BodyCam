// Ordnet Bilddateien eines Textur-Sets ihren Kanälen zu (Dateinamen wie bei Poly Haven, ambientCG, Quixel …).
// Wird vom Vite-Plugin (public/assets/textures) und beim Import im Editor benutzt — keine Browser-Abhängigkeiten.

export type TexChannel = 'albedo' | 'normal' | 'rough' | 'ao' | 'height' | 'arm';

export const TEX_CHANNELS: TexChannel[] = ['albedo', 'normal', 'rough', 'ao', 'height', 'arm'];

export const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

/** Kanal einer Datei; null = wird nicht gebraucht (Metallic, Specular, Opacity …) */
export function classifyTexture(file: string): TexChannel | null {
  const n = file.toLowerCase().replace(/\.[^.]+$/, '');
  if (/(metal|spec|opacity|alpha|mask|emiss|translucen|preview|thumb)/.test(n)) return null;
  if (/(^|[_\-. ])arm($|[_\-. ])/.test(n)) return 'arm';
  if (/(normal|nrm|(^|[_\-. ])nor(gl|dx)?($|[_\-. ])|(^|[_\-. ])n($|[_\-. ]))/.test(n)) return 'normal';
  if (/(rough|rgh|(^|[_\-. ])r($|[_\-. ]))/.test(n)) return 'rough';
  if (/(ambientocclusion|occlusion|(^|[_\-. ])ao($|[_\-. ]))/.test(n)) return 'ao';
  if (/(height|disp|displacement|bump|(^|[_\-. ])h($|[_\-. ]))/.test(n)) return 'height';
  if (/(albedo|basecolor|base_color|diffuse|(^|[_\-. ])diff($|[_\-. ])|color|colour|(^|[_\-. ])col($|[_\-. ]))/.test(n)) return 'albedo';
  return 'albedo';
}

/** DirectX-Normal-Map (grüner Kanal zeigt nach unten)? Standard ist OpenGL. */
export function isDirectXNormal(file: string): boolean {
  return /(_dx|normaldx|nor_dx|directx)/i.test(file);
}

/** gemeinsamer Namensanfang mehrerer Dateien (für den Set-Namen beim Import) */
export function setNameFromFiles(files: string[]): string {
  const stems = files.map((f) => f.replace(/\.[^.]+$/, ''));
  let p = stems[0] ?? 'Textur';
  for (const s of stems) while (p && !s.startsWith(p)) p = p.slice(0, -1);
  p = p.replace(/[_\-. ]+$/, '');
  return p.length >= 2 ? p : (stems[0] ?? 'Textur');
}

/**
 * Dateien eines Sets zuordnen: bei mehreren Kandidaten gewinnt die erste (sortiert); eine Normal-Map im
 * OpenGL-Format wird einer DirectX-Variante vorgezogen.
 */
export function groupTextureFiles(files: string[]): Partial<Record<TexChannel, string>> {
  const out: Partial<Record<TexChannel, string>> = {};
  for (const f of [...files].sort()) {
    if (!IMAGE_RE.test(f)) continue;
    const ch = classifyTexture(f.split('/').pop()!);
    if (!ch) continue;
    if (ch === 'normal' && out.normal && isDirectXNormal(out.normal) && !isDirectXNormal(f)) out.normal = f;
    else if (!out[ch]) out[ch] = f;
  }
  return out;
}
