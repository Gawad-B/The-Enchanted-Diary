Aref Ruqaa Ink, self-hosted as a COLRv1 + OpenType-SVG pair (see src/styles/fonts.css).

aref-ruqaa-ink-arabic-400-colrv1.woff2   Arabic subset, COLRv1 + CPAL colour tables. Fetched from Google Fonts with a
                                         Chrome user agent (Google serves COLRv1 to Chrome, Edge and Firefox).
aref-ruqaa-ink-arabic-400-svg.woff2      Arabic subset, OpenType-SVG colour table. Copied from
                                         @fontsource/aref-ruqaa-ink 5.3.0 (files/aref-ruqaa-ink-arabic-400-normal.woff2).
OFL-aref-ruqaa-ink.txt                   The SIL Open Font License 1.1 and copyright notice for the family.

The Fontsource package ships only the OpenType-SVG flavour, which Chromium draws in plain monochrome; the COLRv1
file is what makes the ink colour (and its @font-palette-values retinting) work there.
