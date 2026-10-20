/**
 * logo.js — the abstract JNSN mark: ember, flame tongue, flung spark.
 *
 * Three solid fills, no strokes or gradients, so it survives any size and
 * inherits its colour from `currentColor`. No width/height attributes: the
 * host element sizes it through CSS (see .card__logo in styles.css).
 *
 * Geometry notes (viewBox 120 x 150):
 *   ember  circle at (30,130) r12
 *   flame  base spans x 28..64 at y 84..114, tip at (94,16); outer edge is
 *          convex, inner edge concave so it leans like a flame blown back
 *   spark  pointed leaf 20 x 8 at (107,24), long axis along the flame's own
 *          direction; big enough to still read at a 60 px tall mark
 *   gaps   ember/flame ~7 units, flame tip/spark ~11 units (both >= 6)
 */

export const logoAlt = 'JNSN mark';

export const logoSVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 150" ' +
  'preserveAspectRatio="xMidYMid meet" fill="currentColor" aria-hidden="true" focusable="false">' +
  '<circle cx="30" cy="130" r="12"/>' +
  '<path d="M94 16C70 30 34 52 28 84C22 100 30 114 46 114C62 114 70 100 64 88C62 66 80 38 94 16Z"/>' +
  '<path d="M-10 0Q0-8 10 0Q0 8-10 0Z" transform="translate(107 24) rotate(-55)"/>' +
  '</svg>';
