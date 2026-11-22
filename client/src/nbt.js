/**
 * Minimal NBT reader/writer (big endian, gzip handled by the caller).
 *
 * Nodes keep their tag type so a file can be read, edited and written back
 * without losing anything the game put there: `servers.dat` holds byte tags
 * next to strings, and guessing types on write would corrupt it.
 *
 *   node = { type: TAG, value: ... }
 */
import zlib from 'node:zlib';

export const TAG = {
  END: 0,
  BYTE: 1,
  SHORT: 2,
  INT: 3,
  LONG: 4,
  FLOAT: 5,
  DOUBLE: 6,
  BYTE_ARRAY: 7,
  STRING: 8,
  LIST: 9,
  COMPOUND: 10,
  INT_ARRAY: 11,
  LONG_ARRAY: 12,
};

const NAME = {
  0: 'end', 1: 'byte', 2: 'short', 3: 'int', 4: 'long', 5: 'float', 6: 'double',
  7: 'byteArray', 8: 'string', 9: 'list', 10: 'compound', 11: 'intArray', 12: 'longArray',
};

// ------------------------------------------------------------------ builders

export const compound = (entries = {}) => ({ type: TAG.COMPOUND, value: entries });
export const list = (elementType, items = []) => ({ type: TAG.LIST, value: { elementType, items } });
export const string = (value) => ({ type: TAG.STRING, value: String(value) });
export const byte = (value) => ({ type: TAG.BYTE, value: Number(value) });
export const int = (value) => ({ type: TAG.INT, value: Number(value) });

// -------------------------------------------------------------------- reader

class Reader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  ensure(bytes) {
    if (this.offset + bytes > this.buffer.length) throw new Error('nbt: unexpected end of data');
  }

  u8() { this.ensure(1); const v = this.buffer.readUInt8(this.offset); this.offset += 1; return v; }
  i8() { this.ensure(1); const v = this.buffer.readInt8(this.offset); this.offset += 1; return v; }
  i16() { this.ensure(2); const v = this.buffer.readInt16BE(this.offset); this.offset += 2; return v; }
  u16() { this.ensure(2); const v = this.buffer.readUInt16BE(this.offset); this.offset += 2; return v; }
  i32() { this.ensure(4); const v = this.buffer.readInt32BE(this.offset); this.offset += 4; return v; }
  i64() { this.ensure(8); const v = this.buffer.readBigInt64BE(this.offset); this.offset += 8; return v; }
  f32() { this.ensure(4); const v = this.buffer.readFloatBE(this.offset); this.offset += 4; return v; }
  f64() { this.ensure(8); const v = this.buffer.readDoubleBE(this.offset); this.offset += 8; return v; }

  str() {
    const length = this.u16();
    this.ensure(length);
    const value = this.buffer.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  payload(type) {
    switch (type) {
      case TAG.END: return { type, value: null };
      case TAG.BYTE: return { type, value: this.i8() };
      case TAG.SHORT: return { type, value: this.i16() };
      case TAG.INT: return { type, value: this.i32() };
      case TAG.LONG: return { type, value: this.i64() };
      case TAG.FLOAT: return { type, value: this.f32() };
      case TAG.DOUBLE: return { type, value: this.f64() };
      case TAG.BYTE_ARRAY: {
        const length = this.i32();
        this.ensure(length);
        const value = Buffer.from(this.buffer.subarray(this.offset, this.offset + length));
        this.offset += length;
        return { type, value };
      }
      case TAG.STRING: return { type, value: this.str() };
      case TAG.LIST: {
        const elementType = this.u8();
        const length = this.i32();
        const items = [];
        for (let i = 0; i < length; i += 1) items.push(this.payload(elementType));
        return { type, value: { elementType, items } };
      }
      case TAG.COMPOUND: {
        const entries = {};
        for (;;) {
          const childType = this.u8();
          if (childType === TAG.END) break;
          const name = this.str();
          entries[name] = this.payload(childType);
        }
        return { type, value: entries };
      }
      case TAG.INT_ARRAY: {
        const length = this.i32();
        const value = [];
        for (let i = 0; i < length; i += 1) value.push(this.i32());
        return { type, value };
      }
      case TAG.LONG_ARRAY: {
        const length = this.i32();
        const value = [];
        for (let i = 0; i < length; i += 1) value.push(this.i64());
        return { type, value };
      }
      default:
        throw new Error(`nbt: unknown tag ${type}`);
    }
  }
}

