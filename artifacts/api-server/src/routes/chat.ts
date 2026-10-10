import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { clerkClient, getAuth } from "@clerk/express";
import {
  CreateChatMessageBody,
  CreateChatMessageResponse,
  GetOwnerChatConversationParams,
  GetOwnerChatConversationResponse,
  GetVisitorChatConversationHeader,
  GetVisitorChatConversationParams,
  GetVisitorChatConversationResponse,
  ListOwnerChatConversationsResponse,
  ListPublicChatMessagesResponse,
  SendOwnerChatReplyBody,
  SendOwnerChatReplyParams,
  SendOwnerChatReplyResponse,
  StreamChatMessagesHeader,
  StreamChatMessagesQueryParams,
} from "@workspace/api-zod";
import {
  chatConversationsTable,
  chatMessagesTable,
  db,
} from "@workspace/db";
import type { ChatConversation, ChatMessage } from "@workspace/db";
import { Router, type IRouter, type RequestHandler } from "express";
import {
  broadcastChatMessage,
  subscribeToChat,
  type ChatStreamScope,
} from "../lib/chatRealtime";

const router: IRouter = Router();
const OWNER_DISPLAY_NAME = "CocoX Owner";
const PRIVATE_PREVIEW_LENGTH = 120;
const OWNER_ACCESS_CACHE_TTL_MS = 30_000;
const ownerAccessCache = new Map<string, number>();

async function ownerAuthFailure(req: Parameters<RequestHandler>[0]): Promise<{
  status: number;
  message: string;
} | null> {
  const auth = getAuth(req);
  if (!auth.userId) {
    return { status: 401, message: "Sign in to continue." };
  }

  const configuredEmail = process.env.CHAT_OWNER_EMAIL?.trim().toLowerCase();
  if (!configuredEmail) {
    req.log.error("Owner email allowlist is not configured");
    return { status: 503, message: "Owner access is not configured." };
  }

  const cachedUntil = ownerAccessCache.get(`${auth.userId}:${configuredEmail}`);
  if (cachedUntil && cachedUntil > Date.now()) return null;

  try {
    const user = await clerkClient.users.getUser(auth.userId);
    const hasVerifiedOwnerEmail = user.emailAddresses.some(
      (address) =>
        address.verification?.status === "verified" &&
        address.emailAddress.trim().toLowerCase() === configuredEmail,
    );
    if (!hasVerifiedOwnerEmail) {
      return { status: 403, message: "Owner access is required." };
    }

    ownerAccessCache.set(
      `${auth.userId}:${configuredEmail}`,
      Date.now() + OWNER_ACCESS_CACHE_TTL_MS,
    );
  } catch (error) {
    req.log.error({ err: error }, "Unable to verify owner email with Clerk");
    return { status: 503, message: "Owner access could not be verified." };
  }

  return null;
}

const requireOwner: RequestHandler = async (req, res, next) => {
  const failure = await ownerAuthFailure(req);
  if (failure) {
    res.status(failure.status).json({ error: failure.message });
    return;
  }
  next();
};

function visitorTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toConversationSummary(
  conversation: ChatConversation,
  lastMessage: ChatMessage,
) {
  return {
    id: conversation.id,
    guestName: conversation.guestName,
    preview: lastMessage.body.slice(0, PRIVATE_PREVIEW_LENGTH),
    updatedAt: conversation.updatedAt,
  };
}

async function getThread(conversationId: string) {
  const [conversation] = await db
    .select()
    .from(chatConversationsTable)
    .where(eq(chatConversationsTable.id, conversationId))
    .limit(1);
  if (!conversation) return null;

  const messages = await db
    .select()
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.conversationId, conversationId))
    .orderBy(asc(chatMessagesTable.id));
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) return null;

  return {
    conversation,
    summary: toConversationSummary(conversation, lastMessage),
    messages,
  };
}

async function storeMessage(input: {
  channel: "public" | "private";
  senderRole: "visitor" | "owner";
  senderName: string;
  body: string;
  conversationId: string | null;
}) {
  const [row] = await db
    .insert(chatMessagesTable)
    .values(input)
    .returning();
  const message = CreateChatMessageResponse.parse(row);
  broadcastChatMessage(message);
  return message;
}

