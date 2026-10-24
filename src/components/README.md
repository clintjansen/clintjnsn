# JNSN® wordmark

The reusable component is `jnsn-wordmark.js`. It has no framework dependency.
It re-exports the canonical component from `site/components/jnsn-wordmark.js`,
so the public loader and the local previews share the same logo.

`jnsn-wordmark.html` is the self-contained HTML counterpart. It opens directly
from disk and includes its own styling, with no JavaScript or external assets.
It displays an enlarged wordmark centered on a white background: 174px on a
wide screen (six times the original), scaling down on narrow screens. Letter
spacing and the ® size and margin all use em units, so every proportion stays
the same. Change the two CSS variables at the top to adjust its size and color.
The reusable JavaScript component keeps its original 29px default.

```html
<script type="module" src="/src/components/jnsn-wordmark.js"></script>
<jnsn-wordmark href="/" label="JNSN home"></jnsn-wordmark>
```

Its default appearance is the exact preview wordmark: Arial, weight 900, 29px,
line height 1, color #171715, and -2px letter spacing. Arial's available heavy
face is selected by the browser; there is no custom font or image behind it.
The ® is 11px, top aligned, with zero letter spacing and a 4px left margin.
Those proportions scale together when changing size:

```css
jnsn-wordmark {
  --jnsn-wordmark-size: 58px;
  --jnsn-wordmark-color: #171715;
}
```

`href`, `label` (the accessible link name), and optional `target` are reactive
attributes. The shadow root isolates the logo from page typography and link
styles. It remains a real keyboard-accessible link.
