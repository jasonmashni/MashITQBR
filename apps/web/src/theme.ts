import { createTheme, type MantineColorsTuple } from '@mantine/core';

/**
 * Mash IT brand blue (#004aad) — the primary. Filled buttons, active nav and
 * links read as the house blue rather than the old teal/green accent.
 */
const brand: MantineColorsTuple = [
  '#e8f1fe',
  '#cfe0fb',
  '#9fbdf5',
  '#6b98ef',
  '#4179ea',
  '#2866e7',
  '#175ce6',
  '#0a4ecc',
  '#004aad', // shade 8 — Mash IT blue
  '#003f96',
];

/** Deep navy — chrome, headings and ink (a darker sibling of the brand blue). */
const navy: MantineColorsTuple = [
  '#eef2f9',
  '#d9e0ee',
  '#b2c0dd',
  '#889dcb',
  '#6580bd',
  '#4f6db4',
  '#4363b1',
  '#34539c',
  '#1a3a67',
  '#0b2545',
];

/** Teal — reserved for genuine positive/success states only (not brand chrome),
 *  kept as a theme key so those refs use one controlled shade. */
const teal: MantineColorsTuple = [
  '#e0fbf8',
  '#cdf1ed',
  '#a1e0da',
  '#72cfc7',
  '#4dc1b7',
  '#35b8ad',
  '#24b4a9',
  '#119e93',
  '#008d82',
  '#007a70',
];

export const theme = createTheme({
  primaryColor: 'brand',
  primaryShade: { light: 8, dark: 7 },
  colors: { brand, navy, teal },
  fontFamily: 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif',
  headings: {
    fontFamily: 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif',
    fontWeight: '600',
  },
  defaultRadius: 'md',
  cursorType: 'pointer',
});
