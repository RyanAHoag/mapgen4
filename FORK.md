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
- `render.ts` — an optional tint by map position, set with `setTint()`: an
  RGBA picture of the world laid over the land's colour, its alpha saying how
  much. Like the colour table, it knows nothing of what it is for.
- `render.ts` — an optional surface by map position, set with `setSurface()`:
  how much of each place is dunes, broadleaf trees and conifers, and how far it
  is inside or outside a forest. The drape adds fine relief there — ridges
  across the wind, crowns of trees — to the heights the light reads, never to
  the height the colour is read by; trees stand thick in a forest's middle and
  thin towards its edge, and each shades the ground behind it. With it, an
  optional wobble of the colour lookup's rain and row, so grounds meet along
  wandering lines. Both are set with the view (`updateView`'s `surface_*`
  keys) and, like the tint, know nothing of what they are for.
- `render.ts` — optional covers by map position, set with `setCovers()`:
  dead woods, rock, fields, marsh and towns. Each thing on them — a bare tree,
  a boulder, a field, a reed clump, a building — stands whole or not at all,
  by the cover at its own middle, so a cover's edge is a ragged line of
  things, never a blur. Fields and buildings take their colours from a
  palette, a row per id; buildings are boxes that lean up the page by their
  height, as the land does by `mountain_height`, taller towards a town's
  middle as much as it rises. Under fields and towns the land's slope is read
  wide, so its fine wrinkles do not buckle them. Like the rest, it knows
  nothing of what they are for.

Everything else is upstream's, unchanged, under upstream's
[Apache License 2.0](LICENSE).

## Keeping up with upstream

- Merge `upstream/master` into `agentic-grid`; never rebase or force-push. The
  prototype installs a commit by its hash, and a commit no branch or tag points
  to can disappear from GitHub.
- Tag each commit the prototype pins: `agentic-grid-1`, `agentic-grid-2`, …
- After a merge, run the prototype's `npm run probe` and `npm test` before
  moving its pin.
