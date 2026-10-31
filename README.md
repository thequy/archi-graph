# Archi-Graph

> POC: a Knowledge Graph for architecture documentation, contained in a single `.html` file.

Archi-Graph is a proof-of-concept for managing architecture documentation (BRD, SAD, HLD, LLD, TSD, ADR, design patterns, diagrams) as a **Knowledge Graph** that visualizes the relationships between documents. It runs directly in the browser with no build tooling.

## Features

- **3-panel layout** with two-way sync: `3D graph (three.js)` | `document viewer` | `detail panel`.
- **three.js** — a 3D graph of document relationships, used for navigation.
- **react-flow** — detailed flow diagrams inside a document (service flow, data flow), lazy-mounted.
- Viewer renders **Markdown and HTML**.
- **Embedded sample data** inside the file — no backend required.
- Two edge kinds:
  - **Hierarchy** — structural chain BRD → SAD → HLD → LLD → TSD.
  - **Semantic** — meaning-based relationships between documents.

The sample dataset models the **CorpDigi (Corporate Digital Banking)** platform along the flow: Frontend → API Gateway → BFF → Backend Services → Inbound Gateway → System of Record.

## Usage

Open `index.html` directly in a browser. All libraries are loaded from CDN (UMD builds), so no bundler or server is required.

## Documentation

- [`SPEC.md`](SPEC.md) — specification and implementation plan (Vietnamese).
- [`SPEC.en.md`](SPEC.en.md) — specification and implementation plan (English).

## Tech Stack

- [three.js](https://threejs.org/) r128 (3D graph)
- [react-flow](https://reactflow.dev/) (flow diagrams)
- [marked](https://marked.js.org/) + [DOMPurify](https://github.com/cure53/DOMPurify) (safe Markdown rendering)
