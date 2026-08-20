import { CameraView, useCameraPermissions } from "expo-camera";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";

import { approvalCommand } from "@/components/chat/pairing-commands";
import { ThemedText } from "@/components/themed-text";
import { AppBottomSheet } from "@/components/ui/bottom-sheet";
import { CopyableCommand } from "@/components/ui/copyable-command";
import { Icon } from "@/components/ui/icon";
import { Colors, Spacing } from "@/constants/theme";
import { isPairingQrPayloadError, pairWithQrPayload } from "@/lib/codex-relay-api";
import { hapticSuccess, hapticWarning } from "@/lib/haptics";
import { resetChatSessionState, setConnection } from "@/state/chat-store";

export default function PairScreen() {
  const params = useLocalSearchParams();
  const initialPairingUrl = useMemo(() => pairingUrlFromParams(params), [params]);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const pairingRef = useRef(false);
  const handledInitialUrlRef = useRef<string | undefined>(undefined);
  const [approval, setApproval] = useState<{ code: string; serverUrl: string } | undefined>();
  const [isApprovalVisible, setApprovalVisible] = useState(false);
  const [isPairing, setPairing] = useState(false);
  const [message, setMessage] = useState("Point the camera at the connection QR.");

  const pair = useCallback(async (payload: unknown) => {
    if (pairingRef.current) {
      return;
    }
    pairingRef.current = true;
    setPairing(true);
    setMessage("QR detected. Connecting…");
    try {
      await pairWithQrPayload(payload, {
        onApprovalCode(code, serverUrl) {
          setApproval({ code, serverUrl });
          setApprovalVisible(true);
          setMessage("Approve this phone from the relay terminal.");
        },
      });
      hapticSuccess();
      resetChatSessionState();
      setConnection("checking");
      router.replace("/");
    } catch (caught) {
      pairingRef.current = false;
      setPairing(false);
      setApproval(undefined);
      setApprovalVisible(false);
      const invalidQr = isPairingQrPayloadError(caught);
      setMessage(
        invalidQr
          ? "This is not a Codex Relay QR. Scan the QR shown on your computer."
          : "Could not connect. Check Wi-Fi or Tailscale, then scan again.",
      );
      hapticWarning();
      Alert.alert(
        invalidQr ? "Invalid QR code" : "Pairing failed",
        invalidQr
          ? "Run npx codex-relay@latest on your computer, then scan the QR shown there."
          : "Use the same Wi-Fi on both devices, or turn on Tailscale and try again.",
      );
    }
  }, []);

  useEffect(() => {
    if (!initialPairingUrl || handledInitialUrlRef.current === initialPairingUrl) {
      return;
    }
    handledInitialUrlRef.current = initialPairingUrl;
    void pair(initialPairingUrl);
  }, [initialPairingUrl, pair]);

  useEffect(() => {
    if (cameraPermission || initialPairingUrl) {
      return;
    }
    void requestCameraPermission();
  }, [cameraPermission, initialPairingUrl, requestCameraPermission]);

  function close() {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/");
  }

  return (
    <View style={styles.screen}>
      {cameraPermission?.granted && !initialPairingUrl ? (
        <CameraView
          active={!isPairing}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          facing="back"
          onBarcodeScanned={isPairing ? undefined : (result) => void pair(result.data)}
          style={styles.camera}
        />
      ) : (
        <View style={styles.permissionPane}>
          {initialPairingUrl || !cameraPermission ? (
            <ActivityIndicator color={Colors.dark.textSecondary} />
          ) : (
            <View style={styles.permissionCard}>
              <ThemedText type="smallBold" style={styles.permissionTitle}>
                Camera access is off
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.centeredCopy}>
                Allow camera access to scan the connection QR shown by codex-relay.
              </ThemedText>
              <Pressable
                accessibilityRole="button"
                onPress={
                  cameraPermission.canAskAgain
                    ? () => void requestCameraPermission()
                    : () => void Linking.openSettings()
                }
                style={({ pressed }) => [styles.permissionButton, pressed && styles.pressed]}
              >
                <ThemedText type="smallBold">
                  {cameraPermission.canAskAgain ? "Allow Camera" : "Open Settings"}
                </ThemedText>
              </Pressable>
            </View>
          )}
        </View>
      )}

      <SafeAreaView edges={["top", "left", "right", "bottom"]} style={styles.overlay}>
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Close pairing"
            accessibilityRole="button"
            onPress={close}
            style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
          >
            <Icon name="back" size={18} tintColor={Colors.dark.text} />
          </Pressable>
          <ThemedText type="smallBold" style={styles.headerTitle}>
            Pair another computer
          </ThemedText>
          <View style={styles.headerButton} />
        </View>
        <View style={styles.messageCard}>
          {isPairing ? <ActivityIndicator color={Colors.dark.text} size="small" /> : null}
          <ThemedText type="smallBold" style={styles.centeredCopy}>
            {message}
          </ThemedText>
          {approval && !isApprovalVisible ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setApprovalVisible(true)}
              style={({ pressed }) => [styles.showApprovalButton, pressed && styles.pressed]}
            >
              <ThemedText type="smallBold">Show code</ThemedText>
            </Pressable>
          ) : null}
        </View>
      </SafeAreaView>

      <AppBottomSheet
        onClose={() => setApprovalVisible(false)}
        scrollable={false}
        subtitle="Finish pairing from the terminal where codex-relay is running."
        title="Approve this phone"
        visible={Boolean(approval && isApprovalVisible)}
      >
        {approval ? (
          <View style={styles.approvalContent}>
            <ThemedText type="small" themeColor="textSecondary">
              Approval code
            </ThemedText>
            <ThemedText selectable style={styles.approvalCode}>
              {approval.code}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Run this command on your computer:
            </ThemedText>
            <CopyableCommand
              command={approvalCommand(approval.code, approval.serverUrl)}
              copyAccessibilityLabel="Copy approval command"
            />
          </View>
        ) : null}
      </AppBottomSheet>
    </View>
  );
}

