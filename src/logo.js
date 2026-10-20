/**
 * logo.js — the JNSN mark: one unbroken stroke.
 *
 * A single rectilinear line of constant 12-unit thickness travels J -> N -> S -> N:
 * the hook and first stem are the J, stem + top bar + stem the first N, the stepped
 * half-stems around the middle bar the S, stem + bottom bar + stem the last N. It reads
 * as an abstract meander first and the four letters second, like the contour lines in
 * the art. One filled polygon, no strokes, no gradients; colour comes from `currentColor`.
 *
 * Geometry (viewBox 120 x 120): bounding box x 14-106, y 12-108; stems at x 14-26, 34-46,
 * 54-66, 74-86, 94-106; channels between them 8 units; bars at y 12-24, 54-66, 96-108.
 */

export const logoAlt = 'JNSN mark';

export const logoSVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" ' +
  'preserveAspectRatio="xMidYMid meet" fill="currentColor" aria-hidden="true" focusable="false">' +
  '<polygon points="34,12 66,12 66,54 86,54 86,96 94,96 94,12 106,12 106,108 74,108 74,66 54,66 54,24 46,24 46,108 14,108 14,72 26,72 26,96 34,96"/>' +
  '</svg>';

/** The J-hook alone: the favicon glyph (the whole meander fills in at 16 px). */
export const faviconSVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" rx="12" fill="#d8371d"/>' +
  '<polygon fill="#fff" points="26,10 54,10 54,21 36,21 36,54 10,54 10,34 21,34 21,43 26,43"/>' +
  '</svg>';
