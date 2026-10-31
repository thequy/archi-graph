// Typed HTTP client for the Archi-Graph API. Every function is typed with the
// shared DTOs (@archi-graph/shared) so the request/response shapes stay in lock
// step with the NestJS controllers (apps/api). Transport is the browser `fetch`
// — in tests it is stubbed via vi.stubGlobal, so there is no network coupling.
//
// Base URL comes from the Vite env var VITE_API_URL, defaulting to
// http://localhost:3001 (the API's local port). `createClient(base)` lets tests
// pin an explicit base.

import type {
  BlastRadius,
  Entity,
  GraphDiff,
  HeadState,
  MergeConflict,
  MergeResolutions,
  MergeResult,
  RagAnswer,
  Relation,
} from '@archi-graph/shared';

export type Direction = 'downstream' | 'upstream';

// Merge contract types (MergeConflict / MergeResult / MergeResolutions) are now
// canonical in @archi-graph/shared and imported above — the API merge endpoint
// (POST /branches/:candidateId/merge) and this client share one definition.
// Re-exported so existing consumers (e.g. workbench/Workbench.tsx) that imported
// them from this module keep compiling unchanged.
export type { MergeConflict, MergeResolutions, MergeResult } from '@archi-graph/shared';

/** Branch summary row as returned by GET /branches. */
export interface BranchSummary {
  id: string;
  name: string;
  headCommitId: string | null;
  parentCommitId: string | null;
  author: string;
  createdAt: string;
}

export interface CreateEntityResult {
  commitId: string;
  entityId: string;
}
export interface CreateRelationResult {
  commitId: string;
  relationId: string;
}
export interface CreateCandidateResult {
  branchId: string;
}

export interface ApiClient {
  readonly baseUrl: string;
  getGraph(branchId: string): Promise<HeadState>;
  createEntity(branchId: string, entity: Entity): Promise<CreateEntityResult>;
  deleteEntity(branchId: string, entityId: string): Promise<CreateEntityResult>;
  createRelation(branchId: string, relation: Relation): Promise<CreateRelationResult>;
  deleteRelation(branchId: string, relationId: string): Promise<CreateRelationResult>;
  listBranches(): Promise<BranchSummary[]>;
  createCandidate(name: string, fromBranchId: string): Promise<CreateCandidateResult>;
  getDiff(base: string, candidate: string): Promise<GraphDiff>;
  blastForNode(
    branchId: string,
    entityId: string,
    direction: Direction,
    maxDepth?: number,
  ): Promise<BlastRadius>;
  blastForCandidate(base: string, candidate: string, direction: Direction): Promise<BlastRadius>;
  ask(branchId: string, question: string): Promise<RagAnswer>;
  merge(candidateId: string, resolutions?: MergeResolutions): Promise<MergeResult>;
}

const DEFAULT_BASE_URL = 'http://localhost:3001';

/** Reads the Vite-injected API URL, falling back to the local default. */
function resolveDefaultBaseUrl(): string {
  // import.meta.env is defined under Vite (dev/build/test). Guard so a bare
  // Node context (no Vite) still works.
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_API_URL ?? DEFAULT_BASE_URL;
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

export function createClient(baseUrl: string = resolveDefaultBaseUrl()): ApiClient {
  // Normalise away a trailing slash so `${base}/path` never doubles up.
  const base = baseUrl.replace(/\/+$/, '');

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${base}${path}`, init);
    if (!res.ok) {
      let detail = '';
      try {
        detail = await res.text();
      } catch {
        /* body already consumed / empty */
      }
      throw new Error(`API ${init?.method ?? 'GET'} ${path} failed: ${res.status} ${detail}`.trim());
    }
    return (await res.json()) as T;
  }

  function jsonBody(body: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  return {
    baseUrl: base,

    getGraph(branchId) {
      return request<HeadState>(`/branches/${enc(branchId)}/graph`);
    },

    createEntity(branchId, entity) {
      return request<CreateEntityResult>(`/branches/${enc(branchId)}/entities`, jsonBody(entity));
    },

    deleteEntity(branchId, entityId) {
      return request<CreateEntityResult>(
        `/branches/${enc(branchId)}/entities/${enc(entityId)}`,
        { method: 'DELETE' },
      );
    },

    createRelation(branchId, relation) {
      return request<CreateRelationResult>(
        `/branches/${enc(branchId)}/relations`,
        jsonBody(relation),
      );
    },

    deleteRelation(branchId, relationId) {
      return request<CreateRelationResult>(
        `/branches/${enc(branchId)}/relations/${enc(relationId)}`,
        { method: 'DELETE' },
      );
    },

    listBranches() {
      return request<BranchSummary[]>('/branches');
    },

    createCandidate(name, fromBranchId) {
      return request<CreateCandidateResult>('/branches', jsonBody({ name, fromBranchId }));
    },

    getDiff(base: string, candidate: string) {
      return request<GraphDiff>(`/diff?base=${enc(base)}&candidate=${enc(candidate)}`);
    },

    blastForNode(branchId, entityId, direction, maxDepth) {
      const qs = new URLSearchParams({ direction });
      if (maxDepth !== undefined) qs.set('maxDepth', String(maxDepth));
      return request<BlastRadius>(
        `/branches/${enc(branchId)}/blast/${enc(entityId)}?${qs.toString()}`,
      );
    },

    blastForCandidate(base: string, candidate: string, direction) {
      const qs = new URLSearchParams({ base, candidate, direction });
      return request<BlastRadius>(`/blast/candidate?${qs.toString()}`);
    },

    ask(branchId, question) {
      return request<RagAnswer>(`/branches/${enc(branchId)}/ask`, jsonBody({ question }));
    },

    merge(candidateId, resolutions) {
      // POST /branches/:candidateId/merge { resolutions? } -> MergeResult.
      return request<MergeResult>(
        `/branches/${enc(candidateId)}/merge`,
        jsonBody(resolutions ? { resolutions } : {}),
      );
    },
  };
}

/** A default client wired to the env base URL (convenient for app code). */
export const api = createClient();
