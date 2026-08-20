import type {
  ChatMessage,
  CheckoutWorkspaceBranchRequest,
  CommitPushWorkspaceRequest,
  CreateThreadRequest,
  ListQueuedThreadInputsResponse,
  ListThreadsResponse,
  QueuedThreadInput,
  RenameThreadRequest,
  RewindThreadRequest,
  RunThreadRequest,
  RuntimePreferences,
  RuntimePreferencesResponse,
  StatusResponse,
  StreamThreadRunEvent,
  ThreadDetailResponse,
  ThreadSummary,
  UpdateThreadGoalRequest,
  VersionResponse,
} from "codex-relay/api-schema";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import {
  archiveThread,
  checkoutWorkspaceBranch,
  clearThreadGoal,
  commitPushWorkspace,
  createThread,
  getThreadGoal,
  getRateLimits,
  getStatus,
  getThread,
  getThreadContextWindow,
  getVersion,
  getWorkspaceChanges,
  listModels,
  listQueuedThreadInputs,
  listThreads,
  listWorkspaceDirectories,
  removeQueuedThreadInput,
  renameThread,
  rewindThread,
  steerQueuedThreadInput,
  submitThreadInput,
  updateThreadGoal,
  updateRuntimePreferences,
} from "@/lib/codex-relay-api";
import {
  cacheWorkspaceRuntimePreferences,
  cacheWorkspaceRuntimePreferencesFromStatus,
} from "@/lib/workspace-runtime-preferences-cache";
import {
  appendOptimisticSteeringMessageToDetail,
  mergeThreadDetailState,
  upsertMessage,
} from "./server-state-messages";
import { getActiveHostId, updatePairedHostConnection } from "@/state/paired-host-store";

const rootKey = "codex-relay";
const serverStateScope = "server-state";
const persistableServerStateScopes = new Set(["models", "status", "threads"]);

export const serverStateKeys = {
  all: (hostId = activeHostQueryId()) => [rootKey, hostId, serverStateScope] as const,
  contextWindow: (threadId: string, hostId = activeHostQueryId()) =>
    [...serverStateKeys.threadScope(threadId, hostId), "context-window"] as const,
  models: (hostId = activeHostQueryId()) => [...serverStateKeys.all(hostId), "models"] as const,
  queuedInputs: (threadId: string, hostId = activeHostQueryId()) =>
    [...serverStateKeys.threadScope(threadId, hostId), "queued-inputs"] as const,
  rateLimits: (hostId = activeHostQueryId()) =>
    [...serverStateKeys.all(hostId), "rate-limits"] as const,
  status: (hostId = activeHostQueryId()) => [...serverStateKeys.all(hostId), "status"] as const,
  thread: (threadId: string, hostId = activeHostQueryId()) =>
    [...serverStateKeys.threadScope(threadId, hostId), "detail"] as const,
  threadScope: (threadId: string, hostId = activeHostQueryId()) =>
    [...serverStateKeys.threads(hostId), threadId] as const,
  threads: (hostId = activeHostQueryId()) => [...serverStateKeys.all(hostId), "threads"] as const,
  version: (hostId = activeHostQueryId()) => [...serverStateKeys.all(hostId), "version"] as const,
  workspaceChanges: (workspacePath: string | undefined, hostId = activeHostQueryId()) =>
    [...serverStateKeys.all(hostId), "workspace-changes", workspacePath ?? null] as const,
  workspaceDirectories: (path: string | undefined, hostId = activeHostQueryId()) =>
    [...serverStateKeys.all(hostId), "workspace-directories", path ?? null] as const,
};

export function isPersistableServerStateQueryKey(queryKey: readonly unknown[]) {
  return (
    queryKey[0] === rootKey &&
    queryKey[2] === serverStateScope &&
    persistableServerStateScopes.has(String(queryKey[3] ?? ""))
  );
}

export function fetchStatusState(queryClient: QueryClient, hostId = activeHostQueryId()) {
  return queryClient.fetchQuery({
    queryKey: serverStateKeys.status(hostId),
    queryFn: () => getStatus(hostId),
  });
}

export function fetchThreadsState(queryClient: QueryClient, hostId = activeHostQueryId()) {
  return queryClient.fetchQuery({
    queryKey: serverStateKeys.threads(hostId),
    queryFn: () => listThreads(hostId),
  });
}