/** Parses a decompressed NBT root compound. */
export function parseNbt(buffer) {
  const reader = new Reader(buffer);
  const type = reader.u8();
  if (type !== TAG.COMPOUND) throw new Error('nbt: root must be a compound');
  const name = reader.str();
  const root = reader.payload(type);
  return { name, ...root };
}

// -------------------------------------------------------------------- writer

function writeString(value) {
  const body = Buffer.from(String(value), 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length, 0);
  return Buffer.concat([length, body]);
}

function writePayload(node) {
  const type = node.type;
  const value = node.value;
  switch (type) {
    case TAG.BYTE: return Buffer.from([value & 0xff]);
    case TAG.SHORT: { const b = Buffer.alloc(2); b.writeInt16BE(value, 0); return b; }
    case TAG.INT: { const b = Buffer.alloc(4); b.writeInt32BE(value, 0); return b; }
    case TAG.LONG: { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(value), 0); return b; }
    case TAG.FLOAT: { const b = Buffer.alloc(4); b.writeFloatBE(value, 0); return b; }
    case TAG.DOUBLE: { const b = Buffer.alloc(8); b.writeDoubleBE(value, 0); return b; }
    case TAG.BYTE_ARRAY: {
      const length = Buffer.alloc(4);
      length.writeInt32BE(value.length, 0);
      return Buffer.concat([length, value]);
    }
    case TAG.STRING: return writeString(value);
    case TAG.LIST: {
      const items = value.items || [];
      const header = Buffer.alloc(5);
      header.writeUInt8(items.length ? items[0].type : value.elementType || TAG.END, 0);
      header.writeInt32BE(items.length, 1);
      return Buffer.concat([header, ...items.map(writePayload)]);
    }
    case TAG.COMPOUND: {
      const parts = [];
      for (const [key, child] of Object.entries(value)) {
        parts.push(Buffer.from([child.type]), writeString(key), writePayload(child));
      }
      parts.push(Buffer.from([TAG.END]));
      return Buffer.concat(parts);
    }
    case TAG.INT_ARRAY: {
      const length = Buffer.alloc(4);
      length.writeInt32BE(value.length, 0);
      const body = Buffer.alloc(value.length * 4);
      value.forEach((item, index) => body.writeInt32BE(item, index * 4));
      return Buffer.concat([length, body]);
    }
    case TAG.LONG_ARRAY: {
      const length = Buffer.alloc(4);
      length.writeInt32BE(value.length, 0);
      const body = Buffer.alloc(value.length * 8);
      value.forEach((item, index) => body.writeBigInt64BE(BigInt(item), index * 8));
      return Buffer.concat([length, body]);
    }
    default:
      throw new Error(`nbt: cannot write tag ${type}`);
  }
}

/** Serializes a root node ({type, value}) back to bytes (not compressed). */
export function writeNbt(root, name = '') {
  if (root.type !== TAG.COMPOUND) throw new Error('nbt: root must be a compound');
  return Buffer.concat([Buffer.from([TAG.COMPOUND]), writeString(name), writePayload(root)]);
}

export function gzipNbt(root, name = '') {
  return zlib.gzipSync(writeNbt(root, name), { level: 9 });
}

export function gunzipNbt(buffer) {
  return parseNbt(zlib.gunzipSync(buffer));
}

export const tagName = (type) => NAME[type] || String(type);
