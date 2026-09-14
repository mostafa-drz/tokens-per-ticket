import { formatDay, formatUsd } from "@/lib/format";
import type { TicketDetail } from "@/lib/ledger";

/** Server-rendered bars, one per active day, on a shared spend scale. */
export function DailySpendChart({ days }: { days: TicketDetail["days"] }) {
  const width = 960;
  const height = 200;
  const pad = { top: 16, right: 8, bottom: 28, left: 56 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const max = Math.max(...days.map((d) => d.spend));
  const ceiling = niceCeiling(max);
  const slot = plotW / days.length;
  const barW = Math.min(48, slot * 0.6);
  const y = (value: number) => pad.top + plotH - (value / ceiling) * plotH;
  const ticks = [0, ceiling / 2, ceiling];

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full min-w-[560px]"
        role="img"
        aria-label={`Spend per active day, highest ${formatUsd(max)}`}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} stroke="var(--rule)" />
            <text x={pad.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" fontSize="12" fill="var(--ink-soft)" className="num">
              {formatUsd(tick)}
            </text>
          </g>
        ))}
        {days.map((day, i) => {
          const cx = pad.left + slot * i + slot / 2;
          return (
            <g key={day.date}>
              <rect x={cx - barW / 2} y={y(day.spend)} width={barW} height={pad.top + plotH - y(day.spend)} rx="2" fill="var(--money)">
                <title>{`${formatDay(day.date)}: ${formatUsd(day.spend)}`}</title>
              </rect>
              <text x={cx} y={height - 8} textAnchor="middle" fontSize="12" fill="var(--ink-soft)" className="num">
                {formatDay(day.date)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * magnitude >= value) ?? 10;
  return step * magnitude;
}