router.get("/chat/messages/public", async (req, res): Promise<void> => {
  const recentMessages = await db
    .select()
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.channel, "public"))
    .orderBy(desc(chatMessagesTable.id))
    .limit(100);

  res.json(
    ListPublicChatMessagesResponse.parse({
      messages: recentMessages.reverse(),
    }),
  );
});

router.post("/chat/messages", async (req, res): Promise<void> => {
  const parsed = CreateChatMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a name and a message to continue." });
    return;
  }

  const senderName = parsed.data.senderName.trim();
  const body = parsed.data.body.trim();
  if (!senderName || !body) {
    res.status(400).json({ error: "Enter a name and a message to continue." });
    return;
  }
  if (senderName.toLowerCase() === OWNER_DISPLAY_NAME.toLowerCase()) {
    res.status(400).json({ error: "That display name is reserved." });
    return;
  }

  if (parsed.data.channel === "public") {
    if (parsed.data.conversationId) {
      res.status(400).json({ error: "Public messages cannot use a private thread." });
      return;
    }
    const message = await storeMessage({
      channel: "public",
      senderRole: "visitor",
      senderName,
      body,
      conversationId: null,
    });
    res.status(201).json(message);
    return;
  }

  const tokenHash = visitorTokenHash(parsed.data.visitorToken);
  const [knownConversation] = await db
    .select()
    .from(chatConversationsTable)
    .where(eq(chatConversationsTable.visitorTokenHash, tokenHash))
    .limit(1);

  if (
    parsed.data.conversationId &&
    knownConversation?.id !== parsed.data.conversationId
  ) {
    res.status(403).json({ error: "This private conversation is unavailable." });
    return;
  }

  let conversation = knownConversation;
  if (!conversation) {
    const [created] = await db
      .insert(chatConversationsTable)
      .values({ visitorTokenHash: tokenHash, guestName: senderName })
      .onConflictDoNothing({
        target: chatConversationsTable.visitorTokenHash,
      })
      .returning();
    conversation =
      created ??
      (
        await db
          .select()
          .from(chatConversationsTable)
          .where(eq(chatConversationsTable.visitorTokenHash, tokenHash))
          .limit(1)
      )[0];
  }
  if (!conversation) {
    res.status(500).json({ error: "The private message could not be saved." });
    return;
  }

  await db
    .update(chatConversationsTable)
    .set({ guestName: senderName, updatedAt: new Date() })
    .where(eq(chatConversationsTable.id, conversation.id));

  const message = await storeMessage({
    channel: "private",
    senderRole: "visitor",
    senderName,
    body,
    conversationId: conversation.id,
  });
  res.status(201).json(message);
});

router.get(
  "/chat/conversations/:conversationId",
  async (req, res): Promise<void> => {
    const params = GetVisitorChatConversationParams.safeParse({
      conversationId: req.params.conversationId,
    });
    const headers = GetVisitorChatConversationHeader.safeParse({
      "X-Chat-Token": req.get("X-Chat-Token"),
    });
    if (!params.success || !headers.success) {
      res.status(400).json({ error: "A valid conversation and token are required." });
      return;
    }

    const tokenHash = visitorTokenHash(headers.data["X-Chat-Token"]);
    const [conversation] = await db
      .select()
      .from(chatConversationsTable)
      .where(
        and(
          eq(chatConversationsTable.id, params.data.conversationId),
          eq(chatConversationsTable.visitorTokenHash, tokenHash),
        ),
      )
      .limit(1);
    if (!conversation) {
      res.status(403).json({ error: "This private conversation is unavailable." });
      return;
    }

    const thread = await getThread(conversation.id);
    if (!thread) {
      res.status(404).json({ error: "This private conversation is unavailable." });
      return;
    }

    res.json(
      GetVisitorChatConversationResponse.parse({
        conversation: thread.summary,
        messages: thread.messages,
      }),
    );
  },
);

