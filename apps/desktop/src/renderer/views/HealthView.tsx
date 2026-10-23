import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Snapshot } from "@munin/core";
import type { ActivityDTO, HealthDTO, PrivacyDTO } from "@munin/application";
import {
  deltaSign,
  formatClock,
  formatCompact,
  formatMoment,
  formatNumber,
  formatSignedUsd,
  formatUsd,
} from "../../shared/view.js";
import { Badge, Card, CardTitle, EmptyState, Notice } from "../components/primitives.js";
import { Icon, type IconName } from "../components/Icon.js";

type HealthRowId = "source" | "pricing" | "reconcile" | "network" | "privacy";
type RowTone = "ok" | "warn" | "bad" | "muted";

interface HealthViewProps {
  health: HealthDTO;
  activity: ActivityDTO;
  privacy: PrivacyDTO | null;
  timeZone: string;
}

function warningCount(snapshot: Snapshot): number {
  return Object.values(snapshot.warningCounts).reduce((sum, count) => sum + count, 0);
}

function HealthRow({
  id,
  icon,
  label,
  value,
  tone,
  open,
  onToggle,
}: {
  id: HealthRowId;
  icon: IconName;
  label: string;
  value: string;
  tone: RowTone;
  open: boolean;
  onToggle: (id: HealthRowId) => void;
}) {
  return (
    <button
      type="button"
      className={`health-row ${open ? "open" : ""}`}
      aria-expanded={open}
      onClick={() => onToggle(id)}
    >
      <span className={`health-icon ${tone}`}>
        <Icon name={icon} size={15} />
      </span>
      <span className="health-label">{label}</span>
      <span className={`health-value ${tone}`}>{value}</span>
      <span className={`chevron ${open ? "open" : ""}`}>
        <Icon name="chevron" size={13} />
      </span>
    </button>
  );
}

function SourceDetail({ health }: { health: HealthDTO }) {
  const source = health.source;
  return (
    <div className="health-detail">
      <div className="detail-grid">
        <span className="detail-label">Status</span>
        <span className="detail-value">{source.status}</span>
        <span className="detail-label">Path</span>
        <span className="detail-value mono wrap">{source.path}</span>
        <span className="detail-label">Origin</span>
        <span className="detail-value">{source.origin}</span>
        <span className="detail-label">Schema</span>
        <span className="detail-value mono">{source.schema ?? "not read"}</span>
        <span className="detail-label">Size</span>
        <span className="detail-value mono">
          {source.sizeBytes === undefined ? "—" : `${formatNumber(source.sizeBytes)} bytes`}
        </span>
        <span className="detail-label">Modified</span>
        <span className="detail-value mono">
          {source.modifiedAt === undefined ? "—" : formatMoment(source.modifiedAt, "local")}
        </span>
        {source.reason === undefined ? null : (
          <>
            <span className="detail-label">Reason</span>
            <span className="detail-value wrap">{source.reason}</span>
          </>
        )}
      </div>
      <p className="note">
        The source is opened read-only. Munin's own derived state lives in the state directory
        below, never in the OpenCode database.
      </p>
      <div className="detail-grid">
        <span className="detail-label">State dir</span>
        <span className="detail-value mono wrap">{health.config.stateDir}</span>
        <span className="detail-label">Settings</span>
        <span className="detail-value mono wrap">{health.config.settingsPath}</span>
        <span className="detail-label">Configured</span>
        <span className="detail-value">
          {health.config.reportingDays === null
            ? "all recorded days"
            : `${health.config.reportingDays} days`}
          {health.config.timeZone === null ? "" : ` · ${health.config.timeZone}`}
        </span>
      </div>
    </div>
  );
}

