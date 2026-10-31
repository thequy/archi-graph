// Graph3D — three.js rendering of an API HeadState, ported from the POC
// (index.html at the worktree root). The POC was UMD/global THREE + examples/js
// scripts; here three.js is a proper npm dependency and the OrbitControls /
// CSS2DRenderer add-ons are ES-module imports from `three/examples/jsm/*`
// (stable path on three 0.160.x — see the task report for the version rationale).
//
// WHAT IS PORTED (visual + interaction parity with the POC):
//   - node sprite with a circular badge: RING = group color, ICON = type emoji;
//   - CSS2D label: [code badge] + short title;
//   - edges: hierarchy = solid thick blue tube + arrow cone; semantic = dashed
//     thin purple segments + arrow cone;
//   - 2D layered-by-tier columns vs 3D clustered sphere (via computeLayout);
//   - tier-column headers in 2D;
//   - filter: hide nodes by group and/or type AND their incident edges;
//   - selection highlight: focus node enlarged, neighbors kept bright, others
//     dimmed; only edges touching the selection stay visible, with labels.
//
// DATA SOURCE: the POC's embedded `documents`/`relations` are replaced by the
// `head: HeadState` prop (from api.getGraph). All layout math lives in the pure,
// unit-tested computeLayout — this component owns only rendering, so the test
// suite needs no WebGL.
//
// TWO-WAY SELECTION: `selectedEntityId` (controlled prop) drives the highlight;
// clicking a node fires `onSelectEntity(id)`. React owns selection state.

import { useEffect, useRef } from 'react';
import type { Group, HeadState, EntityType } from '@archi-graph/shared';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  CSS2DRenderer,
  CSS2DObject,
} from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { computeLayout, TIER_ORDER, type LayoutMode, type Vec3 } from './layout';
import {
  EDGE_HIGHLIGHT,
  EDGE_STYLES,
  TIER_LABELS,
  nodeCode,
  nodeColor,
  nodeIcon,
} from './styles';

export interface GraphFilter {
  hiddenGroups?: Group[];
  hiddenTypes?: EntityType[];
}

export interface Graph3DProps {
  head: HeadState;
  mode: LayoutMode;
  filter?: GraphFilter;
  selectedEntityId?: string | null;
  onSelectEntity?: (entityId: string) => void;
}

const LABEL_OFFSET = new THREE.Vector3(0, 6.5, 0);
const FOG_DENSITY = 0.01;
const NODE_SCALE = 9;
const NODE_CLEARANCE = 4.5;

function vecToThree(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );
}

/** Circular badge texture: white disc, group-colored ring, type emoji. */
function makeIconTexture(icon: string, ringColor: string): THREE.CanvasTexture {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S / 2 - 6, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = ringColor;
  ctx.stroke();
  ctx.font = "64px 'Segoe UI Emoji','Apple Color Emoji',sans-serif";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(icon, S / 2, S / 2 + 4);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  return tex;
}

