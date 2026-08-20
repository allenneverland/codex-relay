import {
  RuntimePreferencesSchema,
  type RuntimePreferences,
  type StatusResponse,
} from "codex-relay/api-schema";
import { createMMKV } from "react-native-mmkv";

const storage = createMMKV({ id: "codex-relay-workspace-runtime-preferences" });

export function readCachedWorkspaceRuntimePreferences(
  serverUrl: string,
  workspacePath: string | undefined,
): RuntimePreferences | undefined {
  if (!workspacePath) {
    return undefined;
  }

  const raw = storage.getString(cacheKey(serverUrl, workspacePath));
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = RuntimePreferencesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function cacheWorkspaceRuntimePreferences(
  serverUrl: string,
  workspacePath: string | undefined,
  preferences: RuntimePreferences,
) {
  if (!workspacePath) {
    return;
  }

  storage.set(
    cacheKey(serverUrl, workspacePath),
    JSON.stringify(RuntimePreferencesSchema.parse(preferences)),
  );
}

export function cacheWorkspaceRuntimePreferencesFromStatus(
  serverUrl: string,
  status: StatusResponse,
) {
  cacheWorkspaceRuntimePreferences(serverUrl, status.workspacePath, status.preferences);
  for (const [workspacePath, preferences] of Object.entries(
    status.runtimePreferencesByWorkspacePath ?? {},
  )) {
    cacheWorkspaceRuntimePreferences(serverUrl, workspacePath, preferences);
  }
}

export function removeCachedWorkspaceRuntimePreferencesForHost(hostId: string) {
  const prefix = `${normalizeServerUrl(hostId)}::`;
  for (const key of storage.getAllKeys()) {
    if (key.startsWith(prefix)) {
      storage.remove(key);
    }
  }
}

function cacheKey(serverUrl: string, workspacePath: string) {
  return `${normalizeServerUrl(serverUrl)}::${workspacePath}`;
}

function normalizeServerUrl(serverUrl: string) {
  return serverUrl.trim().replace(/\/$/, "");
}