export function fetchModelsState(queryClient: QueryClient) {
  const hostId = activeHostQueryId();
  return queryClient.fetchQuery({
    queryKey: serverStateKeys.models(hostId),
    queryFn: () => listModels(hostId),
  });
}

export function fetchRateLimitsState(queryClient: QueryClient) {
  const hostId = activeHostQueryId();
  return queryClient.fetchQuery({
    queryKey: serverStateKeys.rateLimits(hostId),
    queryFn: () => getRateLimits(hostId),
  });
}

export async function fetchThreadState(
  queryClient: QueryClient,
  threadId: string,
  options: { refresh?: boolean } = {},
  hostId = activeHostQueryId(),
) {
  const response = options.refresh
    ? await getThread(threadId, { refresh: true }, hostId)
    : await queryClient.fetchQuery({
        queryKey: serverStateKeys.thread(threadId, hostId),
        queryFn: () => getThread(threadId, {}, hostId),
      });
  setThreadDetailState(
    queryClient,
    response.thread,
    response.messages,
    response.pendingInputRequests,
    { replaceMessages: options.refresh },
    hostId,
  );
  return response;
}

export function fetchQueuedInputsState(queryClient: QueryClient, threadId: string) {
  const hostId = activeHostQueryId();
  return queryClient.fetchQuery({
    queryKey: serverStateKeys.queuedInputs(threadId, hostId),
    queryFn: () => listQueuedThreadInputs(threadId, hostId),
  });
}

export function fetchContextWindowState(queryClient: QueryClient, threadId: string) {
  const hostId = activeHostQueryId();
  return queryClient.fetchQuery({
    queryKey: serverStateKeys.contextWindow(threadId, hostId),
    queryFn: () => getThreadContextWindow(threadId, hostId),
  });
}

export async function fetchThreadGoalState(queryClient: QueryClient, threadId: string) {
  const hostId = activeHostQueryId();
  const response = await getThreadGoal(threadId, hostId);
  upsertThreadState(queryClient, response.thread, hostId);
  return response;
}

export function fetchWorkspaceChangesState(
  queryClient: QueryClient,
  workspacePath: string | undefined,
  options: { staleTime?: number } = {},
) {
  const hostId = activeHostQueryId();
  return queryClient.fetchQuery({
    queryKey: serverStateKeys.workspaceChanges(workspacePath, hostId),
    queryFn: () => getWorkspaceChanges({ workspacePath }, hostId),
    staleTime: options.staleTime,
  });
}

export function fetchWorkspaceDirectoriesState(queryClient: QueryClient, path: string | undefined) {
  const hostId = activeHostQueryId();
  return queryClient.fetchQuery({
    queryKey: serverStateKeys.workspaceDirectories(path, hostId),
    queryFn: () => listWorkspaceDirectories(path, hostId),
  });
}

export const serverStateQueryFns = {
  contextWindow: ({ queryKey }: RelayQueryContext) =>
    getThreadContextWindow(String(queryKey[4] ?? ""), queryHostId(queryKey)),
  models: ({ queryKey }: RelayQueryContext) => listModels(queryHostId(queryKey)),
  queuedInputs: ({ queryKey }: RelayQueryContext) =>
    listQueuedThreadInputs(String(queryKey[4] ?? ""), queryHostId(queryKey)),
  rateLimits: ({ queryKey }: RelayQueryContext) => getRateLimits(queryHostId(queryKey)),
  status: ({ queryKey }: RelayQueryContext) => getStatus(queryHostId(queryKey)),
  thread: ({ queryKey }: RelayQueryContext) =>
    getThread(String(queryKey[4] ?? ""), {}, queryHostId(queryKey)),
  threads: ({ queryKey }: RelayQueryContext) => listThreads(queryHostId(queryKey)),
  version: ({ queryKey }: RelayQueryContext) => getVersion(queryHostId(queryKey)),
  workspaceChanges: ({ queryKey }: RelayQueryContext) =>
    getWorkspaceChanges(
      { workspacePath: typeof queryKey[4] === "string" ? queryKey[4] : undefined },
      queryHostId(queryKey),
    ),
  workspaceDirectories: ({ queryKey }: RelayQueryContext) =>
    listWorkspaceDirectories(
      typeof queryKey[4] === "string" ? queryKey[4] : undefined,
      queryHostId(queryKey),
    ),
};

