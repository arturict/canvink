export interface PersistenceGate {
  storageReady: boolean;
  loadFailed: boolean;
}

export function canAutosave(gate: PersistenceGate): boolean {
  return gate.storageReady && !gate.loadFailed;
}
