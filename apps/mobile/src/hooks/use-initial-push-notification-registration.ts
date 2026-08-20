import { useSelector } from "@legendapp/state/react";
import type { PushNotificationPreferences } from "codex-relay/api-schema";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";

import { getPushNotificationSettings, registerPushNotifications } from "@/lib/codex-relay-api";
import {
  addApnsPushTokenListener,
  defaultPushNotificationPreferences,
  getApnsPushRegistration,
  supportsPushNotifications,
} from "@/lib/push-notifications";
import { hasPairedHostSession, pairedHostStore$ } from "@/state/paired-host-store";

export function useInitialPushNotificationRegistration() {
  const hostIds = useSelector(() => pairedHostStore$.hostIds.get());
  const pairingRevision = useSelector(() => pairedHostStore$.pairingRevision.get());
  const hostIdsRef = useRef(hostIds);
  const preferencesRef = useRef<Record<string, PushNotificationPreferences>>({});
  const syncPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const syncRequestedRef = useRef(false);

  hostIdsRef.current = hostIds;

  useEffect(() => {
    if (hostIds.length === 0 || !supportsPushNotifications()) {
      return;
    }

    const syncRegistration = () => {
      if (syncPromiseRef.current) {
        syncRequestedRef.current = true;
        return syncPromiseRef.current;
      }
      const sync = (async () => {
        do {
          syncRequestedRef.current = false;
          const registration = await getApnsPushRegistration();
          for (const hostId of hostIdsRef.current) {
            if (!hasPairedHostSession(hostId)) {
              continue;
            }
            try {
              const settings = await getPushNotificationSettings(hostId);
              const preferences =
                settings.registered ||
                settings.preferences.actionRequired ||
                settings.preferences.turnTerminal
                  ? settings.preferences
                  : defaultPushNotificationPreferences;
              preferencesRef.current[hostId] = preferences;
              await registerPushNotifications({ ...registration, preferences }, hostId);
            } catch {
              // One offline host must not prevent the others from registering.
            }
          }
        } while (syncRequestedRef.current);
      })();
      syncPromiseRef.current = sync;
      const clearSync = () => {
        if (syncPromiseRef.current === sync) {
          syncPromiseRef.current = undefined;
        }
      };
      void sync.then(clearSync, clearSync);
      return sync;
    };

    void syncRegistration().catch(() => undefined);
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void syncRegistration().catch(() => undefined);
      }
    });
    const tokenSubscription = addApnsPushTokenListener((registration) => {
      for (const hostId of hostIdsRef.current) {
        if (!hasPairedHostSession(hostId)) {
          continue;
        }
        void registerPushNotifications(
          {
            ...registration,
            preferences: preferencesRef.current[hostId] ?? defaultPushNotificationPreferences,
          },
          hostId,
        ).catch(() => undefined);
      }
    });

    return () => {
      appStateSubscription.remove();
      tokenSubscription.remove();
    };
  }, [hostIds, pairingRevision]);
}
