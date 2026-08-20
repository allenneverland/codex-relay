import "react-native-get-random-values";

import {
  ArchiveThreadResponseSchema,
  CheckoutWorkspaceBranchRequestSchema,
  CommitPushWorkspaceRequestSchema,
  CreateThreadResponseSchema,
  InterruptThreadRunResponseSchema,
  ImageAttachmentUploadResponseSchema,
  ListModelsResponseSchema,
  ListQueuedThreadInputsResponseSchema,
  ListSkillsResponseSchema,
  ListThreadsResponseSchema,
  ListWorkspaceFilesResponseSchema,
  ListWorkspaceDirectoriesResponseSchema,
  PairResponseSchema,
  PushNotificationSettingsResponseSchema,
  PushNotificationTestResponseSchema,
  QueuedThreadInputActionResponseSchema,
  RateLimitsResponseSchema,
  RenameThreadRequestSchema,
  RenameThreadResponseSchema,
  ResolveApprovalResponseSchema,
  RewindThreadRequestSchema,
  RuntimePreferencesResponseSchema,
  RunThreadResponseSchema,
  StatusResponseSchema,
  SubmitThreadInputResponseSchema,
  ThreadContextWindowResponseSchema,
  ThreadDetailResponseSchema,
  ThreadGoalResponseSchema,
  ThreadMessageDetailResponseSchema,
  RegisterPushNotificationRequestSchema,
  UpdateThreadGoalRequestSchema,
  UpdateWorkspaceFileContentRequestSchema,
  UpdateRuntimePreferencesRequestSchema,
  VersionResponseSchema,
  WorkspaceFileContentResponseSchema,
  WorkspaceChangesResponseSchema,
  WorkspaceGitActionResponseSchema,
  WorkspaceTailscaleServeRequestSchema,
  WorkspaceTailscaleServeResponseSchema,
  WorkspaceTerminalOutputResponseSchema,
  WorkspaceTerminalSessionResponseSchema,
  apiPaths,
  relayIdFromServerPublicKey,
  type ArchiveThreadResponse,
  type CheckoutWorkspaceBranchRequest,
  type CommitPushWorkspaceRequest,
  type CreateThreadRequest,
  type CreateThreadResponse,
  type ImageAttachmentUploadResponse,
  type ListModelsResponse,
  type ListQueuedThreadInputsResponse,
  type ListSkillsResponse,
  type ListThreadsResponse,
  type ListWorkspaceFilesResponse,
  type ListWorkspaceDirectoriesResponse,
  type PushNotificationSettingsResponse,
  type PushNotificationTestResponse,
  type QueuedThreadInputActionResponse,
  type RateLimitsResponse,
  type RenameThreadRequest,
  type RenameThreadResponse,
  type ResolveApprovalRequest,
  type ResolveApprovalResponse,
  type RewindThreadRequest,
  type RuntimePreferencesResponse,
  type RegisterPushNotificationRequest,
  type RunThreadRequest,
  type RunThreadResponse,
  type StatusResponse,
  type StreamThreadRunRequest,
  type StreamThreadRunEvent,
  type SubmitThreadInputResponse,
  type ThreadContextWindowResponse,
  type ThreadDetailResponse,
  type ThreadGoalResponse,
  type ThreadMessageDetailField,
  type ThreadMessageDetailResponse,
  type UpdateThreadGoalRequest,
  type UpdateWorkspaceFileContentRequest,
  type UpdateRuntimePreferencesRequest,
  type VersionResponse,
  type WorkspaceFileContentResponse,
  type WorkspaceChangesResponse,
  type WorkspaceGitActionResponse,
  type WorkspaceSelectionRequest,
  type WorkspaceTailscaleServeRequest,
  type WorkspaceTailscaleServeResponse,
  type WorkspaceTerminalOutputResponse,
  type WorkspaceTerminalSessionResponse,
} from "codex-relay/api-schema";
import { Platform } from "react-native";
import { dfetch, dfetchStream } from "react-native-direct-fetch";
import { fetch as nitroFetch } from "react-native-nitro-fetch";
import EventSource from "react-native-sse";
import {
  attachApprovalCode,
  clearSecureSession,
  completeSecurePairing,
  createSecurePairingAttempt,
  decryptResponsePayload,
  encryptRequestPayload,
  persistSecureSession,
} from "./secure-transport";
import { startPairingTrialIfNeeded } from "./pairing-trial";
import {
  createThreadRunSseDispatcher,
  parseThreadRunStreamPayload,
  threadRunStreamEventTypes,
} from "./thread-run-stream";
import { requestWithNetworkTimeout, withTimeout } from "./network-timeout";
import {
  codexRelayStorage as storage,
  dedupeServerUrls,
  fallbackCodexRelayServerUrl,
  getCodexRelayServerUrl,
  getCodexRelayServerUrlCandidates,
  isCarrierGradePrivateIPv4Host,
  isLocalIPv6Host,
  isPrivateIPv4Host,
  normalizeServerUrl,
  setCodexRelayServerUrl,
  type CodexRelayServerUrlCandidate,
} from "./codex-relay-server-url-storage";
import {
  getActiveHostId,
  getHostClientToken,
  getPairedHost,
  hasPairedHostSession,
  markPairedHostRequiresRepair,
  removePairedHostRecord,
  upsertPairedHost,
} from "@/state/paired-host-store";

