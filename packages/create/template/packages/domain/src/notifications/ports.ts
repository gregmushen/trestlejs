import type { Mutation } from "../access/ports.js";
import type { NotificationChannel, PreferenceSource } from "./model.js";

export type NotificationRecord = Readonly<{
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  groupKey: string | null;
  groupCount: number;
  dedupeKey: string | null;
  eventId: string | null;
  correlationId: string;
  createdAt: Date;
  updatedAt: Date;
  readAt: Date | null;
  /** When the notification becomes visible (and deliverable); defaults to creation. */
  scheduledAt?: Date;
  /** The stream version the send resolved, for runtime streams. */
  streamVersion?: number | null;
}>;

export type NotificationDeliveryRecord = Readonly<{
  id: string;
  notificationId: string;
  userId: string;
  type: string;
  channel: NotificationChannel;
  status: "pending" | "sent" | "failed" | "skipped" | "cancelled";
  preferenceSource: PreferenceSource;
  mandatory: boolean;
  attempts: number;
  failureCategory: string | null;
  emailDeliveryId: string | null;
  correlationId: string;
  createdAt: Date;
  completedAt: Date | null;
}>;

export type PreferenceRow = Readonly<{ userId: string; type: string; channel: NotificationChannel; enabled: boolean }>;
export type Recipient = Readonly<{ userId: string; name: string; email: string }>;

export interface NotificationRepository {
  recipients(selector: Readonly<{ organizationRoles?: readonly string[]; userIds?: readonly string[] }>): Promise<Recipient[]>;
  preferences(userIds: readonly string[]): Promise<PreferenceRow[]>;
  findRecent(userId: string, type: string, key: Readonly<{ dedupeKey?: string; groupKey?: string }>, since: Date): Promise<NotificationRecord | null>;
  insert(notification: NotificationRecord, deliveries: readonly (Omit<NotificationDeliveryRecord, "type" | "createdAt" | "completedAt"> & { nextAttemptAt?: Date })[]): Promise<void>;
  regroup(id: string, content: Readonly<{ title: string; body: string; link: string | null }>, groupCount: number, now: Date): Promise<void>;
  inbox(userId: string, limit: number): Promise<NotificationRecord[]>;
  unreadCount(userId: string): Promise<number>;
  markRead(userId: string, ids: readonly string[] | "all", now: Date): Promise<number>;
  setPreference(row: PreferenceRow, updatedBy: string, mutation?: Mutation): Promise<void>;
  clearPreference(userId: string, type: string, channel: NotificationChannel, mutation?: Mutation): Promise<void>;
  deliveries(filter: Readonly<{ limit: number; notificationId?: string }>): Promise<NotificationDeliveryRecord[]>;
  delivery(id: string): Promise<(NotificationDeliveryRecord & { recipientEmail: string | null; content: Readonly<{ title: string; body: string; link: string | null }> }) | null>;
  completeDelivery(id: string, result: Readonly<{ status: "sent" | "failed" | "pending"; failureCategory: string | null; emailDeliveryId: string | null; nextAttemptAt: Date | null }>, now: Date): Promise<void>;
}
