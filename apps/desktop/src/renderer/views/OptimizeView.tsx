import { useEffect, useMemo, useState } from "react";
import type { FindingTier, ReportFinding } from "@munin/core";
import type {
  FindingDetailDTO,
  FindingListDTO,
  ServiceErrorDTO,
} from "@munin/application";
import type { ReadRequest } from "../../shared/ipc.js";
import {
  filterFindings,
  findingSavingsLabel,
  formatNumber,
  formatPercent,
  formatUsd,
  orderFindings,
} from "../../shared/view.js";
import { Badge, Card, CardTitle, EmptyState, Notice, Spinner } from "../components/primitives.js";
import { Icon } from "../components/Icon.js";

type TierFilter = FindingTier | "all";

interface OptimizeViewProps {
  data: FindingListDTO;
  tier: TierFilter;
  selectedRule: string | null;
  readOptions: ReadRequest;
  onTier: (tier: TierFilter) => void;
  onSelectRule: (rule: string | null) => void;
}

interface DetailState {
  status: "loading" | "ready" | "error";
  detail?: FindingDetailDTO | null;
  error?: ServiceErrorDTO;
}

const TIERS: ReadonlyArray<{ id: TierFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "fix", label: "Fix" },
  { id: "try", label: "Try" },
  { id: "test", label: "Test" },
];

function FindingFacts({ finding }: { finding: ReportFinding }) {
  const { savings, affected } = finding;
  return (
    <div className="metric-grid three">
      <div className="fact">
        <span className="metric-label">Confidence</span>
        <span className={`fact-value ${savings.confidence}`}>{savings.confidence}</span>
      </div>
      <div className="fact">
        <span className="metric-label">Severity</span>
        <span className="fact-value">{finding.severity}</span>
      </div>
      <div className="fact">
        <span className="metric-label">Risk</span>
        <span className="fact-value">{finding.risk === "safe" ? "safe" : "verify"}</span>
      </div>
      <div className="fact">
        <span className="metric-label">Verification</span>
        <span className="fact-value">{finding.verification.replace("-", " ")}</span>
      </div>
      <div className="fact">
        <span className="metric-label">Impact</span>
        <span className="fact-value">{finding.impact}</span>
      </div>
      <div className="fact">
        <span className="metric-label">Affected</span>
        <span className="fact-value mono">
          {formatNumber(affected.calls)} · {formatPercent(affected.share)}
        </span>
      </div>
    </div>
  );
}