function pairingUrlFromParams(params: Record<string, string | string[]>) {
  const serverUrl = firstParam(params.serverUrl);
  const serverPublicKey = firstParam(params.serverPublicKey);
  if (!serverUrl || !serverPublicKey) {
    return null;
  }

  const pairingUrl = new URL("codex-relay://pair");
  pairingUrl.searchParams.set("serverUrl", serverUrl);
  pairingUrl.searchParams.set("serverPublicKey", serverPublicKey.replaceAll(" ", "+"));
  for (const key of ["h", "serverHosts", "serverUrls"]) {
    const value = firstParam(params[key]);
    if (value) {
      pairingUrl.searchParams.set(key, value);
    }
  }
  return pairingUrl.toString();
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

const styles = StyleSheet.create({
  approvalCode: {
    fontFamily: "GeistMono-Medium",
    fontSize: 28,
    letterSpacing: 4,
    lineHeight: 36,
  },
  approvalContent: {
    gap: Spacing.two,
  },
  camera: {
    ...StyleSheet.absoluteFillObject,
  },
  centeredCopy: {
    textAlign: "center",
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  headerButton: {
    alignItems: "center",
    backgroundColor: "rgba(32, 34, 34, 0.82)",
    borderColor: "rgba(255, 255, 255, 0.14)",
    borderRadius: 20,
    borderWidth: 1,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  headerTitle: {
    backgroundColor: "rgba(32, 34, 34, 0.82)",
    borderColor: "rgba(255, 255, 255, 0.14)",
    borderRadius: 18,
    borderWidth: 1,
    overflow: "hidden",
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  messageCard: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: "rgba(32, 34, 34, 0.88)",
    borderColor: "rgba(255, 255, 255, 0.14)",
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: Spacing.two,
    marginBottom: Spacing.four,
    maxWidth: 360,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  overlay: {
    flex: 1,
    justifyContent: "space-between",
  },
  permissionButton: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderRadius: 8,
    padding: Spacing.three,
  },
  permissionCard: {
    backgroundColor: Colors.dark.backgroundElement,
    borderColor: "rgba(255, 255, 255, 0.14)",
    borderRadius: 12,
    borderWidth: 1,
    gap: Spacing.three,
    maxWidth: 340,
    padding: Spacing.four,
    width: "100%",
  },
  permissionPane: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    padding: Spacing.four,
  },
  permissionTitle: {
    fontSize: 17,
    lineHeight: 22,
    textAlign: "center",
  },
  pressed: {
    opacity: 0.7,
  },
  screen: {
    backgroundColor: Colors.dark.background,
    flex: 1,
  },
  showApprovalButton: {
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    borderRadius: 8,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
});
