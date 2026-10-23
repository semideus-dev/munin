import { useState } from "react";
import type { FindingTier, SpendBucket } from "@munin/core";
import type { OverviewDTO } from "@munin/application";
import {
  dailySeries,
  formatCompact,
  formatNumber,
  formatPercent,
  formatUsd,
  pricedBadge,
} from "../../shared/view.js";
import { Badge, Card, CardTitle, EmptyState, Metric, Notice } from "../components/primitives.js";
import { Icon } from "../components/Icon.js";

interface OverviewViewProps {
  overview: OverviewDTO;
  byDay: SpendBucket[] | null;
  onOpenTier: (tier: FindingTier | "all") => void;
  onOpenFinding: (rule: string) => void;
}

function windowTitle(overview: OverviewDTO, buckets: number): string {
  if (overview.window.start === null) return "SPEND · NO CALLS";
  const days = buckets > 0 ? buckets : Math.max(1, Math.ceil(overview.window.days));
  return days <= 1 ? "SPEND · 1 DAY" : `SPEND · ${days} DAYS`;
}

function SavingsRow({
  label,
  note,
  usd,
  monthlyUsd,
  tone,
  scale,
  onClick,
}: {
  label: string;
  note?: string;
  usd: number;
  monthlyUsd: number;
  tone: "fix" | "try" | "test" | "all";
  scale: number;
  onClick: () => void;
}) {
  const width = scale <= 0 ? 0 : Math.min(100, Math.max(usd <= 0 ? 0 : 2, (usd / scale) * 100));
  return (
    <button type="button" className={`tier-row ${tone}`} onClick={onClick}>
      <span className={`tier-badge ${tone}`}>{label}</span>
      <span className="tier-track" aria-hidden="true">
        <span className="tier-fill" style={{ width: `${width}%` }} />
      </span>
      <span className="tier-value">
        <span className="tier-usd mono">{formatUsd(usd)}</span>
        <span className="tier-note">{note ?? `${formatUsd(monthlyUsd)}/mo`}</span>
      </span>
    </button>
  );
}

