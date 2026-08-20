import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Platform,
  Pressable,
  View,
} from "react-native";
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

const SCANNER_TO_APPROVAL_SHEET_DELAY_MS = 450;

export default function PairScreen() {
  const params = useLocalSearchParams();
  const initialPairingUrl = useMemo(() => pairingUrlFromParams(params), [params]);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const pairingRef = useRef(false);
  const nativeScannerOpenRef = useRef(false);
  const resumeNativeScannerRef = useRef(false);
  const didAutoLaunchScannerRef = useRef(false);
  const handledInitialUrlRef = useRef<string | undefined>(undefined);
  const [approval, setApproval] = useState<{ code: string; serverUrl: string } | undefined>();
  const [appState, setAppState] = useState(AppState.currentState);
  const [isEmbeddedScannerVisible, setEmbeddedScannerVisible] = useState(false);
  const [isFocused, setFocused] = useState(false);
  const [isApprovalVisible, setApprovalVisible] = useState(false);
  const [isPairing, setPairing] = useState(false);
  const [message, setMessage] = useState("Scan the connection QR or paste its pairing link.");

  const dismissNativeScanner = useCallback(async () => {
    const wasOpen = nativeScannerOpenRef.current;
    nativeScannerOpenRef.current = false;
    if (wasOpen && CameraView.isModernBarcodeScannerAvailable) {
      await CameraView.dismissScanner().catch(() => undefined);
    }
  }, []);

  const stopScanner = useCallback(async () => {
    setEmbeddedScannerVisible(false);
    await dismissNativeScanner();
  }, [dismissNativeScanner]);

  const pair = useCallback(
    async (payload: unknown) => {
      if (pairingRef.current) {
        return;
      }
      pairingRef.current = true;
      setPairing(true);
      setMessage("Pairing link detected. Connecting…");
      await stopScanner();
      try {
        await pairWithQrPayload(payload, {
          onApprovalCode(code, serverUrl) {
            setApproval({ code, serverUrl });
            setMessage("Approve this phone from the relay terminal.");
            void delay(SCANNER_TO_APPROVAL_SHEET_DELAY_MS).then(() => {
              if (pairingRef.current) {
                setApprovalVisible(true);
              }
            });
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
            ? "This is not a Codex Relay pairing link. Scan or paste the link shown on your computer."
            : "Could not connect. Check Wi-Fi or Tailscale, then try again.",
        );
        hapticWarning();
        Alert.alert(
          invalidQr ? "Invalid pairing link" : "Pairing failed",
          invalidQr
            ? "Run npx codex-relay@latest on your computer, then scan or paste the pairing link shown there."
            : "Use the same Wi-Fi on both devices, or turn on Tailscale and try again.",
        );
      }
    },
    [stopScanner],
  );

  const openScanner = useCallback(async () => {
    if (
      pairingRef.current ||
      initialPairingUrl ||
      !isFocused ||
      AppState.currentState !== "active"
    ) {
      return;
    }

    let permission = cameraPermission;
    if (!permission?.granted) {
      permission = await requestCameraPermission();
    }
    if (!permission.granted) {
      setMessage("Camera access is off. Allow it to scan, or paste the pairing link instead.");
      return;
    }

    setEmbeddedScannerVisible(false);
    setMessage("Point the camera at the connection QR.");
    await dismissNativeScanner();

    if (CameraView.isModernBarcodeScannerAvailable) {
      nativeScannerOpenRef.current = true;
      try {
        await CameraView.launchScanner({
          barcodeTypes: ["qr"],
          isHighlightingEnabled: true,
        });
        if (!pairingRef.current && AppState.currentState === "active") {
          return;
        }
        await dismissNativeScanner();
      } catch (caught) {
        nativeScannerOpenRef.current = false;
        if (isBarcodeScannerCancellation(caught)) {
          return;
        }
      }
    }

    if (!pairingRef.current && AppState.currentState === "active") {
      setEmbeddedScannerVisible(true);
    }
  }, [
    cameraPermission,
    dismissNativeScanner,
    initialPairingUrl,
    isFocused,
    requestCameraPermission,
  ]);

  const handlePastedPairingLink = useCallback(
    (value: string | undefined) => {
      const pairingLink = value?.trim();
      if (!pairingLink || !isPairingLink(pairingLink)) {
        setMessage("Paste the codex-relay:// pairing link shown by the relay terminal.");
        hapticWarning();
        Alert.alert(
          "Invalid pairing link",
          "Copy the complete codex-relay://pair link printed by codex-relay, then paste it here.",
        );
        return;
      }
      void pair(pairingLink);
    },
    [pair],
  );

  const pastePairingLink = useCallback(async () => {
    try {
      handlePastedPairingLink(await Clipboard.getStringAsync());
    } catch {
      Alert.alert("Could not paste", "Copy the pairing link again, then retry.");
    }
  }, [handlePastedPairingLink]);

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

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => {
        setFocused(false);
        resumeNativeScannerRef.current = false;
        void dismissNativeScanner();
      };
    }, [dismissNativeScanner]),
  );

  useEffect(() => {
    if (
      didAutoLaunchScannerRef.current ||
      !isFocused ||
      appState !== "active" ||
      !cameraPermission?.granted ||
      initialPairingUrl
    ) {
      return;
    }
    didAutoLaunchScannerRef.current = true;
    void openScanner();
  }, [appState, cameraPermission?.granted, initialPairingUrl, isFocused, openScanner]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      setAppState(nextState);
      if (nextState !== "active" && nativeScannerOpenRef.current) {
        resumeNativeScannerRef.current = true;
        void dismissNativeScanner();
      }
    });
    return () => subscription.remove();
  }, [dismissNativeScanner]);

  useEffect(() => {
    if (
      appState !== "active" ||
      !isFocused ||
      !resumeNativeScannerRef.current ||
      pairingRef.current
    ) {
      return;
    }
    resumeNativeScannerRef.current = false;
    void openScanner();
  }, [appState, isFocused, openScanner]);

  useEffect(() => {
    const subscription = CameraView.onModernBarcodeScanned((result) => {
      if (!nativeScannerOpenRef.current || pairingRef.current) {
        return;
      }
      void pair(result.data);
    });
    return () => subscription.remove();
  }, [pair]);

  async function close() {
    resumeNativeScannerRef.current = false;
    await stopScanner();
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/");
  }

  return (
    <View style={styles.screen}>
      {isEmbeddedScannerVisible && cameraPermission?.granted && !initialPairingUrl ? (
        <CameraView
          active={appState === "active" && isFocused && !isPairing}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          facing="back"
          onBarcodeScanned={isPairing ? undefined : (result) => void pair(result.data)}
          onCameraReady={() => setMessage("Point the camera at the connection QR.")}
          onMountError={() => {
            setEmbeddedScannerVisible(false);
            setMessage(
              "Camera preview is unavailable. Retry the scanner or paste the pairing link.",
            );
          }}
          style={styles.camera}
        />
      ) : (
        <View style={styles.permissionPane}>
          {initialPairingUrl || !cameraPermission ? (
            <ActivityIndicator color={Colors.dark.textSecondary} />
          ) : !cameraPermission.granted ? (
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
          ) : (
            <View style={styles.readyCard}>
              <ThemedText type="smallBold" style={styles.permissionTitle}>
                Ready to pair
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.centeredCopy}>
                Open the scanner again, or paste the full pairing link from the relay terminal.
              </ThemedText>
            </View>
          )}
        </View>
      )}

      <SafeAreaView
        edges={["top", "left", "right", "bottom"]}
        pointerEvents="box-none"
        style={styles.overlay}
      >
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Close pairing"
            accessibilityRole="button"
            onPress={() => void close()}
            style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
          >
            <Icon name="back" size={18} tintColor={Colors.dark.text} />
          </Pressable>
          <ThemedText type="smallBold" style={styles.headerTitle}>
            Pair another computer
          </ThemedText>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.footer}>
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
          {!initialPairingUrl && !isPairing ? (
            <View style={styles.actions}>
              <Pressable
                accessibilityLabel="Scan pairing QR"
                accessibilityRole="button"
                onPress={() => void openScanner()}
                style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
              >
                <ThemedText type="smallBold">Scan QR</ThemedText>
              </Pressable>
              {Platform.OS === "ios" && Clipboard.isPasteButtonAvailable ? (
                <Clipboard.ClipboardPasteButton
                  acceptedContentTypes={["plain-text", "url"]}
                  backgroundColor="rgba(255, 255, 255, 0.12)"
                  cornerStyle="large"
                  displayMode="iconAndLabel"
                  foregroundColor={Colors.dark.text}
                  onPress={(event) =>
                    handlePastedPairingLink(event.type === "text" ? event.text : undefined)
                  }
                  style={styles.nativePasteButton}
                />
              ) : (
                <Pressable
                  accessibilityLabel="Paste pairing link"
                  accessibilityRole="button"
                  onPress={() => void pastePairingLink()}
                  style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
                >
                  <ThemedText type="smallBold">Paste link</ThemedText>
                </Pressable>
              )}
            </View>
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

function isPairingLink(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "codex-relay:" && url.hostname === "pair";
  } catch {
    return false;
  }
}

function isBarcodeScannerCancellation(error: unknown) {
  return error instanceof Error && error.message.toLowerCase().includes("cancel");
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

const styles = StyleSheet.create({
  actionButton: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.12)",
    borderColor: "rgba(255, 255, 255, 0.14)",
    borderRadius: 12,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    minWidth: 136,
    paddingHorizontal: Spacing.three,
  },
  actions: {
    alignItems: "center",
    flexDirection: "row",
    gap: Spacing.two,
    justifyContent: "center",
  },
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
  footer: {
    alignItems: "center",
    gap: Spacing.two,
    paddingBottom: Spacing.four,
    paddingHorizontal: Spacing.three,
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
  headerSpacer: {
    height: 40,
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
    maxWidth: 360,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  nativePasteButton: {
    height: 44,
    width: 136,
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
  readyCard: {
    gap: Spacing.two,
    maxWidth: 320,
    padding: Spacing.four,
  },
  showApprovalButton: {
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    borderRadius: 8,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
});
