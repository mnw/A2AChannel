# Vendored fonts

Self-hosted WOFF2 bundles loaded via `@font-face` in `ui/style.css`. No
CDN; matches the app's strict CSP (`font-src 'self' data:`).

| File | Family | Weight | Style | Source |
|---|---|---|---|---|
| `Inter-400.woff2` | Inter | 400 | normal | Bunny Fonts (`fonts.bunny.net/inter`) |
| `Inter-500.woff2` | Inter | 500 | normal | Bunny Fonts |
| `Inter-600.woff2` | Inter | 600 | normal | Bunny Fonts |
| `Fraunces-400.woff2` | Fraunces | 400 | normal | Bunny Fonts |
| `Fraunces-400-italic.woff2` | Fraunces | 400 | italic | Bunny Fonts |
| `Fraunces-500.woff2` | Fraunces | 500 | normal | Bunny Fonts |
| `Fraunces-500-italic.woff2` | Fraunces | 500 | italic | Bunny Fonts |
| `JetBrainsMono-400.woff2` | JetBrains Mono | 400 | normal | Bunny Fonts |
| `JetBrainsMono-500.woff2` | JetBrains Mono | 500 | normal | Bunny Fonts |
| `JetBrainsMono-600.woff2` | JetBrains Mono | 600 | normal | Bunny Fonts |
| `CaskaydiaMonoNerdFont-Regular.ttf` | CaskaydiaMono Nerd Font | 400 | normal | legacy v0.6 bundle, retained as fallback |
| `CaskaydiaMonoNerdFont-Bold.ttf` | CaskaydiaMono Nerd Font | 700 | normal | legacy v0.6 bundle, retained as fallback |

All three primary families (Inter, Fraunces, JetBrains Mono) are
distributed under the **SIL Open Font License 1.1**.

To refresh: re-run the `curl` commands against Bunny Fonts with matching
weights; the format has been stable across Bunny's rolling updates.