const skillsPath = "/v1/skills";
const skillsRequestTimeoutMs = 8000;
const clientSessionIdStorageKey = "codex-relay.client-session-id";
const pairingConnectTimeoutMs = 2500;
const streamRequestTimeoutMs = 10 * 60 * 1000;
const terminalStreamRequestTimeoutMs = 24 * 60 * 60 * 1000;

type NetworkRequestInit = RequestInit & {
  timeoutMs?: number;
};

type PairingQrPayload = {
  relayId: string;
  serverPublicKey: string;
  serverUrl: string;
  serverUrls: string[];
};

type RelayRequestContext = {
  hostId?: string;
  serverUrl: string;
  token?: string;
};

export {
  fallbackCodexRelayServerUrl,
  getCodexRelayServerUrl,
  getCodexRelayServerUrlCandidates,
  normalizeServerUrl,
  setCodexRelayServerUrl,
};
export type { CodexRelayServerUrlCandidate };

class CodexRelayApiError extends Error {
  code: string | undefined;
  status: number;

  constructor(message: string, status: number, code: string | undefined) {
    super(message);
    this.name = "CodexRelayApiError";
    this.status = status;
    this.code = code;
  }
}

class PairingCandidateConnectionError extends Error {
  serverUrl: string;

  constructor(serverUrl: string, cause: unknown) {
    super(`Could not reach ${serverUrl}: ${errorMessage(cause, "network error")}`);
    this.name = "PairingCandidateConnectionError";
    this.serverUrl = serverUrl;
  }
}

class PairingQrPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairingQrPayloadError";
  }
}

export function isPairingQrPayloadError(error: unknown) {
  return error instanceof PairingQrPayloadError;
}

export function resolveCodexRelayUrl(url: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return url;
  }
  return `${getCodexRelayServerUrl()}${url.startsWith("/") ? "" : "/"}${url}`;
}

export function resolveCodexRelayImageUrl(url: string) {
  return resolveCodexRelayUrl(url);
}

export function codexRelayImageRequestHeaders() {
  const context = captureRelayRequestContext();
  const headers: Record<string, string> = {
    accept: "image/*",
    "x-codex-relay-client-session-id": getClientSessionId(),
  };
  if (context.token) {
    headers.authorization = `Bearer ${context.token}`;
  }
  return headers;
}

export function signOutCodexRelaySession() {
  const hostId = getActiveHostId();
  if (!hostId) {
    return undefined;
  }
  clearSecureSession(hostId);
  return removePairedHostRecord(hostId);
}

export function hasCodexRelaySession(hostId = getActiveHostId()) {
  return hasPairedHostSession(hostId);
}

export async function pairWithQrPayload(
  payload: unknown,
  handlers?: { onApprovalCode?: (approvalCode: string, serverUrl: string) => void },
) {
  const pairingPayload = parsePairingQrPayload(payload);
  const connectionErrors: PairingCandidateConnectionError[] = [];

  for (const serverUrl of pairingPayload.serverUrls) {
    try {
      const paired = await pairWithApproval(serverUrl, pairingPayload.serverPublicKey, handlers);
      const host = upsertPairedHost({
        clientToken: paired.clientToken,
        relayId: pairingPayload.relayId,
        serverUrl: paired.serverUrl,
        serverUrls: pairingPayload.serverUrls,
      });
      persistSecureSession(host.id, paired.secureSession);
      await startPairingTrialIfNeeded();
      return {
        ...pairingPayload,
        hostId: host.id,
        serverUrl: paired.serverUrl,
      };
    } catch (error) {
      if (!(error instanceof PairingCandidateConnectionError)) {
        throw error;
      }
      connectionErrors.push(error);
    }
  }

  throw new Error(pairingCandidateFailureMessage(connectionErrors));
}

async function pairWithApproval(
  serverUrl: string,
  serverPublicKey: string,
  handlers?: { onApprovalCode?: (approvalCode: string, serverUrl: string) => void },
) {
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  const securePairing = createSecurePairingAttempt({
    serverPublicKey,
    serverUrl: normalizedServerUrl,
  });

  const pairUrl = `${normalizedServerUrl}${apiPaths.pair}`;
  const response = await fetchWithNetworkContext(pairUrl, {
    method: "POST",
    timeoutMs: pairingConnectTimeoutMs,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      clientSessionId: getClientSessionId(),
      clientName: "Codex Relay mobile",
      secure: {
        clientEphemeralPublicKey: securePairing.clientEphemeralPublicKey,
        clientNonce: securePairing.clientNonce,
        protocolVersion: 1,
      },
    }),
  }).catch((error) => {
    throw new PairingCandidateConnectionError(normalizedServerUrl, error);
  });
  const responsePayload = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw new Error(
      errorMessage(responsePayload, `Codex Relay server returned ${response.status}`),
    );
  }

  const parsed = PairResponseSchema.parse(responsePayload);
  if (!parsed.approvalCode) {
    throw new Error("Pairing response did not include an approval code.");
  }

  attachApprovalCode(securePairing, parsed.approvalCode);
  handlers?.onApprovalCode?.(parsed.approvalCode, normalizedServerUrl);
  const approved = await waitForPairingApproval(normalizedServerUrl, parsed.approvalCode);
  const completed = completeSecurePairing(securePairing, approved);
  return {
    approvalCode: parsed.approvalCode,
    clientToken: completed.payload.clientToken,
    secureSession: completed.session,
    serverUrl: normalizedServerUrl,
  };
}

