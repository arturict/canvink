import { SyncClientError } from './errors';
import type { EnabledSyncConfiguration, SyncConfiguration } from './types';

const APPWRITE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateSyncConfiguration(config: SyncConfiguration | undefined): EnabledSyncConfiguration | null {
  if (!config?.enabled) return null;
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch (error) {
    throw new SyncClientError('invalid-config', 'The sync endpoint is invalid.', { cause: error });
  }
  const localHttp = endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !localHttp) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new SyncClientError('invalid-config', 'The sync endpoint must be HTTPS or local development HTTP.');
  }
  for (const [label, value] of Object.entries({
    projectId: config.projectId,
    functionId: config.functionId,
    databaseId: config.databaseId,
    changesTableId: config.changesTableId,
    assetBucketId: config.assetBucketId,
  })) {
    if (!APPWRITE_ID.test(value)) throw new SyncClientError('invalid-config', `${label} is invalid.`);
  }
  return { ...config, endpoint: endpoint.toString().replace(/\/$/, '') };
}

export function createOptionalSyncClient<T>(
  config: SyncConfiguration | undefined,
  factory: (enabled: EnabledSyncConfiguration) => T,
): T | null {
  const enabled = validateSyncConfiguration(config);
  return enabled ? factory(enabled) : null;
}
