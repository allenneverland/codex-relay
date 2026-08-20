import * as Application from "expo-application";
import * as Notifications from "expo-notifications";
import type { PushNotificationPreferences } from "codex-relay/api-schema";
import { Platform } from "react-native";

export const codexRelayBundleId = "com.allenneverland.codexrelay";

export const defaultPushNotificationPreferences: PushNotificationPreferences = {
  actionRequired: true,
  turnTerminal: true,
};

let foregroundNotificationHandlerConfigured = false;

export class PushNotificationPermissionDeniedError extends Error {
  constructor() {
    super("Notifications are not allowed for Codex Relay.");
    this.name = "PushNotificationPermissionDeniedError";
  }
}

export function configurePushNotificationPresentation() {
  if (!supportsPushNotifications() || foregroundNotificationHandlerConfigured) {
    return;
  }
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
  foregroundNotificationHandlerConfigured = true;
}

export function supportsPushNotifications() {
  return Platform.OS === "ios";
}

export async function getApnsPushRegistration() {
  assertIosBundle();
  const existingPermissions = await Notifications.getPermissionsAsync();
  const permissions =
    existingPermissions.status === "granted"
      ? existingPermissions
      : await Notifications.requestPermissionsAsync();
  if (permissions.status !== "granted") {
    throw new PushNotificationPermissionDeniedError();
  }
  return apnsPushRegistrationFromToken(await Notifications.getDevicePushTokenAsync());
}

export async function apnsPushRegistrationFromToken(token: Notifications.DevicePushToken) {
  assertIosBundle();
  if (token.type !== "ios" || typeof token.data !== "string" || !token.data.trim()) {
    throw new Error("iOS did not return a valid APNs device token.");
  }
  const environment = await Application.getIosPushNotificationServiceEnvironmentAsync();
  if (environment !== "development" && environment !== "production") {
    throw new Error("This iOS build does not expose an APNs environment.");
  }
  return {
    bundleId: codexRelayBundleId,
    deviceToken: token.data.replaceAll(/[< >]/g, ""),
    environment,
    provider: "apns" as const,
  };
}

export function addApnsPushTokenListener(
  listener: (registration: Awaited<ReturnType<typeof getApnsPushRegistration>>) => void,
) {
  return Notifications.addPushTokenListener((token) => {
    void apnsPushRegistrationFromToken(token)
      .then(listener)
      .catch(() => undefined);
  });
}

export function notificationResponseTarget(response: Notifications.NotificationResponse) {
  const data = notificationResponseData(response);
  const threadId = data?.threadId;
  if (typeof threadId !== "string" || !threadId.trim() || threadId === "test") {
    return undefined;
  }
  const relayId = data?.relayId;
  return {
    relayId: typeof relayId === "string" && relayId.trim() ? relayId : undefined,
    threadId,
  };
}

function notificationResponseData(response: Notifications.NotificationResponse) {
  const contentData = response.notification.request.content.data;
  if (contentData && Object.keys(contentData).length > 0) {
    return contentData;
  }
  const trigger = response.notification.request.trigger;
  if (!trigger || typeof trigger !== "object" || !("payload" in trigger)) {
    return undefined;
  }
  const payload = trigger.payload;
  return payload && typeof payload === "object" ? payload : undefined;
}

function assertIosBundle() {
  if (Platform.OS !== "ios") {
    throw new Error("Direct APNs notifications are available only in the iOS app.");
  }
  if (Application.applicationId !== codexRelayBundleId) {
    throw new Error(
      `Expected bundle ID ${codexRelayBundleId}, received ${Application.applicationId ?? "unknown"}.`,
    );
  }
}
