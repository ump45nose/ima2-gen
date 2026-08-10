export type LocalFolderPermission = "granted" | "denied" | "prompt";

type LocalFileHandle = {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
};

type LocalDirectoryEntry = LocalFileHandle | {
  kind: "directory";
  name: string;
};

export type LocalDirectoryHandle = {
  kind: "directory";
  name: string;
  values: () => AsyncIterableIterator<LocalDirectoryEntry>;
  queryPermission?: (descriptor: { mode: "read" }) => Promise<LocalFolderPermission>;
  requestPermission?: (descriptor: { mode: "read" }) => Promise<LocalFolderPermission>;
};

export type LocalFolderImage = {
  id: string;
  name: string;
  file: File;
};

type PersistedDirectory = {
  key: "active";
  name: string;
  handle: LocalDirectoryHandle;
};

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read" }) => Promise<LocalDirectoryHandle>;
};

const DB_NAME = "ima2-local-folder";
const DB_VERSION = 1;
const STORE_NAME = "directory-handles";
const ACTIVE_KEY = "active";
const NATURAL_NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const SUPPORTED_EXTENSIONS = /\.(?:jpe?g|png|webp)$/i;
const SUPPORTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function openDirectoryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local folder storage"));
  });
}

function completeTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Local folder storage failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Local folder storage aborted"));
  });
}

function readActiveDirectory(db: IDBDatabase): Promise<PersistedDirectory | null> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(ACTIVE_KEY);
    request.onsuccess = () => resolve((request.result as PersistedDirectory | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("Could not read local folder"));
  });
}

export function supportsLocalDirectoryPicker(): boolean {
  return typeof window !== "undefined"
    && typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function"
    && typeof indexedDB !== "undefined";
}

export function localFolderSelectionLimit(activeLimit: number, trayCount: number): number {
  return Math.max(0, Math.min(4, Math.trunc(activeLimit) - Math.max(0, Math.trunc(trayCount))));
}

export function toggleLocalFolderSelection(
  selected: readonly string[],
  id: string,
  limit: number,
): string[] {
  if (selected.includes(id)) return selected.filter((candidate) => candidate !== id);
  if (selected.length >= Math.max(0, limit)) return [...selected];
  return [...selected, id];
}

export function isSupportedLocalFolderImage(name: string, mimeType: string): boolean {
  return SUPPORTED_TYPES.has(mimeType.toLowerCase()) || SUPPORTED_EXTENSIONS.test(name);
}

export async function pickLocalDirectory(): Promise<LocalDirectoryHandle> {
  try {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) throw new Error("Local directory picker is unavailable");
    return await picker({ mode: "read" });
  } catch (error) {
    throw error;
  }
}

export async function queryLocalDirectoryPermission(handle: LocalDirectoryHandle): Promise<LocalFolderPermission> {
  try {
    if (!handle.queryPermission) return "prompt";
    return await handle.queryPermission({ mode: "read" });
  } catch {
    return "denied";
  }
}

export async function requestLocalDirectoryPermission(handle: LocalDirectoryHandle): Promise<LocalFolderPermission> {
  try {
    if (!handle.requestPermission) return "denied";
    return await handle.requestPermission({ mode: "read" });
  } catch {
    return "denied";
  }
}

export async function scanLocalDirectoryImages(handle: LocalDirectoryHandle): Promise<LocalFolderImage[]> {
  try {
    const images: LocalFolderImage[] = [];
    for await (const entry of handle.values()) {
      if (entry.kind !== "file") continue;
      const file = await entry.getFile();
      if (!isSupportedLocalFolderImage(file.name || entry.name, file.type)) continue;
      images.push({ id: entry.name, name: entry.name, file });
    }
    return images.sort((left, right) => NATURAL_NAME_ORDER.compare(left.name, right.name));
  } catch (error) {
    throw new Error("Could not scan the selected folder", { cause: error });
  }
}

export async function loadPersistedLocalDirectory(): Promise<PersistedDirectory | null> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDirectoryDb();
    return await readActiveDirectory(db);
  } catch (error) {
    throw new Error("Could not restore the local folder", { cause: error });
  } finally {
    db?.close();
  }
}

export async function persistLocalDirectory(handle: LocalDirectoryHandle): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDirectoryDb();
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({ key: ACTIVE_KEY, name: handle.name, handle } satisfies PersistedDirectory);
    await completeTransaction(transaction);
  } catch (error) {
    throw new Error("Could not remember the local folder", { cause: error });
  } finally {
    db?.close();
  }
}

export async function clearPersistedLocalDirectory(): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDirectoryDb();
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(ACTIVE_KEY);
    await completeTransaction(transaction);
  } catch (error) {
    throw new Error("Could not clear the local folder", { cause: error });
  } finally {
    db?.close();
  }
}
