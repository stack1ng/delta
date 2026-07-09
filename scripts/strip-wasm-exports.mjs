// Rewrites a wasm binary's export section, keeping only the named exports.
//
// zstd-sys's wasm shim marks its malloc/free helpers #[no_mangle], so the
// linker exports them from the cdylib alongside our ABI. The functions are
// still needed internally (libzstd calls them); only the export *entries*
// are surplus surface, so this drops them without touching code sections.
//
// Usage: node strip-wasm-exports.mjs <file.wasm> <keep1> <keep2> ...

import { readFileSync, writeFileSync } from "node:fs";

const [file, ...keep] = process.argv.slice(2);
if (!file || keep.length === 0) {
  console.error("usage: strip-wasm-exports.mjs <file.wasm> <export-name>...");
  process.exit(1);
}
const keepSet = new Set(keep);
const bytes = readFileSync(file);

function readU32(offset) {
  // LEB128 u32: at most 5 bytes, never past EOF.
  let result = 0;
  let shift = 0;
  let position = offset;
  for (;;) {
    if (position >= bytes.length) {
      throw new Error(`${file}: truncated LEB128 at offset ${offset}`);
    }
    if (shift > 28) {
      throw new Error(`${file}: LEB128 u32 overflow at offset ${offset}`);
    }
    const byte = bytes[position];
    position += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return [result >>> 0, position];
    }
    shift += 7;
  }
}

function encodeU32(value) {
  const out = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (v !== 0);
  return Uint8Array.from(out);
}

if (bytes.readUInt32LE(0) !== 0x6d736100 || bytes.readUInt32LE(4) !== 1) {
  throw new Error(`${file}: not a wasm v1 binary`);
}

let pos = 8;
while (pos < bytes.length) {
  const sectionId = bytes[pos];
  const [size, bodyStart] = readU32(pos + 1);
  const bodyEnd = bodyStart + size;
  if (sectionId !== 7) {
    pos = bodyEnd;
    continue;
  }

  // Export section: count, then (name, kind, index) entries.
  let [count, cursor] = readU32(bodyStart);
  const kept = [];
  const dropped = [];
  for (let i = 0; i < count; i++) {
    const entryStart = cursor;
    const [nameLen, nameStart] = readU32(cursor);
    const name = bytes.subarray(nameStart, nameStart + nameLen).toString("utf8");
    cursor = nameStart + nameLen + 1; // + kind byte
    const [, next] = readU32(cursor); // index
    cursor = next;
    (keepSet.has(name) ? kept : dropped).push({ name, entry: bytes.subarray(entryStart, cursor) });
  }
  if (cursor !== bodyEnd) {
    throw new Error(`${file}: export section parse mismatch`);
  }
  if (dropped.length === 0) {
    process.exit(0);
  }

  const countBytes = encodeU32(kept.length);
  const bodyLen = countBytes.length + kept.reduce((sum, e) => sum + e.entry.length, 0);
  const sizeBytes = encodeU32(bodyLen);
  const section = Buffer.concat([
    Buffer.from([7]),
    sizeBytes,
    countBytes,
    ...kept.map((e) => e.entry),
  ]);
  writeFileSync(file, Buffer.concat([bytes.subarray(0, pos), section, bytes.subarray(bodyEnd)]));
  console.log(`${file}: dropped exports ${dropped.map((e) => e.name).join(", ")}`);
  process.exit(0);
}
throw new Error(`${file}: no export section found`);