async function waitForPairingApproval(serverUrl: string, approvalCode: string) {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const response = await fetchWithNetworkContext(
      `${serverUrl}${apiPaths.pairApproval(approvalCode)}`,
      {
        headers: {
          accept: "application/json",
        },
      },
    );
    const responsePayload = await response.json().catch(() => undefined);
    if (response.status === 202) {
      await sleep(1000);
      continue;
    }
    if (!response.ok) {
      throw new Error(
        errorMessage(responsePayload, `Codex Relay server returned ${response.status}`),
      );
    }
    return PairResponseSchema.parse(responsePayload);
  }

  throw new Error("Pairing approval timed out.");
}

async function fetchWithNetworkContext(url: string, init?: NetworkRequestInit) {
  if (isLocalhostUrl(url)) {
    try {
      return await requestWithNetworkTimeout(fetch(url, init), init?.timeoutMs);
    } catch (error) {
      throw new Error(
        `Network request failed via fetch for ${url}: ${errorMessage(error, "network error")}`,
      );
    }
  }

  const useDirectFetch = shouldUseDirectFetch(url, init);
  const transport = useDirectFetch ? "dfetch" : "nitroFetch";
  try {
    if (useDirectFetch) {
      return await requestWithNetworkTimeout(dfetch(url, init), init?.timeoutMs);
    }
    return await requestWithNetworkTimeout(nitroFetch(url, init), init?.timeoutMs);
  } catch (error) {
    throw new Error(
      `Network request failed via ${transport} for ${url}: ${errorMessage(error, "network error")}`,
    );
  }
}

function shouldUseDirectFetch(url: string, init?: NetworkRequestInit) {
  if (Platform.OS !== "ios") {
    return false;
  }
  if (!isDirectFetchSupportedBody(init?.body)) {
    return false;
  }

  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host.endsWith(".local") ||
      host.endsWith(".ts.net") ||
      host.endsWith(".beta.tailscale.net") ||
      isPrivateIPv4Host(host) ||
      isCarrierGradePrivateIPv4Host(host) ||
      isLocalIPv6Host(host)
    );
  } catch {
    return false;
  }
}

function isDirectFetchSupportedBody(body: NetworkRequestInit["body"] | undefined) {
  if (body == null || typeof body === "string") {
    return true;
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return true;
  }
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return true;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return true;
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return true;
  }
  return false;
}

function isLocalhostUrl(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export async function refreshSession() {
  return hasCodexRelaySession();
}

function parsePairingQrPayload(payload: unknown): PairingQrPayload {
  if (typeof payload !== "string" || !payload.trim()) {
    throw new PairingQrPayloadError(`Pairing QR payload was empty (${String(payload)}).`);
  }

  let parsed: URL;
  try {
    parsed = new URL(payload.trim());
  } catch {
    throw new PairingQrPayloadError("Scan the pairing QR from the Codex Relay server.");
  }
  if (parsed.protocol !== "codex-relay:" || parsed.hostname !== "pair") {
    throw new PairingQrPayloadError("Scan the pairing QR from the Codex Relay server.");
  }

  const serverUrl = parsed.searchParams.get("serverUrl");
  const serverPublicKey = parsed.searchParams.get("serverPublicKey")?.trim();
  if (!serverUrl || !serverPublicKey) {
    throw new PairingQrPayloadError("Pairing QR code is missing connection details.");
  }

  let normalizedServerUrl: string;
  try {
    normalizedServerUrl = normalizeServerUrl(serverUrl);
  } catch {
    throw new PairingQrPayloadError("Pairing QR code has an invalid server URL.");
  }

  return {
    relayId: relayIdFromServerPublicKey(serverPublicKey),
    serverPublicKey,
    serverUrl: normalizedServerUrl,
    serverUrls: parsePairingServerUrls(parsed, normalizedServerUrl),
  };
}

function parsePairingServerUrls(parsed: URL, fallbackServerUrl: string) {
  const urls = [
    fallbackServerUrl,
    ...parseCompactPairingHosts(parsed.searchParams.get("h"), fallbackServerUrl),
    ...parseCompactPairingHosts(parsed.searchParams.get("serverHosts"), fallbackServerUrl),
    ...parsePairingServerUrlsParam(parsed.searchParams.get("serverUrls")),
  ];
  return dedupeServerUrls(urls);
}

function parseCompactPairingHosts(value: string | null, fallbackServerUrl: string) {
  if (!value) {
    return [];
  }

  try {
    const fallback = new URL(fallbackServerUrl);
    const port = fallback.port ? `:${fallback.port}` : "";
    return value
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean)
      .map((host) => `${fallback.protocol}//${host}${port}`);
  } catch {
    return [];
  }
}