export function Graph3D({
  head,
  mode,
  filter,
  selectedEntityId,
  onSelectEntity,
}: Graph3DProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  // Latest selection callback without re-running the heavy scene effect.
  const onSelectRef = useRef(onSelectEntity);
  onSelectRef.current = onSelectEntity;

  // Imperative handle to the live scene so the lightweight effects (selection,
  // filter) can mutate it without a full rebuild.
  const sceneApiRef = useRef<{
    setHighlight: (id: string | null) => void;
    setFilter: (f: GraphFilter | undefined) => void;
  } | null>(null);

  // Build / rebuild the whole scene when head or mode changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf4f6fb);
    scene.fog = mode === '3d' ? new THREE.FogExp2(0xf4f6fb, FOG_DENSITY) : null;

    const camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 2000);
    camera.position.set(0, mode === '2d' ? 0 : 20, mode === '2d' ? 230 : 120);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    container.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(w, h);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0';
    labelRenderer.domElement.style.left = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    container.appendChild(labelRenderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enableRotate = mode === '3d';

    scene.add(new THREE.AmbientLight(0xffffff, 0.95));
    const dir = new THREE.DirectionalLight(0xffffff, 0.5);
    dir.position.set(50, 80, 60);
    scene.add(dir);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const positions = computeLayout(head, mode);
    const posVec = new Map<string, THREE.Vector3>();
    for (const [id, v] of Object.entries(positions)) posVec.set(id, vecToThree(v));

    const entityById = new Map(head.entities.map((e) => [e.entityId, e]));

    // ----- nodes (sprites) + labels -----
    const nodeMeshes = new Map<string, THREE.Sprite>();
    const nodeLabels = new Map<string, CSS2DObject>();
    for (const e of head.entities) {
      const p = posVec.get(e.entityId);
      if (!p) continue;
      const ring = nodeColor(e.group, e.type);
      const tex = makeIconTexture(nodeIcon(e.type), ring);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(NODE_SCALE, NODE_SCALE, 1);
      sprite.position.copy(p);
      sprite.userData = { id: e.entityId };
      scene.add(sprite);
      nodeMeshes.set(e.entityId, sprite);

      const div = document.createElement('div');
      div.className = 'node-label';
      div.innerHTML =
        `<span class="nl-code" style="background:${ring}">${escapeHtml(nodeCode(e.code, e.type))}</span>` +
        `<span class="nl-name">${escapeHtml(e.shortTitle || e.title)}</span>`;
      const label = new CSS2DObject(div);
      label.position.copy(p).add(LABEL_OFFSET);
      scene.add(label);
      nodeLabels.set(e.entityId, label);
    }

    // ----- edges -----
    interface EdgeRec {
      group: THREE.Group;
      mats: THREE.MeshBasicMaterial[];
      a: string;
      b: string;
      elabel: CSS2DObject;
      baseColor: number;
      baseOpacity: number;
    }
    const edges: EdgeRec[] = [];
    for (const r of head.relations) {
      const a = posVec.get(r.sourceEntityId);
      const b = posVec.get(r.targetEntityId);
      if (!a || !b) continue;
      const es = EDGE_STYLES[r.kind];
      const group = new THREE.Group();
      const edgeDir = new THREE.Vector3().subVectors(b, a).normalize();
      const headLen = es.arrow ? 3.2 : 0;
      const start = a.clone().addScaledVector(edgeDir, NODE_CLEARANCE);
      const end = b.clone().addScaledVector(edgeDir, -(NODE_CLEARANCE + headLen));
      const segLen = Math.max(start.distanceTo(end), 0.01);
      const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
      const up = new THREE.Vector3(0, 1, 0);

      const mats: THREE.MeshBasicMaterial[] = [];
      const mat = new THREE.MeshBasicMaterial({ color: es.color, transparent: true, opacity: es.opacity });
      mats.push(mat);

      if (es.dashed) {
        // semantic: short dashes instead of one solid tube.
        const dash = 2.0;
        const gap = 1.6;
        const step = dash + gap;
        for (let dd = 0; dd + dash <= segLen; dd += step) {
          const s = start.clone().addScaledVector(edgeDir, dd);
          const e2 = start.clone().addScaledVector(edgeDir, dd + dash);
          const mm = new THREE.Vector3().addVectors(s, e2).multiplyScalar(0.5);
          const seg = new THREE.Mesh(new THREE.CylinderGeometry(es.radius, es.radius, dash, 8, 1, true), mat);
          seg.position.copy(mm);
          seg.quaternion.setFromUnitVectors(up, edgeDir);
          group.add(seg);
        }
      } else {
        // hierarchy: one solid tube.
        const tube = new THREE.Mesh(new THREE.CylinderGeometry(es.radius, es.radius, segLen, 8, 1, true), mat);
        tube.position.copy(mid);
        tube.quaternion.setFromUnitVectors(up, edgeDir);
        group.add(tube);
      }

      if (es.arrow) {
        const coneMat = new THREE.MeshBasicMaterial({
          color: es.color,
          transparent: true,
          opacity: Math.min(1, es.opacity + 0.15),
        });
        mats.push(coneMat);
        const cone = new THREE.Mesh(new THREE.ConeGeometry(es.radius * 2.4, headLen, 12), coneMat);
        cone.position.copy(end.clone().addScaledVector(edgeDir, headLen / 2));
        cone.quaternion.setFromUnitVectors(up, edgeDir);
        group.add(cone);
      }

      const ldiv = document.createElement('div');
      ldiv.className = 'edge-label';
      ldiv.textContent = r.label;
      const elabel = new CSS2DObject(ldiv);
      elabel.position.copy(mid);
      elabel.visible = false;
      group.add(elabel);

      scene.add(group);
      edges.push({ group, mats, a: r.sourceEntityId, b: r.targetEntityId, elabel, baseColor: es.color, baseOpacity: es.opacity });
    }

    // ----- tier column headers (2D only) -----
    const tierLabels: CSS2DObject[] = [];
    if (mode === '2d' && head.entities.length > 0) {
      const colX = new Map<number, number>();
      const colTopY = new Map<number, number>();
      for (const e of head.entities) {
        const ord = TIER_ORDER[e.tier] ?? TIER_ORDER.tx;
        const p = posVec.get(e.entityId);
        if (!p) continue;
        colX.set(ord, p.x);
        colTopY.set(ord, Math.max(colTopY.get(ord) ?? -Infinity, p.y));
      }
      // Use the first entity of each order to label the column.
      const seenOrders = new Map<number, string>();
      for (const e of head.entities) {
        const ord = TIER_ORDER[e.tier] ?? TIER_ORDER.tx;
        if (!seenOrders.has(ord)) seenOrders.set(ord, e.tier);
      }
      for (const [ord, tier] of seenOrders) {
        const div = document.createElement('div');
        div.className = 'tier-label';
        div.textContent = TIER_LABELS[tier as keyof typeof TIER_LABELS] ?? tier;
        const lbl = new CSS2DObject(div);
        lbl.position.set(colX.get(ord) ?? 0, (colTopY.get(ord) ?? 0) + 20, 0);
        scene.add(lbl);
        tierLabels.push(lbl);
      }
    }

    // ----- filter: hide nodes by group/type + their incident edges -----
    function applyFilter(f: GraphFilter | undefined): void {
      const hiddenGroups = new Set(f?.hiddenGroups ?? []);
      const hiddenTypes = new Set(f?.hiddenTypes ?? []);
      const isVisible = (id: string): boolean => {
        const e = entityById.get(id);
        if (!e) return false;
        return !hiddenGroups.has(e.group) && !hiddenTypes.has(e.type);
      };
      for (const [id, sprite] of nodeMeshes) {
        const vis = isVisible(id);
        sprite.visible = vis;
        const lbl = nodeLabels.get(id);
        if (lbl) lbl.visible = vis;
      }
      for (const edge of edges) {
        edge.group.visible = isVisible(edge.a) && isVisible(edge.b);
      }
    }

    // ----- selection highlight (focus + neighbors; dim rest) -----
    function setHighlight(id: string | null): void {
      const neighbors = new Set<string>(id ? [id] : []);
      if (id) {
        for (const r of head.relations) {
          if (r.sourceEntityId === id) neighbors.add(r.targetEntityId);
          if (r.targetEntityId === id) neighbors.add(r.sourceEntityId);
        }
      }
      for (const [nid, sprite] of nodeMeshes) {
        const isFocus = nid === id;
        sprite.scale.setScalar(isFocus ? NODE_SCALE * 1.5 : NODE_SCALE);
        const op = id ? (neighbors.has(nid) ? 1 : 0.25) : 1;
        sprite.material.opacity = op;
        const lbl = nodeLabels.get(nid);
        if (lbl) (lbl.element as HTMLElement).style.opacity = String(op);
      }
      for (const edge of edges) {
        const touches = edge.a === id || edge.b === id;
        const hex = id && touches ? EDGE_HIGHLIGHT : edge.baseColor;
        const op = id ? 1 : edge.baseOpacity;
        for (const m of edge.mats) {
          m.color.setHex(hex);
          m.opacity = op;
        }
        edge.elabel.visible = !!(id && touches);
        // When a node is selected, only edges that touch it remain visible
        // (respecting the filter visibility set earlier).
        if (id) {
          edge.group.visible = edge.group.visible && touches;
        }
      }
    }

    // raycast picking -> onSelect
    function pickAt(clientX: number, clientY: number): string | null {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects([...nodeMeshes.values()].filter((m) => m.visible));
      return hits.length ? (hits[0].object.userData.id as string) : null;
    }

    let tapStart: { x: number; y: number; t: number; id: number } | null = null;
    const onPointerDown = (e: PointerEvent): void => {
      tapStart = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    };
    const onPointerUp = (e: PointerEvent): void => {
      if (!tapStart || e.pointerId !== tapStart.id) {
        tapStart = null;
        return;
      }
      const dx = e.clientX - tapStart.x;
      const dy = e.clientY - tapStart.y;
      const dt = performance.now() - tapStart.t;
      tapStart = null;
      if (dx * dx + dy * dy > 100 || dt > 600) return; // drag, not a tap
      const id = pickAt(e.clientX, e.clientY);
      if (id) onSelectRef.current?.(id);
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    // resize handling
    const onResize = (): void => {
      const cw = container.clientWidth || w;
      const ch = container.clientHeight || h;
      camera.aspect = cw / ch;
      camera.updateProjectionMatrix();
      renderer.setSize(cw, ch);
      labelRenderer.setSize(cw, ch);
    };
    window.addEventListener('resize', onResize);

    let raf = 0;
    const animate = (): void => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    };
    animate();

    // initial filter + selection
    applyFilter(filter);
    setHighlight(selectedEntityId ?? null);

    sceneApiRef.current = {
      setHighlight,
      setFilter: (f) => {
        applyFilter(f);
        setHighlight(selectedEntityId ?? null);
      },
    };

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      renderer.dispose();
      scene.traverse((o) => {
        const anyO = o as unknown as { geometry?: { dispose(): void }; material?: { dispose(): void } };
        anyO.geometry?.dispose();
        anyO.material?.dispose();
      });
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      if (labelRenderer.domElement.parentNode)
        labelRenderer.domElement.parentNode.removeChild(labelRenderer.domElement);
      sceneApiRef.current = null;
    };
    // Rebuild when the data or mode changes. filter/selection handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head, mode]);

  // Re-apply filter without a full rebuild.
  useEffect(() => {
    sceneApiRef.current?.setFilter(filter);
  }, [filter]);

  // Re-apply selection highlight without a full rebuild.
  useEffect(() => {
    sceneApiRef.current?.setHighlight(selectedEntityId ?? null);
  }, [selectedEntityId]);

  return <div ref={containerRef} className="graph-canvas" style={{ position: 'absolute', inset: 0 }} />;
}
