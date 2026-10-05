import {
  type Message,
  type Tool,
  type TranscriptContext,
  getSystemMessageText,
  renderSystemMessageUpdate,
  getCurrentTools,
} from "@earendil-works/pi-ai";

export interface ContentPart {
  type: "text" | "image";
  text?: string;
  mimeType?: string;
  base64Data?: string;
}

export interface ChatHistoryItem {
  role: "user" | "assistant" | "system" | "tool";
  content: string | ContentPart[];
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: unknown;
}

export interface MappedChat {
  messages: ChatHistoryItem[];
  tools: ToolDef[];
}

function userContent(content: Message["content"]): string | ContentPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: ContentPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") parts.push({ type: "text", text: part.text });
    if (part.type === "image") {
      parts.push({ type: "image", mimeType: part.mimeType, base64Data: part.data });
    }
  }
  return parts;
}

export function mapContextToChat(context: TranscriptContext): MappedChat {
  const messages: ChatHistoryItem[] = [];
  const pendingToolCalls = new Set<string>();
  const pendingUpdates: ChatHistoryItem[] = [];
  const closeToolCalls = () => {
    // A new turn or transcript end closes interrupted batches, matching Pi's turn boundaries.
    pendingToolCalls.clear();
    messages.push(...pendingUpdates.splice(0));
  };
  let hasSystemMessage = false;
  for (const [index, message] of context.messages.entries()) {
    if (message.role === "system") {
      const text = hasSystemMessage ? renderSystemMessageUpdate(message) : getSystemMessageText(message);
      hasSystemMessage = true;
      if (text) {
        // Devin carries instructions in user text. Keep updates out of the cached head and
        // never insert them between tool calls and their results, even for custom transcripts.
        const target = pendingToolCalls.size > 0 ? pendingUpdates : messages;
        target.push(index === 0
          ? { role: "system", content: text }
          : { role: "user", content: `<system>\n${text}\n</system>` });
      }
      continue;
    }
    if (message.role === "user") {
      closeToolCalls();
      messages.push({ role: "user", content: userContent(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      closeToolCalls();
      const texts: string[] = [];
      const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
      for (const part of message.content) {
        if (part.type === "text") texts.push(part.text);
        if (part.type === "toolCall") {
          // Pi never executes tools from interrupted responses, so no results will arrive.
          if (message.stopReason !== "aborted" && message.stopReason !== "error") {
            pendingToolCalls.add(part.id);
          }
          toolCalls.push({
            id: part.id,
            name: part.name,
            arguments: JSON.stringify(part.arguments ?? {}),
          });
        }
      }
      messages.push({
        role: "assistant",
        content: texts.join("\n"),
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });
      continue;
    }
    if (message.role === "toolResult") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
      messages.push({
        role: "tool",
        content: text,
        tool_call_id: message.toolCallId,
      });
      pendingToolCalls.delete(message.toolCallId);
      if (pendingToolCalls.size === 0) closeToolCalls();
    }
  }

  closeToolCalls();
  const tools: ToolDef[] = getCurrentTools(context.messages).map((tool: Tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

  return { messages, tools };
}
