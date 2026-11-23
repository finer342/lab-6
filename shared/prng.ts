// Deterministic seeded PRNG (Mulberry32).
// Replaces Math.random() and Date.now() so client and server generate identical states from a server seed.

import { Seed, toSeed } from './types.js';

export interface SeededRng {
  next(): number;
  nextRange(min: number, max: number): number;
  nextInt(min: number, max: number): number;
  getState(): number;
  setState(newState: number): void;
}

export function createSeededRng(initialSeed: Seed): SeededRng {
  let state = (initialSeed >>> 0) || 1;

  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function nextRange(min: number, max: number): number {
    return min + next() * (max - min);
  }

  function nextInt(min: number, max: number): number {
    return Math.floor(nextRange(min, max + 1));
  }

  function getState(): number {
    return state >>> 0;
  }

  function setState(newState: number): void {
    state = (newState >>> 0) || 1;
  }

  return {
    next,
    nextRange,
    nextInt,
    getState,
    setState
  };
}

export function hashSeed(input: string): Seed {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return toSeed(h);
}
