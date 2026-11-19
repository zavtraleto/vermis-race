// R32 roadside objects. Signature-only stub so tests compile; the implementer replaces the body.
export const ROADSIDE_LAMP = 0,
  ROADSIDE_BILLBOARD = 1,
  ROADSIDE_BUILDING = 2;

export interface RoadsideConfig {
  lamps: { every: number; offset: number };
  billboards: { everyMin: number; everyMax: number; offset: number };
  buildings: {
    everyMin: number;
    everyMax: number;
    offsetMin: number;
    offsetMax: number;
    variants: number;
  };
}

export interface Roadside {
  count: number;
  seg: Int32Array;
  x: Float32Array;
  kind: Uint8Array;
  variant: Uint8Array;
}

export type BuildRoadside = (segmentCount: number, cfg: RoadsideConfig, seed: number) => Roadside;

export const buildRoadside: BuildRoadside = () => {
  throw new Error('not implemented');
};
