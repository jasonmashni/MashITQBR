import { describe, expect, it } from 'vitest';
import { classifyInvoiceLine, isLabourLine, spendLabelKey, stripBillingPlaceholders } from '../src/index.js';

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

  it('does not treat sizes as hardware, accepts hyphenated per-user, and ignores "unmanaged"', () => {
    expect(classifyInvoiceLine('Cloud Backup 500GB')).toBe('recurring');
    expect(classifyInvoiceLine('Per-User Support Plan')).toBe('recurring');
    expect(classifyInvoiceLine('Unmanaged switch')).toBe('variable');
  });

  it('treats anything not labour, hardware or Other as recurring', () => {
    for (const l of ['Radius Server cloud', 'Foxit PDF Editor Pro+', 'Windows 365 Cloud PC', 'Power BI Pro', 'Dell Latitude 5450 lease']) {
      expect(classifyInvoiceLine(l)).toBe('recurring');
    }
    // Nothing to go on: not counted as recurring.
    expect(classifyInvoiceLine('')).toBe('variable');
    expect(classifyInvoiceLine('   ')).toBe('variable');
  });

  it('knows hardware-looking items', () => {
    for (const l of [
      'Dell Laptop',
      'HP Desktop',
      'Dell 27in Monitor',
      'Netgear 8-port Switch',
      'FortiGate 60F Firewall Appliance',
      'APC UPS 1500',
      'USB-C Dock',
      'Logitech Keyboard',
      'Wireless Mouse',
      'Intel Core i7 workstation',
    ]) {
      expect(classifyInvoiceLine(l)).toBe('variable');
    }
  });
});

describe('isLabourLine', () => {
  it('is true only for labour and one-off service words, not hardware or Other', () => {
    expect(isLabourLine('Remote Support')).toBe(true);
    expect(isLabourLine('Consulting (per hr)')).toBe(true);
    expect(isLabourLine('Onsite Labor')).toBe(true);
    expect(isLabourLine('Managed Support Agreement')).toBe(false);
    expect(isLabourLine('Managed End User')).toBe(false);
    expect(isLabourLine('Radius Server cloud')).toBe(false);
    expect(isLabourLine('Dell Laptop')).toBe(false);
  });
});

describe('billing placeholders and spend label keys', () => {
  it('strips Halo period placeholders with their joiner', () => {
    expect(stripBillingPlaceholders('Managed End User $periodStartDate - $PeriodEndDate')).toBe('Managed End User');
    expect(stripBillingPlaceholders('Power BI Pro ($PERIODSTARTDATE - $periodenddate)')).toBe('Power BI Pro');
    expect(stripBillingPlaceholders('Radius Server cloud - $periodStartDate')).toBe('Radius Server cloud');
    expect(stripBillingPlaceholders('Managed Workstation - Windows PC')).toBe('Managed Workstation - Windows PC');
  });

  it('gives recurring and posted labels the same key', () => {
    expect(spendLabelKey('Managed Workstation - Windows PC $periodStartDate - $PeriodEndDate (monthly)')).toBe(spendLabelKey('Managed Workstation - Windows PC'));
    expect(spendLabelKey('Managed End User (monthly)')).toBe('managed end user');
    expect(spendLabelKey('  Compliance   Management - Reg ')).toBe('compliance management - reg');
  });
});
