import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { stations, users } from "./org.js";

/**
 * Every mutation, with who, where, on what device, and whether it came from an offline
 * queue. Written in the same transaction as the change it describes. Never deleted.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    action: text("action").notNull(), // e.g. "ticket.pay", "lab.approve", "price.set"
    entityTable: text("entity_table").notNull(),
    entityId: uuid("entity_id"),
    /** What changed. For append-only tables this is the inserted row. */
    payload: jsonb("payload"),
    actorId: uuid("actor_id").references(() => users.id),
    actorRole: text("actor_role"),
    stationId: uuid("station_id").references(() => stations.id),
    deviceFingerprint: text("device_fingerprint"),
    ipAddress: text("ip_address"),
    originatedOffline: integer("originated_offline").notNull().default(0),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_entity_idx").on(t.entityTable, t.entityId),
    index("audit_log_actor_idx").on(t.actorId),
    index("audit_log_occurred_idx").on(t.occurredAt),
  ],
);

/**
 * The server-side half of the offline queue. A station posts operations with a
 * client-generated UUID; this table records the outcome so that a replay after a flaky
 * connection returns the original result instead of performing the work twice.
 */
export const syncOperations = pgTable(
  "sync_operations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientUuid: uuid("client_uuid").notNull(),
    operation: text("operation").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull(), // APPLIED | REJECTED
    resultJson: jsonb("result_json"),
    errorMessage: text("error_message"),
    stationId: uuid("station_id").references(() => stations.id),
    actorId: uuid("actor_id").references(() => users.id),
    /** When the station performed it, vs when the server received it. */
    clientTimestamp: timestamp("client_timestamp", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sync_operations_client_uuid_idx").on(t.clientUuid),
    index("sync_operations_station_idx").on(t.stationId),
  ],
);
