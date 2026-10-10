import { createInsertSchema } from "drizzle-zod";
import {
  index,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const chatConversationsTable = pgTable(
  "chat_conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    visitorTokenHash: text("visitor_token_hash").notNull().unique(),
    guestName: varchar("guest_name", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("chat_conversations_updated_at_idx").on(table.updatedAt)],
);

export const chatMessagesTable = pgTable(
  "chat_messages",
  {
    id: serial("id").primaryKey(),
    conversationId: uuid("conversation_id").references(
      () => chatConversationsTable.id,
      { onDelete: "cascade" },
    ),
    channel: varchar("channel", { length: 8 }).notNull(),
    senderRole: varchar("sender_role", { length: 8 }).notNull(),
    senderName: varchar("sender_name", { length: 32 }).notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("chat_messages_created_at_idx").on(table.createdAt),
    index("chat_messages_conversation_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    index("chat_messages_channel_idx").on(table.channel, table.createdAt),
  ],
);

export const insertChatConversationSchema = createInsertSchema(
  chatConversationsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertChatMessageSchema = createInsertSchema(
  chatMessagesTable,
).omit({
  id: true,
  createdAt: true,
});

export type InsertChatConversation = z.infer<
  typeof insertChatConversationSchema
>;
export type ChatConversation = typeof chatConversationsTable.$inferSelect;
export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;
export type ChatMessage = typeof chatMessagesTable.$inferSelect;
