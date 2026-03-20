import * as fs from 'fs';
import * as path from 'path';

// Store caches in node_modules to avoid cluttering version control or the project root.
const CACHE_DIR = path.join(process.cwd(), 'node_modules', '.ika-cache');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * Maximum file size (in bytes) that we'll attempt to JSON.parse.
 *
 * Protocol public parameters can be 80–100 MB when serialized as JSON arrays
 * of numbers.  V8's JSON parser cannot allocate FixedArrays that large and
 * will crash the process with a fatal error (crbug.com/1201626).
 *
 * Files above this threshold are treated as unsafe for JSON.parse and are
 * skipped to avoid process crashes — unless we can positively identify the
 * new compact Base64 Uint8Array format.
 */
const MAX_SAFE_JSON_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

const COMPACT_UINT8ARRAY_PREFIX_BYTES = 512;

async function readFilePrefix(filepath: string, bytes: number): Promise<string> {
  const handle = await fs.promises.open(filepath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Ensures the cache directory exists and writes the data to the file,
 * correctly serializing Object, Number, BigInt, or Uint8Array.
 *
 * Uint8Array is encoded as a **Base64 string** (not a JSON number array)
 * to avoid V8 fatal crashes when parsing huge arrays back.
 */
export async function writeToDiskCache(filename: string, data: any): Promise<void> {
  const filepath = path.join(CACHE_DIR, filename);

  const payload = JSON.stringify(data, (_key, value) => {
    // Handle BigInts
    if (typeof value === 'bigint') {
      return { _type: 'BigInt', value: value.toString() };
    }
    // Handle Uint8Arrays — encode as Base64 string (compact + safe for V8)
    if (value instanceof Uint8Array) {
      return { _type: 'Uint8Array', encoding: 'base64', value: Buffer.from(value).toString('base64') };
    }
    // Handle Node.js Buffer-like objects that appear during JSON serialization
    if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
      return { _type: 'Uint8Array', encoding: 'base64', value: Buffer.from(value.data).toString('base64') };
    }
    return value;
  });

  await fs.promises.writeFile(filepath, payload, 'utf8');
}

/**
 * Reads from the disk cache. If the file doesn't exist, returns null.
 * Reconstructs BigInts and Uint8Arrays back to their original types.
 *
 * Handles both serialization formats:
 *   - New: `{ _type: 'Uint8Array', encoding: 'base64', value: '<base64>' }`
 *   - Old: `{ _type: 'Uint8Array', value: [number[]] }` (only for small files)
 *
 * Files larger than 50 MB are skipped because V8 cannot safely JSON.parse
 * large old-format payloads.
 */
export async function readFromDiskCache(filename: string): Promise<any | null> {
  const filepath = path.join(CACHE_DIR, filename);

  if (!fs.existsSync(filepath)) {
    return null;
  }

  try {
    // Safety check: reject files that are too large for V8 to JSON.parse
    // (old format used number arrays that could be 80–100 MB).
    const stat = await fs.promises.stat(filepath);
    if (stat.size > MAX_SAFE_JSON_SIZE_BYTES) {
      const prefix = await readFilePrefix(filepath, COMPACT_UINT8ARRAY_PREFIX_BYTES);
      const isCompactBase64Uint8Array =
        prefix.includes('"_type":"Uint8Array"') &&
        prefix.includes('"encoding":"base64"');

      if (!isCompactBase64Uint8Array) {
        console.warn(
          `[IKA Disk Cache] ${filename} is ${(stat.size / 1024 / 1024).toFixed(1)} MB ` +
          `(exceeds ${MAX_SAFE_JSON_SIZE_BYTES / 1024 / 1024} MB limit). ` +
          `Skipping cache file without deleting it to avoid unsafe JSON parsing.`,
        );
        return null;
      }

      console.warn(
        `[IKA Disk Cache] ${filename} is ${(stat.size / 1024 / 1024).toFixed(1)} MB ` +
        `and exceeds the generic size limit, but appears to be compact base64 Uint8Array format. ` +
        `Reading it instead of skipping.`,
      );
    }

    const content = await fs.promises.readFile(filepath, 'utf8');
    return JSON.parse(content, (_key, value) => {
      // Reconstruct BigInt
      if (value && value._type === 'BigInt') {
        return BigInt(value.value);
      }
      // Reconstruct Uint8Array
      if (value && value._type === 'Uint8Array') {
        // New format: Base64 string
        if (value.encoding === 'base64' && typeof value.value === 'string') {
          return new Uint8Array(Buffer.from(value.value, 'base64'));
        }
        // Old format: number array (only safe for small arrays)
        if (Array.isArray(value.value)) {
          return new Uint8Array(value.value);
        }
      }
      return value;
    });
  } catch (error) {
    // If the cache is corrupt, pretend it doesn't exist (triggers an auto-fetch and overwrite).
    console.warn(`[IKA Disk Cache] Failed to read ${filename}, treating as a miss`, error);
    return null;
  }
}
