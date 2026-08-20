import { observable } from "@legendapp/state";

import { getActiveHostId } from "./paired-host-store";
import { persistLocalObservable } from "./persistence";

type PinnedThreadState = {
  threadIds?: string[];
  threadIdsByHostId: Record<string, string[]>;
};

const legacyPinnedHostId = getActiveHostId();

export const pinnedThreadStore$ = observable<PinnedThreadState>({
  threadIds: [],
  threadIdsByHostId: {},
});

persistLocalObservable(pinnedThreadStore$, "pinned-threads");
migrateLegacyPinnedThreadState();

export function getPinnedThreadIds(hostId = getActiveHostId()): readonly string[] {
  return [...pinnedThreadIdsForHost(hostId)];
}

export function pinThread(threadId: string, hostId = getActiveHostId()) {
  const storageId = hostStorageId(hostId);
  pinnedThreadStore$.threadIdsByHostId[storageId].set((current = legacyPinnedThreadIds(hostId)) => {
    if (current.includes(threadId)) {
      return current;
    }

    return [threadId, ...current];
  });
}

export function unpinThread(threadId: string, hostId = getActiveHostId()) {
  const storageId = hostStorageId(hostId);
  pinnedThreadStore$.threadIdsByHostId[storageId].set((current = legacyPinnedThreadIds(hostId)) => {
    if (!current.includes(threadId)) {
      return current;
    }

    return current.filter((candidate) => candidate !== threadId);
  });
}

export function togglePinnedThread(threadId: string) {
  if (pinnedThreadIdsForActiveHost().includes(threadId)) {
    unpinThread(threadId);
    return;
  }

  pinThread(threadId);
}

export function resetPinnedThreadState() {
  pinnedThreadStore$.set({ threadIds: [], threadIdsByHostId: {} });
}

export function removePinnedThreadHostState(hostId: string) {
  pinnedThreadStore$.threadIdsByHostId.set((current) => {
    const { [hostId]: _removed, ...rest } = current;
    return rest;
  });
  if (hostId === legacyPinnedHostId) {
    pinnedThreadStore$.threadIds.set([]);
  }
}

export function pinnedThreadIdsForActiveHost() {
  return pinnedThreadIdsForHost(getActiveHostId());
}

function pinnedThreadIdsForHost(hostId: string | undefined) {
  const hostIds = pinnedThreadStore$.threadIdsByHostId[hostStorageId(hostId)].peek();
  return hostIds ?? legacyPinnedThreadIds(hostId);
}

function legacyPinnedThreadIds(hostId: string | undefined) {
  return hostId === legacyPinnedHostId ? (pinnedThreadStore$.threadIds.peek() ?? []) : [];
}

function hostStorageId(hostId: string | undefined) {
  return hostId ?? "__unpaired__";
}

function migrateLegacyPinnedThreadState() {
  const threadIds = pinnedThreadStore$.threadIds.peek() ?? [];
  if (!legacyPinnedHostId || threadIds.length === 0) {
    return;
  }
  if (!pinnedThreadStore$.threadIdsByHostId[legacyPinnedHostId].peek()) {
    pinnedThreadStore$.threadIdsByHostId[legacyPinnedHostId].set(threadIds);
  }
  pinnedThreadStore$.threadIds.set([]);
}
