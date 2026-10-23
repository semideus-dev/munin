import { useEffect, useMemo, useState } from "react";
import type { SessionSummary, SpendBucket } from "@munin/core";
import type {
  SessionDetailDTO,
  ServiceErrorDTO,
  UsageOverviewDTO,
} from "@munin/application";
import type { ReadRequest } from "../../shared/ipc.js";
import {
  costLabel,
  formatCompact,
  formatMoment,
  formatNumber,
  formatPercent,
  formatUsd,
  sessionHeading,
  subagentCount,
  tokenSegments,
} from "../../shared/view.js";
import { Badge, Card, CardTitle, EmptyState, Metric, Notice, Spinner } from "../components/primitives.js";
import { Icon } from "../components/Icon.js";

interface UsageViewProps {
  data: UsageOverviewDTO;
  readOptions: ReadRequest;
  selectedModel: string | null;
  selectedSession: string | null;
  onModel: (key: string | null) => void;
  onSession: (id: string | null) => void;
}

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="back-button" onClick={onClick}>
      <Icon name="back" size={13} /> {label}
    </button>
  );
}

function ModelRow({
  bucket,
  maxUsd,
  onOpen,
}: {
  bucket: SpendBucket;
  maxUsd: number;
  onOpen: () => void;
}) {
  const unknown = bucket.unpriced && bucket.headlineUsd === 0;
  const width = maxUsd <= 0 ? 0 : Math.max(1, (bucket.headlineUsd / maxUsd) * 100);
  return (
    <button
      type="button"
      className="bar-row"
      onClick={onOpen}
      aria-label={`${bucket.key}: ${costLabel(bucket.unpriced, bucket.headlineUsd)} across ${bucket.calls} calls`}
    >
      <span className="bar-row-label mono" title={bucket.key}>
        {bucket.key || "unknown model"}
      </span>
      <span className="bar-row-track" aria-hidden="true">
        <span
          className={`bar-row-fill ${unknown ? "unknown" : ""}`}
          style={{ width: `${width}%` }}
        />
      </span>
      <span className={`bar-row-value mono ${unknown ? "unknown" : ""}`}>
        {costLabel(bucket.unpriced, bucket.headlineUsd)}
      </span>
    </button>
  );
}

function SessionRow({
  session,
  sessions,
  onOpen,
}: {
  session: SessionSummary;
  sessions: readonly SessionSummary[];
  onOpen: () => void;
}) {
  const heading = sessionHeading(session);
  const subs = subagentCount(sessions, session.id);
  const unknown = session.unpriced && session.headlineUsd === 0;
  return (
    <button
      type="button"
      className="session-row"
      onClick={onOpen}
      aria-label={`${heading.title}, session ${heading.shortId}: ${costLabel(session.unpriced, session.headlineUsd)}`}
    >
      <span className="session-name">
        <span className="session-title" title={session.title ?? session.project}>
          {heading.title}
        </span>
        <span className="session-meta mono">
          #{heading.shortId}
          {subs > 0 ? ` · ${subs} sub` : ""}
          {session.isSubagent ? " · subagent" : ""}
        </span>
      </span>
      <span className={`session-cost mono ${unknown ? "unknown" : ""}`}>
        {costLabel(session.unpriced, session.headlineUsd)}
      </span>
      <span className="chevron">
        <Icon name="chevron" size={13} />
      </span>
    </button>
  );
}

