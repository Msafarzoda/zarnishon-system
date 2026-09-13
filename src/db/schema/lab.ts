import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { analysisStage, analysisStatus } from "./enums.js";
import { batches } from "./cotton.js";
import { users } from "./org.js";

/**
 * Форма №9-хл — справка о влажности и засорённости хлопка-сырца.
 * One analysis per партия per stage. Immutable once APPROVED; a re-analysis inserts a
 * new row and marks the old one SUPERSEDED. Tickets already paid are never restated.
 */
export const labAnalyses = pgTable(
  "lab_analyses",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientUuid: uuid("client_uuid").notNull(),

    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id),
    /** cols 7–8 (по приёмке) or cols 9–10 (при отправке на завод). Payment uses on_intake. */
    stage: analysisStage("stage").notNull().default("on_intake"),
    status: analysisStatus("status").notNull().default("DRAFT"),

    /** Влажность — moisture, basis points. */
    moistureBp: integer("moisture_bp").notNull(),
    /** Засорённость — trash, basis points. */
    trashBp: integer("trash_bp").notNull(),

    /** Mode and norms actually in force when this analysis was approved, frozen here. */
    deductionMode: text("deduction_mode").notNull(),
    normMoistureBp: integer("norm_moisture_bp").notNull(),
    normTrashBp: integer("norm_trash_bp").notNull(),

    /** Deduction computed from the readings above. */
    computedDeductionBp: integer("computed_deduction_bp").notNull(),
    /** Lab head's override. When set, this is what pays — and `overrideReason` is required. */
    overrideDeductionBp: integer("override_deduction_bp"),
    overrideReason: text("override_reason"),

    /** Наименование хранилища — склад / бунт / навес, as recorded on the form. */
    storageNote: text("storage_note"),
    sampledAt: timestamp("sampled_at", { withTimezone: true }),

    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededById: uuid("superseded_by_id"),
  },
  (t) => [
    uniqueIndex("lab_analyses_client_uuid_idx").on(t.clientUuid),
    index("lab_analyses_batch_idx").on(t.batchId, t.stage),
    index("lab_analyses_status_idx").on(t.status),
  ],
);
