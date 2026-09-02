# Homey Style Library (dev-only, committed, never shipped)

Athom's own CSS and fonts, exactly as a Homey serves them to a pairing wizard, so
[`test/pair-preview.html`](../pair-preview.html) can render this app's two custom views against
the real injected styling:

| View | File |
|---|---|
| Pair · learn | [`drivers/blind/pair/learn.html`](../../drivers/blind/pair/learn.html) |
| Repair · calibrate | [`drivers/blind/repair/calibrate.html`](../../drivers/blind/repair/calibrate.html) |

Nothing in `app.json` or `driver.compose.json` references `test/`, and `test` is listed in
`.homeyignore`, so none of this is packaged with the app.

Stored **verbatim** — original filenames and folder layout, no combining or renaming — so the
relative `@import` and `url()` paths inside the files resolve unchanged, and the committed copies
stay byte-comparable against a live Homey.

Copied from the sibling `family.bothe.dexcom` app, which established the pattern. The two are
independent snapshots; a firmware change affects both, and each is refreshed on its own.

## Running the preview

It must be served over http(s). Opening it as `file://` gives an empty screen, because every
`fetch()` below is then a cross-origin request:

```bash
python3 -m http.server 8731
```

Then open <http://127.0.0.1:8731/test/pair-preview.html>. The preview switches between the two
views, forces light or dark, and lets you pick what the driver does — a remote found or not
heard, a calibration that saves or one rejected as too short. Its copy comes from the app's live
`locales/en.json`, so what it shows cannot drift from what ships.

## Refreshing

```bash
HOMEY_ASSETS_BASE='https://<your-homey-id>.connect.athom.com/manager/webserver/assets' \
  ./test/homey-css/fetch.sh && git diff --stat test/homey-css
```

`fetch.sh` re-downloads all 25 files in place; `git diff` then shows whether a firmware update
changed the wizard's appearance. It rejects any response that is an HTML error page rather than
writing it over a good file, and leaves existing copies untouched if anything fails. Find
`<your-homey-id>` in the URL bar with the Homey web app open. No authentication is needed.

**`icons/` and `img/` are siblings of `css/`, not children.** The sheets reach them as `../icons/`
and `../img/`. A `css/`-relative URL returns a 404 whose body is an HTML error page, which then
saves under the right filename and passes any does-the-file-exist check:

```
assets/icons/chevron-down-regular.svg      not  assets/css/icons/…
assets/img/spinner.svg                     not  assets/css/img/…
```

**`homey.css` vs `homey.drivers.css`** — similar names, unrelated files. The first is the Style
Library manifest (all `@import`s, no rules of its own); the second is the pairing wizard chrome.
There is no `homey-drivers.css` or `homey-app.css` on the server.

## Layout

```
test/homey-css/
  css/
    homey.css                <- Style Library manifest: @imports only, no rules
    homey.drivers.css        <- wizard chrome (#hy-wrap / #hy-views / .hy-view)
    _homey-variables.css     <- --homey-* custom properties (colors, --homey-su-* spacing)
    _base.css                <- reset / base element styles
    _homey-typography.css    <- .homey-title / .homey-subtitle / .homey-text-align-*
    _homey-button.css        <- .homey-button-* (incl. .homey-button-primary-full)
    _homey-form.css          <- .homey-form / -group / -label / -input / -select
    _homey-icon.css          <- .homey-icon-arrow-{left,right}
  font/
    roboto/roboto.css        <- + its .ttf files (see Fonts)
    notosansarabic/notosansarabic.css
    fontawesome/fontawesome.css
  icons/                     <- checkmarks, wizard nav arrows, <select> chevron
  img/                       <- spinner, throbbers, search fields
```

Without the six `_*.css` partials the views render essentially unstyled — `homey.css` alone
carries no rules, and all six are `@import`ed by it whether or not a given screen uses them.

**Neither of this app's views reaches anything in `icons/` or `img/`.** They have no form
controls, no wizard nav and no `.is-loading` button, so the only assets they touch are the
stylesheets and two Roboto weights (see Fonts). The rest is kept anyway, at 44K, so a view added
later needs no second download — and so `fetch.sh` keeps checking the paths that are easy to get
wrong.

## Fonts

`font/*/*.css` declares `@font-face` rules pointing at **`.ttf`** files beside them. Without the
binaries the browser falls back to a system font, and font metrics are most of what this harness
exists to get right.

`roboto.css` declares eight faces. Two are actually fetched when these views render — confirmed
by watching the preview's network requests, not by reading the sheets:

| Weight | File | Used by |
|---|---|---|
| 500 | `Roboto-Medium.ttf` | `.homey-button-primary-full`, and both views' `--homey-font-weight-medium` — the step heading and the calibration stopwatch |
| 400 | `Roboto-Regular.ttf` | hint and status lines |

`Roboto-Bold.ttf` (700) is **not** loaded: it is `.homey-title`'s weight, and neither view uses
that class — both set their own heading style. It is kept because a view that does use
`.homey-title` would need it, and a missing weight is synthesised from Regular with the wrong
metrics rather than failing visibly.

Noto Sans Arabic and Font Awesome are declared by `homey.css` but likewise never pull a binary
here; they matter only for RTL locales and Homey's icon glyphs.

## Dark mode

Homey **inverts** a pair view rather than re-theming it, and the preview does the same:

```css
html { filter: invert(1) hue-rotate(180deg); }
```

That is the `--theme-filter-dark-mode` Homey's own web app defines (`:root, .lightTheme { none }` /
`.darkTheme { invert(1) hue-rotate(180deg) }`). `invert(1)` flips lightness; the
`hue-rotate(180deg)` restores hues, so blues stay blue. Filtering the root inverts its own
background too, so `_base.css`'s `--homey-color-white` renders `#000`.

The Style Library has **no dark values at all** — no `prefers-color-scheme` query, no
`[data-theme]` selector, no `@media` block in any partial. On a real Homey in dark mode, inside
the wizard's frame, `--homey-color-white` still computes to `#fff` while the screen renders dark.
Nothing here changes between light and dark, which is why switching theme downloads nothing.

Inversion is also the only mechanism available: the wizard is served from
`<id>.connect.athom.com` and the shell from `my.homey.app`, so the shell cannot reach into the
wizard's DOM to re-theme it. A filter on the frame needs no DOM access.

### Consequences for these two views

- Everything inverts wholesale and **no `--homey-*` token can opt out**.
- The blind illustration is a `#2D2C2C` SVG, so in dark mode it renders as light grey slats on
  black. That is correct — it is what the device does — and it is why the drawing is a flat fill
  rather than an image.
- A hardcoded colour is not the light-only bug it would be under a themed system; it inverts along
  with everything else. Style Library tokens still matter for light-mode fidelity. The one
  hardcoded value in `calibrate.html` is the stopwatch's `22px`, which is a size, not a colour.

## Not covered

`Homey.alert()`'s modal is in none of these stylesheets (`homey.drivers.css` covers only
`#hy-overlay-loading`). Neither view calls it.
