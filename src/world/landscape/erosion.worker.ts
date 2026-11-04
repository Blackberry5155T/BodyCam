import { runErosion, type ErosionKind, type ErosionParams } from './erosion.ts';

// Web Worker: Erosion großer Bereiche, ohne den Editor einzufrieren.
// Eingang: { heights (Float32Array, wird übertragen), w, h, q, kind, params, seed }
// Ausgang: { progress } … dann { done: true, heights }

interface Job {
  heights: Float32Array;
  w: number;
  h: number;
  q: number;
  kind: ErosionKind;
  params: ErosionParams;
  seed: number;
}

self.onmessage = (e: MessageEvent<Job>) => {
  const j = e.data;
  let last = 0;
  runErosion(j.heights, j.w, j.h, j.q, j.kind, j.params, j.seed, (f) => {
    const now = performance.now();
    if (now - last > 100) {
      last = now;
      (self as unknown as Worker).postMessage({ progress: f });
    }
  });
  (self as unknown as Worker).postMessage({ done: true, heights: j.heights }, [j.heights.buffer]);
};