function SessionDetail({
  detail,
  sessions,
  onBack,
  onSession,
}: {
  detail: SessionDetailDTO;
  sessions: readonly SessionSummary[];
  onBack: () => void;
  onSession: (id: string) => void;
}) {
  const { session } = detail;
  const heading = sessionHeading(session);
  const children = sessions.filter((row) => row.parentSessionId === session.id);
  const parent = sessions.find((row) => row.id === detail.parentSessionId);
  return (
    <>
      <Card>
        <BackButton label="Usage" onClick={onBack} />
        <div className="detail-heading">
          <div>
            <div className="detail-title" title={session.title ?? session.project}>
              {heading.title}
            </div>
            <div className="detail-sub mono">
              #{heading.shortId} · {session.project || "no project"}
            </div>
          </div>
          <div className="chip-row">
            {session.isSubagent ? <Badge tone="cyan">subagent</Badge> : null}
            {session.unpriced ? <Badge tone="warn">unpriced</Badge> : null}
          </div>
        </div>

        <div className="metric-grid three">
          <Metric label="Headline" value={costLabel(session.unpriced, session.headlineUsd)} />
          <Metric label="Observed" value={formatUsd(session.observedUsd)} />
          <Metric label="Estimated" value={formatUsd(session.estimatedUsd)} />
          <Metric label="Calls" value={formatNumber(session.calls)} />
          <Metric label="Turns" value={formatNumber(session.turns)} />
          <Metric label="Tokens" value={formatCompact(session.totalTokens)} />
          <Metric label="Cache hit" value={formatPercent(session.cacheHitRate)} />
          <Metric label="Coverage" value={formatPercent(session.observedCoverage)} />
          <Metric label="Schema" value={session.schema} mono={false} />
        </div>

        <div className="detail-grid spaced">
          <span className="detail-label">Agents</span>
          <span className="detail-value">
            {session.agents.length === 0 ? "not recorded" : session.agents.join(", ")}
          </span>
          <span className="detail-label">Models</span>
          <span className="detail-value mono wrap">
            {session.models.length === 0 ? "none" : session.models.join(", ")}
          </span>
          <span className="detail-label">First call</span>
          <span className="detail-value mono">
            {session.firstTs === null ? "—" : formatMoment(session.firstTs, "local")}
          </span>
          <span className="detail-label">Last call</span>
          <span className="detail-value mono">
            {session.lastTs === null ? "—" : formatMoment(session.lastTs, "local")}
          </span>
          <span className="detail-label">Compactions</span>
          <span className="detail-value mono">{formatNumber(session.compactions)}</span>
          <span className="detail-label">Parent</span>
          <span className="detail-value mono">
            {parent === undefined ? (
              detail.parentSessionId ?? "none"
            ) : (
              <button type="button" className="inline-link" onClick={() => onSession(parent.id)}>
                #{sessionHeading(parent).shortId} {sessionHeading(parent).title}
              </button>
            )}
          </span>
        </div>

        {children.length === 0 ? null : (
          <div className="sub-block">
            <h3>Subagent sessions</h3>
            <div className="session-list compact">
              {children.map((child) => (
                <SessionRow
                  key={child.id}
                  session={child}
                  sessions={sessions}
                  onOpen={() => onSession(child.id)}
                />
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card>
        <CardTitle aside={<span className="subtle">{detail.attempts.length} total</span>}>
          Attempts
        </CardTitle>
        {detail.attempts.length === 0 ? (
          <p className="muted">No attempts recorded for this session.</p>
        ) : (
          <div className="scroll-list attempts">
            {detail.attempts.map((attempt) => (
              <div
                key={attempt.id}
                className={`attempt-row ${attempt.hasUsage ? "" : "failed"}`}
              >
                <span className="mono attempt-time">{formatMoment(attempt.ts, "local")}</span>
                <span className="mono attempt-model" title={attempt.model ?? attempt.id}>
                  {attempt.model ?? attempt.errorType ?? "attempt"}
                </span>
                <span className={`attempt-state ${attempt.hasUsage ? "ok" : "bad"}`}>
                  {attempt.hasUsage ? "usage" : "failed"}
                </span>
                <span className="mono attempt-cost">
                  {attempt.observedUsd === null ? "—" : formatUsd(attempt.observedUsd)}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="note">
          Failed attempts are listed separately and never counted as free successful calls.
        </p>
      </Card>

      <Card>
        <CardTitle aside={<span className="subtle">{detail.events.length} priced</span>}>
          Model calls
        </CardTitle>
        {detail.events.length === 0 ? (
          <p className="muted">No priced model calls in this session.</p>
        ) : (
          <div className="scroll-list events">
            {detail.events.map((event) => (
              <div className="event-row" key={event.id}>
                <div className="row-between">
                  <span className="mono event-model" title={event.model}>
                    {event.model}
                  </span>
                  <span className="mono event-cost">
                    {event.cost.unpriced && event.cost.total === 0
                      ? "unknown"
                      : formatUsd(event.cost.total)}
                  </span>
                </div>
                <div className="event-meta mono">
                  {formatMoment(event.ts, "local")} · {formatCompact(event.inputTokens)} in ·{" "}
                  {formatCompact(event.outputTokens)} out · {formatCompact(event.cacheReadTokens)}{" "}
                  read
                  {event.thinkingTokens > 0
                    ? ` · ${formatCompact(event.thinkingTokens)} thinking`
                    : ""}
                </div>
                <div className="event-meta muted">
                  {event.agent ?? "no agent"}
                  {event.latencyMs === null ? "" : ` · ${formatNumber(event.latencyMs)} ms`}
                  {event.toolCallCount === 0 ? "" : ` · ${event.toolCallCount} tools`}
                  {event.stopReason === null ? "" : ` · ${event.stopReason}`}
                  {event.isSubagent ? " · subagent" : ""}
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="note">
          Only call metadata is shown: no prompts, message bodies or tool output.
        </p>
      </Card>
    </>
  );
}

function ModelDetail({
  bucket,
  sessions,
  onBack,
  onSession,
}: {
  bucket: SpendBucket;
  sessions: readonly SessionSummary[];
  onBack: () => void;
  onSession: (id: string) => void;
}) {
  const matching = sessions.filter((session) => session.models.includes(bucket.key));
  const unknown = bucket.unpriced && bucket.headlineUsd === 0;
  return (
    <>
      <Card>
        <BackButton label="Usage" onClick={onBack} />
        <div className="detail-heading">
          <div>
            <div className="detail-title mono">{bucket.key}</div>
            <div className="detail-sub">
              {bucket.providers.length === 0 ? "provider unknown" : bucket.providers.join(", ")}
            </div>
          </div>
          {bucket.unpriced ? <Badge tone="warn">unpriced</Badge> : null}
        </div>
        <div className="metric-grid three">
          <Metric label="Headline" value={costLabel(bucket.unpriced, bucket.headlineUsd)} />
          <Metric label="Observed" value={formatUsd(bucket.observedUsd)} />
          <Metric label="Estimated" value={formatUsd(bucket.estimatedUsd)} />
          <Metric label="Calls" value={formatNumber(bucket.calls)} />
          <Metric label="Tokens" value={formatCompact(bucket.totalTokens)} />
          <Metric label="Spend share" value={formatPercent(bucket.spendShare)} />
          <Metric label="Cache hit" value={formatPercent(bucket.cacheHitRate)} />
          <Metric label="Input" value={formatCompact(bucket.inputTokens)} />
          <Metric label="Output" value={formatCompact(bucket.outputTokens)} />
        </div>
        {unknown ? (
          <Notice tone="warn">
            This model has no price card and no observed charge, so its cost is unknown, not
            zero.
          </Notice>
        ) : null}
      </Card>

      <Card>
        <CardTitle aside={<span className="subtle">{matching.length}</span>}>Sessions</CardTitle>
        {matching.length === 0 ? (
          <p className="muted">No sessions in this window use this model.</p>
        ) : (
          <div className="session-list">
            {matching.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                sessions={sessions}
                onOpen={() => onSession(session.id)}
              />
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

function SessionLoader({
  sessionId,
  readOptions,
  sessions,
  onBack,
  onSession,
}: {
  sessionId: string;
  readOptions: ReadRequest;
  sessions: readonly SessionSummary[];
  onBack: () => void;
  onSession: (id: string) => void;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; detail: SessionDetailDTO | null }
    | { status: "error"; error: ServiceErrorDTO }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const bridge = window.munin;
    if (bridge === undefined) {
      setState({
        status: "error",
        error: {
          code: "bridge.missing",
          kind: "internal",
          message: "The desktop bridge did not load. Restart Munin.",
        },
      });
      return;
    }
    void bridge
      .getSessionDetail({ ...readOptions, sessionId })
      .then((result) => {
        if (cancelled) return;
        setState(
          result.ok
            ? { status: "ready", detail: result.data }
            : { status: "error", error: result.error },
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          error: {
            code: "ipc.failed",
            kind: "internal",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, readOptions]);

  if (state.status === "loading") {
    return (
      <Card>
        <BackButton label="Usage" onClick={onBack} />
        <Spinner label="Loading session" />
      </Card>
    );
  }
  if (state.status === "error") {
    return (
      <Card>
        <BackButton label="Usage" onClick={onBack} />
        <Notice tone="bad">{state.error.message}</Notice>
      </Card>
    );
  }
  if (state.detail === null) {
    return (
      <Card>
        <BackButton label="Usage" onClick={onBack} />
        <EmptyState title="Session not found in this window">
          The session may have fallen outside the active reporting window. Nothing is invented
          to fill the detail.
        </EmptyState>
      </Card>
    );
  }
  return (
    <SessionDetail
      detail={state.detail}
      sessions={sessions}
      onBack={onBack}
      onSession={onSession}
    />
  );
}

export function UsageView({
  data,
  readOptions,
  selectedModel,
  selectedSession,
  onModel,
  onSession,
}: UsageViewProps) {
  const segments = useMemo(() => tokenSegments(data.totals), [data.totals]);
  const model = useMemo(
    () => data.byModel.find((row) => row.key === selectedModel) ?? null,
    [data.byModel, selectedModel],
  );
  const maxModelUsd = Math.max(0, ...data.byModel.map((row) => row.headlineUsd));

  if (selectedSession !== null) {
    return (
      <SessionLoader
        sessionId={selectedSession}
        readOptions={readOptions}
        sessions={data.sessions}
        onBack={() => onSession(null)}
        onSession={onSession}
      />
    );
  }

  if (model !== null) {
    return (
      <ModelDetail
        bucket={model}
        sessions={data.sessions}
        onBack={() => onModel(null)}
        onSession={onSession}
      />
    );
  }

  if (selectedModel !== null) {
    return (
      <Card>
        <BackButton label="Usage" onClick={() => onModel(null)} />
        <EmptyState title="Model not found in this window">
          The model has no calls inside the active reporting window.
        </EmptyState>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardTitle
          aside={<span className="subtle">{formatNumber(data.byModel.length)} models</span>}
        >
          By model
        </CardTitle>
        {data.byModel.length === 0 ? (
          <p className="muted">No model calls in this window.</p>
        ) : (
          <div className="bar-list">
            {data.byModel.map((bucket) => (
              <ModelRow
                key={bucket.key}
                bucket={bucket}
                maxUsd={maxModelUsd}
                onOpen={() => onModel(bucket.key)}
              />
            ))}
          </div>
        )}
        <p className="note">
          Bars use headline cost. Unpriced rows show unknown, never a fabricated zero.
        </p>
      </Card>

      <Card>
        <CardTitle
          aside={<span className="subtle">{formatCompact(data.totals.totalTokens)} total</span>}
        >
          Token composition
        </CardTitle>
        {data.totals.totalTokens === 0 ? (
          <p className="muted">No tokens in this window.</p>
        ) : (
          <>
            <div
              className="stack"
              role="img"
              aria-label={segments
                .map(
                  (segment) =>
                    `${segment.label} ${formatNumber(segment.value)} tokens (${formatPercent(segment.share)})`,
                )
                .join(", ")}
            >
              {segments.map((segment) => (
                <span
                  key={segment.key}
                  className={`stack-seg ${segment.tone}`}
                  style={{ width: `${segment.share * 100}%` }}
                  title={`${segment.label}: ${formatNumber(segment.value)} (${formatPercent(segment.share)})`}
                />
              ))}
            </div>
            <div className="legend">
              {segments.map((segment) => (
                <span className="legend-row" key={segment.key}>
                  <span className={`legend-dot ${segment.tone}`} />
                  <span className="legend-label">{segment.label}</span>
                  <span className="legend-value mono">{formatCompact(segment.value)}</span>
                  <span className="legend-share mono">{formatPercent(segment.share)}</span>
                </span>
              ))}
            </div>
            <p className="note">
              Mutually exclusive: uncached input, cache read, cache write and priced output.
              Output already includes thinking, so nothing is counted twice.
            </p>
          </>
        )}
      </Card>

      <Card>
        <CardTitle
          aside={<span className="subtle">{formatNumber(data.sessions.length)} sessions</span>}
        >
          Recent sessions
        </CardTitle>
        {data.sessions.length === 0 ? (
          <p className="muted">No sessions with usage-bearing calls in this window.</p>
        ) : (
          <div className="session-list scroll-list">
            {data.sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                sessions={data.sessions}
                onOpen={() => onSession(session.id)}
              />
            ))}
          </div>
        )}
        <p className="note">
          Parent and subagent sessions are listed separately; child usage is not rolled into the
          parent.
        </p>
      </Card>
    </>
  );
}
