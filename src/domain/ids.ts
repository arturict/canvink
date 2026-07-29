let fallbackCounter = 0;

export function createId(prefix: string): string {
  const randomId =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${(fallbackCounter += 1).toString(36)}`;

  return `${prefix}-${randomId}`;
}
