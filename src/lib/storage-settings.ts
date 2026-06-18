export type StorageDestination = 'local' | 'server' | 'both';

export interface StorageSettings {
  destination: StorageDestination;
  /** Subfolder under the browser's Downloads directory for local saves. */
  subfolder: string;
  serverUrl: string;
  username: string;
  password: string;
}

export const STORAGE_SETTINGS_KEY = 'storageSettings';
export const DEFAULT_STORAGE_SETTINGS: StorageSettings = {
  destination: 'local',
  subfolder: '',
  serverUrl: '',
  username: '',
  password: '',
};

export async function loadStorageSettings(): Promise<StorageSettings> {
  await restrictStorageSettingsAccess();
  const stored = await chrome.storage.local.get(STORAGE_SETTINGS_KEY);
  return normalizeStorageSettings(stored[STORAGE_SETTINGS_KEY]);
}

export async function saveStorageSettings(settings: StorageSettings): Promise<void> {
  await restrictStorageSettingsAccess();
  await chrome.storage.local.set({
    [STORAGE_SETTINGS_KEY]: normalizeStorageSettings(settings),
  });
}

export function normalizeStorageSettings(value: unknown): StorageSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_STORAGE_SETTINGS };
  const candidate = value as Omit<Partial<StorageSettings>, 'destination'> & {
    destination?: unknown;
  };
  const destination =
    candidate.destination === 'both'
      ? 'both'
      : candidate.destination === 'server'
        ? 'server'
      : 'local';
  return {
    destination,
    subfolder: sanitizeSubfolder(candidate.subfolder),
    serverUrl: typeof candidate.serverUrl === 'string' ? candidate.serverUrl.trim() : '',
    username: typeof candidate.username === 'string' ? candidate.username.trim() : '',
    password: typeof candidate.password === 'string' ? candidate.password : '',
  };
}

/**
 * Keep a Downloads-relative subfolder: drop leading/trailing slashes and any
 * '.'/'..' segments. chrome.downloads rejects absolute paths and back-refs.
 */
export function sanitizeSubfolder(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');
}

/** Prepend the configured subfolder to a Downloads-relative filename. */
export function localDownloadPath(subfolder: string, filename: string): string {
  return subfolder ? `${subfolder}/${filename}` : filename;
}

let accessRestriction: Promise<void> | undefined;

export function restrictStorageSettingsAccess(): Promise<void> {
  accessRestriction ??= chrome.storage.local.setAccessLevel({
    accessLevel: 'TRUSTED_CONTEXTS',
  });
  return accessRestriction;
}
