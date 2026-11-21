import { describe, expect, it } from 'vitest';
import { createGameFlow, menuEnabled } from '../../src/app/gameFlow';

/**
 * Spec: docs/brief.md R95 (start screen and pause, outside the sim). Pure model, no DOM:
 * phases 'menu' | 'run' | 'pause'; the sim steps only in 'run'.
 * "Автоматика": no start screen with ?menu=0 or any `scenario` parameter.
 */
describe('R95 game flow: phases and transitions', () => {
  it('menu: true starts in menu with the sim stopped; menu: false starts in run', () => {
    const a = createGameFlow({ menu: true });
    expect(a.phase).toBe('menu');
    expect(a.simRunning).toBe(false);
    const b = createGameFlow({ menu: false });
    expect(b.phase).toBe('run');
    expect(b.simRunning).toBe(true);
  });
  it('start: menu -> run', () => {
    const f = createGameFlow({ menu: true });
    f.start();
    expect(f.phase).toBe('run');
    expect(f.simRunning).toBe(true);
  });
  it('pause: run -> pause (sim stopped); resume: pause -> run', () => {
    const f = createGameFlow({ menu: false });
    f.pause();
    expect(f.phase).toBe('pause');
    expect(f.simRunning).toBe(false);
    f.resume();
    expect(f.phase).toBe('run');
    expect(f.simRunning).toBe(true);
  });
  it('restart from pause returns true and goes to run', () => {
    const f = createGameFlow({ menu: false });
    f.pause();
    expect(f.restart()).toBe(true);
    expect(f.phase).toBe('run');
    expect(f.simRunning).toBe(true);
  });
  it('invalid transitions have no effect: pause/resume from menu, start/resume from run', () => {
    const m = createGameFlow({ menu: true });
    m.pause();
    expect(m.phase).toBe('menu');
    m.resume();
    expect(m.phase).toBe('menu');
    expect(m.simRunning).toBe(false);
    const r = createGameFlow({ menu: false });
    r.start();
    expect(r.phase).toBe('run');
    r.resume();
    expect(r.phase).toBe('run');
    expect(r.simRunning).toBe(true);
  });
  it('pause twice stays paused; resume twice stays running', () => {
    const f = createGameFlow({ menu: false });
    f.pause();
    f.pause();
    expect(f.phase).toBe('pause');
    f.resume();
    f.resume();
    expect(f.phase).toBe('run');
  });
  it('simRunning is true exactly in run along a full session', () => {
    const f = createGameFlow({ menu: true });
    const seen: [string, boolean][] = [];
    const log = (): void => {
      seen.push([f.phase, f.simRunning]);
    };
    log();
    f.start();
    log();
    f.pause();
    log();
    f.resume();
    log();
    f.pause();
    log();
    f.restart();
    log();
    expect(seen).toEqual([
      ['menu', false],
      ['run', true],
      ['pause', false],
      ['run', true],
      ['pause', false],
      ['run', true],
    ]);
  });
});

describe('R95 menuEnabled(search): automation runs without the start screen', () => {
  it.each([
    ['', true],
    ['?dev=1', true],
    ['?hud=1&map=0', true],
    ['?menu=1', true],
    ['?menu=0', false],
    ['?dev=1&menu=0', false],
    ['?scenario=stress', false],
    ['?scenario', false],
    ['?menu=1&scenario=stress', false],
  ] as const)('%j -> %s', (search, want) => {
    expect(menuEnabled(search)).toBe(want);
  });
});
