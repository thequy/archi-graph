// DetailPanel — right panel. Shows the selected entity's identity (type badge,
// code, short title), metadata (group/tier/status/author/date), tags, and its
// relationships grouped by kind (hierarchy vs semantic). Each relationship is a
// button that navigates the graph to the other end (two-way sync): clicking a
// related entity fires onSelectEntity with that entity's id.

import { useMemo } from 'react';
import type { Entity, HeadState, Relation } from '@archi-graph/shared';
import { GROUP_STYLES, TIER_LABELS, TYPE_STYLES } from '../graph/styles';

export interface DetailPanelProps {
  entity: Entity;
  head: HeadState;
  onSelectEntity: (entityId: string) => void;
  onClose?: () => void;
}

interface RelView {
  relation: Relation;
  otherId: string;
  otherLabel: string;
  dir: 'out' | 'in';
}

function relViews(entity: Entity, head: HeadState, kind: Relation['kind']): RelView[] {
  const byId = new Map(head.entities.map((e) => [e.entityId, e]));
  const out: RelView[] = [];
  for (const r of head.relations) {
    if (r.kind !== kind) continue;
    if (r.sourceEntityId === entity.entityId) {
      const other = byId.get(r.targetEntityId);
      out.push({
        relation: r,
        otherId: r.targetEntityId,
        otherLabel: other ? other.shortTitle || other.title : r.targetEntityId,
        dir: 'out',
      });
    } else if (r.targetEntityId === entity.entityId) {
      const other = byId.get(r.sourceEntityId);
      out.push({
        relation: r,
        otherId: r.sourceEntityId,
        otherLabel: other ? other.shortTitle || other.title : r.sourceEntityId,
        dir: 'in',
      });
    }
  }
  return out;
}

function RelGroup({
  title,
  rels,
  onSelectEntity,
}: {
  title: string;
  rels: RelView[];
  onSelectEntity: (id: string) => void;
}): JSX.Element | null {
  if (rels.length === 0) return null;
  return (
    <div className="rel-group">
      <div className="rel-title">{title}</div>
      <ul className="rel-list">
        {rels.map((rv) => (
          <li key={rv.relation.relationId}>
            <button
              type="button"
              className="rel-link"
              onClick={() => onSelectEntity(rv.otherId)}
              title={`Go to ${rv.otherLabel}`}
            >
              <span className="rel-dir">{rv.dir === 'out' ? '→' : '←'}</span>
              <span className="rel-label">{rv.relation.label}</span>
              <span className="rel-other">{rv.otherLabel}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DetailPanel({
  entity,
  head,
  onSelectEntity,
  onClose,
}: DetailPanelProps): JSX.Element {
  const hierarchy = useMemo(() => relViews(entity, head, 'hierarchy'), [entity, head]);
  const semantic = useMemo(() => relViews(entity, head, 'semantic'), [entity, head]);
  const ts = TYPE_STYLES[entity.type];
  const gs = GROUP_STYLES[entity.group];

  return (
    <aside className="detail-panel" aria-label="Detail panel">
      <div className="detail-head">
        <span className="d-type" style={{ background: ts.color }}>
          {entity.code || ts.code}
        </span>
        {onClose && (
          <button className="close" onClick={onClose} title="Close" aria-label="Close detail">
            ✕
          </button>
        )}
      </div>

      <h2 className="d-title">{entity.shortTitle || entity.title}</h2>
      <div className="d-fulltitle">{entity.title}</div>

      <dl className="d-meta-list">
        <div>
          <dt>Type</dt>
          <dd>{ts.label}</dd>
        </div>
        <div>
          <dt>Group</dt>
          <dd>{gs.label}</dd>
        </div>
        <div>
          <dt>Tier</dt>
          <dd>{TIER_LABELS[entity.tier] ?? entity.tier}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{entity.metadata.status}</dd>
        </div>
        <div>
          <dt>Author</dt>
          <dd>{entity.metadata.author}</dd>
        </div>
        <div>
          <dt>Date</dt>
          <dd>{entity.metadata.date}</dd>
        </div>
      </dl>

      {entity.metadata.tags.length > 0 && (
        <div className="d-tags">
          {entity.metadata.tags.map((t) => (
            <span key={t} className="d-tag">
              {t}
            </span>
          ))}
        </div>
      )}

      <div className="d-relationships">
        <div className="d-section-title">Relationships</div>
        <RelGroup title="Hierarchy" rels={hierarchy} onSelectEntity={onSelectEntity} />
        <RelGroup title="Semantic" rels={semantic} onSelectEntity={onSelectEntity} />
        {hierarchy.length === 0 && semantic.length === 0 && (
          <div className="rel-empty">No relationships</div>
        )}
      </div>
    </aside>
  );
}
