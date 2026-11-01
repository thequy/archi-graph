import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { HeadState, Entity, Relation, GraphDiff, BlastRadius, RagAnswer } from '@archi-graph/shared';
import { createClient } from './client';

const BASE = 'http://api.test';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const sampleEntity: Entity = {
  entityId: 'e1',
  type: 'lld',
  code: 'LLD-01',
  shortTitle: 'Web',
  group: 'soe',
  tier: 't0',
  title: 'Frontend — Web',
  metadata: { author: 'Guild', date: '2026-03-10', status: 'stable', tags: ['frontend'] },
  contentMarkdown: '# Web',
  flow: null,
  links: [],
};

const sampleRelation: Relation = {
  relationId: 'r1',
  sourceEntityId: 'e1',
  targetEntityId: 'e2',
  kind: 'hierarchy',
  label: 'contains',
};

describe('api client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('getGraph parses a HeadState response into typed entities/relations', async () => {
    const head: HeadState = { entities: [sampleEntity], relations: [sampleRelation] };
    fetchMock.mockResolvedValueOnce(jsonResponse(head));

    const api = createClient(BASE);
    const result = await api.getGraph('main');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api.test/branches/main/graph');
    expect(init?.method ?? 'GET').toBe('GET');

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].entityId).toBe('e1');
    expect(result.entities[0].group).toBe('soe');
    expect(result.relations[0].kind).toBe('hierarchy');
  });

  it('createEntity POSTs the entity as JSON to the branch entities endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ commitId: 'c1', entityId: 'e1' }));
    const api = createClient(BASE);
    const res = await api.createEntity('main', sampleEntity);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api.test/branches/main/entities');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(init!.body as string)).toMatchObject({ entityId: 'e1', group: 'soe' });
    expect(res).toMatchObject({ entityId: 'e1' });
  });

  it('deleteEntity DELETEs the entity by id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ commitId: 'c2', entityId: 'e1' }));
    const api = createClient(BASE);
    await api.deleteEntity('main', 'e1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api.test/branches/main/entities/e1');
    expect(init?.method).toBe('DELETE');
  });

  it('createRelation POSTs to the relations endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ commitId: 'c3', relationId: 'r1' }));
    const api = createClient(BASE);
    await api.createRelation('main', sampleRelation);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api.test/branches/main/relations');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toMatchObject({ relationId: 'r1', kind: 'hierarchy' });
  });

  it('deleteRelation DELETEs the relation by id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ commitId: 'c4', relationId: 'r1' }));
    const api = createClient(BASE);
    await api.deleteRelation('main', 'r1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api.test/branches/main/relations/r1');
    expect(init?.method).toBe('DELETE');
  });

  it('listBranches GETs /branches', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([{ id: 'main', name: 'main', headCommitId: null, parentCommitId: null, author: 'a', createdAt: '2026-01-01' }]),
    );
    const api = createClient(BASE);
    const branches = await api.listBranches();
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/branches');
    expect(branches[0].id).toBe('main');
  });

  it('createCandidate POSTs { name, fromBranchId } to /branches', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ branchId: 'cand-1' }));
    const api = createClient(BASE);
    const res = await api.createCandidate('feature', 'main');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api.test/branches');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({ name: 'feature', fromBranchId: 'main' });
    expect(res.branchId).toBe('cand-1');
  });

  it('getDiff GETs /diff with base & candidate query params', async () => {
    const diff: GraphDiff = { entities: [], relations: [] };
    fetchMock.mockResolvedValueOnce(jsonResponse(diff));
    const api = createClient(BASE);
    await api.getDiff('main', 'cand-1');
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/diff?base=main&candidate=cand-1');
  });

  it('blastForNode GETs the node blast endpoint with direction & maxDepth', async () => {
    const blast: BlastRadius = { direction: 'downstream', nodes: [] };
    fetchMock.mockResolvedValueOnce(jsonResponse(blast));
    const api = createClient(BASE);
    const res = await api.blastForNode('main', 'e1', 'downstream', 3);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://api.test/branches/main/blast/e1?direction=downstream&maxDepth=3',
    );
    expect(res.direction).toBe('downstream');
  });

  it('blastForNode omits maxDepth when not provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ direction: 'upstream', nodes: [] }));
    const api = createClient(BASE);
    await api.blastForNode('main', 'e1', 'upstream');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://api.test/branches/main/blast/e1?direction=upstream',
    );
  });

  it('blastForCandidate GETs /blast/candidate with base, candidate, direction', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ direction: 'downstream', nodes: [] }));
    const api = createClient(BASE);
    await api.blastForCandidate('main', 'cand-1', 'downstream');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://api.test/blast/candidate?base=main&candidate=cand-1&direction=downstream',
    );
  });

  it('ask POSTs { question } to the branch ask endpoint', async () => {
    const answer: RagAnswer = { answer: 'hi', citations: [] };
    fetchMock.mockResolvedValueOnce(jsonResponse(answer));
    const api = createClient(BASE);
    const res = await api.ask('main', 'what is x?');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api.test/branches/main/ask');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({ question: 'what is x?' });
    expect(res.answer).toBe('hi');
  });

  it('listProjects GETs /projects and returns the project summaries', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: 'p1', name: 'Alpha', description: 'first', createdAt: '2026-01-01' },
        { id: 'p2', name: 'Beta', description: null, createdAt: '2026-01-02' },
      ]),
    );
    const api = createClient(BASE);
    const projects = await api.listProjects();
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/projects');
    expect(projects).toHaveLength(2);
    expect(projects[0]).toMatchObject({ id: 'p1', name: 'Alpha' });
    expect(projects[1].description).toBeNull();
  });

  it('createProject POSTs { name, description } to /projects', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 'p3', name: 'Gamma', description: 'third', createdAt: '2026-01-03' }),
    );
    const api = createClient(BASE);
    const res = await api.createProject('Gamma', 'third');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api.test/projects');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(init!.body as string)).toEqual({ name: 'Gamma', description: 'third' });
    expect(res.id).toBe('p3');
  });

  it('createProject omits description when not provided', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 'p4', name: 'Delta', description: null, createdAt: '2026-01-04' }),
    );
    const api = createClient(BASE);
    await api.createProject('Delta');
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init!.body as string)).toEqual({ name: 'Delta' });
  });

  it('getProject GETs /projects/:id', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 'p1', name: 'Alpha', description: null, createdAt: '2026-01-01' }),
    );
    const api = createClient(BASE);
    const res = await api.getProject('p1');
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/projects/p1');
    expect(res.id).toBe('p1');
  });

  it('renameProject PATCHes { name } to /projects/:id', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 'p1', name: 'Renamed', description: null, createdAt: '2026-01-01' }),
    );
    const api = createClient(BASE);
    const res = await api.renameProject('p1', 'Renamed');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api.test/projects/p1');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init!.body as string)).toEqual({ name: 'Renamed' });
    expect(res.name).toBe('Renamed');
  });

  it('deleteProject DELETEs /projects/:id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'p1' }));
    const api = createClient(BASE);
    await api.deleteProject('p1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api.test/projects/p1');
    expect(init?.method).toBe('DELETE');
  });

  it('listBranches scopes to a project via ?projectId= when given', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([{ id: 'b1', name: 'main', headCommitId: null, parentCommitId: null, author: 'a', createdAt: '2026-01-01' }]),
    );
    const api = createClient(BASE);
    await api.listBranches('p1');
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/branches?projectId=p1');
  });

  it('listBranches omits the query string when no project id is given', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const api = createClient(BASE);
    await api.listBranches();
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/branches');
  });

  it('throws on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'nope' }, 404));
    const api = createClient(BASE);
    await expect(api.getGraph('ghost')).rejects.toThrow();
  });

  it('defaults the base URL when created with no argument', () => {
    const api = createClient();
    expect(api.baseUrl).toBe('http://localhost:3001');
  });
});
