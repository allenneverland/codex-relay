import { useSelector } from "@legendapp/state/react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostSyncEvent } from "codex-relay/api-schema";
import { useEffect, useState } from "react";
import { AppState } from "react-native";

import { streamHostSync } from "@/lib/codex-relay-api";
import { fetchThreadState, fetchThreadsState, setThreadsState } from "@/lib/server-state";
import { chatStore$, setActiveThread } from "@/state/chat-store";
import { getActiveHostId, hasPairedHostSession, pairedHostStore$ } from "@/state/paired-host-store";

const hostSyncCoalescingWindowMs = 200;
const hostSyncReconnectDelaysMs = [1_000, 2_000, 5_000, 10_000] as const;

type HostSyncBatch = {
  refreshAll: boolean;
  threadIds: Set<string>;
};

export function ActiveHostSyncCoordinator() {
  const queryClient = useQueryClient();
  const activeHostId = useSelector(() => {
    const hostId = pairedHostStore$.activeHostId.get();
    return hostId && pairedHostStore$.hostsById[hostId].get() ? hostId : undefined;
  });
  const [isForeground, setIsForeground] = useState(AppState.currentState === "active");

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setIsForeground(state === "active");
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!activeHostId || !isForeground || !hasPairedHostSession(activeHostId)) {
      return;
    }

    const hostId = activeHostId;
    let stopped = false;
    let closeStream: (() => void) | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempt = 0;
    let refreshTail = Promise.resolve();
    let pendingBatch: HostSyncBatch = {
      refreshAll: false,
      threadIds: new Set(),
    };

    const refreshBatch = async (batch: HostSyncBatch) => {
      const activeThreadId = chatStore$.activeThreadId.peek();
      const shouldRefreshActiveThread = Boolean(
        activeThreadId && (batch.refreshAll || batch.threadIds.has(activeThreadId)),
      );
      const activeThreadRefresh =
        activeThreadId && shouldRefreshActiveThread
          ? fetchThreadState(queryClient, activeThreadId, { refresh: true }, hostId).catch(
              () => undefined,
            )
          : Promise.resolve(undefined);

      const threadsResponse = await fetchThreadsState(queryClient, hostId);
      setThreadsState(queryClient, threadsResponse.threads, threadsResponse.source, hostId);
      await activeThreadRefresh;

      if (stopped || getActiveHostId() !== hostId) {
        return;
      }
      const currentActiveThreadId = chatStore$.activeThreadId.peek();
      if (
        currentActiveThreadId &&
        !threadsResponse.threads.some((thread) => thread.id === currentActiveThreadId)
      ) {
        setActiveThread(threadsResponse.threads[0]?.id);
      }
    };

    const flush = () => {
      flushTimer = undefined;
      const batch = pendingBatch;
      pendingBatch = { refreshAll: false, threadIds: new Set() };
      refreshTail = refreshTail.then(() => refreshBatch(batch)).catch(() => undefined);
    };

    const enqueue = (event: HostSyncEvent) => {
      reconnectAttempt = 0;
      if (event.type === "sync.required") {
        pendingBatch.refreshAll = true;
      } else {
        pendingBatch.threadIds.add(event.threadId);
      }
      if (!flushTimer) {
        flushTimer = setTimeout(flush, hostSyncCoalescingWindowMs);
      }
    };

    const scheduleReconnect = () => {
      if (stopped || reconnectTimer) {
        return;
      }
      const delay =
        hostSyncReconnectDelaysMs[Math.min(reconnectAttempt, hostSyncReconnectDelaysMs.length - 1)];
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };

    const connect = () => {
      if (stopped) {
        return;
      }
      closeStream?.();
      closeStream = undefined;
      try {
        closeStream = streamHostSync(hostId, {
          onError() {
            closeStream?.();
            closeStream = undefined;
            scheduleReconnect();
          },
          onEvent: enqueue,
        });
      } catch {
        scheduleReconnect();
      }
    };

    connect();
    return () => {
      stopped = true;
      closeStream?.();
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
    };
  }, [activeHostId, isForeground, queryClient]);

  return null;
}
