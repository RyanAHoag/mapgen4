# This fork

A fork of [redblobgames/mapgen4](https://github.com/redblobgames/mapgen4) for
a mapping prototype in a private repository, which pins it by commit.

**Branch `agentic-grid`**, from upstream commit `c1d8cb0` (2026-03-29). Three
files are changed, and each says so at its top. Everything they add is
optional: left out, mapgen4 draws exactly as upstream.

- `render.ts` — an optional 3D colour table, set with `setColormap3D()`,
  looked up by height, rain and map row instead of height and rain only, so a
  colour can change across the map. It knows nothing of what the rows mean;
  the prototype decides that.
- **A world that need not be 1000×1000.** `choosePoints()` in
  `generate-points.ts`, `Map` in `map.ts` (`param.width`, `param.height`, and
  a painted grid of `columns` × `rows`) and `Renderer` in `render.ts` each take
  an optional world size; the renderer's canvas and textures take its shape,
  the longer side 2048 pixels.

Everything else is upstream's, unchanged, under upstream's
[Apache License 2.0](LICENSE).

## Keeping up with upstream

- Merge `upstream/master` into `agentic-grid`; never rebase or force-push. The
  prototype installs a commit by its hash, and a commit no branch or tag points
  to can disappear from GitHub.
- Tag each commit the prototype pins: `agentic-grid-1`, `agentic-grid-2`, …
- After a merge, run the prototype's `npm run probe` and `npm test` before
  moving its pin.
