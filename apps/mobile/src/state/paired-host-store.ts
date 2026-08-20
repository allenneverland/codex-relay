import { observable } from "@legendapp/state";
import { createMMKV } from "react-native-mmkv";

const registryStorageKey = "codex-relay.paired-hosts.v1";
const legacyClientTokenExpiresAtStorageKey = "codex-relay.client-token-expires-at";
const legacyClientTokenStorageKey = "codex-relay.client-token";
const legacyServerUrlCandidatesStorageKey = "codex-relay.server-url-candidates";
const legacyServerUrlStorageKey = "codex-relay.server-url";
const hostClientTokenStorageKey = (hostId: string) => `codex-relay.host.${hostId}.client-token`;

export const codexRelayStorage = createMMKV({ id: "codex-relay" });

export type PairedRelayHost = {
  activeUrl: string;
  createdAt: number;
  id: string;
  lastConnectedAt?: number;
  machineName?: string;
  relayId?: string;
  requiresRepair?: boolean;
  urlCandidates: string[];
};

type PairedHostRegistry = {
  activeHostId?: string;
  hostIds: string[];
  hostsById: Record<string, PairedRelayHost>;
  pairingRevision: number;
  version: 1;
};

export type PendingNotificationTarget = {
  hostId: string;
  threadId: string;
};

const initialRegistry = readOrMigrateRegistry();

export const pairedHostStore$ = observable<PairedHostRegistry>(initialRegistry);
export const pendingNotificationTarget$ = observable<PendingNotificationTarget | undefined>(
  undefined,
);

export function getActiveHostId() {
  const activeHostId = pairedHostStore$.activeHostId.peek();
  return activeHostId && pairedHostStore$.hostsById[activeHostId].peek() ? activeHostId : undefined;
}

export function getActivePairedHost() {
  const activeHostId = getActiveHostId();
  return activeHostId ? pairedHostStore$.hostsById[activeHostId].peek() : undefined;
}

export function getPairedHost(hostId: string | undefined) {
  return hostId ? pairedHostStore$.hostsById[hostId].peek() : undefined;
}

export function getPairedHosts() {
  const registry = pairedHostStore$.peek();
  return registry.hostIds.flatMap((hostId) => {
    const host = registry.hostsById[hostId];
    return host ? [host] : [];
  });
}

export function getHostClientToken(hostId: string | undefined) {
  return hostId ? codexRelayStorage.getString(hostClientTokenStorageKey(hostId)) : undefined;
}

export function hasPairedHostSession(hostId = getActiveHostId()) {
  return Boolean(getPairedHost(hostId) && getHostClientToken(hostId));
}

export function setActivePairedHost(hostId: string) {
  if (!getPairedHost(hostId)) {
    throw new Error("Paired computer was not found.");
  }
  updateRegistry((current) =>
    current.activeHostId === hostId ? current : { ...current, activeHostId: hostId },
  );
}

export function upsertPairedHost(input: {
  clientToken: string;
  relayId: string;
  serverUrl: string;
  serverUrls: string[];
}) {
  const serverUrl = normalizeServerUrl(input.serverUrl);
  const serverUrls = dedupeServerUrls([serverUrl, ...input.serverUrls]);
  const current = pairedHostStore$.peek();
  const existing = current.hostIds
    .map((hostId) => current.hostsById[hostId])
    .find(
      (host) =>
        host?.relayId === input.relayId ||
        (!host?.relayId &&
          host &&
          serverUrls.some((candidate) => host.urlCandidates.includes(candidate))),
    );
  const now = Date.now();
  const host: PairedRelayHost = existing
    ? {
        ...existing,
        activeUrl: serverUrl,
        lastConnectedAt: now,
        relayId: input.relayId,
        requiresRepair: false,
        urlCandidates: dedupeServerUrls([...serverUrls, ...existing.urlCandidates]),
      }
    : {
        activeUrl: serverUrl,
        createdAt: now,
        id: createUuidV4(),
        lastConnectedAt: now,
        relayId: input.relayId,
        urlCandidates: serverUrls,
      };

  codexRelayStorage.set(hostClientTokenStorageKey(host.id), input.clientToken);
  updateRegistry((registry) => ({
    ...registry,
    activeHostId: host.id,
    hostIds: registry.hostIds.includes(host.id) ? registry.hostIds : [...registry.hostIds, host.id],
    hostsById: { ...registry.hostsById, [host.id]: host },
    pairingRevision: registry.pairingRevision + 1,
  }));
  return host;
}

export function updatePairedHostConnection(
  hostId: string,
  input: { machineName?: string; relayId?: string },
) {
  updatePairedHost(hostId, (host) => ({
    ...host,
    lastConnectedAt: Date.now(),
    machineName: input.machineName ?? host.machineName,
    relayId: input.relayId ?? host.relayId,
    requiresRepair: false,
  }));
}

export function markPairedHostRequiresRepair(hostId: string) {
  updatePairedHost(hostId, (host) => ({ ...host, requiresRepair: true }));
}

export function updatePairedHostUrl(hostId: string, url: string) {
  const activeUrl = normalizeServerUrl(url);
  updatePairedHost(hostId, (host) => ({
    ...host,
    activeUrl,
    urlCandidates: dedupeServerUrls([activeUrl, ...host.urlCandidates]),
  }));
  return activeUrl;
}