type RelayQueryContext = { queryKey: readonly unknown[] };

function queryHostId(queryKey: readonly unknown[]) {
  return typeof queryKey[1] === "string" && queryKey[1] !== "__unpaired__"
    ? queryKey[1]
    : undefined;
}

export async function createThreadServerState(queryClient: QueryClient, body: CreateThreadRequest) {
  const hostId = activeHostQueryId();
  const response = await createThread(body);
  setThreadDetailState(queryClient, response.thread, response.messages, [], {}, hostId);
  return response;
}

export async function archiveThreadServerState(queryClient: QueryClient, threadId: string) {
  const hostId = activeHostQueryId();
  const response = await archiveThread(threadId);
  setThreadsState(queryClient, response.threads, response.source, hostId);
  removeThreadDetailState(queryClient, response.archivedThreadId, hostId);
  return response;
}

export async function renameThreadServerState(
  queryClient: QueryClient,
  threadId: string,
  body: RenameThreadRequest,
) {
  const hostId = activeHostQueryId();
  const response = await renameThread(threadId, body);
  upsertThreadState(queryClient, response.thread, hostId);
  return response;
}

export async function rewindThreadServerState(
  queryClient: QueryClient,
  threadId: string,
  body: RewindThreadRequest,
) {
  const hostId = activeHostQueryId();
  const response = await rewindThread(threadId, body);
  setThreadDetailState(
    queryClient,
    response.thread,
    response.messages,
    response.pendingInputRequests,
    { replaceMessages: true },
    hostId,
  );
  setQueuedInputsState(queryClient, threadId, [], undefined, hostId);
  return response;
}

export async function submitThreadInputServerState(
  queryClient: QueryClient,
  threadId: string,
  body: RunThreadRequest,
) {
  const hostId = activeHostQueryId();
  const response = await submitThreadInput(threadId, body);
  upsertThreadState(queryClient, response.thread, hostId);
  return response;
}

export async function removeQueuedThreadInputServerState(
  queryClient: QueryClient,
  threadId: string,
  inputId: string,
) {
  const hostId = activeHostQueryId();
  const response = await removeQueuedThreadInput(threadId, inputId);
  upsertThreadState(queryClient, response.thread, hostId);
  removeQueuedInputState(queryClient, threadId, inputId, hostId);
  return response;
}

export async function steerQueuedThreadInputServerState(
  queryClient: QueryClient,
  threadId: string,
  inputId: string,
) {
  const hostId = activeHostQueryId();
  const response = await steerQueuedThreadInput(threadId, inputId);
  upsertThreadState(queryClient, response.thread, hostId);
  removeQueuedInputState(queryClient, threadId, inputId, hostId);
  return response;
}

export async function checkoutWorkspaceBranchServerState(
  queryClient: QueryClient,
  body: CheckoutWorkspaceBranchRequest,
) {
  const hostId = activeHostQueryId();
  const response = await checkoutWorkspaceBranch(body);
  await queryClient.invalidateQueries({
    queryKey: serverStateKeys.workspaceChanges(body.workspacePath, hostId),
  });
  return response;
}

export async function commitPushWorkspaceServerState(
  queryClient: QueryClient,
  body: CommitPushWorkspaceRequest,
) {
  const hostId = activeHostQueryId();
  const response = await commitPushWorkspace(body);
  await queryClient.invalidateQueries({
    queryKey: serverStateKeys.workspaceChanges(body.workspacePath, hostId),
  });
  return response;
}

export function updateRuntimePreferencesServerState(
  body: Parameters<typeof updateRuntimePreferences>[0],
  hostId = activeHostQueryId(),
) {
  return updateRuntimePreferences(body, hostId);
}

export async function updateThreadGoalServerState(
  queryClient: QueryClient,
  threadId: string,
  body: UpdateThreadGoalRequest,
) {
  const hostId = activeHostQueryId();
  const response = await updateThreadGoal(threadId, body, hostId);
  upsertThreadState(queryClient, response.thread, hostId);
  return response;
}

export async function clearThreadGoalServerState(queryClient: QueryClient, threadId: string) {
  const hostId = activeHostQueryId();
  const response = await clearThreadGoal(threadId, hostId);
  upsertThreadState(queryClient, response.thread, hostId);
  return response;
}

