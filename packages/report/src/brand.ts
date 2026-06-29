import type { Brand } from '@mashit/core';

/** Fully-resolved brand tokens used by the renderer. */
export interface BrandTokens {
  name: string;
  logoDataUri?: string;
  primary: string;
  accent: string;
  ink: string;
  bg: string;
  font: string;
}

export const MASH_IT_BRAND: BrandTokens = {
  name: 'Mash IT',
  primary: '#0b2545',
  accent: '#1d7874',
  ink: '#1a1a1a',
  bg: '#ffffff',
  font: "'Segoe UI', system-ui, -apple-system, sans-serif",
};

/** Merge a partial per-client Brand over the Mash IT defaults. */
export function resolveBrand(brand?: Brand): BrandTokens {
  if (!brand) return MASH_IT_BRAND;
  return {
    name: brand.name ?? MASH_IT_BRAND.name,
    logoDataUri: brand.logoDataUri,
    primary: brand.primary ?? MASH_IT_BRAND.primary,
    accent: brand.accent ?? MASH_IT_BRAND.accent,
    ink: brand.ink ?? MASH_IT_BRAND.ink,
    bg: MASH_IT_BRAND.bg,
    font: brand.font ?? MASH_IT_BRAND.font,
  };
}
