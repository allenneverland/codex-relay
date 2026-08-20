import { getActiveHostId } from "@/state/paired-host-store";

export const workspaceFileContentQueryKey = (
  workspacePath: string | undefined,
  path: string | null,
  hostId = getActiveHostId(),
) =>
  [
    "codex-relay",
    hostId ?? "__unpaired__",
    "workspace-preview-file",
    workspacePath ?? null,
    path,
  ] as const;

export const workspaceFilesQueryKeyPrefix = (
  workspacePath: string | undefined,
  hostId = getActiveHostId(),
) =>
  [
    "codex-relay",
    hostId ?? "__unpaired__",
    "workspace-preview-files",
    workspacePath ?? null,
  ] as const;

export function relayHostIdFromQueryKey(queryKey: readonly unknown[]) {
  return typeof queryKey[1] === "string" && queryKey[1] !== "__unpaired__"
    ? queryKey[1]
    : undefined;
}
