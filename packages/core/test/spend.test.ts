import { describe, expect, it } from 'vitest';
import { classifyInvoiceLine } from '../src/index.js';

describe('classifyInvoiceLine', () => {
  it.each([
    // ANP 2026-Q1 to Q3 invoice lines.
    ['Managed Workstation - Windows PC', 'recurring'],
    ['Managed End User', 'recurring'],
    ['Compliance Management - Reg', 'recurring'],
    ['Networking Monitoring & Management - Small Site', 'recurring'],
    ['Microsoft 365 Business Premium', 'licensing'],
    ['Remote Support', 'variable'],
    ['Pro Svcs (Without ZTNA)', 'variable'],
    ['Consulting (per hr)', 'variable'],
    ['GMKtec Gaming Mini PC K8 Plus AMD Ryzen 7 8845HS(8C/16T', 'variable'],
    ['Other', 'variable'],
  ] as const)('%s is %s', (label, kind) => {
    expect(classifyInvoiceLine(label)).toBe(kind);
  });

  it('is case-insensitive', () => {
    expect(classifyInvoiceLine('MANAGED END USER')).toBe('recurring');
    expect(classifyInvoiceLine('remote support')).toBe('variable');
    expect(classifyInvoiceLine('office 365 e3')).toBe('licensing');
    expect(classifyInvoiceLine('other')).toBe('variable');
  });

  it('knows Microsoft licensing lines', () => {
    for (const l of ['M365 Business Basic', 'Exchange Online (Plan 1)', 'Microsoft 365 Copilot', 'Business Standard', 'Office 365 E1']) {
      expect(classifyInvoiceLine(l)).toBe('licensing');
    }
  });

  it('checks labour and one-offs before the weaker recurring words', () => {
    for (const l of ['On-site Support', 'Hourly Consulting', 'Professional Services', 'Firewall Install', 'Backup Project', 'Travel', 'Security Labour (per hour)', 'Hardware - Dell Monitor', 'Compliance Consulting']) {
      expect(classifyInvoiceLine(l)).toBe('variable');
    }
  });

  it('lets strong recurring words win over labour words', () => {
    for (const l of ['Managed Support Agreement', 'Managed Services Onsite Labor', 'Support Subscription', 'Helpdesk Support per user', 'Project Agreement']) {
      expect(classifyInvoiceLine(l)).toBe('recurring');
    }
    expect(classifyInvoiceLine('Remote Support')).toBe('variable');
    expect(classifyInvoiceLine('Managed End User')).toBe('recurring');
    expect(classifyInvoiceLine('Consulting (per hr)')).toBe('variable');
    // Licensing still comes first.
    expect(classifyInvoiceLine('Microsoft 365 Business Premium subscription')).toBe('licensing');
  });

  it('knows recurring service lines', () => {
    for (const l of ['Cloud Backup', 'Security Awareness Subscription', 'Firewall Maintenance', 'Service Agreement', 'Endpoint Protection per Device', 'Email Archiving per user', 'Password Manager per seat']) {
      expect(classifyInvoiceLine(l)).toBe('recurring');
    }
  });

  it('treats anything unknown as variable', () => {
    expect(classifyInvoiceLine('Dell Latitude 5450')).toBe('variable');
    expect(classifyInvoiceLine('')).toBe('variable');
  });
});
