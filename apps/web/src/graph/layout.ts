// Pure graph-layout math — NO three.js, NO WebGL, NO DOM. This is the
// unit-testable core extracted from the POC's `computeLayout` / `layoutLayered`
// / `relax` functions (index.html at the worktree root). `Graph3D` consumes the
// positions produced here and only owns rendering (meshes, sprites, camera).
//
// Two modes, both ported from the POC:
//   '2d' — LAYERED by tier: each tier is a column (X = tier order, left→right),
//          nodes stack vertically (Y), z fixed at 0. Column order follows the
//          POC's TIERS table; t3 (Backend Services) and t3d (Databases) share a
//          column (same order index), exactly as in the POC.
//   '3d' — CLUSTER: seed nodes on a Fibonacci sphere, then relax with a
//          spring (edges) + inverse-square repulsion (all pairs) simulation —
//          the POC's `relax(..., flat=false)`. Fully deterministic (fixed seed
//          + fixed iteration count) so it is unit-testable without a GPU.

import type { HeadState, Tier } from '@archi-graph/shared';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type LayoutMode = '2d' | '3d';

/** positions keyed by entityId. */
export type Positions = Record<string, Vec3>;

// Column index per tier (POC TIERS[*].order). t3 & t3d intentionally collide:
// Backend Services and Databases render in the same column.
export const TIER_ORDER: Record<Tier, number> = {
  t0: 0,
  t1: 1,
  t2: 2,
  t3: 3,
  t3d: 3,
  t4: 4,
  t5: 5,
  tx: 6,
};

// 2D column/row spacing (ported from the POC's COL_W / ROW_H).
const COL_W = 62;
const ROW_H = 18;

// 3D relaxation constants (ported from the POC `relax`).
const SPHERE_R = 60;
const ITERATIONS = 260;
const REPULSION = 900;
const REST_LENGTH = 34;
const SPRING_K = 0.05;
const CENTER_PULL = 0.002;

/** Entry point. Pure: same input → same output. */
export function computeLayout(head: HeadState, mode: LayoutMode): Positions {
  return mode === '2d' ? layout2D(head) : layout3D(head);
}

/**
 * LAYERED 2D layout. Nodes are grouped into tier columns; within a column they
 * are sorted (group, then code) and stacked top→bottom, centred on Y=0. X of a
 * column is centred around the middle column so the whole layout straddles the
 * origin (matches the POC camera framing). z is always 0.
 */
function layout2D(head: HeadState): Positions {
  const positions: Positions = {};
  if (head.entities.length === 0) return positions;

  const byOrder = new Map<number, typeof head.entities>();
  for (const e of head.entities) {
    const ord = TIER_ORDER[e.tier] ?? TIER_ORDER.tx;
    const bucket = byOrder.get(ord);
    if (bucket) bucket.push(e);
    else byOrder.set(ord, [e]);
  }

  const orders = [...byOrder.keys()].sort((a, b) => a - b);
  const minOrd = orders[0];
  const maxOrd = orders[orders.length - 1];
  const midOrd = (minOrd + maxOrd) / 2;

  for (const ord of orders) {
    const col = byOrder.get(ord)!;
    col.sort(
      (a, b) =>
        (a.group || '').localeCompare(b.group || '') ||
        (a.code || '').localeCompare(b.code || ''),
    );
    const x = (ord - midOrd) * COL_W;
    const totalH = (col.length - 1) * ROW_H;
    col.forEach((e, i) => {
      positions[e.entityId] = { x, y: totalH / 2 - i * ROW_H, z: 0 };
    });
  }
  return positions;
}

/**
 * 3D CLUSTER layout: Fibonacci-sphere seed + spring/repulsion relaxation.
 * Deterministic — no randomness — so tests get stable positions.
 */
function layout3D(head: HeadState): Positions {
  const positions: Positions = {};
  const n = head.entities.length;
  if (n === 0) return positions;

  // Seed on a Fibonacci sphere (POC seeding formula).
  const pos = new Map<string, Vec3>();
  head.entities.forEach((e, i) => {
    const phi = Math.acos(-1 + (2 * i) / n);
    const theta = Math.sqrt(n * Math.PI) * phi;
    pos.set(e.entityId, {
      x: SPHERE_R * Math.cos(theta) * Math.sin(phi),
      y: SPHERE_R * Math.sin(theta) * Math.sin(phi),
      z: SPHERE_R * Math.cos(phi),
    });
  });

  const ids = head.entities.map((e) => e.entityId);
  const idSet = new Set(ids);
  const edges = head.relations
    .filter((r) => idSet.has(r.sourceEntityId) && idSet.has(r.targetEntityId))
    .map((r) => [r.sourceEntityId, r.targetEntityId] as const);

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const disp = new Map<string, Vec3>(ids.map((id) => [id, { x: 0, y: 0, z: 0 }]));

    // inverse-square repulsion between every pair.
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i])!;
        const b = pos.get(ids[j])!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        const dist = Math.hypot(dx, dy, dz) || 0.01;
        const force = REPULSION / (dist * dist);
        const ux = (dx / dist) * force;
        const uy = (dy / dist) * force;
        const uz = (dz / dist) * force;
        add(disp.get(ids[i])!, ux, uy, uz);
        add(disp.get(ids[j])!, -ux, -uy, -uz);
      }
    }

    // spring attraction along edges (toward REST_LENGTH).
    for (const [s, t] of edges) {
      const a = pos.get(s)!;
      const b = pos.get(t)!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dz = a.z - b.z;
      const dist = Math.hypot(dx, dy, dz) || 0.01;
      const force = (dist - REST_LENGTH) * SPRING_K;
      const ux = (dx / dist) * force;
      const uy = (dy / dist) * force;
      const uz = (dz / dist) * force;
      add(disp.get(s)!, -ux, -uy, -uz);
      add(disp.get(t)!, ux, uy, uz);
    }

    // integrate with cooling + gentle pull toward the origin.
    const cool = 1 - iter / 320;
    const maxStep = 6 * cool;
    for (const id of ids) {
      const p = pos.get(id)!;
      const d = disp.get(id)!;
      clampLength(d, maxStep);
      p.x += d.x - p.x * CENTER_PULL;
      p.y += d.y - p.y * CENTER_PULL;
      p.z += d.z - p.z * CENTER_PULL;
    }
  }

  for (const id of ids) positions[id] = pos.get(id)!;
  return positions;
}

function add(v: Vec3, x: number, y: number, z: number): void {
  v.x += x;
  v.y += y;
  v.z += z;
}

function clampLength(v: Vec3, max: number): void {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len > max && len > 0) {
    const s = max / len;
    v.x *= s;
    v.y *= s;
    v.z *= s;
  }
}
