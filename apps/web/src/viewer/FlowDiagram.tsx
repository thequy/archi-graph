// FlowDiagram — renders an entity's `flow` JSON as a reactflow graph. This is
// lazy-mounted by DocViewer (React.lazy) so the reactflow bundle only loads when
// a selected entity actually carries a flow, matching the POC's "react-flow only
// when a flow is shown" behaviour.
//
// The `flow` field on Entity is typed `unknown | null` in the shared package, so
// we validate its shape defensively here: a flow is usable only when it has
// array `nodes` and `edges`. Anything else renders nothing (the viewer simply
// shows the markdown without a diagram).

import { useMemo } from 'react';
import ReactFlow, { Background, Controls, type Edge, type Node } from 'reactflow';
import 'reactflow/dist/style.css';

interface FlowShape {
  nodes: Node[];
  edges: Edge[];
}

function asFlow(flow: unknown): FlowShape | null {
  if (!flow || typeof flow !== 'object') return null;
  const f = flow as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(f.nodes) || !Array.isArray(f.edges)) return null;
  return { nodes: f.nodes as Node[], edges: f.edges as Edge[] };
}

export interface FlowDiagramProps {
  flow: unknown;
}

export default function FlowDiagram({ flow }: FlowDiagramProps): JSX.Element | null {
  const parsed = useMemo(() => asFlow(flow), [flow]);
  if (!parsed) return null;
  return (
    <div className="flow-diagram" style={{ height: 320 }} data-testid="flow-diagram">
      <ReactFlow nodes={parsed.nodes} edges={parsed.edges} fitView proOptions={{ hideAttribution: true }}>
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
