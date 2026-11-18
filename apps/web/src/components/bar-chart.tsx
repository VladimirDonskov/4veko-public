"use client";

import { useState } from "react";
import { money, moneyCompact } from "@/lib/format";

/**
 * Single-series bar chart. One accent hue (the title names the series, so no
 * legend), bars anchored to the baseline with 4px rounded tops and gaps between
 * them, recessive gridlines, a tooltip per bar, and a data table for screen
 * readers.
 */
export function BarChart({ data, label }: { data: { key: string; label: string; value: number }[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 560;
  const H = 200;
  const pad = { top: 12, right: 8, bottom: 26, left: 52 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = Math.max(1, ...data.map((d) => d.value));
  const nice = niceMax(max);
  const ticks = [0, nice / 2, nice];
  const slot = innerW / data.length;
  const barW = Math.min(44, slot - 12);
  const y = (v: number) => pad.top + innerH - (Math.max(0, v) / nice) * innerH;

  return (
    <figure className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={label}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)">
              {moneyCompact(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = pad.left + slot * i + (slot - barW) / 2;
          const top = y(d.value);
          const h = pad.top + innerH - top;
          const r = Math.min(4, h);
          return (
            <g key={d.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {/* Hit target larger than the bar */}
              <rect x={pad.left + slot * i} y={pad.top} width={slot} height={innerH} fill="transparent" />
              {h > 0 && (
                <path
                  d={`M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + h} Z`}
                  fill="var(--accent)"
                  opacity={hover === null || hover === i ? 1 : 0.55}
                />
              )}
              <text x={x + barW / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--text-muted)">
                {d.label}
              </text>
            </g>
          );
        })}
        <line x1={pad.left} x2={W - pad.right} y1={pad.top + innerH} y2={pad.top + innerH} stroke="var(--border-input)" strokeWidth={1} />
      </svg>
      {hover !== null && data[hover] && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs shadow-pop"
          style={{ left: `${((pad.left + slot * hover + slot / 2) / W) * 100}%`, top: 0 }}
        >
          <div className="text-muted">{data[hover].label}</div>
          <div className="font-semibold tabular">{money(data[hover].value)}</div>
        </div>
      )}
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th>Month</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.key}>
              <td>{d.label}</td>
              <td>{money(d.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function niceMax(v: number) {
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * exp;
}
