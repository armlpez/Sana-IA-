/**
 * StoragePort — contract every storage backend must fulfill.
 *
 * Consumers depend only on this interface, never on a concrete adapter.
 * Adding a new backend (GCS, Azure Blob, etc.) means writing one adapter
 * and registering it in StorageModule — no changes to callers.
 */
export interface StorageObject {
  buffer: Buffer;
  contentType: string;
}

export interface StoragePort {
  /** Persists the object under `key`. Returns the key to store as the durable reference. */
  save(object: StorageObject, key: string): Promise<string>;

  /** Reads the object identified by `key` into memory. */
  get(key: string): Promise<Buffer>;

  /** Removes the object identified by `key`. Must not throw on missing keys. */
  remove(key: string): Promise<void>;
}

export const STORAGE_PORT = Symbol('STORAGE_PORT');
