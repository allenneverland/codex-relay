import type { ChatMessage } from "codex-relay/api-schema";
import { memo, useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";

import { ThemedText } from "@/components/themed-text";
import { Icon } from "@/components/ui/icon";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { hapticSelection } from "@/lib/haptics";

import { MessageBubble } from "./MessageBubble";
import type { WorkspaceMarkdownPreviewTarget } from "./workspace-preview/markdown-target";

export const CommentaryGroup = memo(function CommentaryGroup({
  isActive,
  messages,
  onMessageCopied,
  onOpenMarkdownAttachment,
  turnId,
}: {
  isActive: boolean;
  messages: ChatMessage[];
  onMessageCopied?: () => void;
  onOpenMarkdownAttachment?: (target: WorkspaceMarkdownPreviewTarget) => void;
  turnId: string;
}) {
  const [isExpanded, setExpanded] = useState(isActive);
  const theme = useTheme();
  const latestUpdate = useMemo(
    () => compactCommentaryPreview(messages.at(-1)?.content),
    [messages],
  );

  useEffect(() => {
    setExpanded(isActive);
  }, [isActive, turnId]);

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: theme.backgroundElement, borderColor: theme.backgroundSelected },
      ]}
    >
      <Pressable
        accessibilityLabel={`Codex progress, ${messages.length} updates`}
        accessibilityRole="button"
        accessibilityState={{ expanded: isExpanded }}
        onPress={() => {
          hapticSelection();
          setExpanded((current) => !current);
        }}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
      >
        <View style={styles.headerText}>
          <ThemedText type="smallBold">Codex progress</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {latestUpdate || `${messages.length} updates`}
          </ThemedText>
        </View>
        <Icon
          name={isExpanded ? "expand" : "chevronRight"}
          size={16}
          tintColor={theme.textSecondary}
        />
      </Pressable>

      {isExpanded ? (
        <Animated.View entering={FadeIn.duration(120)} style={styles.content}>
          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              onMessageCopied={onMessageCopied}
              onOpenMarkdownAttachment={onOpenMarkdownAttachment}
              presentation="commentary"
            />
          ))}
        </Animated.View>
      ) : null}
    </View>
  );
});

function compactCommentaryPreview(content: string | undefined) {
  return content?.replace(/\s+/g, " ").trim();
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 12,
    borderWidth: 1,
    marginVertical: Spacing.two,
    overflow: "hidden",
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: Spacing.two,
    minHeight: 58,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  content: {
    borderTopColor: "rgba(255, 255, 255, 0.08)",
    borderTopWidth: 1,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  pressed: {
    opacity: 0.72,
  },
});
