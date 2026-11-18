---
paths:
  - "src/render/**/*.ts"
  - "src/app/**/*.ts"
---
# src/render

- three.js version is pinned exactly in `package.json`. Write only for that version; when unsure about an API, check the installed typings in `node_modules/three` or the docs via context7 — do not write from memory.
- Read `docs/research/threejs-hybrid-render.md` before touching the renderer: it holds the validated setup and the list of removed/renamed APIs.
- Hybrid renderer: road projection is computed on the CPU (`src/render` reads sim state, never writes it); three.js only draws. Road = one dynamic `BufferGeometry`; sprites of layers 2–4 = one `InstancedMesh` with an atlas, alpha-test, depth write, no sorting.
- Render interpolates between the previous and the current sim state (`alpha`); it never advances the simulation.
- Internal resolution ~360×640, nearest upscale. Never render at native DPR.
- Zero allocations per frame: reuse typed arrays, vectors and matrices; no `new` inside the frame path.
- Budget (checked in smoke via `renderer.info`): ≤ 12 draw calls, ≤ 20 000 triangles per frame until the author changes it.
- Colours of placeholders come from `docs/art-bible.md`.
- UI layer and gameplay layer can be toggled separately so a screenshot checks one thing.