export function clearServerState(queryClient: QueryClient, hostId = activeHostQueryId()) {
  queryClient.removeQueries({ queryKey: [rootKey, hostId] });
}

export function setStatusState(
  queryClient: QueryClient,
  status: StatusResponse,
  hostId = activeHostQueryId(),
) {
  if (hostId !== "__unpaired__") {
    updatePairedHostConnection(hostId, {
      machineName: status.machineName,
      relayId: status.relayId,
    });
  }
  cacheWorkspaceRuntimePreferencesFromStatus(hostId, status);
  queryClient.setQueryData(serverStateKeys.status(hostId), status);
}

function activeHostQueryId() {
  return getActiveHostId() ?? "__unpaired__";
}

export function setVersionState(queryClient: QueryClient, version: VersionResponse) {
  queryClient.setQueryData(serverStateKeys.version(), version);
}

export function setRuntimePreferencesState(
  queryClient: QueryClient,
  preferences: RuntimePreferences,
) {
  queryClient.setQueryData<StatusResponse>(serverStateKeys.status(), (current) =>
    current ? { ...current, preferences } : current,
  );
}

export function setRuntimePreferencesResponseState(
  queryClient: QueryClient,
  response: RuntimePreferencesResponse,
  hostId = activeHostQueryId(),
) {
  const workspacePreferences = response.workspacePath
    ? response.runtimePreferencesByWorkspacePath[response.workspacePath]
    : undefined;
  if (response.workspacePath && workspacePreferences) {
    cacheWorkspaceRuntimePreferences(hostId, response.workspacePath, workspacePreferences);
    setWorkspaceRuntimePreferencesState(
      queryClient,
      response.workspacePath,
      workspacePreferences,
      hostId,
    );
  }
  queryClient.setQueryData<StatusResponse>(serverStateKeys.status(hostId), (current) => {
    if (!current) {
      return current;
    }
    const responseMatchesCurrentWorkspace =
      !response.workspacePath || response.workspacePath === current.workspacePath;
    const nextPreferences = responseMatchesCurrentWorkspace
      ? response.preferences
      : response.workspacePath === current.workspacePath && workspacePreferences
        ? workspacePreferences
        : current.preferences;
    return {
      ...current,
      preferences: nextPreferences,
      runtimePreferencesByWorkspacePath: response.runtimePreferencesByWorkspacePath,
      workspacePath: response.workspacePath ?? current.workspacePath,
    };
  });
}

export function setWorkspaceRuntimePreferencesState(
  queryClient: QueryClient,
  workspacePath: string,
  preferences: RuntimePreferences,
  hostId = activeHostQueryId(),
) {
  cacheWorkspaceRuntimePreferences(hostId, workspacePath, preferences);
  queryClient.setQueryData<StatusResponse>(serverStateKeys.status(hostId), (current) =>
    current
      ? {
          ...current,
          preferences: workspacePath === current.workspacePath ? preferences : current.preferences,
          runtimePreferencesByWorkspacePath: {
            ...current.runtimePreferencesByWorkspacePath,
            [workspacePath]: preferences,
          },
        }
      : current,
  );
}

export function setThreadRunningState(
  queryClient: QueryClient,
  threadId: string | undefined,
  isRunning: boolean,
  hostId = activeHostQueryId(),
) {
  if (!threadId) {
    return;
  }
  patchThreadState(
    queryClient,
    threadId,
    {
      state: isRunning ? "running" : "completed",
      updatedAt: new Date().toISOString(),
    },
    hostId,
  );
}

export function setThreadsState(
  queryClient: QueryClient,
  threads: ThreadSummary[],
  source: ListThreadsResponse["source"] = "memory",
  hostId = activeHostQueryId(),
) {
  queryClient.setQueryData<ListThreadsResponse>(serverStateKeys.threads(hostId), {
    source,
    threads: sortThreads(threads),
  });
}

export function upsertThreadState(
  queryClient: QueryClient,
  thread: ThreadSummary,
  hostId = activeHostQueryId(),
) {
  queryClient.setQueryData<ListThreadsResponse>(serverStateKeys.threads(hostId), (current) => {
    const threads = current?.threads ?? [];
    return {
      source: current?.source ?? "memory",
      threads: sortThreads(upsertById(threads, thread)),
    };
  });
  queryClient.setQueryData<ThreadDetailResponse>(
    serverStateKeys.thread(thread.id, hostId),
    (current) => (current ? { ...current, thread } : current),
  );
}

