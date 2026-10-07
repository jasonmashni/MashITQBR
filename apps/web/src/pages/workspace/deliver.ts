import { ApiError } from '../../api.js';

export interface SendPackageDeps {
  /** Lock 1: stores the pre-read package. A 409 means nothing was locked. */
  markSent: () => Promise<unknown>;
  /** The .eml draft, built from the stored PDF once the quarter is locked. */
  fetchEmail: () => Promise<{ blob: Blob; filename?: string }>;
  save: (blob: Blob, filename: string) => void;
}

/**
 * Send package: lock first, then download the draft. The draft is built from
 * the package the lock stored, so the client receives exactly what was frozen.
 * A refused lock downloads nothing. A draft that fails after the lock leaves
 * the quarter sent; Send again downloads it (marking sent is idempotent).
 */
export async function sendPackageFlow(deps: SendPackageDeps, fallbackName: string): Promise<void> {
  await deps.markSent();
  let email: { blob: Blob; filename?: string };
  try {
    email = await deps.fetchEmail();
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown error';
    throw new Error(`The quarter is locked and marked sent, but the email draft could not be downloaded (${reason}). Choose Send package again to download it.`);
  }
  deps.save(email.blob, email.filename ?? fallbackName);
}

/** An error's message plus any build warnings the API sent with it. */
export function errorDetail(e: unknown): string {
  if (!(e instanceof Error)) return 'Unknown error';
  const warnings = e instanceof ApiError ? (e.warnings ?? []) : [];
  return [e.message, ...warnings].join(' ');
}