router.get(
  "/chat/owner/conversations",
  requireOwner,
  async (_req, res): Promise<void> => {
    const conversations = await db
      .select()
      .from(chatConversationsTable)
      .orderBy(desc(chatConversationsTable.updatedAt))
      .limit(100);
    if (conversations.length === 0) {
      res.json(ListOwnerChatConversationsResponse.parse({ conversations: [] }));
      return;
    }

    const ids = conversations.map((conversation) => conversation.id);
    const recentMessages = await db
      .select()
      .from(chatMessagesTable)
      .where(
        and(
          eq(chatMessagesTable.channel, "private"),
          inArray(chatMessagesTable.conversationId, ids),
        ),
      )
      .orderBy(desc(chatMessagesTable.id));

    const latestByConversation = new Map<string, ChatMessage>();
    for (const message of recentMessages) {
      if (
        message.conversationId &&
        !latestByConversation.has(message.conversationId)
      ) {
        latestByConversation.set(message.conversationId, message);
      }
    }

    const summaries = conversations.flatMap((conversation) => {
      const latest = latestByConversation.get(conversation.id);
      return latest ? [toConversationSummary(conversation, latest)] : [];
    });
    res.json(
      ListOwnerChatConversationsResponse.parse({ conversations: summaries }),
    );
  },
);

router.get(
  "/chat/owner/conversations/:conversationId",
  requireOwner,
  async (req, res): Promise<void> => {
    const params = GetOwnerChatConversationParams.safeParse({
      conversationId: req.params.conversationId,
    });
    if (!params.success) {
      res.status(400).json({ error: "A valid conversation is required." });
      return;
    }

    const thread = await getThread(params.data.conversationId);
    if (!thread) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }

    res.json(
      GetOwnerChatConversationResponse.parse({
        conversation: thread.summary,
        messages: thread.messages,
      }),
    );
  },
);

router.post(
  "/chat/owner/conversations/:conversationId/messages",
  requireOwner,
  async (req, res): Promise<void> => {
    const params = SendOwnerChatReplyParams.safeParse({
      conversationId: req.params.conversationId,
    });
    const parsed = SendOwnerChatReplyBody.safeParse(req.body);
    if (!params.success || !parsed.success || !parsed.data.body.trim()) {
      res.status(400).json({ error: "Enter a reply before sending." });
      return;
    }

    const [conversation] = await db
      .select({ id: chatConversationsTable.id })
      .from(chatConversationsTable)
      .where(eq(chatConversationsTable.id, params.data.conversationId))
      .limit(1);
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }

    await db
      .update(chatConversationsTable)
      .set({ updatedAt: new Date() })
      .where(eq(chatConversationsTable.id, conversation.id));
    const message = await storeMessage({
      channel: "private",
      senderRole: "owner",
      senderName: OWNER_DISPLAY_NAME,
      body: parsed.data.body.trim(),
      conversationId: conversation.id,
    });
    res.status(201).json(SendOwnerChatReplyResponse.parse(message));
  },
);

router.get("/chat/stream", async (req, res): Promise<void> => {
  const query = StreamChatMessagesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Invalid chat stream options." });
    return;
  }

  const { scope, conversationId } = query.data;
  let verifiedConversationId: string | undefined;

  if (scope === "owner") {
    const failure = await ownerAuthFailure(req);
    if (failure) {
      res.status(failure.status).json({ error: failure.message });
      return;
    }
  } else if (scope === "visitor") {
    const headers = StreamChatMessagesHeader.safeParse({
      "X-Chat-Token": req.get("X-Chat-Token"),
    });
    if (!conversationId || !headers.success || !headers.data["X-Chat-Token"]) {
      res.status(400).json({ error: "A private conversation and token are required." });
      return;
    }

    const [conversation] = await db
      .select({ id: chatConversationsTable.id })
      .from(chatConversationsTable)
      .where(
        and(
          eq(chatConversationsTable.id, conversationId),
          eq(
            chatConversationsTable.visitorTokenHash,
            visitorTokenHash(headers.data["X-Chat-Token"]),
          ),
        ),
      )
      .limit(1);
    if (!conversation) {
      res.status(403).json({ error: "This private conversation is unavailable." });
      return;
    }
    verifiedConversationId = conversation.id;
  }

  const streamScope = scope as ChatStreamScope;
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("retry: 3000\n\n");

  const unsubscribe = subscribeToChat(
    res,
    streamScope,
    verifiedConversationId,
  );
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(": keep-alive\n\n");
    }
  }, 20_000);
  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

export default router;