export function setThreadDetailState(
  queryClient: QueryClient,
  thread: ThreadSummary,
  messages: ChatMessage[],
  pendingInputRequests: ThreadDetailResponse["pendingInputRequests"] = [],
  options: { replaceMessages?: boolean } = {},
  hostId = activeHostQueryId(),
) {
  upsertThreadState(queryClient, thread, hostId);
  const response: ThreadDetailResponse = {
    thread,
    messages,
    pendingInputRequests,
  };
  queryClient.setQueryData<ThreadDetailResponse>(
    serverStateKeys.thread(thread.id, hostId),
    (current) => (options.replaceMessages ? response : mergeThreadDetailState(current, response)),
  );
}

export function removeThreadDetailState(
  queryClient: QueryClient,
  threadId: string,
  hostId = activeHostQueryId(),
) {
  queryClient.removeQueries({ queryKey: serverStateKeys.threadScope(threadId, hostId) });
}

export type OptimisticArchiveThreadSnapshot = {
  hostId: string;
  threadScopeQueries: [QueryKey, unknown][];
  threads?: ListThreadsResponse;
};

export async function optimisticallyArchiveThreadState(
  queryClient: QueryClient,
  threadId: string,
): Promise<OptimisticArchiveThreadSnapshot> {
  const hostId = activeHostQueryId();
  await Promise.all([
    queryClient.cancelQueries({ queryKey: serverStateKeys.threads(hostId) }),
    queryClient.cancelQueries({ queryKey: serverStateKeys.threadScope(threadId, hostId) }),
  ]);
  const snapshot: OptimisticArchiveThreadSnapshot = {
    hostId,
    threadScopeQueries: queryClient.getQueriesData({
      queryKey: serverStateKeys.threadScope(threadId, hostId),
    }),
    threads: queryClient.getQueryData<ListThreadsResponse>(serverStateKeys.threads(hostId)),
  };
  queryClient.setQueryData<ListThreadsResponse>(serverStateKeys.threads(hostId), (current) =>
    current
      ? {
          ...current,
          threads: current.threads.filter((thread) => thread.id !== threadId),
        }
      : current,
  );
  removeThreadDetailState(queryClient, threadId, hostId);
  return snapshot;
}

export function restoreOptimisticArchiveThreadState(
  queryClient: QueryClient,
  snapshot: OptimisticArchiveThreadSnapshot | undefined,
) {
  if (!snapshot) {
    return;
  }
  if (snapshot.threads) {
    queryClient.setQueryData(serverStateKeys.threads(snapshot.hostId), snapshot.threads);
  }
  for (const [queryKey, data] of snapshot.threadScopeQueries) {
    queryClient.setQueryData(queryKey, data);
  }
}

export function setQueuedInputsState(
  queryClient: QueryClient,
  threadId: string,
  inputs: QueuedThreadInput[],
  queueLength = inputs.length,
  hostId = activeHostQueryId(),
) {
  queryClient.setQueryData<ListQueuedThreadInputsResponse>(
    serverStateKeys.queuedInputs(threadId, hostId),
    {
      inputs,
      queueLength,
    },
  );
}

export function markMessageApprovalResolvedState(
  queryClient: QueryClient,
  threadId: string,
  messageId: string,
  decision: string,
  hostId = activeHostQueryId(),
) {
  queryClient.setQueryData<ThreadDetailResponse>(
    serverStateKeys.thread(threadId, hostId),
    (current) =>
      current
        ? {
            ...current,
            messages: current.messages.map((message) =>
              message.id === messageId
                ? {
                    ...message,
                    details: {
                      ...message.details,
                      approvalDecision: decision,
                      approvalResolved: true,
                    },
                    updatedAt: new Date().toISOString(),
                  }
                : message,
            ),
          }
        : current,
  );
}

export function removeQueuedInputState(
  queryClient: QueryClient,
  threadId: string,
  inputId: string,
  hostId = activeHostQueryId(),
) {
  queryClient.setQueryData<ListQueuedThreadInputsResponse>(
    serverStateKeys.queuedInputs(threadId, hostId),
    (current) => {
      if (!current) {
        return current;
      }
      const inputs = current.inputs.filter((input) => input.id !== inputId);
      return {
        inputs,
        queueLength:
          inputs.length === current.inputs.length
            ? current.queueLength
            : Math.max(0, current.queueLength - 1),
      };
    },
  );
}

