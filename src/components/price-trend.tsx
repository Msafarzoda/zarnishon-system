import { diramToSomoniString } from "@/domain/units";
import type { PriceTrend } from "@/server/services/price-trend";
import { tg } from "@/lib/i18n/tg";

/**
 * Today's price and which way it moved.
 *
 * This is the number a waiting farmer is watching, and the one the cashier is asked about
 * all day. Shown with the direction of the last change, because "12.50" alone does not
 * answer "should I take it today?".
 */
export function PriceTrendStat({ trend }: { trend: PriceTrend }) {
  const rising = (trend.changeD ?? 0) > 0;
  const falling = (trend.changeD ?? 0) < 0;

  return (
    <div className="card px-4 py-3">
      <div className="text-sm text-ink-soft">{tg.cash.priceToday}</div>
      <div className="tabular text-2xl font-bold leading-tight">
        {trend.currentD !== null ? diramToSomoniString(trend.currentD) : "—"}
        <span className="ms-1 text-base font-medium text-ink-soft">{tg.price.perKg}</span>
      </div>

      {trend.changeD !== null && trend.previousD !== null && (
        <div
          className={`mt-1 text-xs font-medium ${
            rising ? "text-brand" : falling ? "text-alarm" : "text-ink-faint"
          }`}
        >
          {rising ? "▲" : falling ? "▼" : "="}{" "}
          {diramToSomoniString(Math.abs(trend.changeD))} {tg.price.perKg}
          <span className="ms-1 font-normal text-ink-faint">
            {tg.cash.priceSince} {diramToSomoniString(trend.previousD)}
            {trend.changedAt && ` · ${trend.changedAt.toLocaleDateString("ru-RU")}`}
          </span>
        </div>
      )}
    </div>
  );
}
