import { describe, it, expect } from 'vitest';
import type { Entity, HeadState, Relation, Tier } from '@archi-graph/shared';
import { TIERS } from '@archi-graph/shared';
import { computeLayout, TIER_ORDER } from './layout';

function entity(entityId: string, tier: Tier, overrides: Partial<Entity> = {}): Entity {
  return {
    entityId,
    type: 'lld',
    code: entityId.toUpperCase(),
    shortTitle: entityId,
    group: 'soe',
    tier,
    title: entityId,
    metadata: { author: 'a', date: '2026-01-01', status: 'stable', tags: [] },
    contentMarkdown: '',
    flow: null,
    links: [],
    ...overrides,
  };
}

function head(entities: Entity[], relations: Relation[] = []): HeadState {
  return { entities, relations };
}

describe('computeLayout — 2D layered by tier', () => {
  it('places every entity and keys the result by entityId', () => {
    const h = head([entity('a', 't0'), entity('b', 't3'), entity('c', 'tx')]);
    const pos = computeLayout(h, '2d');
    expect(Object.keys(pos).sort()).toEqual(['a', 'b', 'c']);
    for (const id of ['a', 'b', 'c']) {
      expect(pos[id]).toMatchObject({
        x: expect.any(Number),
        y: expect.any(Number),
        z: expect.any(Number),
      });
    }
  });

  it('assigns nodes of different tiers to distinct columns, left→right by tier order', () => {
    // one node per tier so each column holds exactly one node.
    const entities = TIERS.map((t, i) => entity(`n${i}`, t));
    const pos = computeLayout(head(entities), '2d');

    // Column X must be strictly increasing in declared TIER_ORDER, EXCEPT t3/t3d
    // which share the same order (Backend Services + Databases live in one column).
    const xByTier = new Map<Tier, number>();
    entities.forEach((e, i) => xByTier.set(e.tier, pos[`n${i}`].x));

    // t0 < t1 < t2 < (t3 == t3d) < t4 < t5 < tx
    expect(xByTier.get('t0')!).toBeLessThan(xByTier.get('t1')!);
    expect(xByTier.get('t1')!).toBeLessThan(xByTier.get('t2')!);
    expect(xByTier.get('t2')!).toBeLessThan(xByTier.get('t3')!);
    expect(xByTier.get('t3')!).toBe(xByTier.get('t3d')!);
    expect(xByTier.get('t3')!).toBeLessThan(xByTier.get('t4')!);
    expect(xByTier.get('t4')!).toBeLessThan(xByTier.get('t5')!);
    expect(xByTier.get('t5')!).toBeLessThan(xByTier.get('tx')!);
  });

  it('keeps all 2D nodes on the z=0 plane', () => {
    const entities = TIERS.map((t, i) => entity(`n${i}`, t));
    const pos = computeLayout(head(entities), '2d');
    for (const id of Object.keys(pos)) {
      expect(pos[id].z).toBe(0);
    }
  });

  it('stacks same-tier nodes in the same column (equal X) at distinct Y', () => {
    const h = head([
      entity('a', 't3', { code: 'A' }),
      entity('b', 't3', { code: 'B' }),
      entity('c', 't3', { code: 'C' }),
    ]);
    const pos = computeLayout(h, '2d');
    expect(pos.a.x).toBe(pos.b.x);
    expect(pos.b.x).toBe(pos.c.x);
    const ys = new Set([pos.a.y, pos.b.y, pos.c.y]);
    expect(ys.size).toBe(3);
  });

  it('exposes TIER_ORDER with t3 and t3d sharing a column index', () => {
    expect(TIER_ORDER.t0).toBeLessThan(TIER_ORDER.t1);
    expect(TIER_ORDER.t3).toBe(TIER_ORDER.t3d);
    expect(TIER_ORDER.tx).toBe(Math.max(...Object.values(TIER_ORDER)));
  });
});

describe('computeLayout — 3D cluster', () => {
  it('places every entity with a non-trivial z spread (not a flat plane)', () => {
    const entities = Array.from({ length: 12 }, (_, i) => entity(`n${i}`, 't3'));
    const pos = computeLayout(head(entities), '3d');
    expect(Object.keys(pos)).toHaveLength(12);
    const zs = Object.values(pos).map((p) => p.z);
    const spread = Math.max(...zs) - Math.min(...zs);
    expect(spread).toBeGreaterThan(0);
  });

  it('is deterministic — same input yields identical positions', () => {
    const entities = Array.from({ length: 8 }, (_, i) => entity(`n${i}`, 't2'));
    const h = head(entities, [
      { relationId: 'r1', sourceEntityId: 'n0', targetEntityId: 'n1', kind: 'hierarchy', label: '' },
    ]);
    const a = computeLayout(h, '3d');
    const b = computeLayout(h, '3d');
    expect(a).toEqual(b);
  });

  it('handles an empty head without throwing', () => {
    expect(computeLayout(head([]), '2d')).toEqual({});
    expect(computeLayout(head([]), '3d')).toEqual({});
  });
});
