import { requirePageRole } from "@/lib/auth/session";
import { tg } from "@/lib/i18n/tg";
import { Shell } from "@/components/shell";
import { ScaleCheckClient } from "./check-client";

export const dynamic = "force-dynamic";

/**
 * Санҷиши тарозу — the commissioning screen.
 *
 * Kept apart from the weighing screen on purpose. This one is for the half hour after
 * somebody plugs the cable in, when the question is not "what does the truck weigh" but
 * "is the indicator saying anything at all" — and when the answer needs raw bytes and a
 * named fault, not a big number.
 */
export default async function ScaleCheckPage() {
  const user = await requirePageRole("weigher", "owner", "admin", "accountant");

  return (
    <Shell user={user} title={tg.scale.checkTitle}>
      <ScaleCheckClient />
    </Shell>
  );
}
