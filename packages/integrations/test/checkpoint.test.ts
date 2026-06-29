import { describe, it, expect } from 'vitest';
import { normalizeCheckpointEvents, type CheckpointEvent } from '@mashit/integrations';

const events: CheckpointEvent[] = [
  { type: 'phishing', entity: { recipients: ['lisa@kypca.net'] } },
  { type: 'phishing', entity: { recipients: ['lisa@kypca.net'] } },
  { type: 'phishing', entity: { recipients: ['rick@kypca.net'] }, clicked: true },
  { type: 'malware', entity: { recipients: ['lisa@kypca.net'] } },
  { type: 'spam' },
  { type: 'graymail' },
  { type: 'dlp' },
  { type: 'clean' },
];

describe('normalizeCheckpointEvents', () => {
  const by = Object.fromEntries(normalizeCheckpointEvents(events).map((m) => [m.key, m.value]));

  it('counts events by category', () => {
    expect(by['email.events_total']).toBe(8);
    expect(by['email.phishing']).toBe(3);
    expect(by['email.malware']).toBe(1);
    expect(by['email.spam']).toBe(1);
    expect(by['email.graymail']).toBe(1);
    expect(by['email.dlp_events']).toBe(1);
  });

  it('computes threats blocked and malicious clicks', () => {
    expect(by['email.threats_blocked']).toBe(4); // 3 phishing + 1 malware
    expect(by['email.malicious_clicks']).toBe(1);
  });

  it('computes the top attacked user from threat recipients', () => {
    expect(by['email.top_attacked_user']).toBe('lisa@kypca.net (3)');
  });
});
