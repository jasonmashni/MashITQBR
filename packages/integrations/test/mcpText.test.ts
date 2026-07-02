import { describe, expect, it } from 'vitest';
import { headerCount, parseIdNameList, parseJsonLines, parsePipeRows } from '../src/mcpText.js';

// Fixtures below are verbatim captures from the live MASH MCP server.

const HALO_CLIENTS = `Found 3 client(s):

  [35] Addiction Recovery Care
  [47] Adelante KY
  [30] Allodium Real Estate`;

const NINJA_ORGS = `Organizations (9 total):
  [1] Mash IT | Internal Infrastructure
  [2] TEM GROUP
  [3] ANP ENERTECH
  [5] KPCA`;

const NINJA_DEVICES = `Devices for organization 3 (3 returned):
  [17] ANP-LAP-005 | Org: 3 | Role: 202 | Status: Unknown | OS:
  [24] ANP-LAP-001 | Org: 3 | Role: 202 | Status: Unknown | OS:
  [25] ANP-LAP-009 | Org: 3 | Role: 202 | Status: Unknown | OS: `;

const NINJA_AV = `Antivirus Status (3 results):
  {"productName": "Microsoft Defender Antivirus", "productState": "ON", "definitionStatus": "Up-to-Date", "version": "", "deviceId": 147, "timestamp": 1782925570.0}
  {"productName": "Microsoft Defender Antivirus", "productState": "ON", "definitionStatus": "Up-to-Date", "version": "", "deviceId": 20, "timestamp": 1783016290.0}
  {"productName": "Microsoft Defender Antivirus", "productState": "OFF", "definitionStatus": "Out-of-Date", "version": "", "deviceId": 262, "timestamp": 1783017322.0}`;

const HALO_TICKETS = `Found 2 ticket(s):

  #69691 — Device display name: ANP-CoryGobel-11 - System has not rebooted
    Client: ANP Enertech

  #69690 — Device 'Matts-Air-2.home' registered.
    Client: Unknown`;

describe('parseIdNameList', () => {
  it('parses halo client lists', () => {
    expect(parseIdNameList(HALO_CLIENTS)).toEqual([
      { id: '35', name: 'Addiction Recovery Care' },
      { id: '47', name: 'Adelante KY' },
      { id: '30', name: 'Allodium Real Estate' },
    ]);
  });

  it('parses ninja org lists (name may contain a pipe)', () => {
    const orgs = parseIdNameList(NINJA_ORGS);
    expect(orgs[0]).toEqual({ id: '1', name: 'Mash IT' });
    expect(orgs.map((o) => o.id)).toEqual(['1', '2', '3', '5']);
  });

  it('returns [] for prose without id rows', () => {
    expect(parseIdNameList('No clients found.')).toEqual([]);
  });
});

describe('parsePipeRows', () => {
  it('parses ninja device rows with fields', () => {
    const rows = parsePipeRows(NINJA_DEVICES);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.id).toBe('17');
    expect(rows[0]!.name).toBe('ANP-LAP-005');
    expect(rows[0]!.fields['org']).toBe('3');
    expect(rows[0]!.fields['status']).toBe('Unknown');
  });
});

describe('parseJsonLines', () => {
  it('parses ninja query batch output', () => {
    const rows = parseJsonLines(NINJA_AV);
    expect(rows).toHaveLength(3);
    expect(rows[0]!['productState']).toBe('ON');
    expect(rows[2]!['definitionStatus']).toBe('Out-of-Date');
  });

  it('ignores non-JSON lines', () => {
    expect(parseJsonLines(HALO_CLIENTS)).toEqual([]);
  });
});

describe('headerCount', () => {
  it('reads Found N / (N total) / (N results) headers', () => {
    expect(headerCount(HALO_CLIENTS)).toBe(3);
    expect(headerCount(HALO_TICKETS)).toBe(2);
    expect(headerCount(NINJA_ORGS)).toBe(9);
    expect(headerCount(NINJA_AV)).toBe(3);
    expect(headerCount('nothing here')).toBeNull();
  });
});