export type OptimisticSteerQueuedInputSnapshot = {
  hostId: string;
  hadThreadDetail: boolean;
  queuedInputs?: ListQueuedThreadInputsResponse;
  threadDetail?: ThreadDetailResponse;
  threads?: ListThreadsResponse;
};

export async function optimisticallySteerQueuedInputState(
  queryClient: QueryClient,
  threadId: string,
  input: QueuedThreadInput,
): Promise<OptimisticSteerQueuedInputSnapshot> {
  const hostId = activeHostQueryId();
  await Promise.all([
    queryClient.cancelQueries({ queryKey: serverStateKeys.queuedInputs(threadId, hostId) }),
    queryClient.cancelQueries({ queryKey: serverStateKeys.thread(threadId, hostId) }),
  ]);
  const snapshot: OptimisticSteerQueuedInputSnapshot = {
    hostId,
    hadThreadDetail: queryClient.getQueryData<ThreadDetailResponse>(
      serverStateKeys.thread(threadId, hostId),
    )
      ? true
      : false,
    queuedInputs: queryClient.getQueryData<ListQueuedThreadInputsResponse>(
      serverStateKeys.queuedInputs(threadId, hostId),
    ),
    threadDetail: queryClient.getQueryData<ThreadDetailResponse>(
      serverStateKeys.thread(threadId, hostId),
    ),
    threads: queryClient.getQueryData<ListThreadsResponse>(serverStateKeys.threads(hostId)),
  };
  removeQueuedInputState(queryClient, threadId, input.id, hostId);
  appendOptimisticSteeringMessageState(queryClient, threadId, input, hostId);
  setThreadRunningState(queryClient, threadId, true, hostId);
  return snapshot;
}

export function restoreOptimisticSteerQueuedInputState(
  queryClient: QueryClient,
  threadId: string,
  snapshot: OptimisticSteerQueuedInputSnapshot | undefined,
) {
  if (!snapshot) {
    return;
  }
  const hostId = snapshot.hostId;
  if (snapshot.queuedInputs) {
    queryClient.setQueryData(serverStateKeys.queuedInputs(threadId, hostId), snapshot.queuedInputs);
  }
  if (snapshot.threadDetail) {
    queryClient.setQueryData(serverStateKeys.thread(threadId, hostId), snapshot.threadDetail);
  } else if (!snapshot.hadThreadDetail) {
    queryClient.removeQueries({ queryKey: serverStateKeys.thread(threadId, hostId) });
  }
  if (snapshot.threads) {
    queryClient.setQueryData(serverStateKeys.threads(hostId), snapshot.threads);
  }
}

export function applyStreamEventToServerState(
  queryClient: QueryClient,
  event: StreamThreadRunEvent,
  hostId = activeHostQueryId(),
) {
  switch (event.type) {
    case "thread.message.created":
      upsertThreadState(queryClient, event.thread, hostId);
      upsertMessageState(queryClient, event.thread, event.message, hostId);
      return;
    case "thread.message.delta":
      appendMessageDeltaState(queryClient, event.threadId, event.messageId, event.delta, hostId);
      return;
    case "thread.message.completed":
      upsertThreadState(queryClient, event.thread, hostId);
      upsertMessageState(queryClient, event.thread, event.message, hostId);
      return;
    case "thread.state.changed":
      upsertThreadState(queryClient, event.thread, hostId);
      return;
    case "thread.goal.updated":
      upsertThreadState(queryClient, event.thread, hostId);
      return;
    case "thread.error":
      if (event.thread) {
        upsertThreadState(queryClient, event.thread, hostId);
      }
      return;
    case "thread.preview_target.detected":
      return;
    case "thread.input_request.created":
      upsertThreadState(queryClient, event.thread, hostId);
      upsertPendingInputRequestState(queryClient, event.request, hostId);
      return;
    case "thread.input_request.resolved":
      removePendingInputRequestState(queryClient, event.threadId, event.requestId, hostId);
      return;
  }
}

