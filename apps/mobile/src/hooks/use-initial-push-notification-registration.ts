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
import { chatStore$ } from "@/state/chat-store";

export function useInitialPushNotificationRegistration() {
  const hasPairedSession = useSelector(() => chatStore$.hasPairedSession.get());
  const preferencesRef = useRef<PushNotificationPreferences>(defaultPushNotificationPreferences);
  const syncPromiseRef = useRef<Promise<void> | undefined>(undefined);

  useEffect(() => {
    if (!hasPairedSession || !supportsPushNotifications()) {
      return;
    }

    const syncRegistration = () => {
      if (syncPromiseRef.current) {
        return syncPromiseRef.current;
      }
      const sync = (async () => {
        const settings = await getPushNotificationSettings();
        const preferences =
          settings.registered ||
          settings.preferences.actionRequired ||
          settings.preferences.turnTerminal
            ? settings.preferences
            : defaultPushNotificationPreferences;
        preferencesRef.current = preferences;
        await registerPushNotifications({
          ...(await getApnsPushRegistration()),
          preferences,
        });
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
      void registerPushNotifications({
        ...registration,
        preferences: preferencesRef.current,
      }).catch(() => undefined);
    });

    return () => {
      appStateSubscription.remove();
      tokenSubscription.remove();
    };
  }, [hasPairedSession]);
}
