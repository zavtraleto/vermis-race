// Spike E1: how the twisty loop looks as real geometry for a few k3dCurve values: total heading
// per figure, the sharpest heading change inside a 100 / 300 segment sight window, and whether the
// window ever turns back on itself (> 180 deg). Usage: node tools/run-ts.mjs tools/spike/render3d-track.ts
import { loadTestTwisty } from '../../src/data/tracks';
import { buildTrack } from '../../src/sim/track';

export function main(io: { log: (s: string) => void }): number {
  const track = buildTrack(loadTestTwisty().def);
  const c = track.segments.map((s) => s.curve);
  const n = c.length;
  let sum = 0;
  let abs = 0;
  for (const v of c) {
    sum += v;
    abs += Math.abs(v);
  }
  io.log(`segments ${n}, sum curve ${sum.toFixed(1)}, sum |curve| ${abs.toFixed(1)}`);
  for (const k of [0.00075, 0.0015, 0.003, 0.005]) {
    const worst = (win: number): number => {
      let best = 0;
      for (let s = 0; s < n; s++) {
        let h = 0;
        let maxAbs = 0;
        for (let i = 0; i < win; i++) {
          h += c[(s + i) % n]! * k;
          maxAbs = Math.max(maxAbs, Math.abs(h));
        }
        best = Math.max(best, maxAbs);
      }
      return (best * 180) / Math.PI;
    };
    io.log(
      `k ${k}: loop turns ${((sum * k * 180) / Math.PI).toFixed(0)} deg net, ` +
        `${((abs * k * 180) / Math.PI).toFixed(0)} deg total; ` +
        `max heading change in sight: 100 seg ${worst(100).toFixed(0)} deg, 300 seg ${worst(300).toFixed(0)} deg`,
    );
  }
  return 0;
}