function parsePairingServerUrlsParam(value: string | null) {
  if (!value) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((url): url is string => typeof url === "string")
      : [];
  } catch {
    return [];
  }
}

function pairingCandidateFailureMessage(errors: PairingCandidateConnectionError[]) {
  const attemptedUrls = errors.map((error) => error.serverUrl).join(", ");
  return attemptedUrls
    ? `Could not reach any server URL from the pairing QR. Tried: ${attemptedUrls}. Make sure this device is on the same network or Tailscale is connected.`
    : "Could not reach the server URL from the pairing QR.";
}

export async function getStatus(hostId?: string): Promise<StatusResponse> {
  return request(apiPaths.status, undefined, StatusResponseSchema.parse, { hostId });
}

export async function getVersion(hostId?: string): Promise<VersionResponse> {
  return request(apiPaths.version, undefined, VersionResponseSchema.parse, { hostId });
}

export async function updateRuntimePreferences(
  body: UpdateRuntimePreferencesRequest,
  hostId = getActiveHostId(),
): Promise<RuntimePreferencesResponse> {
  return request(
    apiPaths.preferences,
    {
      method: "PATCH",
      body: encryptRequestPayload(UpdateRuntimePreferencesRequestSchema.parse(body), hostId),
    },
    RuntimePreferencesResponseSchema.parse,
    { hostId },
  );
}

export async function getPushNotificationSettings(
  hostId?: string,
): Promise<PushNotificationSettingsResponse> {
  return request(
    apiPaths.pushNotifications,
    undefined,
    PushNotificationSettingsResponseSchema.parse,
    { hostId },
  );
}

export async function registerPushNotifications(
  body: RegisterPushNotificationRequest,
  hostId = getActiveHostId(),
): Promise<PushNotificationSettingsResponse> {
  return request(
    apiPaths.pushNotifications,
    {
      body: encryptRequestPayload(RegisterPushNotificationRequestSchema.parse(body), hostId),
      method: "PUT",
    },
    PushNotificationSettingsResponseSchema.parse,
    { hostId },
  );
}

export async function unregisterPushNotifications(
  hostId?: string,
): Promise<PushNotificationSettingsResponse> {
  return request(
    apiPaths.pushNotifications,
    { method: "DELETE" },
    PushNotificationSettingsResponseSchema.parse,
    { hostId },
  );
}

export async function sendTestPushNotification(
  hostId?: string,
): Promise<PushNotificationTestResponse> {
  return request(
    apiPaths.pushNotificationsTest,
    { method: "POST" },
    PushNotificationTestResponseSchema.parse,
    { hostId },
  );
}

export async function revokeCodexRelaySession(hostId = getActiveHostId()) {
  if (!hostId) {
    return;
  }
  await requestNoContent(apiPaths.session, { method: "DELETE" }, hostId);
}

export async function listThreads(hostId?: string): Promise<ListThreadsResponse> {
  return request(apiPaths.threads, undefined, ListThreadsResponseSchema.parse, { hostId });
}

export async function archiveThread(threadId: string): Promise<ArchiveThreadResponse> {
  return request(
    apiPaths.threadArchive(threadId),
    { method: "DELETE" },
    ArchiveThreadResponseSchema.parse,
  );
}

export async function renameThread(
  threadId: string,
  body: RenameThreadRequest,
): Promise<RenameThreadResponse> {
  return request(
    apiPaths.threadName(threadId),
    {
      method: "POST",
      body: encryptRequestPayload(RenameThreadRequestSchema.parse(body)),
    },
    RenameThreadResponseSchema.parse,
  );
}

export async function listModels(hostId?: string): Promise<ListModelsResponse> {
  return request(apiPaths.models, undefined, ListModelsResponseSchema.parse, { hostId });
}

export async function listSkills(
  workspacePath?: string,
  hostId?: string,
): Promise<ListSkillsResponse> {
  const query = workspacePath ? `?workspacePath=${encodeURIComponent(workspacePath)}` : "";
  return withTimeout(
    request(`${skillsPath}${query}`, undefined, ListSkillsResponseSchema.parse, { hostId }),
    skillsRequestTimeoutMs,
  );
}

export async function listWorkspaceFiles(
  input: { directory?: string; query?: string; workspacePath?: string } = {},
  hostId?: string,
): Promise<ListWorkspaceFilesResponse> {
  const params = new URLSearchParams();
  if (input.directory) {
    params.set("directory", input.directory);
  }
  if (input.query) {
    params.set("query", input.query);
  }
  if (input.workspacePath) {
    params.set("workspacePath", input.workspacePath);
  }
  const query = params.toString();
  return request(
    `${apiPaths.workspaceFiles}${query ? `?${query}` : ""}`,
    undefined,
    ListWorkspaceFilesResponseSchema.parse,
    { hostId },
  );
}

export async function getWorkspaceFileContent(
  input: {
    path: string;
    workspacePath?: string;
  },
  hostId?: string,
): Promise<WorkspaceFileContentResponse> {
  const params = new URLSearchParams();
  params.set("path", input.path);
  if (input.workspacePath) {
    params.set("workspacePath", input.workspacePath);
  }
  return request(
    `${apiPaths.workspaceFileContent}?${params.toString()}`,
    undefined,
    WorkspaceFileContentResponseSchema.parse,
    { hostId },
  );
}

