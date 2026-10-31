// Visual style tables ported verbatim from the POC (index.html at the worktree
// root), keyed to the shared enums so they stay type-checked against the domain.
//
//   - TYPE_STYLES : node ICON + label code, per EntityType.
//   - GROUP_STYLES: node COLOR (the ring / sprite tint), per Group.
//   - EDGE_STYLES : hierarchy = solid thick blue, semantic = dashed thin purple.
//   - TIER_LABELS : human column headers for the 2D layered view.
//
// Global Constraint (preserved): node color = system GROUP; icon = TYPE;
// hierarchy edge solid; semantic edge dashed.

import type { EntityType, Group, RelationKind, Tier } from '@archi-graph/shared';

export interface TypeStyle {
  code: string;
  color: string;
  icon: string;
  label: string;
}

export const TYPE_STYLES: Record<EntityType, TypeStyle> = {
  brd: { code: 'BRD', color: '#e8590c', icon: '📑', label: 'Business Requirement Document' },
  sad: { code: 'SAD', color: '#e03131', icon: '🏛️', label: 'Solution Architecture Document' },
  hld: { code: 'HLD', color: '#f08c00', icon: '🗂️', label: 'High-Level Design' },
  lld: { code: 'LLD', color: '#c99a06', icon: '🧩', label: 'Low-Level Design' },
  tsd: { code: 'TSD', color: '#2f9e44', icon: '🗄️', label: 'Technical Specification Document' },
  adr: { code: 'ADR', color: '#1c7ed6', icon: '📋', label: 'Architecture Decision Record' },
  dp: { code: 'DP', color: '#0ca678', icon: '♟️', label: 'Design Pattern' },
  dia: { code: 'DIA', color: '#7048e8', icon: '📐', label: 'Diagram' },
};

export interface GroupStyle {
  code: string;
  color: string;
  label: string;
}

export const GROUP_STYLES: Record<Group, GroupStyle> = {
  soe: { code: 'SoE', color: '#1c7ed6', label: 'System of Engagement' },
  soo: { code: 'SoO', color: '#0ca678', label: 'System of Operation' },
  soi: { code: 'SoI', color: '#e8590c', label: 'System of Integration' },
  sos: { code: 'SoS', color: '#e03131', label: 'System of Security' },
  sor: { code: 'SoR', color: '#7048e8', label: 'System of Record' },
  soda: { code: 'SoDA', color: '#c99a06', label: 'System of Data & Analytic' },
};

export interface EdgeStyle {
  color: number;
  radius: number;
  dashed: boolean;
  opacity: number;
  arrow: boolean;
  label: string;
}

export const EDGE_STYLES: Record<RelationKind, EdgeStyle> = {
  hierarchy: { color: 0x2f7de1, radius: 0.55, dashed: false, opacity: 0.85, arrow: true, label: 'Hierarchy (structure)' },
  semantic: { color: 0x8158e6, radius: 0.34, dashed: true, opacity: 0.7, arrow: true, label: 'Semantic relationship' },
};

export const EDGE_HIGHLIGHT = 0x1552b5;

export const TIER_LABELS: Record<Tier, string> = {
  t0: 'Frontend Apps',
  t1: 'API Gateway (Ext/Int)',
  t2: 'BFF',
  t3: 'Backend Services',
  t3d: 'Databases',
  t4: 'API Gateway (Inbound)',
  t5: 'System of Record',
  tx: 'Cross-cutting / Docs',
};

/** Node ring/sprite color: group color (always present in the domain). */
export function nodeColor(group: Group, type: EntityType): string {
  return GROUP_STYLES[group]?.color ?? TYPE_STYLES[type]?.color ?? '#5c6b8a';
}

/** Icon shown on the node sprite: by TYPE. */
export function nodeIcon(type: EntityType): string {
  return TYPE_STYLES[type]?.icon ?? '🔗';
}

export function nodeCode(code: string, type: EntityType): string {
  return code || TYPE_STYLES[type]?.code || 'DOC';
}
