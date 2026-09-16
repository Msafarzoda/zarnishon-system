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
import { analysisStage, analysisStatus } from "./enums";
import { batches } from "./cotton";
import { weighTickets } from "./intake";
import { users } from "./org";

/**
 * Форма №9-хл — справка о влажности и засорённости хлопка-сырца.
 *
 * **Every truck is sampled.** A sample is taken from the load after it is weighed, the
 * lab measures намӣ and ифлосӣ for that truck, and its result decides what that farmer
 * is paid. So an analysis normally belongs to a **ticket**.
 *
 * `batchId` is kept for the партия-level certificate the paper Форма №9-хл is written
 * for — a whole lot analysed at once, which still happens when cotton is dispatched.
 * Exactly one of `ticketId` / `batchId` is set.
 *
 * When paying, a ticket's own analysis wins; a партия-level analysis covers any ticket
 * in the lot that was not sampled individually.
 *
 * Immutable once APPROVED; a re-analysis inserts a new row and marks the old one
 * SUPERSEDED. Tickets already paid are never restated.
 */
export const labAnalyses = pgTable(
  "lab_analyses",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    clientUuid: uuid("client_uuid").notNull(),

    /** The truck this sample came from. The normal case. */
    ticketId: uuid("ticket_id").references(() => weighTickets.id),
    /** The партия, when a whole lot is certified at once instead. */
    batchId: uuid("batch_id").references(() => batches.id),
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
    /**
     * Who actually did the analysis, when the person typing it in did not.
     *
     * The лаборант fills in Форма №9-хл by hand and the тарозубон enters it, so `enteredBy`
     * would otherwise read as though the тарозубон had measured the moisture himself. This
     * carries the name off the paper form. Empty means the person who entered it is the
     * person who did it. docs/domain.md §6.
     */
    analysedBy: text("analysed_by"),
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
    index("lab_analyses_ticket_idx").on(t.ticketId, t.stage),
    index("lab_analyses_status_idx").on(t.status),
  ],
);