export async function updateWorkspaceFileContent(
  body: UpdateWorkspaceFileContentRequest,
  hostId = getActiveHostId(),
): Promise<WorkspaceFileContentResponse> {
  return request(
    apiPaths.workspaceFileContent,
    {
      body: encryptRequestPayload(UpdateWorkspaceFileContentRequestSchema.parse(body), hostId),
      method: "PUT",
    },
    WorkspaceFileContentResponseSchema.parse,
    { hostId },
  );
}

export async function listWorkspaceDirectories(
  path?: string,
  hostId?: string,
): Promise<ListWorkspaceDirectoriesResponse> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return request(
    `${apiPaths.workspaceDirectories}${query}`,
    undefined,
    ListWorkspaceDirectoriesResponseSchema.parse,
    { hostId },
  );
}

export async function getWorkspaceChanges(
  input?: WorkspaceSelectionRequest,
  hostId?: string,
): Promise<WorkspaceChangesResponse> {
  const workspacePath = input?.workspacePath?.trim();
  const query = workspacePath ? `?workspacePath=${encodeURIComponent(workspacePath)}` : "";
  return request(
    `${apiPaths.workspaceChanges}${query}`,
    undefined,
    WorkspaceChangesResponseSchema.parse,
    { hostId },
  );
}

export async function checkoutWorkspaceBranch(
  body: CheckoutWorkspaceBranchRequest,
): Promise<WorkspaceGitActionResponse> {
  return request(
    apiPaths.workspaceCheckout,
    {
      method: "POST",
      body: encryptRequestPayload(CheckoutWorkspaceBranchRequestSchema.parse(body)),
    },
    WorkspaceGitActionResponseSchema.parse,
  );
}

export async function commitPushWorkspace(
  body: CommitPushWorkspaceRequest,
): Promise<WorkspaceGitActionResponse> {
  return request(
    apiPaths.workspaceCommitPush,
    {
      method: "POST",
      body: encryptRequestPayload(CommitPushWorkspaceRequestSchema.parse(body)),
    },
    WorkspaceGitActionResponseSchema.parse,
  );
}

export async function startWorkspaceTailscaleServe(
  body: WorkspaceTailscaleServeRequest,
): Promise<WorkspaceTailscaleServeResponse> {
  return request(
    apiPaths.workspaceTailscaleServe,
    {
      method: "POST",
      body: encryptRequestPayload(WorkspaceTailscaleServeRequestSchema.parse(body)),
    },
    WorkspaceTailscaleServeResponseSchema.parse,
  );
}

export async function createWorkspaceTerminalSession(body: {
  cols: number;
  rows: number;
  workspacePath?: string;
}): Promise<WorkspaceTerminalSessionResponse> {
  return request(
    apiPaths.workspaceTerminalSessions,
    {
      method: "POST",
      body: encryptRequestPayload(body),
    },
    WorkspaceTerminalSessionResponseSchema.parse,
  );
}

export async function readWorkspaceTerminalOutput(
  sessionId: string,
  since: number,
): Promise<WorkspaceTerminalOutputResponse> {
  return request(
    `${apiPaths.workspaceTerminalOutput(sessionId)}?since=${encodeURIComponent(String(since))}`,
    undefined,
    WorkspaceTerminalOutputResponseSchema.parse,
  );
}

export function streamWorkspaceTerminalOutput(
  sessionId: string,
  since: number,
  handlers: {
    onOutput: (response: WorkspaceTerminalOutputResponse) => void;
    onError: (error: Error) => void;
  },
) {
  const context = captureRelayRequestContext();
  const requestUrl =
    `${context.serverUrl}${apiPaths.workspaceTerminalOutputStream(sessionId)}` +
    `?since=${encodeURIComponent(String(since))}`;
  let closed = false;
  const dispatcher = createTerminalOutputSseDispatcher(handlers, context.hostId);

  function fail(error: Error) {
    if (closed) {
      return;
    }
    closed = true;
    handlers.onError(error);
  }

  dfetchStream(
    requestUrl,
    {
      method: "GET",
      headers: streamRequestHeaders({ jsonContentType: false }, context),
      timeoutMs: terminalStreamRequestTimeoutMs,
    },
    (text) => {
      if (closed || !dispatcher.push(text)) {
        closed = true;
      }
    },
  )
    .then((response) => {
      if (closed) {
        return;
      }
      if (!response.ok) {
        markRepairIfUnauthorized(response.status, context.hostId);
        void response.text().then((text) => {
          let payload: unknown = text;
          try {
            payload = decryptResponsePayload(JSON.parse(text), context.hostId);
          } catch {}
          fail(new Error(errorMessage(payload, `Codex Relay server returned ${response.status}`)));
        });
        return;
      }
      if (!dispatcher.flush()) {
        closed = true;
      }
    })
    .catch((error: unknown) => {
      fail(new Error(errorMessage(error, "Codex Relay terminal stream failed.")));
    });

  return () => {
    closed = true;
  };
}

