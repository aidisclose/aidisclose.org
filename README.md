# aidisclose-generator

Web generator for [`aidisclose`](https://github.com/joaomlourenco/aidisclose)
disclosure statements. Pick the tasks you delegated to generative AI and it
emits ready-to-compile LaTeX.

Live: <https://aidisclose.org>

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | The whole app — markup, styles hooks, and all the generator logic in two inline `<script>` blocks. |
| `css/fonts.css` | `@font-face` rules for the self-hosted webfonts. |
| `css/base.css` | Layout and components. Colour-agnostic: every colour is a CSS variable. |
| `css/theme-minimal.css` | The one active theme, defining those variables for light and dark. |
| `fonts/` | Inter and JetBrains Mono woff2 subsets (SIL OFL 1.1). |
| `counter/` | Cloudflare Worker behind the "statements generated" badge — see `counter/DEPLOY-counter.md`. |
| `_headers` | Response headers (HSTS, CSP, …) applied by Cloudflare Pages. |

There is no build step: the deployed site is these files as-is.

## Theming

`<html>` carries `data-theme` and `data-mode`, and `theme-minimal.css` scopes
its variables to `[data-theme="minimal"][data-mode="light"|"dark"]`. `base.css`
never names a colour, so adding a theme means adding one file with the same
variable set and switching `data-theme`. Light/dark is chosen before first paint
by the inline `<head>` script: stored preference, then OS preference, then local
time as a last resort.

Earlier `theme-dark`, `theme-glass` and `theme-saas` files were removed once
`data-theme` was pinned to `minimal` — recover them from history if wanted:

```sh
git show HEAD:css/theme-glass.css > css/theme-glass.css
```

## Refreshing the fonts

The webfonts are self-hosted so no visitor data reaches a third party on page
load. To pull newer versions, ask Google Fonts for the CSS with a modern
browser UA, then fetch each `woff2` it names into `fonts/`:

```sh
curl -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" \
  "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap"
```

Both families are variable fonts, so one file per unicode subset covers the
whole weight range. Keep the `unicode-range` values in `css/fonts.css` in step
with that CSS, and keep filenames stable — `_headers` caches `/fonts/*` as
immutable for a year.

## Notes

- **The package version in the subtitle is hardcoded.** Bump it in `index.html`
  when `aidisclose` releases; likewise the taxonomy checkboxes must match the
  keys in `aidisclose.sty` (`\AIDactivate{...}`) and the language dropdown must
  match `langdef/aidisclose-*.ldf`.
- **The CSP still allows `script-src 'unsafe-inline'`.** Two things need it: the
  pre-paint theme script in `<head>` (it has to run synchronously to avoid a
  flash of the wrong mode) and the `onclick` attributes on the buttons. Moving
  the handlers to `addEventListener` and the theme script to its own
  synchronously-loaded file would let that be dropped from `_headers`.
- **The Overleaf button fetches the package sources from `main`** at click time
  and inlines them with `filecontents`, so exports always carry the latest
  package rather than whatever TeX Live has — but a breaking change on `main`
  breaks exports immediately.
