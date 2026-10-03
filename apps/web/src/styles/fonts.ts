/*
 * Font roles and licences. The faces themselves are declared in fonts.css (self-hosted, woff2 only, with
 * unicode-ranges); this module pulls that stylesheet into the bundle and names the families for code that
 * draws text itself (canvas textures wait for `document.fonts.load()` per family and script).
 *
 *   Role                     Latin                       Arabic                          Licence
 *   reader's quill           La Belle Aurore (>= 20px)   Aref Ruqaa (monochrome)         OFL-1.1
 *   diary's lead hand        Petit Formal Script         Aref Ruqaa Ink (COLRv1 palette) OFL-1.1
 *   title / homage line      Pinyon Script (>= 24px)     Aref Ruqaa Ink                  OFL-1.1
 *   diary's fair copy        Cormorant Infant italic     Amiri                           OFL-1.1
 *   reading and body         EB Garamond                 Amiri                           OFL-1.1
 *   UI                       EB Garamond small caps      Amiri                           OFL-1.1
 */
import './fonts.css';

export const FONT_FAMILIES = {
  quill: { latin: 'La Belle Aurore', arabic: 'Aref Ruqaa' },
  reply: { latin: 'Petit Formal Script', arabic: 'Aref Ruqaa Ink' },
  title: { latin: 'Pinyon Script', arabic: 'Aref Ruqaa Ink' },
  fair: { latin: 'Cormorant Infant', arabic: 'Amiri' },
  body: { latin: 'EB Garamond', arabic: 'Amiri' },
} as const;
