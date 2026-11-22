import type { PadConfig } from './types';

/**
 * R214 lines of the R202 control pad in CSS px relative to the game area top-left corner.
 * The same formulas as the input model in pad.ts.
 */
export interface PadLayout {
  /** X stops (full counter-steer / full steer): centre -/+ steerSpan * half-width. */
  left: number;
  right: number;
  /** Y stops (full gas / full brake): centre -/+ padHalfH * half-height. */
  top: number;
  bottom: number;
  centerX: number;
  centerY: number;
  /** Dead-zone marks: centre -/+ steerDead * steerSpan * half-width. */
  deadLeft: number;
  deadRight: number;
  /** Gas/lift border: the horizontal axis (y = 0). */
  liftY: number;
  /** Lift/brake border: y = -liftZone. */
  brakeY: number;
}

/** R214 finger dot position, CSS px relative to the game area. */
export interface PadDot {
  x: number;
  y: number;
}

/** Fills `out` with the R202 pad lines for a width x height game area. No allocations. */
export function padLayout(cfg: PadConfig, width: number, height: number, out: PadLayout): void {
  const halfW = width / 2;
  const halfH = height / 2;
  const spanX = cfg.steerSpan * halfW;
  const spanY = cfg.padHalfH * halfH;
  const dead = cfg.steerDead * spanX;
  out.centerX = halfW;
  out.centerY = halfH;
  out.left = halfW - spanX;
  out.right = halfW + spanX;
  out.top = halfH - spanY;
  out.bottom = halfH + spanY;
  out.deadLeft = halfW - dead;
  out.deadRight = halfW + dead;
  out.liftY = halfH;
  out.brakeY = halfH + cfg.liftZone * spanY;
}

/** R214(b): the finger (fx, fy) clamped to the pad rectangle. No allocations. */
export function padDot(
  _cfg: PadConfig,
  layout: PadLayout,
  fx: number,
  fy: number,
  out: PadDot,
): void {
  out.x = fx < layout.left ? layout.left : fx > layout.right ? layout.right : fx;
  out.y = fy < layout.top ? layout.top : fy > layout.bottom ? layout.bottom : fy;
}
