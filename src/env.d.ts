/// <reference types="vite/client" />

declare module 'virtual:bodycam-models' {
  /** URLs aller .glb/.gltf-Dateien unter public/assets/models (z. B. "/assets/models/kiste.glb") */
  const models: string[];
  export default models;
}
