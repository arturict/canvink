import type { CanvinkDocumentV2, MigrationManifestV2 } from '../v2/types';
import {
  V2_TO_V3_MIGRATION_VERSION,
  WORKSPACE_SCHEMA_VERSION_V3,
  type CanvinkDocumentV3,
  type NotebookDocV3,
  type PageDocV3,
  type WorkspaceManifestV3,
} from './types';

export function upgradeDocumentV2ToV3(document: CanvinkDocumentV2): CanvinkDocumentV3 {
  if (document.kind === 'notebook') {
    return {
      ...structuredClone(document),
      schemaVersion: WORKSPACE_SCHEMA_VERSION_V3,
    } satisfies NotebookDocV3;
  }
  return {
    ...structuredClone(document),
    schemaVersion: WORKSPACE_SCHEMA_VERSION_V3,
  } satisfies PageDocV3;
}

export function isDocumentV3(document: { schemaVersion: number }): document is CanvinkDocumentV3 {
  return document.schemaVersion === WORKSPACE_SCHEMA_VERSION_V3;
}

export function upgradeManifestV2ToV3(
  manifest: MigrationManifestV2,
  sourceArtifactFingerprint: `sha256:${string}`,
  preparedAt: string,
): WorkspaceManifestV3 {
  return {
    ...structuredClone(manifest),
    schemaVersion: WORKSPACE_SCHEMA_VERSION_V3,
    format: 'canvink-schema-v3',
    upgrade: {
      name: 'workspace-v2-to-v3',
      version: V2_TO_V3_MIGRATION_VERSION,
      upgradeId: `workspace-v2-to-v3:${sourceArtifactFingerprint.slice('sha256:'.length)}`,
      sourceArtifactFingerprint,
      preparedAt,
    },
  };
}

export function isManifestV3(
  manifest: MigrationManifestV2 | WorkspaceManifestV3,
): manifest is WorkspaceManifestV3 {
  return manifest.schemaVersion === WORKSPACE_SCHEMA_VERSION_V3;
}
