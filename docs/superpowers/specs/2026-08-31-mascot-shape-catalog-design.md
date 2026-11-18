# Mascot shape catalog

## Problem

## What we are building

A generated catalog of ten silhouettes, selectable per bot, rendered from one
solved source of truth on both platforms.

Not in scope: parametric sliders, custom SVG outlines, surface styles, face
variants, accessories. What varies is the body's shape; its fill stays the bot's
colour gradient.

## Design

### The catalog

Ten shapes, each a fixed parameterisation of a Blob Studio shape family. The id
is the persisted value and must stay stable.

| id | family | notes |
|----|--------|-------|
| `cursor` | cursor | default; byte-identical to today's outline |
| `blob` | blob | wobble 0.35 |
| `circle` | circle | |
| `squircle` | squircle | round 0.5 |
| `capsule` | capsule | |
| `drop` | drop | belly 0.62 |
| `shield` | cone | tip 0.45, base 0.9 |
| `hexagon` | hex | sides 6, corners 0.12 |
| `diamond` | hex | sides 4, corners 0.12 |
| `star` | star | 5 points, depth 0.42 |

A catalog entry is `{ id, name, body, clip, fit, anchor }` — the `CursorSilhouette`
the desktop renderer already consumes, plus an id.

### Face scale is clamped

The solver caps face scale at 1.0 and otherwise fits the largest face a shape can
hold. A circle holds a much bigger face than the cramped cursor, which would make
the ten shapes read as ten different characters rather than one character in
different bodies.

So after solving every shape, the generator takes the **minimum** solved scale
across the catalog and applies it to all ten, re-solving each anchor position at
that fixed scale to keep the face centred in its body. Roomier shapes get more
margin, not a bigger face.

The minimum is expected to be `cursor`'s, since it is the most cramped outline.
If a future shape solves lower than `cursor`, the clamp would shrink every
existing bot's face — so the generator fails if the shared scale would drop below
`cursor`'s own solved scale, and such a shape must be reparameterised or dropped.

### The generator

`scripts/gen-mascot-shapes.mjs`. Plain Node, no new dependencies. Per shape:

1. Build the outline from a shape builder ported from Blob Studio's
   `desktop/src/shapes/builtin.ts`, emitting **absolute cubic** path data only.
2. Flatten the cubics to a polyline; measure real bounds; derive the `fit`
   transform mapping those bounds into the 228.541-unit face box.
3. Scanline-fill the polyline into a 256x256 mask.
4. `fieldFromMask(mask)` -> signed distance field.
5. Solve the anchor and scale directly: seed at the largest inscribed circle,
   then sweep outward against the pooled four-aim point clouds for the
   placement that maximizes face size without clipping.

Then, across the whole catalog: compute the clamped shared scale, re-solve each
anchor at that scale, and emit.

Blob Studio's `buildSdf` rasterises through `<img>` + canvas and its `measureFit`
calls `getBBox`. Both are DOM-only. Because we generate the outlines ourselves we
know them analytically, so steps 2 and 3 replace those two functions with a cubic
flattener and a scanline fill — roughly 60 lines. Everything downstream of the
mask (`fieldFromMask`, `sampleSdf`, `largestInscribedCircle`, and the
expression point-cloud construction) is already pure math and is copied verbatim
from the studio. The anchor/scale solve itself is the generator's own — a
seeded outward sweep against the pooled four-aim clouds — rather than Blob
Studio's `solveFit`. No headless browser, so it runs in CI.

**The generator fails if any shape's baked anchor clips any of the 25
expressions.** That assertion, not visual review, is the correctness guarantee.

Outputs, both checked in:

- `packages/shared/mascot-shapes.ts` — the TypeScript catalog, the id union, and the zod
  schema.

### Desktop

`Avatar.tsx` gains `shape?: MascotShapeId`, defaulting to `"cursor"`, and looks
the silhouette up in the catalog instead of building one inline.

This removes the `GRADIENT_SILHOUETTE` workaround: the exported pack baked
`fill="#000000"` into the body where the renderer expects a `{{GRADIENT}}`
placeholder, so `Avatar.tsx` patched it back with a regex. The generator emits
the placeholder directly, so the patch is deleted rather than generalised.

Of the 29 `HezuoAvatar` call sites, only those rendering a specific bot change.
They already pass `color={bot.color}`; `shape={bot.mascotShape}` rides alongside.
Sites rendering a generic mascot keep the default and are untouched.

The picker lives in `BotProfileAvatarCard.tsx`, in a row beside the existing
colour swatches and expression grid. Each swatch is a live miniature rendered in
that bot's own colour, so the choice is previewed rather than described.

### Schema and sync

The field follows `avatarCrop`'s existing path end to end:

- `packages/shared/mascot-shapes.ts` — zod enum plus a `botMascotShape()` safe-parse
  helper defaulting to `cursor`, mirroring `packages/shared/bot-avatar.ts`.
- `desktop/server/store.ts` — `BotRecord.mascotShape?: MascotShapeId | null`.
- `desktop/server/bot-profile.ts` — added to the patch allow-list, with a readable
  error message in the same style as the `avatarCrop` one.
- `desktop/server/team-manifest.ts`, `desktop/server/bot-package.ts`, `desktop/server/package-export.ts`
  — carried inside `appearance`, beside `color` and `mascotExpression`.
- `desktop/server/index.ts` — added to the profile broadcast key list (~line 4048).

An absent or unrecognised value resolves to `cursor` on read, on both platforms.
An older client that does not know the field ignores it and keeps rendering the
default body, and an older server drops it on write — neither is a corrupt state.

## Testing

- **Generator golden test**: regenerating produces the checked-in files
  byte-for-byte. This is the drift guard; without it the generated files can be
  hand-edited and silently diverge from their source.
- **Clearance test**: for every shape, all 25 expressions clear the outline at the
  baked anchor. Runs against the checked-in catalog, so it fails if a file is
  edited by hand into an invalid state.
- **Clamp test**: every shape's baked scale is identical, and equals `cursor`'s
  solved scale.
- **Schema test**: an unknown shape id resolves to `cursor`, mirroring
  `desktop/server/bot-avatar.test.ts`.
- **Patch test**: an invalid shape returns the readable error, mirroring
  `desktop/server/bot-profile.test.ts`.

## Risks

**The clamp shrinks nothing today, but constrains the catalog.** Adding a shape
more cramped than `cursor` later would either shrink every bot's face or require
dropping the shape. The generator fails loudly rather than silently shrinking.

**The scanline rasteriser is new code on a correctness path.** A fill bug would
produce a wrong distance field and a wrong anchor. Mitigated by the clearance
assertion, which tests the actual rendered geometry rather than the intermediate
field, and by `cursor` acting as a known-good fixture: it must solve to a face
that matches today's rendering.
