# Browd brand artwork

👤 Direction approved on 2026-09-12: a geometric lowercase `b`, violet and
lavender with a restrained warm edge highlight. Compact identity in the app;
larger artwork in store assets. Neutral product surfaces stay unchanged.

🤖 `browd-master.png` was generated with OpenAI ImageGen and then edited with
ImageGen to remove the background. It is the approved raster source, not a
vector drawing. Final edit prompt: preserve the exact purple b geometry and
lighting; remove white outside and inside the counter; return true alpha.

Exports: trim transparent outer margins, fit within an 896px square, add 64px
padding on all sides, and downsample the resulting 1024px square using Lanczos.
The extension uses a 256px transparent logo and 16/32/48/128px icon exports.
White-background versions are flattened onto white from the same artwork.

👤 Dark theme (2026-09-12): the original body reads as a dark blot on the
dark surfaces (stem contrast 1.3:1 against #141414). `browd-logo-dark.png`
is the same 256px export with an HLS lightness curve `l' = l^0.6` applied
per pixel; alpha is untouched, so the silhouette is pixel-identical. Body
contrast goes to ~5.2:1, the stem to ~2.1:1. No recoloring, no alternate
silhouette. The in-product lockup switches files on the user's appearance
theme (`data-browd-theme`), the permission page and README switch on
`prefers-color-scheme`. Manifest icons stay single-file: Chrome has no
theme-aware `default_icon`.

The wordmark is lowercase `browd` in the project's Inter Variable font, 600
weight, 18px, -0.04em letter spacing. Icon box: 28px; gap: 6px.

Store graphics must contain genuine captured product UI. Never generate task
results or ratings. Recommended upload sizes: icon 128x128, screenshot
1280x800, small promo 440x280. Source:
https://developer.chrome.com/docs/webstore/images
