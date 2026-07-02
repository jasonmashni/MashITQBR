/**
 * Signed-in user identity from Azure App Service Authentication (Easy Auth).
 * Easy Auth fronts every request in production and injects trusted headers;
 * `x-ms-client-principal` is a base64 JSON envelope of the validated claims.
 */

export interface Principal {
  name: string;
  email?: string;
  roles: string[];
  /** True only for the local-dev fallback identity. */
  dev?: boolean;
}

interface PrincipalEnvelope {
  auth_typ?: string;
  claims?: Array<{ typ: string; val: string }>;
  name_typ?: string;
  role_typ?: string;
}

/** Header accessor so both routers (Azure Functions + node:http) can feed us. */
export type HeaderGet = (name: string) => string | null | undefined;

export function principalFrom(get: HeaderGet): Principal | undefined {
  const b64 = get('x-ms-client-principal');
  if (!b64) return undefined;
  try {
    const env = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as PrincipalEnvelope;
    const claims = env.claims ?? [];
    const claim = (typ: string) => claims.find((c) => c.typ === typ)?.val;
    const roleTyp = env.role_typ ?? 'roles';
    const headerName = get('x-ms-client-principal-name') ?? undefined;
    return {
      name: claim('name') ?? headerName ?? 'Unknown user',
      email: claim('preferred_username') ?? claim('email') ?? headerName,
      roles: claims.filter((c) => c.typ === roleTyp).map((c) => c.val),
    };
  } catch {
    return undefined;
  }
}

/** Short actor string for audit entries. */
export function actorFrom(get: HeaderGet): string {
  const p = principalFrom(get);
  return p?.email ?? p?.name ?? 'anonymous';
}
