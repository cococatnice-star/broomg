import type { Response } from "express";
import type { ChatMessage } from "@workspace/api-zod";

export type ChatStreamScope = "public" | "visitor" | "owner";

type Subscriber = {
  response: Response;
  scope: ChatStreamScope;
  conversationId?: string;
};

const subscribers = new Set<Subscriber>();

export function subscribeToChat(
  response: Response,
  scope: ChatStreamScope,
  conversationId?: string,
): () => void {
  const subscriber = { response, scope, conversationId };
  subscribers.add(subscriber);

  return () => {
    subscribers.delete(subscriber);
  };
}

export function broadcastChatMessage(message: ChatMessage): void {
  const event = `event: message\ndata: ${JSON.stringify(message)}\n\n`;

  for (const subscriber of subscribers) {
    const { response, scope, conversationId } = subscriber;
    if (response.writableEnded || response.destroyed) {
      subscribers.delete(subscriber);
      continue;
    }

    const shouldReceive =
      (scope === "public" && message.channel === "public") ||
      (scope === "owner" && message.channel === "private") ||
      (scope === "visitor" &&
        message.channel === "private" &&
        message.conversationId === conversationId);

    if (shouldReceive) {
      response.write(event);
    }
  }
}
