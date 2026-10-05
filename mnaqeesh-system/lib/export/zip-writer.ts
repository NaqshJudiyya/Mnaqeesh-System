/**
 * Minimal ZIP writer — browser AND server compatible.
 *
 * Kept dependency-free on purpose: this project has to build on a static
 * host without pulling in an archive library. The XLSX writer feeds this.
 *
 * Originally this used Node's zlib; the static (GitHub Pages / Firebase
 * Hosting) build runs in the BROWSER, so compression now uses the
 * standard CompressionStream API with a store-only fallback, and all
 * byte handling is plain Uint8Array + DataView instead of Buffer.
 */

const CRC_TABLE: number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

/** DEFLATE-raw via CompressionStream, or null when unsupported. */
async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream('deflate-raw'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}

/** MS-DOS packed date/time, as required by the ZIP central directory. */
function dosDateTime(date: Date): { time: number; date: number } {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: dosDate & 0xffff };
}

/** Growable little-endian byte sink. */
class ByteWriter {
  private chunks: Uint8Array[] = [];
  length = 0;

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  bytes(count: number): DataView {
    const view = new DataView(new ArrayBuffer(count));
    this.chunks.push(new Uint8Array(view.buffer));
    this.length += count;
    return view;
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

export type ZipEntry = { path: string; data: Uint8Array | string };

export async function buildZip(entries: ZipEntry[], modified: Date = new Date(0)): Promise<Uint8Array> {
  const { time, date } = dosDateTime(modified);
  const out = new ByteWriter();
  const central = new ByteWriter();
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;

    // Tiny files get bigger under DEFLATE, so store them instead.
    const deflated = await deflateRaw(raw);
    const useDeflate = deflated !== null && deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const localHeader = out.bytes(30);
    localHeader.setUint32(0, 0x04034b50, true); // local file header signature
    localHeader.setUint16(4, 20, true); // version needed
    localHeader.setUint16(6, 0x0800, true); // UTF-8 filename flag
    localHeader.setUint16(8, method, true);
    localHeader.setUint16(10, time, true);
    localHeader.setUint16(12, date, true);
    localHeader.setUint32(14, crc, true);
    localHeader.setUint32(18, payload.length, true);
    localHeader.setUint32(22, raw.length, true);
    localHeader.setUint16(26, nameBytes.length, true);
    localHeader.setUint16(28, 0, true); // no extra field

    out.push(nameBytes);
    out.push(payload);

    const centralHeader = central.bytes(46);
    centralHeader.setUint32(0, 0x02014b50, true); // central directory signature
    centralHeader.setUint16(4, 20, true); // version made by
    centralHeader.setUint16(6, 20, true); // version needed
    centralHeader.setUint16(8, 0x0800, true); // UTF-8 flag
    centralHeader.setUint16(10, method, true);
    centralHeader.setUint16(12, time, true);
    centralHeader.setUint16(14, date, true);
    centralHeader.setUint32(16, crc, true);
    centralHeader.setUint32(20, payload.length, true);
    centralHeader.setUint32(24, raw.length, true);
    centralHeader.setUint16(28, nameBytes.length, true);
    centralHeader.setUint16(30, 0, true); // extra length
    centralHeader.setUint16(32, 0, true); // comment length
    centralHeader.setUint16(34, 0, true); // disk number
    centralHeader.setUint16(36, 0, true); // internal attributes
    centralHeader.setUint32(38, 0, true); // external attributes
    centralHeader.setUint32(42, offset, true);

    central.push(nameBytes);
    offset += 30 + nameBytes.length + payload.length;
  }

  const centralBytes = central.toUint8Array();
  const end = out.bytes(22);
  end.setUint32(0, 0x06054b50, true); // end of central directory
  end.setUint16(4, 0, true); // this disk
  end.setUint16(6, 0, true); // disk with central directory
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralBytes.length, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true); // no comment

  out.push(centralBytes);
  return out.toUint8Array();
}
