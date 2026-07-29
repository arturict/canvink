export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index)!;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else {
      bytes += 4;
      index += 1;
    }
  }
  return bytes;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index)!;
    const width =
      codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + width > maxBytes) break;
    bytes += width;
    end = index + (codePoint > 0xffff ? 2 : 1);
    if (codePoint > 0xffff) index += 1;
  }
  return value.slice(0, end);
}
