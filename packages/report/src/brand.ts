import type { Brand } from '@mashit/core';

/** Fully-resolved brand tokens used by the renderers. */
export interface BrandTokens {
  /** Display name for the report brand line (client override or Mash IT). */
  name: string;
  /** The client's logo, when they have one. */
  logoDataUri?: string;
  /** The MSP's name — always present. */
  orgName: string;
  /** The MSP's logo — uploaded in Settings, falling back to the built-in wordmark. */
  orgLogoDataUri: string;
  primary: string;
  accent: string;
  ink: string;
  bg: string;
  font: string;
}

/**
 * Built-in Mash IT wordmark (SVG) so every deliverable carries a logo even
 * before one is uploaded in Settings. Kept as raw SVG — renderers convert to
 * a data URI (HTML/PPTX) or use the markup directly (pdfmake svg nodes).
 */
export const MASH_IT_WORDMARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="64" viewBox="0 0 300 64">
<rect x="2" y="8" width="48" height="48" rx="10" fill="#0b2545"/>
<path d="M12 46V22l7 12 7-12v24" stroke="#ffffff" stroke-width="3.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M36 46V30" stroke="#4cc9be" stroke-width="3.4" stroke-linecap="round"/>
<circle cx="36" cy="23.5" r="2.4" fill="#4cc9be"/>
<text x="62" y="40" font-family="Segoe UI, Arial, sans-serif" font-size="27" font-weight="700" fill="#0b2545">MASH <tspan fill="#1d7874">IT</tspan></text>
<text x="63" y="55" font-family="Segoe UI, Arial, sans-serif" font-size="10" letter-spacing="2.6" fill="#5a6b7b">MANAGED IT SERVICES</text>
</svg>`;

/** The wordmark as a data URI (for <img> tags and PPTX images). */
export const MASH_IT_WORDMARK_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(MASH_IT_WORDMARK_SVG).toString('base64')}`;

export const MASH_IT_BRAND: BrandTokens = {
  name: 'Mash IT',
  orgName: 'Mash IT',
  orgLogoDataUri: MASH_IT_WORDMARK_DATA_URI,
  primary: '#0b2545',
  accent: '#1d7874',
  ink: '#1a1a1a',
  bg: '#ffffff',
  font: "'Segoe UI', system-ui, -apple-system, sans-serif",
};

/**
 * Resolve brand tokens: Mash IT defaults ← org settings (Settings page:
 * the real Mash IT logo + house colors) ← per-client overrides. The client
 * logo never replaces the org logo — deliverables carry both.
 */
export function resolveBrand(brand?: Brand, orgBrand?: Brand): BrandTokens {
  const org: BrandTokens = {
    ...MASH_IT_BRAND,
    orgName: orgBrand?.name ?? MASH_IT_BRAND.orgName,
    name: orgBrand?.name ?? MASH_IT_BRAND.name,
    orgLogoDataUri: orgBrand?.logoDataUri ?? MASH_IT_BRAND.orgLogoDataUri,
    primary: orgBrand?.primary ?? MASH_IT_BRAND.primary,
    accent: orgBrand?.accent ?? MASH_IT_BRAND.accent,
    ink: orgBrand?.ink ?? MASH_IT_BRAND.ink,
    font: orgBrand?.font ?? MASH_IT_BRAND.font,
  };
  if (!brand) return org;
  return {
    ...org,
    name: brand.name ?? org.name,
    logoDataUri: brand.logoDataUri,
    primary: brand.primary ?? org.primary,
    accent: brand.accent ?? org.accent,
    ink: brand.ink ?? org.ink,
    font: brand.font ?? org.font,
  };
}
