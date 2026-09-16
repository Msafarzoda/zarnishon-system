import { tg } from "@/lib/i18n/tg";

/**
 * Says plainly that this screen is being watched, not worked.
 *
 * Without it an owner looking at the cash desk sees a page with no buttons and cannot
 * tell whether that is by design or because something is broken.
 */
export function ReadOnlyBanner() {
  return (
    <div className="no-print mb-5 card border-ink-faint/40 bg-paper px-4 py-2.5">
      <p className="text-sm font-medium text-ink-soft">
        {tg.auth.readOnly}
        <span className="ms-2 font-normal text-ink-faint">{tg.auth.readOnlyHint}</span>
      </p>
    </div>
  );
}