function createTerminalOutputSseDispatcher(
  handlers: {
    onOutput: (response: WorkspaceTerminalOutputResponse) => void;
    onError: (error: Error) => void;
  },
  hostId: string | undefined,
) {
  let pendingChunk = "";
  let closed = false;

  return {
    push(text: string) {
      if (closed) {
        return false;
      }
      pendingChunk += text;
      const parts = pendingChunk.split(/\r?\n\r?\n/);
      pendingChunk = parts.pop() ?? "";
      for (const part of parts) {
        if (!dispatchTerminalOutputSseChunk(part, handlers, hostId)) {
          closed = true;
          return false;
        }
      }
      return true;
    },
    flush() {
      if (closed) {
        return false;
      }
      if (pendingChunk.trim() && !dispatchTerminalOutputSseChunk(pendingChunk, handlers, hostId)) {
        closed = true;
        return false;
      }
      pendingChunk = "";
      return true;
    },
  };
}

function dispatchTerminalOutputSseChunk(
  chunk: string,
  handlers: {
    onOutput: (response: WorkspaceTerminalOutputResponse) => void;
    onError: (error: Error) => void;
  },
  hostId: string | undefined,
) {
  const data = chunk
    .split(/\r?\n/)
    .reduce<string[]>((lines, line) => {
      if (line.startsWith("data:")) {
        lines.push(line.slice("data:".length).trimStart());
      }
      return lines;
    }, [])
    .join("\n");
  if (!data) {
    return true;
  }

  try {
    const payload = decryptResponsePayload(JSON.parse(data), hostId);
    handlers.onOutput(WorkspaceTerminalOutputResponseSchema.parse(payload));
    return true;
  } catch {
    handlers.onError(new Error("Codex Relay server returned invalid terminal output."));
    return false;
  }
}

export async function writeWorkspaceTerminalInput(sessionId: string, data: string) {
  if (!data) {
    return { ok: true };
  }
  await requestNoContent(apiPaths.workspaceTerminalInput(sessionId), {
    method: "POST",
    body: encryptRequestPayload({ data, input: data }),
  });
  return { ok: true };
}

export async function resizeWorkspaceTerminalSession(
  sessionId: string,
  size: { cols: number; rows: number },
) {
  await requestNoContent(apiPaths.workspaceTerminalResize(sessionId), {
    method: "POST",
    body: encryptRequestPayload(size),
  });
  return { ok: true };
}

export async function closeWorkspaceTerminalSession(sessionId: string) {
  await requestNoContent(apiPaths.workspaceTerminalSession(sessionId), {
    method: "DELETE",
  });
  return { ok: true };
}

async function requestNoContent(path: string, init: RequestInit, hostId?: string) {
  const context = captureRelayRequestContext(hostId);
  const headers = requestHeaders(init.headers, {}, context);
  const serverRequestUrl = `${context.serverUrl}${path}`;
  const response = await fetchWithNetworkContext(serverRequestUrl, {
    ...init,
    headers,
  });
  if (response.ok) {
    return;
  }

  markRepairIfUnauthorized(response.status, context.hostId);

  const payload = decryptResponsePayload(
    await response.json().catch(() => undefined),
    context.hostId,
  );
  const message = errorMessage(payload, `Codex Relay server returned ${response.status}`);
  throw new CodexRelayApiError(message, response.status, errorCode(payload));
}

export async function getRateLimits(hostId?: string): Promise<RateLimitsResponse> {
  return request(apiPaths.rateLimits, undefined, RateLimitsResponseSchema.parse, { hostId });
}

export async function getThread(
  threadId: string,
  options: { refresh?: boolean } = {},
  hostId?: string,
): Promise<ThreadDetailResponse> {
  const path = options.refresh
    ? `${apiPaths.thread(threadId)}?refresh=true`
    : apiPaths.thread(threadId);
  return request(path, undefined, ThreadDetailResponseSchema.parse, { hostId });
}

export async function rewindThread(
  threadId: string,
  body: RewindThreadRequest,
): Promise<ThreadDetailResponse> {
  return request(
    apiPaths.threadRollback(threadId),
    {
      method: "POST",
      body: encryptRequestPayload(RewindThreadRequestSchema.parse(body)),
    },
    ThreadDetailResponseSchema.parse,
  );
}

export async function getThreadMessageDetail(
  threadId: string,
  messageId: string,
  field: ThreadMessageDetailField,
): Promise<ThreadMessageDetailResponse> {
  return request(
    apiPaths.threadMessageDetail(threadId, messageId, field),
    undefined,
    ThreadMessageDetailResponseSchema.parse,
  );
}

export async function getThreadContextWindow(
  threadId: string,
  hostId?: string,
): Promise<ThreadContextWindowResponse> {
  return request(
    apiPaths.threadContextWindow(threadId),
    undefined,
    ThreadContextWindowResponseSchema.parse,
    { hostId },
  );
}

export async function getThreadGoal(
  threadId: string,
  hostId?: string,
): Promise<ThreadGoalResponse> {
  return request(apiPaths.threadGoal(threadId), undefined, ThreadGoalResponseSchema.parse, {
    hostId,
  });
}

