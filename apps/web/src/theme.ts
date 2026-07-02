import { createTheme, type MantineColorsTuple } from '@mantine/core';

/** Mash IT brand navy — deep at the top of the scale so filled UI reads navy. */
const navy: MantineColorsTuple = [
  '#eef2f9',
  '#d9e0ee',
  '#b2c0dd',
  '#889dcb',
  '#6580bd',
  '#4f6db4',
  '#4363b1',
  '#34539c',
  '#2b498c',
  '#0b2545',
];

/** Teal accent (secondary actions, positive states). */
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
  primaryColor: 'navy',
  primaryShade: { light: 9, dark: 8 },
  colors: { navy, teal },
  fontFamily: 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif',
  headings: {
    fontFamily: 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif',
    fontWeight: '600',
  },
  defaultRadius: 'md',
  cursorType: 'pointer',
});
