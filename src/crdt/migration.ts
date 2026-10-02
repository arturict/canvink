import type { WorkspaceState } from '../domain/types';
import {
  prepareV1ToV2Migration,
  sha256Canonical,
  type MigrationResultV2,
  type StoredDocumentV2,
  verifyMigrationResult,
} from '../domain/v2';
import {
  createAutomergeDocument,
  getAutomergeHeads,
  loadAutomergeDocument,
  saveAutomergeDocument,
} from './document';
import { createYieldBudget } from '../performance/yield';
import { assertPortableRichTextRoundTrip } from './richText';
import type { MaterializedAutomergeMigration, PageAutomergeDoc } from './types';

async function deterministicActorId(
  migration: MigrationResultV2,
  documentId: string,
): Promise<string> {
  const checksum = await sha256Canonical({
    namespace: 'canvink-schema-v2-automerge-actor',
    migrationArtifactFingerprint: migration.artifactFingerprint,
    documentId,
  });
  return checksum.slice('sha256:'.length);
}

/** Materialize prepared v1 projections as deterministic, real Automerge saves. */
export async function materializeMigrationAsAutomerge(
  migration: MigrationResultV2,
  options: { alreadyVerified?: boolean } = {},
): Promise<MaterializedAutomergeMigration> {
  // A caller that verified the migration itself (it has the asset bytes) can pass it on without them.
  if (!options.alreadyVerified) await verifyMigrationResult(migration);
  const documents: StoredDocumentV2[] = [];
  const budget = createYieldBudget();
  for (const source of migration.documents) {
    // A notebook of hundreds of pages is materialized one document at a time; the input
    // stays responsive between them.
    await budget.maybeYield();
    const actorId = await deterministicActorId(migration, source.documentId);
    const document = createAutomergeDocument(source, { actorId });
    const bytes = saveAutomergeDocument(document);
    const reloaded = loadAutomergeDocument(bytes, {
      expectedDocumentId: source.documentId,
      expectedKind: source.kind,
    });
    if (source.kind === 'page') {
      for (const [elementId, element] of Object.entries(source.elementsById)) {
        if (element.kind === 'richText') {
          assertPortableRichTextRoundTrip(
            reloaded as PageAutomergeDoc,
            elementId,
            element.content,
          );
        }
      }
    }
    documents.push({
      documentId: source.documentId,
      kind: source.kind,
      schemaVersion: source.schemaVersion,
      documentFormat: 'automerge',
      encoding: 'binary',
      version: { protocol: 'automerge', heads: getAutomergeHeads(reloaded) },
      bytes,
    });
  }
  return { documents };
}

export async function prepareV1ToAutomergeMigration(
  workspace: WorkspaceState,
): Promise<{ migration: MigrationResultV2; materialized: MaterializedAutomergeMigration }> {
  const migration = await prepareV1ToV2Migration(workspace);
  return {
    migration,
    materialized: await materializeMigrationAsAutomerge(migration),
  };
}