export async function updateThreadGoal(
  threadId: string,
  body: UpdateThreadGoalRequest,
  hostId = getActiveHostId(),
): Promise<ThreadGoalResponse> {
  return request(
    apiPaths.threadGoal(threadId),
    {
      method: "POST",
      body: encryptRequestPayload(UpdateThreadGoalRequestSchema.parse(body), hostId),
    },
    ThreadGoalResponseSchema.parse,
    { hostId },
  );
}

export async function clearThreadGoal(
  threadId: string,
  hostId?: string,
): Promise<ThreadGoalResponse> {
  return request(
    apiPaths.threadGoal(threadId),
    {
      method: "DELETE",
    },
    ThreadGoalResponseSchema.parse,
    { hostId },
  );
}

export async function createThread(body: CreateThreadRequest): Promise<CreateThreadResponse> {
  return request(
    apiPaths.threads,
    {
      method: "POST",
      body: encryptRequestPayload(body),
    },
    CreateThreadResponseSchema.parse,
  );
}

export function streamThreadRun(
  threadId: string,
  body: StreamThreadRunRequest,
  handlers: {
    onEvent: (event: StreamThreadRunEvent) => void;
    onError: (error: Error) => void;
    onClose?: () => void;
  },
) {
  const context = captureRelayRequestContext();
  const requestUrl = `${context.serverUrl}${apiPaths.threadRunStream(threadId)}`;
  const requestBody = encryptRequestPayload(body, context.hostId);
  if (shouldUseDirectFetch(requestUrl, { body: requestBody })) {
    return streamThreadRunWithDirectFetch(requestUrl, requestBody, handlers, context);
  }

  const source = new EventSource<StreamThreadRunEvent["type"]>(requestUrl, {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      ...authorizationHeader(context),
      "content-type": "application/json",
    },
    body: requestBody,
    pollingInterval: 0,
  });

  for (const type of threadRunStreamEventTypes) {
    source.addEventListener(type, (event) => {
      if (!event.data) {
        return;
      }

      try {
        handlers.onEvent(
          parseThreadRunStreamPayload(event.data, (payload) =>
            decryptResponsePayload(payload, context.hostId),
          ),
        );
      } catch {
        handlers.onError(new Error("Codex Relay server returned an invalid stream event."));
      }
    });
  }

  source.addEventListener("error", (event) => {
    const message = "message" in event ? event.message : "Codex Relay stream failed.";
    handlers.onError(new Error(message));
  });
  source.addEventListener("close", () => {
    handlers.onClose?.();
  });

  return () => {
    source.close();
  };
}

function streamThreadRunWithDirectFetch(
  requestUrl: string,
  requestBody: string,
  handlers: {
    onEvent: (event: StreamThreadRunEvent) => void;
    onError: (error: Error) => void;
    onClose?: () => void;
  },
  context: RelayRequestContext,
) {
  let closed = false;
  const dispatcher = createThreadRunSseDispatcher(handlers, (payload) =>
    decryptResponsePayload(payload, context.hostId),
  );

  function close() {
    if (closed) {
      return;
    }
    closed = true;
    handlers.onClose?.();
  }

  function fail(error: Error) {
    if (closed) {
      return;
    }
    closed = true;
    handlers.onError(error);
  }

  function processText(text: string) {
    if (closed) {
      return;
    }
    if (!dispatcher.push(text)) {
      closed = true;
    }
  }

  dfetchStream(
    requestUrl,
    {
      method: "POST",
      headers: streamRequestHeaders({}, context),
      body: requestBody,
      timeoutMs: streamRequestTimeoutMs,
    },
    processText,
  )
    .then((response) => {
      if (closed) {
        return;
      }
      if (!response.ok) {
        markRepairIfUnauthorized(response.status, context.hostId);
        void response.text().then((text) => {
          let payload: unknown = text;
          try {
            payload = decryptResponsePayload(JSON.parse(text), context.hostId);
          } catch {}
          fail(new Error(errorMessage(payload, `Codex Relay server returned ${response.status}`)));
        });
        return;
      }
      if (!dispatcher.flush()) {
        closed = true;
        return;
      }
      close();
    })
    .catch((error: unknown) => {
      fail(new Error(errorMessage(error, "Codex Relay stream failed.")));
    });

  return () => {
    closed = true;
  };
}

function streamRequestHeaders(
  options: { jsonContentType?: boolean } = {},
  context = captureRelayRequestContext(),
) {
  const headers = new Headers({
    accept: "text/event-stream",
  });
  if (options.jsonContentType !== false) {
    headers.set("content-type", "application/json");
  }
  const authorization = authorizationHeader(context).authorization;
  if (authorization) {
    headers.set("authorization", authorization);
  }
  return headers;
}

export async function runThread(
  threadId: string,
  body: RunThreadRequest,
): Promise<RunThreadResponse> {
  return request(
    apiPaths.threadRuns(threadId),
    {
      method: "POST",
      body: encryptRequestPayload(body),
    },
    RunThreadResponseSchema.parse,
  );
}

