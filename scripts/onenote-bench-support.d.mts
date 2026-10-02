export function benchConfig(): { exportDir?: string; out?: string };
export function exportFolderFiles(root: string): Promise<{
  has(path: string): boolean;
  size(path: string): number | undefined;
  read(path: string): Promise<Uint8Array>;
}>;
export function memoryUsage(): { rss: number; heapUsed: number; external: number; arrayBuffers: number };
export function log(text: string): void;
export function writeJson(path: string, value: unknown): Promise<void>;