function DetailPanel({
  finding,
  state,
  onOpenRule,
}: {
  finding: ReportFinding;
  state: DetailState | undefined;
  onOpenRule: (rule: string) => void;
}) {
  return (
    <div className="finding-detail">
      <p className="finding-detail-text">{finding.detail}</p>
      {finding.why.trim() === "" ? null : <p className="finding-why">{finding.why}</p>}

      <FindingFacts finding={finding} />

      <div className="detail-grid">
        <span className="detail-label">Window</span>
        <span className="detail-value mono">{formatUsd(finding.savings.windowUsd)}</span>
        <span className="detail-label">Monthly</span>
        <span className="detail-value mono">{formatUsd(finding.savings.monthlyUsd)}</span>
        <span className="detail-label">Formula</span>
        <span className="detail-value mono wrap">{finding.savings.calculation}</span>
        <span className="detail-label">Confidence basis</span>
        <span className="detail-value wrap">{finding.savings.confidenceBasis}</span>
      </div>

      {finding.advisory ? (
        <Notice tone="warn">
          Advisory: this is a real cost, not recoverable waste. It claims no savings and is
          included in no combined total.
        </Notice>
      ) : null}
      {finding.savings.unpriced ? (
        <Notice tone="warn">
          Some affected calls have no price card and no observed charge. Their dollars are
          withheld; the token figure is still reported.
        </Notice>
      ) : null}

      {finding.candidate === undefined ? null : (
        <div className="sub-block">
          <h3>Candidate</h3>
          <p>
            {finding.candidate.description}
            {finding.candidate.from === undefined ? null : (
              <span className="mono"> · from {finding.candidate.from}</span>
            )}
            {finding.candidate.to === undefined ? null : (
              <span className="mono"> → {finding.candidate.to}</span>
            )}
          </p>
        </div>
      )}

      {finding.observations.length === 0 ? null : (
        <div className="sub-block">
          <h3>Observations</h3>
          <ul className="tight-list">
            {finding.observations.map((observation) => (
              <li key={observation}>{observation}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="sub-block">
        <h3>Affected traffic</h3>
        <p className="muted">
          {finding.affected.models.length === 0
            ? "No model names recorded."
            : finding.affected.models.join(", ")}
          {finding.affected.projects.length === 0
            ? ""
            : ` · ${finding.affected.projects.join(", ")}`}
        </p>
      </div>

      {finding.overlapWith === undefined || finding.overlapWith.length === 0 ? null : (
        <div className="sub-block">
          <h3>Overlaps</h3>
          <div className="chip-row">
            {finding.overlapWith.map((rule) => (
              <button
                key={rule}
                type="button"
                className="chip overlap"
                onClick={() => onOpenRule(rule)}
              >
                {rule}
              </button>
            ))}
          </div>
          <p className="note">
            These rules claim at least one of the same calls. Combined savings use Munin's
            per-call de-overlap, never a sum.
          </p>
        </div>
      )}

      {finding.savings.assumptions.length === 0 ? null : (
        <div className="sub-block">
          <h3>Assumptions</h3>
          <ul className="tight-list">
            {finding.savings.assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
        </div>
      )}

      {finding.fix.trim() === "" ? null : (
        <div className="sub-block">
          <h3>What to change</h3>
          <p>{finding.fix}</p>
        </div>
      )}

      <div className="sub-block">
        <h3>Claimed calls</h3>
        {state === undefined || state.status === "loading" ? (
          <Spinner label="Loading claimed calls" />
        ) : state.status === "error" ? (
          <Notice tone="bad">{state.error?.message ?? "Could not load claimed calls."}</Notice>
        ) : state.detail === null || state.detail === undefined ? (
          <p className="muted">No detail is available for this finding.</p>
        ) : state.detail.claims.length === 0 ? (
          <p className="muted">This finding names no individual calls.</p>
        ) : (
          <div className="claim-list">
            {state.detail.claims.slice(0, 6).map((claim) => (
              <div className="claim-row" key={claim.eventId}>
                <span className="mono claim-model" title={claim.model ?? claim.eventId}>
                  {claim.model ?? "unknown model"}
                </span>
                <span className="mono claim-meta">
                  {claim.totalTokens === null ? "—" : formatNumber(claim.totalTokens)} tok
                </span>
                <span className="mono claim-usd">
                  {claim.usd === 0 && claim.model === null ? "unknown" : formatUsd(claim.usd)}
                </span>
              </div>
            ))}
            {state.detail.claims.length > 6 ? (
              <p className="note">
                Showing 6 of {formatNumber(state.detail.claims.length)} claimed calls.
              </p>
            ) : null}
          </div>
        )}
      </div>

      <p className="note">
        Read-only analysis. Munin does not apply or undo changes from this desktop build.
      </p>
    </div>
  );
}

export function OptimizeView({
  data,
  tier,
  selectedRule,
  readOptions,
  onTier,
  onSelectRule,
}: OptimizeViewProps) {
  const ordered = useMemo(
    () => orderFindings(data.findings, data.recommendations),
    [data.findings, data.recommendations],
  );
  const visible = useMemo(() => filterFindings(ordered, tier), [ordered, tier]);
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  // `null` means "choose the first finding"; `""` means the user collapsed all.
  const expanded =
    selectedRule === null ? (visible[0]?.rule ?? null) : selectedRule === "" ? null : selectedRule;

  useEffect(() => {
    if (selectedRule !== null) return;
    const first = visible[0]?.rule;
    if (first !== undefined) onSelectRule(first);
  }, [selectedRule, visible, onSelectRule]);

  // Claim evidence is window-specific. Drop it when the read filters change so
  // the expanded panel cannot show calls from the previous window.
  useEffect(() => {
    setDetails({});
  }, [readOptions]);

  useEffect(() => {
    if (expanded === null) return;
    const existing = details[expanded];
    if (existing !== undefined) return;
    let cancelled = false;
    setDetails((prev) => ({ ...prev, [expanded]: { status: "loading" } }));
    const bridge = window.munin;
    if (bridge === undefined) {
      setDetails((prev) => ({
        ...prev,
        [expanded]: {
          status: "error",
          error: {
            code: "bridge.missing",
            kind: "internal",
            message: "The desktop bridge did not load. Restart Munin.",
          },
        },
      }));
      return;
    }
    void bridge
      .getFinding({ ...readOptions, rule: expanded })
      .then((result) => {
        if (cancelled) return;
        setDetails((prev) => ({
          ...prev,
          [expanded]: result.ok
            ? { status: "ready", detail: result.data }
            : { status: "error", error: result.error },
        }));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDetails((prev) => ({
          ...prev,
          [expanded]: {
            status: "error",
            error: {
              code: "ipc.failed",
              kind: "internal",
              message: error instanceof Error ? error.message : String(error),
            },
          },
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, details, readOptions]);

  useEffect(() => {
    if (
      selectedRule !== null &&
      selectedRule !== "" &&
      !visible.some((finding) => finding.rule === selectedRule)
    ) {
      onSelectRule(visible[0]?.rule ?? "");
    }
  }, [selectedRule, visible, onSelectRule]);

  const counts = useMemo(() => {
    const result: Record<TierFilter, number> = { all: ordered.length, fix: 0, try: 0, test: 0 };
    for (const finding of ordered) result[finding.tier] += 1;
    return result;
  }, [ordered]);

  return (
    <>
      <Card>
        <CardTitle
          aside={
            <span className="subtle">
              {formatUsd(data.savings.all.windowUsd)} combined
            </span>
          }
        >
          Findings
        </CardTitle>
        <div className="chip-row" role="group" aria-label="Filter findings by tier">
          {TIERS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`chip ${tier === option.id ? "active" : ""}`}
              aria-pressed={tier === option.id}
              onClick={() => onTier(option.id)}
            >
              {option.label}
              <span className="chip-count">{counts[option.id]}</span>
            </button>
          ))}
        </div>
        <p className="note">
          Per-call de-overlap: the combined figure is {formatUsd(data.savings.all.windowUsd)} and
          is not the sum of the tiers.
        </p>
      </Card>

      {visible.length === 0 ? (
        <Card>
          <EmptyState title="No findings for this filter">
            The analysis returned {ordered.length === 0 ? "no findings" : "no findings in this tier"}{" "}
            for the active window. Nothing is fabricated to fill the list.
          </EmptyState>
        </Card>
      ) : (
        visible.map((finding) => {
          const isOpen = expanded === finding.rule;
          return (
            <section
              key={finding.rule}
              className={`card finding-card ${isOpen ? "open" : ""}`}
              onKeyDown={(event) => {
                if (event.key === "Escape" && isOpen) onSelectRule("");
              }}
            >
              <button
                type="button"
                className="finding-head"
                aria-expanded={isOpen}
                onClick={() => onSelectRule(isOpen ? "" : finding.rule)}
              >
                <span className={`tier-badge ${finding.tier}`}>{finding.tier}</span>
                <span className="finding-head-text">
                  <span className="finding-title">{finding.title}</span>
                  <span className="finding-sub">
                    {formatNumber(finding.affected.calls)} calls · {finding.severity} ·{" "}
                    {finding.savings.confidence} confidence
                  </span>
                </span>
                <span className="finding-saving">
                  <span className="mono">{findingSavingsLabel(finding)}</span>
                  <span className="finding-saving-note">
                    {finding.advisory ? "no claim" : `${formatUsd(finding.savings.monthlyUsd)}/mo`}
                  </span>
                </span>
                <span className={`chevron ${isOpen ? "open" : ""}`}>
                  <Icon name="chevron" size={14} />
                </span>
              </button>
              {isOpen ? (
                <DetailPanel
                  finding={finding}
                  state={details[finding.rule]}
                  onOpenRule={(rule) => onSelectRule(rule)}
                />
              ) : null}
            </section>
          );
        })
      )}

      {data.findings.length === 0 ? (
        <Card>
          <EmptyState title="No optimization findings">
            Munin found no recommendations in the active window. Findings appear only when the
            detectors have real evidence.
          </EmptyState>
        </Card>
      ) : null}

      {data.findings.some((finding) => finding.advisory) ? (
        <p className="note page-note">
          Advisories describe real costs you absorb; they claim nothing and are excluded from
          every savings total.
        </p>
      ) : null}
    </>
  );
}
