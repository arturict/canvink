/**
 * Web-side client for the desktop sign-in routes (services/collab-sync
 * PERSONAL-SYNC.md §3.7). The browser page asks for a one-time code and
 * watches it; the account menu lists and signs out desktop devices. The
 * desktop app's own token exchange and refresh live in Rust
 * (src-tauri/src/desktop_auth.rs), so no refresh token ever reaches web code.
 */

import { PersonalSpaceHttpError, type PersonalSpaceHttpConfig } from './http';

export type DesktopCodeStatus = 'pending' | 'used' | 'expired' | 'unknown';

export interface DesktopDevice {
  id: string;
  /** The name the app or the user gave it; older entries read "HOST (Windows)". */
  label: string;
  createdAt: string;
  lastUsedAt: string;
  /** Sent by apps since the account page; older entries have neither. */
  platform?: string;
  appVersion?: string;
}

function url(config: PersonalSpaceHttpConfig, path: string): string {
  return `${config.syncUrl.replace(/\/+$/, '')}/api/v1${path}`;
}

async function call(
  config: PersonalSpaceHttpConfig,
  path: string,
  jwt: string,
  init: { method: string; body?: unknown },
): Promise<Response> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(url(config, path), {
    method: init.method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) {
    let code = 'http-error';
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string') code = body.error;
    } catch {
      // keep the generic code
    }
    throw new PersonalSpaceHttpError(response.status, code);
  }
  return response;
}

/** `POST /device/code`: a one-time code for the desktop app's PKCE challenge. */
export async function requestDesktopCode(
  config: PersonalSpaceHttpConfig,
  jwt: string,
  challenge: string,
): Promise<{ code: string; expiresIn: number }> {
  const response = await call(config, '/device/code', jwt, { method: 'POST', body: { challenge, method: 'S256' } });
  const body = (await response.json()) as { code: string; expires_in: number };
  return { code: body.code, expiresIn: body.expires_in };
}

/** `POST /device/code/status`: whether the desktop app has redeemed the code. */
export async function desktopCodeStatus(
  config: PersonalSpaceHttpConfig,
  jwt: string,
  code: string,
): Promise<DesktopCodeStatus> {
  const response = await call(config, '/device/code/status', jwt, { method: 'POST', body: { code } });
  const { status } = (await response.json()) as { status: DesktopCodeStatus };
  return status;
}

/** `GET /me/devices`: the account's signed-in desktop devices. */
export async function listDesktopDevices(config: PersonalSpaceHttpConfig, jwt: string): Promise<DesktopDevice[]> {
  const response = await call(config, '/me/devices', jwt, { method: 'GET' });
  const { devices } = (await response.json()) as { devices: DesktopDevice[] };
  return devices;
}

/** `PATCH /me/devices/:id`: renames a device; returns the name the Worker kept. */
export async function renameDesktopDevice(
  config: PersonalSpaceHttpConfig,
  jwt: string,
  deviceId: string,
  label: string,
): Promise<string> {
  const response = await call(config, `/me/devices/${encodeURIComponent(deviceId)}`, jwt, {
    method: 'PATCH',
    body: { label },
  });
  return ((await response.json()) as { label: string }).label;
}

/** `DELETE /me/devices/:id`: signs that desktop device out. */
export async function revokeDesktopDevice(config: PersonalSpaceHttpConfig, jwt: string, deviceId: string): Promise<void> {
  await call(config, `/me/devices/${encodeURIComponent(deviceId)}`, jwt, { method: 'DELETE' });
}
