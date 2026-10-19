# This fork

A fork of [redblobgames/mapgen4](https://github.com/redblobgames/mapgen4) for
a mapping prototype in a private repository, which pins it by commit.

**Branch `agentic-grid`**, from upstream commit `c1d8cb0` (2026-03-29). One file
is changed, and it says so at its top:

- `render.ts` — an optional 3D colour table, set with `setColormap3D()`,
  looked up by height, rain and map row instead of height and rain only, so a
  colour can change across the map. With no table set it draws exactly as
  upstream. It knows nothing of what the rows mean; the prototype decides that.

Everything else is upstream's, unchanged, under upstream's
[Apache License 2.0](LICENSE).

## Keeping up with upstream

- Merge `upstream/master` into `agentic-grid`; never rebase or force-push. The
  prototype installs a commit by its hash, and a commit no branch or tag points
  to can disappear from GitHub.
- Tag each commit the prototype pins: `agentic-grid-1`, `agentic-grid-2`, …
- After a merge, run the prototype's `npm run probe` and `npm test` before
  moving its pin.
