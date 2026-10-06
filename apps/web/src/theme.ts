import { Badge, Button, Card, Table, Tooltip, createTheme, type MantineColorsTuple } from '@mantine/core';

/**
 * Design tokens for the admin app. One type family, the fixed brand pair
 * (navy ink + Mash IT blue), and one semantic set shared with every
 * deliverable: good (teal), watch (amber), act (red), slate for "not
 * measured". Nothing here is a Mantine default with a colour swapped in.
 */

/** Mash IT brand blue (#004aad): interactive. Primary button, links, focus ring. */
const brand: MantineColorsTuple = [
  '#e8f1fe',
  '#cfe0fb',
  '#9fbdf5',
  '#6b98ef',
  '#4179ea',
  '#2866e7',
  '#175ce6',
  '#0a4ecc',
  '#004aad', // shade 8: Mash IT blue
  '#003f96',
];

/** Deep navy (#0b2545): headings, chrome, the brand mark. */
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

/** Good: teal, centered on #0e7c72. */
const good: MantineColorsTuple = [
  '#e3f6f3',
  '#c6ece6',
  '#9edcd3',
  '#72cbbf',
  '#4bbaab',
  '#2aa698',
  '#1a9387',
  '#148378',
  '#0e7c72',
  '#0a6359',
];

/** Watch: amber, centered on #9a5b00 with a #fff4db wash. */
const watch: MantineColorsTuple = [
  '#fff4db',
  '#ffe8b8',
  '#fbd68a',
  '#f3c05c',
  '#e8a836',
  '#d4911a',
  '#bf7d0a',
  '#a96a03',
  '#9a5b00',
  '#7d4900',
];

/** Act: red, centered on #b42318. */
const act: MantineColorsTuple = [
  '#fdecea',
  '#f9d3cf',
  '#f2aaa3',
  '#e97f75',
  '#df5a4e',
  '#d33e30',
  '#c62d20',
  '#b42318',
  '#9d1d13',
  '#7f160e',
];

/** Slate: canvas, hairlines, muted and body text. Never used to mean good or bad. */
const slate: MantineColorsTuple = [
  '#f3f5f8',
  '#eef1f5',
  '#e2e7ee',
  '#d8dfe8',
  '#b9c3d1',
  '#98a5b8',
  '#7d8ba0',
  '#6b7a90',
  '#4f5e74',
  '#3b4a5f',
];

/** Raw hex values for places that need a literal (charts, inline SVG). */
export const SEMANTIC = {
  good: '#0e7c72',
  watch: '#9a5b00',
  watchBg: '#fff4db',
  act: '#b42318',
  unknown: '#6b7a90',
  unknownBg: '#eef1f5',
  ink: '#0b2545',
  brand: '#004aad',
  text: '#3b4a5f',
  muted: '#6b7a90',
  hairline: '#d8dfe8',
  canvas: '#f3f5f8',
} as const;

const FONT = '"Public Sans", "Segoe UI", system-ui, -apple-system, sans-serif';

export const theme = createTheme({
  primaryColor: 'brand',
  primaryShade: { light: 8, dark: 7 },
  // Filled surfaces pick black or white text by luminance, so amber never gets white-on-amber.
  autoContrast: true,
  luminanceThreshold: 0.35,
  // `teal` stays a key so existing color="teal" references render the semantic good.
  colors: { brand, navy, good, watch, act, slate, teal: good },
  black: '#0b2545',
  fontFamily: FONT,
  fontSizes: { xs: '12px', sm: '13px', md: '15px', lg: '18px', xl: '22px' },
  lineHeights: { xs: '1.45', sm: '1.5', md: '1.5', lg: '1.4', xl: '1.3' },
  headings: {
    fontFamily: FONT,
    fontWeight: '600',
    sizes: {
      h1: { fontSize: '34px', lineHeight: '1.2' },
      h2: { fontSize: '28px', lineHeight: '1.2' },
      h3: { fontSize: '22px', lineHeight: '1.25' },
      h4: { fontSize: '18px', lineHeight: '1.3' },
      h5: { fontSize: '15px', lineHeight: '1.4' },
      h6: { fontSize: '13px', lineHeight: '1.4' },
    },
  },
  // Radius carries hierarchy: 0 for tables, 4px for controls and badges, 8px for the few true cards.
  defaultRadius: 'sm',
  radius: { xs: '2px', sm: '4px', md: '8px', lg: '12px', xl: '16px' },
  shadows: {
    xs: 'none',
    sm: '0 1px 2px rgba(11, 37, 69, 0.06)',
    md: '0 2px 8px rgba(11, 37, 69, 0.08)',
    lg: '0 8px 24px rgba(11, 37, 69, 0.10)',
    xl: '0 16px 40px rgba(11, 37, 69, 0.12)',
  },
  cursorType: 'pointer',
  components: {
    Card: Card.extend({ defaultProps: { radius: 'md', padding: 'lg', withBorder: true, shadow: 'xs' } }),
    Badge: Badge.extend({
      defaultProps: { radius: 'xs', variant: 'light' },
      // Sentence case, always: a badge is a word, not a shout.
      styles: { root: { textTransform: 'none', letterSpacing: 0, fontWeight: 600 } },
    }),
    Table: Table.extend({ defaultProps: { verticalSpacing: 'sm', highlightOnHover: true } }),
    Button: Button.extend({ defaultProps: { radius: 'sm' } }),
    Tooltip: Tooltip.extend({ defaultProps: { withArrow: true } }),
  },
  other: { semantic: SEMANTIC },
});
