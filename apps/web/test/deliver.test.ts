import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.js';
import { errorDetail, sendPackageFlow } from '../src/pages/workspace/deliver.js';

describe('sendPackageFlow', () => {
  it('locks first, then fetches the email built from the stored PDF and saves it', async () => {
    const calls: string[] = [];
    await sendPackageFlow(
      {
        markSent: async () => void calls.push('markSent'),
        fetchEmail: async () => {
          calls.push('fetchEmail');
          return { blob: new Blob(['eml']), filename: 'QBR.eml' };
        },
        save: (_blob, name) => void calls.push(`save:${name}`),
      },
      'fallback.eml',
    );
    expect(calls).toEqual(['markSent', 'fetchEmail', 'save:QBR.eml']);
  });

  it('a refused lock downloads nothing', async () => {
    const calls: string[] = [];
    const refused = new ApiError('The AI narrative failed.', 409, ['The AI narrative failed (overloaded).']);
    await expect(
      sendPackageFlow(
        {
          markSent: async () => {
            throw refused;
          },
          fetchEmail: async () => {
            calls.push('fetchEmail');
            return { blob: new Blob(['eml']) };
          },
          save: () => void calls.push('save'),
        },
        'fallback.eml',
      ),
    ).rejects.toBe(refused);
    expect(calls).toEqual([]);
  });

  it('says the quarter is locked when only the email fetch fails', async () => {
    await expect(
      sendPackageFlow(
        {
          markSent: async () => undefined,
          fetchEmail: async () => {
            throw new Error('500 Internal Server Error');
          },
          save: () => undefined,
        },
        'fallback.eml',
      ),
    ).rejects.toThrow(/locked and marked sent.*email draft could not be downloaded.*500 Internal Server Error/);
  });
});

describe('errorDetail', () => {
  it('appends the build warnings an ApiError carries', () => {
    expect(errorDetail(new ApiError('Nothing was sent.', 409, ['First warning.', 'Second warning.']))).toBe('Nothing was sent. First warning. Second warning.');
    expect(errorDetail(new Error('Plain.'))).toBe('Plain.');
    expect(errorDetail('x')).toBe('Unknown error');
  });
});
