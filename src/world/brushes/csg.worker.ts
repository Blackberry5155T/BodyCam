import { evaluateCluster, type CsgRequest, type CsgResponse } from './csg.ts';

// Worker: verrechnet Brush-Cluster im Hintergrund (siehe csg.ts / manager.ts)

self.onmessage = (e: MessageEvent<CsgRequest>) => {
  const res: CsgResponse = { job: e.data.job, clusters: e.data.clusters.map(evaluateCluster) };
  const transfer: ArrayBuffer[] = [];
  for (const c of res.clusters) for (const p of c.parts) for (const f of p.faces) transfer.push(f.pos.buffer as ArrayBuffer, f.nor.buffer as ArrayBuffer);
  (self as unknown as Worker).postMessage(res, transfer);
};
