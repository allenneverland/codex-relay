import { createMMKV } from "react-native-mmkv";
import { expect, it, vi } from "vitest";

vi.mock("react-native-get-random-values", () => ({}));

it("migrates and isolates the mobile paired-host registry", async () => {
  const storage = createMMKV({ id: "codex-relay" });
  storage.set("codex-relay.server-url", "http://legacy-host:8787");
  storage.set("codex-relay.client-token", "legacy-token");
  storage.set(
    "codex-relay.server-url-candidates",
    JSON.stringify(["http://legacy-host.local:8787"]),
  );
  vi.resetModules();

  const hosts = await import("../../../apps/mobile/src/state/paired-host-store.js");
  const migratedHost = hosts.getActivePairedHost();
  expect(migratedHost?.activeUrl).toBe("http://legacy-host:8787");
  expect(hosts.getHostClientToken(migratedHost?.id)).toBe("legacy-token");

  const paired = hosts.upsertPairedHost({
    clientToken: "second-token",
    relayId: "relay-2",
    serverUrl: "http://second-host:8787",
    serverUrls: ["http://second-host.local:8787"],
  });
  const repaired = hosts.upsertPairedHost({
    clientToken: "replacement-token",
    relayId: "relay-2",
    serverUrl: "http://second-host.local:8787",
    serverUrls: ["http://second-host:8787"],
  });

  expect(repaired.id).toBe(paired.id);
  expect(hosts.getPairedHosts()).toHaveLength(2);
  expect(hosts.getHostClientToken(repaired.id)).toBe("replacement-token");
  expect(hosts.getHostClientToken(migratedHost?.id)).toBe("legacy-token");
  expect(repaired.urlCandidates).toEqual([
    "http://second-host.local:8787",
    "http://second-host:8787",
  ]);

  const secureTransport = await import("../../../apps/mobile/src/lib/secure-transport.js");
  secureTransport.persistSecureSession(migratedHost!.id, {
    keyEpoch: 1,
    lastServerCounter: 0,
    mobileToServerKey: new Uint8Array(32).fill(1),
    nextMobileCounter: 2,
    serverToMobileKey: new Uint8Array(32).fill(2),
  });
  secureTransport.persistSecureSession(repaired.id, {
    keyEpoch: 2,
    lastServerCounter: 0,
    mobileToServerKey: new Uint8Array(32).fill(3),
    nextMobileCounter: 11,
    serverToMobileKey: new Uint8Array(32).fill(4),
  });
  expect(
    JSON.parse(secureTransport.encryptRequestPayload({ host: 1 }, migratedHost!.id)).counter,
  ).toBe(2);
  expect(JSON.parse(secureTransport.encryptRequestPayload({ host: 2 }, repaired.id)).counter).toBe(
    11,
  );

  expect(hosts.removePairedHostRecord(repaired.id)).toBe(migratedHost?.id);
  expect(hosts.getActiveHostId()).toBe(migratedHost?.id);
});
