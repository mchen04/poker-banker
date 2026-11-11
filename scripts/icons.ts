import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const letters = [
  ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
];

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function icon(size: number): Buffer {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  const cell = Math.floor(size / 21);
  const width = 11 * cell;
  const offsetX = Math.floor((size - width) / 2);
  const offsetY = Math.floor((size - 7 * cell) / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const column = Math.floor((x - offsetX) / cell);
      const row = Math.floor((y - offsetY) / cell);
      const letter = column < 5 ? 0 : column >= 6 && column < 11 ? 1 : -1;
      const glyphColumn = letter === 1 ? column - 6 : column;
      const ink = letter >= 0 && row >= 0 && row < 7 && glyphColumn >= 0 && glyphColumn < 5 && letters[letter]?.[row]?.[glyphColumn] === '1';
      const pixel = y * (size * 4 + 1) + 1 + x * 4;
      pixels.set(ink ? [248, 246, 240, 255] : [45, 79, 64, 255], pixel);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

export async function generateIcons(directory = 'public'): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const size of [180, 192, 512]) await writeFile(`${directory}/icon-${size}.png`, icon(size));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await generateIcons();
