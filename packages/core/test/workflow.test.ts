import { describe, expect, it } from 'vitest';
import { advanceStatus, isQbrStatus, QBR_STATUS_ORDER } from '../src/workflow.js';

describe('QBR_STATUS_ORDER / isQbrStatus', () => {
  it('lists all eight lifecycle stages in order', () => {
    expect(QBR_STATUS_ORDER).toEqual([
      'draft',
      'data_synced',
      'narrative_approved',
      'scheduled',
      'completed',
      'dispositioned',
      'actions_pushed',
      'archived',
    ]);
  });

  it('accepts every known status and rejects everything else', () => {
    for (const s of QBR_STATUS_ORDER) expect(isQbrStatus(s)).toBe(true);
    expect(isQbrStatus('bogus')).toBe(false);
    expect(isQbrStatus('')).toBe(false);
    expect(isQbrStatus(undefined)).toBe(false);
    expect(isQbrStatus(3)).toBe(false);
  });
});

describe('advanceStatus', () => {
  it('moves forward', () => {
    expect(advanceStatus('draft', 'data_synced')).toBe('data_synced');
    expect(advanceStatus('data_synced', 'scheduled')).toBe('scheduled');
    expect(advanceStatus('dispositioned', 'actions_pushed')).toBe('actions_pushed');
  });

  it('never downgrades (the re-sync case)', () => {
    expect(advanceStatus('scheduled', 'data_synced')).toBe('scheduled');
    expect(advanceStatus('completed', 'data_synced')).toBe('completed');
    expect(advanceStatus('actions_pushed', 'dispositioned')).toBe('actions_pushed');
  });

  it('is a no-op for the same status', () => {
    expect(advanceStatus('scheduled', 'scheduled')).toBe('scheduled');
  });

  it('treats undefined as draft', () => {
    expect(advanceStatus(undefined, 'scheduled')).toBe('scheduled');
    expect(advanceStatus(undefined, 'draft')).toBe('draft');
  });

  it('treats archived as terminal', () => {
    expect(advanceStatus('archived', 'actions_pushed')).toBe('archived');
    expect(advanceStatus('archived', 'archived')).toBe('archived');
  });
});