export function removePendingInputRequestState(
  queryClient: QueryClient,
  threadId: string,
  requestId: string,
  hostId = activeHostQueryId(),
) {
  queryClient.setQueryData<ThreadDetailResponse>(
    serverStateKeys.thread(threadId, hostId),
    (current) =>
      current
        ? {
            ...current,
            pendingInputRequests: (current.pendingInputRequests ?? []).filter(
              (request) => request.id !== requestId,
            ),
          }
        : current,
  );
}

function upsertPendingInputRequestState(
  queryClient: QueryClient,
  request: NonNullable<ThreadDetailResponse["pendingInputRequests"]>[number],
  hostId = activeHostQueryId(),
) {
  queryClient.setQueryData<ThreadDetailResponse>(
    serverStateKeys.thread(request.threadId, hostId),
    (current) =>
      current
        ? {
            ...current,
            pendingInputRequests: upsertById(current.pendingInputRequests ?? [], request),
          }
        : current,
  );
}

function upsertMessageState(
  queryClient: QueryClient,
  thread: ThreadSummary,
  message: ChatMessage,
  hostId = activeHostQueryId(),
) {
  queryClient.setQueryData<ThreadDetailResponse>(
    serverStateKeys.thread(thread.id, hostId),
    (current) => ({
      thread,
      messages: upsertMessage(current?.messages ?? [], message),
      pendingInputRequests: current?.pendingInputRequests ?? [],
    }),
  );
}

function appendOptimisticSteeringMessageState(
  queryClient: QueryClient,
  threadId: string,
  input: QueuedThreadInput,
  hostId = activeHostQueryId(),
) {
  queryClient.setQueryData<ThreadDetailResponse>(
    serverStateKeys.thread(threadId, hostId),
    (current) => {
      return appendOptimisticSteeringMessageToDetail(current, {
        input,
        nowIso: new Date().toISOString(),
        thread: optimisticSteeringThread(queryClient, threadId, hostId),
        threadId,
      });
    },
  );
}

function optimisticSteeringThread(
  queryClient: QueryClient,
  threadId: string,
  hostId = activeHostQueryId(),
) {
  const detailThread = queryClient.getQueryData<ThreadDetailResponse>(
    serverStateKeys.thread(threadId, hostId),
  )?.thread;
  return (
    detailThread ??
    queryClient
      .getQueryData<ListThreadsResponse>(serverStateKeys.threads(hostId))
      ?.threads.find((thread) => thread.id === threadId)
  );
}

function appendMessageDeltaState(
  queryClient: QueryClient,
  threadId: string,
  messageId: string,
  delta: string,
  hostId = activeHostQueryId(),
) {
  queryClient.setQueryData<ThreadDetailResponse>(
    serverStateKeys.thread(threadId, hostId),
    (current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        messages: current.messages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                content: `${message.content}${normalizeStreamDelta(message.content, delta)}`,
                state: "streaming",
                updatedAt: new Date().toISOString(),
              }
            : message,
        ),
      };
    },
  );
}

function normalizeStreamDelta(existingContent: string, incomingDelta: string) {
  if (!existingContent || !incomingDelta.startsWith(existingContent)) {
    return incomingDelta;
  }
  return incomingDelta.slice(existingContent.length);
}

function patchThreadState(
  queryClient: QueryClient,
  threadId: string,
  patch: Partial<ThreadSummary>,
  hostId = activeHostQueryId(),
) {
  queryClient.setQueryData<ListThreadsResponse>(serverStateKeys.threads(hostId), (current) =>
    current
      ? {
          ...current,
          threads: sortThreads(
            current.threads.map((thread) =>
              thread.id === threadId ? { ...thread, ...patch } : thread,
            ),
          ),
        }
      : current,
  );
  queryClient.setQueryData<ThreadDetailResponse>(
    serverStateKeys.thread(threadId, hostId),
    (current) =>
      current
        ? {
            ...current,
            thread: {
              ...current.thread,
              ...patch,
            },
          }
        : current,
  );
}

function upsertById<T extends { id: string }>(items: T[], item: T) {
  const existingIndex = items.findIndex((candidate) => candidate.id === item.id);
  if (existingIndex === -1) {
    return [...items, item];
  }
  return items.map((candidate) => (candidate.id === item.id ? item : candidate));
}

function sortThreads(threads: ThreadSummary[]) {
  return threads.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