function PricingDetail({ health }: { health: HealthDTO }) {
  const unpriced = health.data?.unpricedModels ?? [];
  return (
    <div className="health-detail">
      <div className="detail-grid">
        <span className="detail-label">Catalogue</span>
        <span className="detail-value mono">
          {health.pricing.asOf} · v{health.pricing.version}
        </span>
        <span className="detail-label">Unpriced models</span>
        <span className="detail-value mono">{formatNumber(unpriced.length)}</span>
      </div>
      {health.data === null ? (
        <p className="muted">Pricing coverage could not be checked because the source is unreadable.</p>
      ) : unpriced.length === 0 ? (
        <p className="muted">Every model with calls has a price card.</p>
      ) : (
        <div className="unpriced-list">
          {unpriced.map((row) => (
            <div className="unpriced-row" key={row.model}>
              <span className="mono">{row.model}</span>
              <span className="muted">
                {formatNumber(row.calls)} calls · {formatNumber(row.unpricedCalls)} unpriced ·{" "}
                {row.observedUsd === 0 ? "no observed charge" : formatUsd(row.observedUsd)}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="note">
        An unpriced call has no card and no observed charge. Its cost is unknown, not $0.
      </p>
    </div>
  );
}

function ReconcileDetail({ health }: { health: HealthDTO }) {
  const data = health.data;
  if (data === null) {
    return (
      <div className="health-detail">
        <p className="muted">Reconciliation did not run because the source could not be read.</p>
      </div>
    );
  }
  const reconcile = data.reconciliation;
  return (
    <div className="health-detail">
      <div className="detail-grid">
        <span className="detail-label">Sessions checked</span>
        <span className="detail-value mono">{formatNumber(reconcile.checkedSessions)}</span>
        <span className="detail-label">Mismatched</span>
        <span className="detail-value mono">{formatNumber(reconcile.mismatchSessions)}</span>
        <span className="detail-label">Largest delta</span>
        <span className="detail-value mono">{formatNumber(reconcile.largestDelta)} tokens</span>
        <span className="detail-label">Detector errors</span>
        <span className="detail-value mono">{formatNumber(data.detectorErrors.length)}</span>
      </div>
      {reconcile.mismatches.length === 0 ? (
        <p className="muted">
          Session aggregates agree with message totals within the reconciliation threshold.
        </p>
      ) : (
        <div className="mismatch-list">
          {reconcile.mismatches.map((row) => (
            <div className="mismatch-row" key={`${row.sessionId}-${row.category}`}>
              <span className="mono">{row.sessionId}</span>
              <span className="muted">
                {row.category}: expected {formatNumber(row.expected)}, got{" "}
                {formatNumber(row.actual)} ({row.delta >= 0 ? "+" : "−"}
                {formatNumber(Math.abs(row.delta))})
              </span>
            </div>
          ))}
        </div>
      )}
      {data.detectorErrors.length === 0 ? null : (
        <ul className="warnings">
          {data.detectorErrors.map((error) => (
            <li key={error.rule}>
              <span className="mono">{error.rule}</span> {error.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NetworkDetail() {
  return (
    <div className="health-detail">
      <p>
        Munin makes no outbound requests: there is no telemetry client, remote endpoint or
        update check in the desktop service.
      </p>
      <p className="note">
        This is an architectural property of the code, not a runtime measurement of this
        machine's traffic.
      </p>
    </div>
  );
}

function PrivacyDetail({ privacy }: { privacy: PrivacyDTO | null }) {
  if (privacy === null) {
    return (
      <div className="health-detail">
        <p className="muted">The privacy audit has not been loaded yet.</p>
      </div>
    );
  }
  return (
    <div className="health-detail">
      <div className="detail-grid">
        <span className="detail-label">Ledger audit</span>
        <span className="detail-value">
          {privacy.ledger.audit === "pass"
            ? "passed in this session"
            : privacy.ledger.audit === "empty"
              ? "no ledger files yet"
              : "failed"}
        </span>
        <span className="detail-label">Checked</span>
        <span className="detail-value mono">{formatMoment(privacy.checkedAt, "local")}</span>
        <span className="detail-label">Reads</span>
        <span className="detail-value wrap">{privacy.reads.join(" · ")}</span>
        <span className="detail-label">Never reads</span>
        <span className="detail-value wrap">{privacy.neverReads.join(", ")}</span>
        <span className="detail-label">Stores</span>
        <span className="detail-value wrap">{privacy.stores.join(" · ")}</span>
        <span className="detail-label">Retention</span>
        <span className="detail-value wrap">{privacy.retention}</span>
      </div>
      {privacy.ledger.auditMessage === null ? null : (
        <Notice tone={privacy.ledger.audit === "fail" ? "bad" : "neutral"}>
          {privacy.ledger.auditMessage}
        </Notice>
      )}
      <p className="note">
        The audit validates the derived ledger and snapshot journals for banned keys. The
        no-bodies rule is a design guarantee of the DTO boundary, not a scan of source content.
      </p>
    </div>
  );
}

function SnapshotDetails({ snapshot, timeZone }: { snapshot: Snapshot; timeZone: string }) {
  const warnings = Object.entries(snapshot.warningCounts);
  return (
    <div className="health-detail">
      <div className="detail-grid">
        <span className="detail-label">Snapshot</span>
        <span className="detail-value mono">#{snapshot.id}</span>
        <span className="detail-label">At</span>
        <span className="detail-value mono">{formatMoment(snapshot.at, timeZone)}</span>
        <span className="detail-label">Mode</span>
        <span className="detail-value">{snapshot.scope.mode}</span>
        <span className="detail-label">Sessions read</span>
        <span className="detail-value mono">{formatNumber(snapshot.scope.sessionsRead)}</span>
        <span className="detail-label">Slices replaced</span>
        <span className="detail-value mono">{formatNumber(snapshot.scope.slicesReplaced)}</span>
        <span className="detail-label">Tracked</span>
        <span className="detail-value mono">
          {formatNumber(snapshot.state.sessionsTracked)} sessions ·{" "}
          {formatNumber(snapshot.state.eventsTracked)} events
        </span>
        <span className="detail-label">Totals</span>
        <span className="detail-value mono">
          {formatNumber(snapshot.totals.calls)} calls · {formatUsd(snapshot.totals.headlineUsd)}
        </span>
        <span className="detail-label">Opportunities</span>
        <span className="detail-value mono">{formatNumber(snapshot.findings.length)}</span>
      </div>
      {warnings.length === 0 ? (
        <p className="muted">No warning counts recorded for this snapshot.</p>
      ) : (
        <ul className="warnings">
          {warnings.map(([code, count]) => (
            <li key={code}>
              <span className="mono">{code}</span> × {formatNumber(count)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function HealthView({ health, activity, privacy, timeZone }: HealthViewProps) {
  const [openRow, setOpenRow] = useState<HealthRowId | null>(null);
  const [openSnapshot, setOpenSnapshot] = useState<number | null>(null);

  const unpriced = health.data?.unpricedModels.length ?? 0;
  const reconcile = health.data?.reconciliation ?? null;
  const audit = privacy?.ledger.audit ?? null;

  const rows: ReadonlyArray<{
    id: HealthRowId;
    icon: IconName;
    label: string;
    value: string;
    tone: RowTone;
    detail: ReactNode;
  }> = [
    {
      id: "source",
      icon: "database",
      label: "OpenCode source",
      value:
        health.source.status === "ready"
          ? "Connected · read-only"
          : health.source.status === "missing"
            ? "Not found"
            : "Unreadable",
      tone:
        health.source.status === "ready"
          ? "ok"
          : health.source.status === "missing"
            ? "warn"
            : "bad",
      detail: <SourceDetail health={health} />,
    },
    {
      id: "pricing",
      icon: "tag",
      label: "Pricing table",
      value:
        health.data === null
          ? "Not checked"
          : unpriced === 0
            ? "All models priced"
            : `${unpriced} ${unpriced === 1 ? "model" : "models"} unpriced`,
      tone: health.data === null ? "muted" : unpriced === 0 ? "ok" : "warn",
      detail: <PricingDetail health={health} />,
    },
    {
      id: "reconcile",
      icon: "scale",
      label: "Ledger reconciliation",
      value:
        reconcile === null
          ? "Not checked"
          : reconcile.mismatchSessions === 0
            ? "Balanced"
            : `${reconcile.mismatchSessions} drifted`,
      tone:
        reconcile === null ? "muted" : reconcile.mismatchSessions === 0 ? "ok" : "warn",
      detail: <ReconcileDetail health={health} />,
    },
    {
      id: "network",
      icon: "wifi",
      label: "Network",
      value: "No outbound requests",
      tone: "ok",
      detail: <NetworkDetail />,
    },
    {
      id: "privacy",
      icon: "lock",
      label: "Privacy check",
      value:
        audit === "pass"
          ? "Ledger audit passed"
          : audit === "empty"
            ? "No ledger files yet"
            : audit === "fail"
              ? "Audit failed"
              : "Not checked",
      tone: audit === "pass" ? "ok" : audit === "fail" ? "bad" : "muted",
      detail: <PrivacyDetail privacy={privacy} />,
    },
  ];

  const snapshots = useMemo(() => [...activity.snapshots].reverse(), [activity.snapshots]);
  const diff = activity.latestDiff;
  const allWarnings = useMemo(() => {
    const merged = [
      ...(health.config.warnings ?? []),
      ...(health.data?.warnings ?? []),
      ...activity.warnings,
    ];
    const seen = new Set<string>();
    return merged.filter((warning) => {
      const key = `${warning.code}\u0000${warning.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [health.config.warnings, health.data?.warnings, activity.warnings]);

  return (
    <>
      <Card>
        <CardTitle
          aside={
            <span className="subtle">{formatMoment(health.checkedAt, "local")}</span>
          }
        >
          Health
        </CardTitle>
        <div className="health-rows">
          {rows.map((row) => (
            <div key={row.id} className="health-row-wrap">
              <HealthRow
                id={row.id}
                icon={row.icon}
                label={row.label}
                value={row.value}
                tone={row.tone}
                open={openRow === row.id}
                onToggle={(id) => setOpenRow((current) => (current === id ? null : id))}
              />
              {openRow === row.id ? row.detail : null}
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardTitle aside={<span className="subtle">vs previous snapshot</span>}>
          Since last scan
        </CardTitle>
        {diff === null ? (
          <EmptyState title="No previous snapshot to compare">
            {activity.snapshots.length === 0
              ? "No snapshots have been recorded yet. Refresh to run the first scan."
              : "Only one snapshot is recorded. Run one more scan to see what changed."}
          </EmptyState>
        ) : (
          <>
            <div className="delta-grid">
              <div className="delta">
                <span className="delta-value mono">{formatSignedUsd(diff.totals.headlineUsd)}</span>
                <span className="delta-label">spend</span>
              </div>
              <div className="delta">
                <span className="delta-value mono">
                  {deltaSign(diff.totals.totalTokens)}
                  {formatCompact(Math.abs(diff.totals.totalTokens))}
                </span>
                <span className="delta-label">tokens</span>
              </div>
              <div className="delta">
                <span className="delta-value mono">
                  {deltaSign(diff.sessions.delta)}
                  {formatNumber(Math.abs(diff.sessions.delta))}
                </span>
                <span className="delta-label">sessions</span>
              </div>
            </div>
            <p className="note">
              Snapshot #{diff.fromId} → #{diff.toId}. These are persisted ledger differences,
              not an estimate.
            </p>
          </>
        )}
      </Card>

      <Card>
        <CardTitle aside={<span className="subtle">{snapshots.length}</span>}>
          Scan history
        </CardTitle>
        {snapshots.length === 0 ? (
          <EmptyState title="No scans recorded">
            Scan history comes from persisted snapshots. Nothing is fabricated to fill it.
          </EmptyState>
        ) : (
          <div className="scan-list scroll-list">
            {snapshots.slice(0, 8).map((snapshot) => {
              const warnings = warningCount(snapshot);
              const open = openSnapshot === snapshot.id;
              return (
                <div className="scan-item" key={snapshot.id}>
                  <button
                    type="button"
                    className={`scan-row ${open ? "open" : ""}`}
                    aria-expanded={open}
                    onClick={() =>
                      setOpenSnapshot((current) => (current === snapshot.id ? null : snapshot.id))
                    }
                  >
                    <span className="mono scan-time">{formatClock(snapshot.at, timeZone)}</span>
                    <span className={`scan-status ${snapshot.dataClean ? "ok" : "warn"}`}>
                      {snapshot.dataClean
                        ? "OK"
                        : `${warnings} ${warnings === 1 ? "warning" : "warnings"}`}
                    </span>
                    <span className="mono scan-duration" title="Duration is not persisted">
                      —
                    </span>
                    <span className={`chevron ${open ? "open" : ""}`}>
                      <Icon name="chevron" size={13} />
                    </span>
                  </button>
                  {open ? <SnapshotDetails snapshot={snapshot} timeZone={timeZone} /> : null}
                </div>
              );
            })}
          </div>
        )}
        <p className="note">
          Background monitoring is off; Refresh scans on demand. Snapshot duration is not
          persisted, so it is not shown.
        </p>
      </Card>

      <Card>
        <CardTitle
          aside={
            <Badge tone={allWarnings.length === 0 ? "ok" : "warn"}>
              {allWarnings.length === 0 ? "none" : `${allWarnings.length}`}
            </Badge>
          }
        >
          Warnings
        </CardTitle>
        {allWarnings.length === 0 ? (
          <p className="muted">No source, pricing or ledger warnings in this read.</p>
        ) : (
          <ul className="warnings">
            {allWarnings.map((warning) => (
              <li key={`${warning.code}-${warning.message}`}>
                <span className="mono">{warning.code}</span> {warning.message}
                {warning.count === undefined ? "" : ` (${formatNumber(warning.count)})`}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="note page-note">
        Healthy here means the source was readable, the catalogue covered every priced call and
        the reconciliation found no drift. Missing checks are shown as missing, not as passes.
      </p>
    </>
  );
}