export function updatePairedHostUrlCandidates(hostId: string, urls: string[]) {
  updatePairedHost(hostId, (host) => ({
    ...host,
    urlCandidates: dedupeServerUrls([host.activeUrl, ...urls]),
  }));
}

export function removePairedHostRecord(hostId: string) {
  const current = pairedHostStore$.peek();
  if (!current.hostsById[hostId]) {
    return getActiveHostId();
  }
  const { [hostId]: _removed, ...hostsById } = current.hostsById;
  const hostIds = current.hostIds.filter((candidate) => candidate !== hostId);
  const nextActiveHostId =
    current.activeHostId === hostId
      ? [...hostIds]
          .map((candidate) => hostsById[candidate])
          .filter((host): host is PairedRelayHost => Boolean(host))
          .sort(
            (left, right) =>
              (right.lastConnectedAt ?? right.createdAt) - (left.lastConnectedAt ?? left.createdAt),
          )[0]?.id
      : current.activeHostId;
  codexRelayStorage.remove(hostClientTokenStorageKey(hostId));
  updateRegistry((registry) => ({
    ...registry,
    activeHostId: nextActiveHostId,
    hostIds,
    hostsById,
  }));
  return nextActiveHostId;
}

export function setPendingNotificationTarget(target: PendingNotificationTarget | undefined) {
  pendingNotificationTarget$.set(target);
}

export function consumePendingNotificationTarget(hostId: string) {
  const target = pendingNotificationTarget$.peek();
  if (!target || target.hostId !== hostId) {
    return undefined;
  }
  pendingNotificationTarget$.set(undefined);
  return target;
}

export function pairedHostDisplayName(host: PairedRelayHost | undefined) {
  if (!host) {
    return "No paired computer";
  }
  if (host.machineName) {
    return host.machineName;
  }
  try {
    return new URL(host.activeUrl).hostname;
  } catch {
    return host.activeUrl.replace(/^https?:\/\//, "");
  }
}

function updatePairedHost(hostId: string, update: (host: PairedRelayHost) => PairedRelayHost) {
  updateRegistry((current) => {
    const host = current.hostsById[hostId];
    if (!host) {
      return current;
    }
    return {
      ...current,
      hostsById: { ...current.hostsById, [hostId]: update(host) },
    };
  });
}

function updateRegistry(update: (registry: PairedHostRegistry) => PairedHostRegistry) {
  const next = update(pairedHostStore$.peek());
  pairedHostStore$.set(next);
  codexRelayStorage.set(registryStorageKey, JSON.stringify(next));
}

function readOrMigrateRegistry(): PairedHostRegistry {
  const stored = codexRelayStorage.getString(registryStorageKey);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as PairedHostRegistry;
      if (parsed.version === 1 && Array.isArray(parsed.hostIds) && parsed.hostsById) {
        return { ...parsed, pairingRevision: parsed.pairingRevision ?? 0 };
      }
    } catch {
      // Fall through to the legacy singleton migration.
    }
  }

  const clientToken = codexRelayStorage.getString(legacyClientTokenStorageKey);
  const serverUrl = codexRelayStorage.getString(legacyServerUrlStorageKey);
  if (!clientToken || !serverUrl) {
    return emptyRegistry();
  }

  const id = createUuidV4();
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  const host: PairedRelayHost = {
    activeUrl: normalizedServerUrl,
    createdAt: Date.now(),
    id,
    urlCandidates: dedupeServerUrls([normalizedServerUrl, ...readLegacyServerUrlCandidates()]),
  };
  const registry: PairedHostRegistry = {
    activeHostId: id,
    hostIds: [id],
    hostsById: { [id]: host },
    pairingRevision: 0,
    version: 1,
  };
  codexRelayStorage.set(hostClientTokenStorageKey(id), clientToken);
  codexRelayStorage.set(registryStorageKey, JSON.stringify(registry));
  codexRelayStorage.remove(legacyClientTokenStorageKey);
  codexRelayStorage.remove(legacyClientTokenExpiresAtStorageKey);
  codexRelayStorage.remove(legacyServerUrlStorageKey);
  codexRelayStorage.remove(legacyServerUrlCandidatesStorageKey);
  return registry;
}

function readLegacyServerUrlCandidates() {
  const stored = codexRelayStorage.getString(legacyServerUrlCandidatesStorageKey);
  if (!stored) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed)
      ? parsed.filter((url): url is string => typeof url === "string")
      : [];
  } catch {
    return [];
  }
}

function emptyRegistry(): PairedHostRegistry {
  return { hostIds: [], hostsById: {}, pairingRevision: 0, version: 1 };
}

function normalizeServerUrl(url: string) {
  return new URL(url.trim().replace(/\/$/, "")).toString().replace(/\/$/, "");
}

function dedupeServerUrls(urls: string[]) {
  const deduped = new Set<string>();
  for (const url of urls) {
    try {
      deduped.add(normalizeServerUrl(url));
    } catch {
      continue;
    }
  }
  return [...deduped];
}

function createUuidV4() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
