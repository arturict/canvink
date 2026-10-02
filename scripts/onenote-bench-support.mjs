/**
 * Node helpers for the OneNote import benchmark that runs inside vitest
 * (src/import/apply/runtimeImport.test.ts). The app's TypeScript project has
 * no Node types, so file access, process memory and the environment live here.
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export function benchConfig() {
  return {
    exportDir: process.env.CANVINK_ONENOTE_BENCH_EXPORT || undefined,
    out: process.env.CANVINK_ONENOTE_BENCH_OUT || undefined,
  };
}

/** An export folder on disk, read file by file like the browser's folder picker does. */
export async function exportFolderFiles(root) {
  const sizes = new Map();
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else sizes.set(relative(root, path).split('\\').join('/'), (await stat(path)).size);
    }
  };
  await walk(root);
  return {
    has: (path) => sizes.has(path),
    size: (path) => sizes.get(path),
    read: async (path) => new Uint8Array(await readFile(join(root, path))),
  };
}

export function memoryUsage() {
  const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
  return { rss, heapUsed, external, arrayBuffers };
}

export function log(text) {
  process.stderr.write(`${text}\n`);
}

export async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2));
}