export function OverviewView({ overview, byDay, onOpenTier, onOpenFinding }: OverviewViewProps) {
  const { totals, cost, efficiency, savings, tokenMix, source, health } = overview;
  const [focusedDay, setFocusedDay] = useState<string | null>(null);
  const series = byDay === null ? [] : dailySeries(overview.window, byDay, overview.timeZone);
  const peak = Math.max(0, ...series.map((day) => day.usd));
  const tierScale = Math.max(
    savings.fix.windowUsd,
    savings.try.windowUsd,
    savings.test.windowUsd,
    savings.all.windowUsd,
  );
  const cacheRate = efficiency.cacheHitRate;
  const hasCalls = totals.calls > 0;
  const topFinding = overview.topFinding;

  return (
    <>
      {!hasCalls ? (
        <Card>
          <CardTitle aside={<Badge tone={source.status === "ready" ? "ok" : "warn"}>{source.status}</Badge>}>
            Overview
          </CardTitle>
          <EmptyState title="No usage in this window">
            Munin read {source.pathLabel} but found no usage-bearing model calls. Nothing is
            estimated or invented.
          </EmptyState>
          {health.warnings.length === 0 ? null : (
            <ul className="warnings">
              {health.warnings.map((warning) => (
                <li key={`${warning.code}-${warning.message}`}>
                  <span className="mono">{warning.code}</span> {warning.message}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : (
        <>
          <Card className="spend-card">
            <CardTitle aside={<Badge tone={cost.unpricedCalls === 0 ? "ok" : "warn"}>{pricedBadge(totals.calls, cost.unpricedCalls)}</Badge>}>
              {windowTitle(overview, series.length)}
            </CardTitle>
            <div className="spend-value mono">{formatUsd(cost.headlineUsd)}</div>
            <div className="spend-basis">
              <span>{formatUsd(cost.observedUsd)} observed</span>
              <span aria-hidden="true">·</span>
              <span>{formatUsd(cost.estimatedUsd)} estimated</span>
            </div>
            {cost.unpricedCalls === 0 ? null : (
              <Notice tone="warn">
                {formatNumber(cost.unpricedCalls)} unpriced{" "}
                {cost.unpricedCalls === 1 ? "call" : "calls"} — no card and no observed charge
                {cost.unpricedModels.length === 0 ? "" : `: ${cost.unpricedModels.join(", ")}`}
              </Notice>
            )}

            {series.length === 0 ? (
              <p className="note">No daily buckets for this window.</p>
            ) : (
              <div className="spark-wrap">
                <div className="spark-scroll">
                  <div
                    className="spark"
                    role="list"
                    aria-label="Daily headline spend across the reporting window"
                  >
                    {series.map((day) => {
                      const height = peak <= 0 ? 2 : Math.max(2, (day.usd / peak) * 42);
                      return (
                        <div
                          key={day.key}
                          role="listitem"
                          tabIndex={0}
                          className={`spark-bar ${day.isLast ? "latest" : ""} ${day.usd === 0 ? "zero" : ""}`}
                          style={{ height: `${height}px` }}
                          data-tip={`${day.label} · ${formatUsd(day.usd)} · ${formatNumber(day.calls)} ${day.calls === 1 ? "call" : "calls"}`}
                          aria-label={`${day.label}: ${formatUsd(day.usd)}, ${day.calls} calls, ${formatCompact(day.tokens)} tokens`}
                          title={`${day.label} · ${formatUsd(day.usd)}`}
                          onMouseEnter={() => setFocusedDay(day.key)}
                          onMouseLeave={() =>
                            setFocusedDay((current) => (current === day.key ? null : current))
                          }
                          onFocus={() => setFocusedDay(day.key)}
                          onBlur={() =>
                            setFocusedDay((current) => (current === day.key ? null : current))
                          }
                        />
                      );
                    })}
                    {peak <= 0 ? (
                      <span className="spark-zero" aria-hidden="true">
                        No priced spend in this window
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="spark-axis">
                  <span>{series[0]?.label}</span>
                  <span>{series.at(-1)?.label}</span>
                </div>
                <div className="spark-readout" aria-live="polite">
                  {(() => {
                    const day = series.find((row) => row.key === focusedDay);
                    if (day === undefined) return "Focus a bar for its date and spend.";
                    return `${day.label} · ${formatUsd(day.usd)} · ${formatNumber(day.calls)} ${
                      day.calls === 1 ? "call" : "calls"
                    }`;
                  })()}
                </div>
              </div>
            )}

            <div className="metric-grid four">
              <Metric label="Calls" value={formatNumber(totals.calls)} />
              <Metric label="Sessions" value={formatNumber(totals.sessions)} />
              <Metric label="Turns" value={formatNumber(totals.turns)} />
              <Metric label="Priced" value={pricedBadge(totals.calls, cost.unpricedCalls)} mono={false} />
            </div>
          </Card>

          <div className="two-up">
            <Card className="stat-card">
              <CardTitle>Tokens</CardTitle>
              <div className="stat-value mono" title={formatNumber(tokenMix.totalTokens)}>
                {formatCompact(tokenMix.totalTokens)}
              </div>
              <div className="stat-sub">incl. {formatCompact(tokenMix.thinkingTokens)} thinking</div>
              <div className="stat-foot mono" title="Priced output already includes thinking.">
                {formatCompact(tokenMix.inputTokens)} in · {formatCompact(tokenMix.outputTokens)} out
              </div>
            </Card>

            <Card className="stat-card">
              <CardTitle>Cache hit</CardTitle>
              <div className="stat-value mono">
                {cacheRate === null ? "—" : formatPercent(cacheRate)}
              </div>
              <div className="stat-sub">
                {cacheRate === null ? "no input side recorded" : "of input tokens"}
              </div>
              <div className="stat-foot mono" title="Cache read / (uncached input + read + write).">
                {formatCompact(overview.tokenMix.cacheReadTokens)} read ·{" "}
                {formatCompact(overview.tokenMix.cacheWriteTokens)} write
              </div>
            </Card>
          </div>

          <Card>
            <CardTitle aside={<span className="subtle">{savings.windowDays} d window</span>}>
              Potential savings
            </CardTitle>
            <div className="tier-list">
              <SavingsRow
                label="Fix"
                usd={savings.fix.windowUsd}
                monthlyUsd={savings.fix.monthlyUsd}
                tone="fix"
                scale={tierScale}
                onClick={() => onOpenTier("fix")}
              />
              <SavingsRow
                label="Try"
                usd={savings.try.windowUsd}
                monthlyUsd={savings.try.monthlyUsd}
                tone="try"
                scale={tierScale}
                onClick={() => onOpenTier("try")}
              />
              <SavingsRow
                label="Test"
                note={`up to ${formatUsd(savings.test.monthlyUsd)}/mo`}
                usd={savings.test.windowUsd}
                monthlyUsd={savings.test.monthlyUsd}
                tone="test"
                scale={tierScale}
                onClick={() => onOpenTier("test")}
              />
            </div>
            <div className="tier-all">
              <button
                type="button"
                className="tier-row all"
                onClick={() => onOpenTier("all")}
              >
                <span className="tier-badge all">All</span>
                <span className="tier-track" aria-hidden="true">
                  <span
                    className="tier-fill"
                    style={{
                      width: `${tierScale <= 0 ? 0 : Math.min(100, (savings.all.windowUsd / tierScale) * 100)}%`,
                    }}
                  />
                </span>
                <span className="tier-value">
                  <span className="tier-usd mono">{formatUsd(savings.all.windowUsd)}</span>
                  <span className="tier-note">de-overlapped</span>
                </span>
              </button>
            </div>
            <p className="note">
              {formatNumber(Math.round(savings.tokensWasted))} tokens of waste
              {savings.unpricedFindings === 0
                ? ""
                : ` · ${savings.unpricedFindings} unpriced ${
                    savings.unpricedFindings === 1 ? "finding" : "findings"
                  } claim no dollars`}
              . Combined savings are de-overlapped per call; tiers are not summed.
            </p>
          </Card>
        </>
      )}

      {topFinding === null ? null : (
        <button
          type="button"
          className="card top-finding-card"
          onClick={() => onOpenFinding(topFinding.rule)}
        >
          <div className="row-between">
            <span className="card-title-label">Top finding</span>
            <Badge tone={topFinding.tier}>{topFinding.tier}</Badge>
          </div>
          <div className="finding-title">{topFinding.title}</div>
          <div className="row-between muted-row">
            <span>
              {formatUsd(topFinding.windowUsd)} this window ·{" "}
              {formatNumber(topFinding.affectedCalls)} calls
            </span>
            <span className="open-hint">
              Open <Icon name="chevron" size={12} />
            </span>
          </div>
        </button>
      )}
    </>
  );
}
