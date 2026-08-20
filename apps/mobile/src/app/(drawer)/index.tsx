import { useSelector } from "@legendapp/state/react";

import { ChatScreen } from "@/components/chat/ChatScreen";
import { pairedHostStore$ } from "@/state/paired-host-store";

export default function HomeScreen() {
  const activeHostId = useSelector(() => pairedHostStore$.activeHostId.get());
  return <ChatScreen key={activeHostId ?? "unpaired"} />;
}
