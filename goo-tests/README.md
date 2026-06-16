# Gooey-shader visual tests for the trading-card realm

Isolated, single-card explorations of a "make the cards gooey / 3D-shader"
redesign for the trading realm (`src/cards.ts`, `#card-realm` in `index.html`).
Each page renders **one** representative RARE world card with a different goo
treatment so the directions can be compared side by side before any of them is
wired into the real realm.

The card itself is drawn by `card.js` — a compact stand-in for the real
`buildCardEl` + preview painters (frosted gold stock, name/tier head,
space/earth/hell preview column, resource line, ENTER WORLD button) — so every
variation shows the same card. `gl.js` is the shared WebGL harness (a
full-screen fragment-shader pass with the card uploaded as a texture).

## The variations

| File | Tech | Idea |
|------|------|------|
| `v1_svgdrip.html`  | SVG/CSS `feGaussianBlur`+threshold goo filter | Card sits in a pool of tier-gold goo; honey beads drip off its foot and merge into the rippling pool. |
| `v2_jelly.html`    | WebGL refraction | Card set **inside** a thick wobbling block of clear jelly — moving lump-field refraction, a rounded glassy bevel, sliding speculars, Fresnel rim, warm subsurface. |
| `v3_metaball.html` | WebGL metaball field | Card is one mass in a threshold field; fat globs orbit and fuse into its edge with stretching gooey necks, then peel away. |
| `v4_raymarch.html` | WebGL raymarched SDF | Genuinely 3D: fat beads of goo crawl over the card's face (spheres smooth-unioned onto a slab), camera slowly orbits, card refracts under each bead. |
| `v5_submerged.html`| WebGL screen-space | Card hangs deep **in** a body of translucent goo — wobbling surface refraction, crawling caustics, depth absorption, bubbles rising through the gloop. |
| `v6_melt.html`     | WebGL displacement | Card is dissolving: its lower third stretches into long viscous drips that ooze toward a rippling pool of melted tier-gold. |

## Recording

```
node scripts/record-goo-tests.mjs            # all variations → videos/goo/*.mp4
node scripts/record-goo-tests.mjs v2 v4      # a subset, by file stem
```

Because the sandbox only has software WebGL (swiftshader), the shaders paint at
~7-15 fps. Rather than screen-record in real time, the recorder drives each page
deterministically — it stops the live clock and steps the animation one frame at
a time via `window.GOO.seek(t)`, screenshots each frame, and assembles the PNGs
at a constant 30 fps. The result is perfectly smooth and reproducible regardless
of GPU speed.

To view a variation live in a browser, just open its `.html` (it free-runs its
own animation loop).
