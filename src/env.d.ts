/// <reference types="vite/client" />

declare module 'virtual:bodycam-models' {
  /** URLs aller .glb/.gltf-Dateien unter public/assets/models (z. B. "/assets/models/kiste.glb") */
  const models: string[];
  export default models;
}

declare module 'virtual:bodycam-textures' {
  /** Textur-Sets unter public/assets/textures: Name + URL je Kanal (albedo, normal, rough, ao, height, arm) */
  const sets: { name: string; files: Partial<Record<'albedo' | 'normal' | 'rough' | 'ao' | 'height' | 'arm', string>> }[];
  export default sets;
}
