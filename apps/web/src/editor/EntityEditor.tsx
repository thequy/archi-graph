// EntityEditor — create/edit an entity and COMMIT it through the API
// (api.createEntity). This is a focused form: identity (code/title/shortTitle),
// classification (type/group/tier), status + tags, and the markdown body.
// Submitting calls api.createEntity(branchId, entity); on success the host is
// notified (onCommitted) so it can refresh the graph and select the new node.
//
// Editing an existing entity reuses the same create endpoint (the API treats a
// write to an existing entityId as an update/new version — see apps/api), so the
// form is seeded from `initial` when provided.

import { useState } from 'react';
import type { Entity, EntityType, Group, Tier } from '@archi-graph/shared';
import { ENTITY_TYPES, GROUPS, TIERS } from '@archi-graph/shared';
import { api } from '../api/client';
import { GROUP_STYLES, TIER_LABELS, TYPE_STYLES } from '../graph/styles';

export interface EntityEditorProps {
  branchId: string;
  /** When editing, the entity to seed the form from. */
  initial?: Entity | null;
  onCommitted?: (entityId: string, commitId: string) => void;
  onCancel?: () => void;
}

function emptyEntity(): Entity {
  return {
    entityId: '',
    type: 'lld',
    code: '',
    shortTitle: '',
    group: 'soe',
    tier: 't0',
    title: '',
    metadata: { author: '', date: new Date().toISOString().slice(0, 10), status: 'draft', tags: [] },
    contentMarkdown: '',
    flow: null,
    links: [],
  };
}

function genId(code: string): string {
  const slug = code.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || `entity-${Date.now()}`;
}

export function EntityEditor({
  branchId,
  initial,
  onCommitted,
  onCancel,
}: EntityEditorProps): JSX.Element {
  const [form, setForm] = useState<Entity>(() => initial ?? emptyEntity());
  const [tagsText, setTagsText] = useState(() => (initial?.metadata.tags ?? []).join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function patch(p: Partial<Entity>): void {
    setForm((f) => ({ ...f, ...p }));
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const tags = tagsText.split(',').map((t) => t.trim()).filter(Boolean);
    const entityId = form.entityId || genId(form.code || form.title);
    const payload: Entity = {
      ...form,
      entityId,
      metadata: { ...form.metadata, tags },
    };
    try {
      const res = await api.createEntity(branchId, payload);
      onCommitted?.(res.entityId, res.commitId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="entity-editor" aria-label="Entity editor" onSubmit={submit}>
      <div className="ee-row">
        <label>
          Code
          <input value={form.code} onChange={(e) => patch({ code: e.target.value })} />
        </label>
        <label>
          Short title
          <input
            value={form.shortTitle}
            onChange={(e) => patch({ shortTitle: e.target.value })}
          />
        </label>
      </div>

      <label>
        Title
        <input value={form.title} onChange={(e) => patch({ title: e.target.value })} required />
      </label>

      <div className="ee-row">
        <label>
          Type
          <select
            value={form.type}
            onChange={(e) => patch({ type: e.target.value as EntityType })}
          >
            {ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_STYLES[t].label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Group
          <select
            value={form.group}
            onChange={(e) => patch({ group: e.target.value as Group })}
          >
            {GROUPS.map((g) => (
              <option key={g} value={g}>
                {GROUP_STYLES[g].label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tier
          <select value={form.tier} onChange={(e) => patch({ tier: e.target.value as Tier })}>
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {TIER_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="ee-row">
        <label>
          Status
          <input
            value={form.metadata.status}
            onChange={(e) =>
              patch({ metadata: { ...form.metadata, status: e.target.value } })
            }
          />
        </label>
        <label>
          Tags (comma-separated)
          <input value={tagsText} onChange={(e) => setTagsText(e.target.value)} />
        </label>
      </div>

      <label>
        Content (Markdown)
        <textarea
          className="ee-md"
          rows={10}
          value={form.contentMarkdown}
          onChange={(e) => patch({ contentMarkdown: e.target.value })}
        />
      </label>

      {error && <div className="ee-error">{error}</div>}

      <div className="ee-actions">
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : initial ? 'Save changes' : 'Create entity'}
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