export async function uploadImageAttachments(
  images: Array<{ mimeType?: string; name?: string; uri: string }>,
): Promise<ImageAttachmentUploadResponse> {
  const formData = new FormData();
  images.forEach((image, index) => {
    formData.append("images", {
      name: image.name ?? `image-${index + 1}.jpg`,
      type: image.mimeType ?? "image/jpeg",
      uri: image.uri,
    } as never);
  });

  return request(
    apiPaths.imageAttachments,
    {
      method: "POST",
      body: formData as never,
    },
    ImageAttachmentUploadResponseSchema.parse,
    { jsonContentType: false },
  );
}

export async function submitThreadInput(
  threadId: string,
  body: RunThreadRequest,
): Promise<SubmitThreadInputResponse> {
  return request(
    apiPaths.threadInput(threadId),
    {
      method: "POST",
      body: encryptRequestPayload(body),
    },
    SubmitThreadInputResponseSchema.parse,
  );
}

export async function interruptThreadRun(threadId: string) {
  return request(
    apiPaths.threadRunInterrupt(threadId),
    {
      method: "POST",
    },
    InterruptThreadRunResponseSchema.parse,
  );
}

export async function listQueuedThreadInputs(
  threadId: string,
  hostId?: string,
): Promise<ListQueuedThreadInputsResponse> {
  return request(
    apiPaths.threadInput(threadId),
    undefined,
    ListQueuedThreadInputsResponseSchema.parse,
    { hostId },
  );
}

export async function removeQueuedThreadInput(
  threadId: string,
  inputId: string,
): Promise<QueuedThreadInputActionResponse> {
  return request(
    apiPaths.threadQueuedInput(threadId, inputId),
    {
      method: "DELETE",
    },
    QueuedThreadInputActionResponseSchema.parse,
  );
}

export async function steerQueuedThreadInput(
  threadId: string,
  inputId: string,
): Promise<QueuedThreadInputActionResponse> {
  return request(
    apiPaths.threadQueuedInputSteer(threadId, inputId),
    {
      method: "POST",
    },
    QueuedThreadInputActionResponseSchema.parse,
  );
}

export async function resolveApproval(
  approvalId: string,
  body: ResolveApprovalRequest,
): Promise<ResolveApprovalResponse> {
  try {
    return await request(
      apiPaths.approval(approvalId),
      {
        method: "POST",
        body: encryptRequestPayload(body),
      },
      ResolveApprovalResponseSchema.parse,
    );
  } catch (error) {
    if (isResolvedApprovalRace(error)) {
      return ResolveApprovalResponseSchema.parse({ ok: true });
    }
    throw error;
  }
}

async function request<T>(
  path: string,
  init: RequestInit | undefined,
  parse: (payload: unknown) => T,
  options: { hostId?: string; jsonContentType?: boolean } = {},
) {
  const context = captureRelayRequestContext(options.hostId);
  const headers = requestHeaders(init?.headers, options, context);
  const serverRequestUrl = `${context.serverUrl}${path}`;
  const response = await fetchWithNetworkContext(serverRequestUrl, {
    ...init,
    headers,
  });
  const payload = decryptResponsePayload(
    await response.json().catch(() => undefined),
    context.hostId,
  );

  if (!response.ok) {
    markRepairIfUnauthorized(response.status, context.hostId);
    const message = errorMessage(payload, `Codex Relay server returned ${response.status}`);
    throw new CodexRelayApiError(message, response.status, errorCode(payload));
  }

  return parse(payload);
}

function markRepairIfUnauthorized(status: number, hostId: string | undefined) {
  if (status === 401 && hostId) {
    markPairedHostRequiresRepair(hostId);
  }
}

function requestHeaders(
  initHeaders: HeadersInit | undefined,
  options: { jsonContentType?: boolean } = {},
  context = captureRelayRequestContext(),
) {
  const headers = new Headers({
    accept: "application/json",
  });
  if (options.jsonContentType !== false) {
    headers.set("content-type", "application/json");
  }
  for (const [key, value] of new Headers(initHeaders)) {
    headers.set(key, value);
  }

  if (context.token && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${context.token}`);
  }
  if (!headers.has("x-codex-relay-client-session-id")) {
    headers.set("x-codex-relay-client-session-id", getClientSessionId());
  }

  return headers;
}

function captureRelayRequestContext(hostId = getActiveHostId()): RelayRequestContext {
  const host = getPairedHost(hostId);
  return {
    hostId: host?.id,
    serverUrl: host?.activeUrl ?? fallbackCodexRelayServerUrl,
    token: getHostClientToken(host?.id),
  };
}

export function getClientSessionId() {
  const existing = storage.getString(clientSessionIdStorageKey);
  if (existing) {
    return existing;
  }

  const next = createUuidV4();
  storage.set(clientSessionIdStorageKey, next);
  return next;
}

function createUuidV4() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

function authorizationHeader(context = captureRelayRequestContext()) {
  return context.token ? { authorization: `Bearer ${context.token}` } : {};
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(payload: unknown, fallback: string) {
  return payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error
    ? String(payload.error.message)
    : fallback;
}

function errorCode(payload: unknown) {
  return payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "code" in payload.error
    ? String(payload.error.code)
    : undefined;
}

function isResolvedApprovalRace(error: unknown) {
  return (
    error instanceof CodexRelayApiError &&
    error.status === 404 &&
    error.code === "not_found" &&
    error.message.includes("no longer pending")
  );
}
