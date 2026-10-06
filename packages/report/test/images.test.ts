import { describe, it, expect } from 'vitest';
import { imageDims, isRenderableRaster } from '@mashit/report';

/** A real 1x1 PNG (67 bytes), complete with IEND. */
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_URI = `data:image/png;base64,${PNG_1x1}`;

describe('imageDims', () => {
  it('reads PNG and SVG dimensions', () => {
    expect(imageDims(PNG_URI)).toEqual({ w: 1, h: 1 });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="64"></svg>').toString('base64');
    expect(imageDims(`data:image/svg+xml;base64,${svg}`)).toEqual({ w: 300, h: 64 });
  });
  it('returns undefined for garbage', () => {
    expect(imageDims('data:image/png;base64,' + 'A'.repeat(200))).toBeUndefined();
    expect(imageDims('not a data uri')).toBeUndefined();
  });
});

describe('isRenderableRaster', () => {
  it('accepts a complete PNG', () => {
    expect(isRenderableRaster(PNG_URI)).toBe(true);
  });
  it('rejects a truncated PNG (no IEND), a mislabeled type, and SVG', () => {
    const truncated = Buffer.from(PNG_1x1, 'base64').subarray(0, 50).toString('base64');
    expect(isRenderableRaster(`data:image/png;base64,${truncated}`)).toBe(false);
    expect(isRenderableRaster(`data:image/jpeg;base64,${PNG_1x1}`)).toBe(false);
    expect(isRenderableRaster('data:image/png;base64,' + 'A'.repeat(400))).toBe(false);
    expect(isRenderableRaster('data:image/svg+xml;base64,PHN2Zy8+')).toBe(false);
  });
});
