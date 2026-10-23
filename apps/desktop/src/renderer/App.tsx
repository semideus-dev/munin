import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActivityDTO,
  FindingListDTO,
  HealthDTO,
  OverviewDTO,
  PrivacyDTO,
  ServiceErrorDTO,
  UsageOverviewDTO,
} from "@munin/application";
import type { FindingTier } from "@munin/core";
import type { AppInfoDTO, IpcResult, ReadRequest } from "../shared/ipc.js";
import { Content, Footer, Header, TabBar, type TabId } from "./components/Frame.js";
import { Icon } from "./components/Icon.js";
import { Badge, Card } from "./components/primitives.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { OverviewView } from "./views/OverviewView.js";
import { OptimizeView } from "./views/OptimizeView.js";
import { UsageView } from "./views/UsageView.js";
import { HealthView } from "./views/HealthView.js";

type Bundle = {
  overview?: OverviewDTO;
  findings?: FindingListDTO;
  usage?: UsageOverviewDTO;
  health?: HealthDTO;
  activity?: ActivityDTO;
  privacy?: PrivacyDTO;
  appInfo?: AppInfoDTO;
  errors: Partial<Record<"overview" | "findings" | "usage" | "health" | "activity" | "privacy", ServiceErrorDTO>>;
};

type BundleKey = "overview" | "findings" | "usage" | "health" | "activity" | "privacy";

type Loaded<T> = { data?: T; error?: ServiceErrorDTO };

function failure(error: unknown): ServiceErrorDTO {
  return {
    code: "ipc.failed",
    kind: "internal",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function settle<T>(promise: Promise<IpcResult<T>>): Promise<Loaded<T>> {
  try {
    const result = await promise;
    return result.ok ? { data: result.data } : { error: result.error };
  } catch (error) {
    return { error: failure(error) };
  }
}

function errorsOf(entries: Array<[BundleKey, Loaded<unknown>]>): Bundle["errors"] {
  const errors: Bundle["errors"] = {};
  for (const [key, value] of entries) {
    if (value.error !== undefined) errors[key] = value.error;
  }
  return errors;
}

function tabFromHash(): TabId | null {
  const value = window.location.hash.replace(/^#\/?/, "");
  return value === "overview" || value === "optimize" || value === "usage" || value === "health"
    ? value
    : null;
}

function ErrorCard({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: ServiceErrorDTO;
  onRetry: () => void;
}) {
  return (
    <Card className="error-card">
      <div className="row-between">
        <span className="card-title-label">{title}</span>
        <Badge tone="bad">{error.kind}</Badge>
      </div>
      <p className="error-code mono">{error.code}</p>
      <p className="error-message">{error.message}</p>
      <button type="button" className="text-button" onClick={onRetry}>
        <Icon name="refresh" size={13} /> Retry read
      </button>
      <p className="note">
        Retrying a read never scans and never writes. Use Refresh when you want a new scan.
      </p>
    </Card>
  );
}

function LoadingCard() {
  return (
    <Card>
      <div className="loading-line">
        <span className="spinner-dot" />
        <span className="spinner-dot" />
        <span className="spinner-dot" />
        <span>Reading the local OpenCode database…</span>
      </div>
    </Card>
  );
}

export function App() {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [tab, setTab] = useState<TabId>(() => tabFromHash() ?? "overview");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanNotice, setScanNotice] = useState<{ tone: "ok" | "warn" | "bad"; message: string } | null>(
    null,
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [readOptions, setReadOptions] = useState<ReadRequest>({});
  const [optimizeTier, setOptimizeTier] = useState<FindingTier | "all">("all");
  const [optimizeRule, setOptimizeRule] = useState<string | null>(null);
  const [usageModel, setUsageModel] = useState<string | null>(null);
  const [usageSession, setUsageSession] = useState<string | null>(null);
  const activeRef = useRef(0);

  const stableReadOptions = useMemo(
    () => ({
      ...(readOptions.days === undefined ? {} : { days: readOptions.days }),
      ...(readOptions.tz === undefined ? {} : { tz: readOptions.tz }),
    }),
    [readOptions.days, readOptions.tz],
  );

  useEffect(() => {
    const bridge = window.munin;
    if (bridge === undefined) {
      setBundle({
        errors: {
          overview: {
            code: "bridge.missing",
            kind: "internal",
            message: "The desktop bridge did not load. Restart Munin.",
          },
        },
      });
      setLoading(false);
      return;
    }
    const id = activeRef.current + 1;
    activeRef.current = id;
    void (async () => {
      const [overview, findings, usage, health, activity, privacy, appInfo] = await Promise.all([
        settle(bridge.getOverview(stableReadOptions)),
        settle(bridge.getFindings(stableReadOptions)),
        settle(bridge.getUsage(stableReadOptions)),
        settle(bridge.getHealth(stableReadOptions)),
        settle(bridge.getActivity(stableReadOptions)),
        settle(bridge.getPrivacyStatus(stableReadOptions)),
        settle(bridge.getAppInfo()),
      ]);
      if (activeRef.current !== id) return;
      setBundle({
        ...(overview.data === undefined ? {} : { overview: overview.data }),
        ...(findings.data === undefined ? {} : { findings: findings.data }),
        ...(usage.data === undefined ? {} : { usage: usage.data }),
        ...(health.data === undefined ? {} : { health: health.data }),
        ...(activity.data === undefined ? {} : { activity: activity.data }),
        ...(privacy.data === undefined ? {} : { privacy: privacy.data }),
        ...(appInfo.data === undefined ? {} : { appInfo: appInfo.data }),
        errors: errorsOf([
          ["overview", overview],
          ["findings", findings],
          ["usage", usage],
          ["health", health],
          ["activity", activity],
          ["privacy", privacy],
        ]),
      });
      setLoading(false);
    })();
  }, [stableReadOptions, refreshKey]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const bridge = window.munin;
    if (bridge === undefined) return;
    return bridge.onScanEvent(() => setRefreshKey((value) => value + 1));
  }, []);

  useEffect(() => {
    const onHash = (): void => {
      const next = tabFromHash();
      if (next !== null) setTab(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const desired = `#/${tab}`;
    if (window.location.hash !== desired) {
      window.history.replaceState(null, "", desired);
    }
  }, [tab]);

  const reload = useCallback(() => setRefreshKey((value) => value + 1), []);

  const scan = useCallback(async () => {
    const bridge = window.munin;
    if (bridge === undefined) return;
    setBusy(true);
    setScanNotice(null);
    try {
      const result = await bridge.runScan(stableReadOptions);
      if (!result.ok) {
        setScanNotice({ tone: "bad", message: `${result.error.code}: ${result.error.message}` });
      } else {
        const warnings = result.data.warnings.length;
        setScanNotice(
          warnings === 0
            ? { tone: "ok", message: "Scan complete. The open view was refreshed." }
            : {
                tone: "warn",
                message: `Scan complete with ${warnings} ${warnings === 1 ? "warning" : "warnings"}. The open view was refreshed.`,
              },
        );
        setRefreshKey((value) => value + 1);
      }
    } catch (error) {
      setScanNotice({ tone: "bad", message: failure(error).message });
    } finally {
      setBusy(false);
    }
  }, [stableReadOptions]);

  const minimize = useCallback(async () => {
    const bridge = window.munin;
    if (bridge === undefined) return;
    const result = await bridge.minimize();
    if (!result.ok) setScanNotice({ tone: "bad", message: result.error.message });
  }, []);

  const openTier = useCallback((tier: FindingTier | "all") => {
    setOptimizeTier(tier);
    setOptimizeRule(null);
    setTab("optimize");
  }, []);

  const openFinding = useCallback((rule: string) => {
    setOptimizeRule(rule);
    setTab("optimize");
  }, []);

  const changeDays = useCallback((days: number | undefined) => {
    setReadOptions((current) => ({ ...current, days }));
    setOptimizeRule(null);
    setUsageModel(null);
    setUsageSession(null);
  }, []);

  const changeTimeZone = useCallback((tz: string | undefined) => {
    setReadOptions((current) => ({ ...current, tz }));
    setOptimizeRule(null);
    setUsageModel(null);
    setUsageSession(null);
  }, []);

  const overview = bundle?.overview;
  const timeZone = overview?.timeZone ?? stableReadOptions.tz ?? "UTC";
  const source = overview?.source ?? bundle?.health?.source;
  const lastScanAt =
    overview?.scan.lastScanAt ??
    bundle?.activity?.lastScan?.at ??
    bundle?.activity?.latestSnapshot?.at ??
    null;

  const content = (() => {
    if (loading) return <LoadingCard />;
    if (tab === "overview") {
      if (overview === undefined) {
        return (
          <ErrorCard
            title="Overview"
            error={bundle?.errors.overview ?? failure("Overview data is unavailable.")}
            onRetry={reload}
          />
        );
      }
      return (
        <OverviewView
          overview={overview}
          byDay={bundle?.usage?.byDay ?? null}
          onOpenTier={openTier}
          onOpenFinding={openFinding}
        />
      );
    }
    if (tab === "optimize") {
      const findings = bundle?.findings;
      if (findings === undefined) {
        return (
          <ErrorCard
            title="Optimize"
            error={bundle?.errors.findings ?? failure("Finding data is unavailable.")}
            onRetry={reload}
          />
        );
      }
      return (
        <OptimizeView
          data={findings}
          tier={optimizeTier}
          selectedRule={optimizeRule}
          readOptions={stableReadOptions}
          onTier={(tier) => {
            setOptimizeTier(tier);
            setOptimizeRule(null);
          }}
          onSelectRule={setOptimizeRule}
        />
      );
    }
    if (tab === "usage") {
      const usage = bundle?.usage;
      if (usage === undefined) {
        return (
          <ErrorCard
            title="Usage"
            error={bundle?.errors.usage ?? failure("Usage data is unavailable.")}
            onRetry={reload}
          />
        );
      }
      return (
        <UsageView
          data={usage}
          readOptions={stableReadOptions}
          selectedModel={usageModel}
          selectedSession={usageSession}
          onModel={(key) => {
            setUsageModel(key);
            setUsageSession(null);
          }}
          onSession={setUsageSession}
        />
      );
    }
    const health = bundle?.health;
    const activity = bundle?.activity;
    if (health === undefined || activity === undefined) {
      return (
        <ErrorCard
          title="Health"
          error={
            bundle?.errors.health ??
            bundle?.errors.activity ??
            failure("Health data is unavailable.")
          }
          onRetry={reload}
        />
      );
    }
    return (
      <HealthView
        health={health}
        activity={activity}
        privacy={bundle?.privacy ?? null}
        timeZone={timeZone}
      />
    );
  })();

  return (
    <div className="shell">
      <Header
        source={source}
        lastScanAt={lastScanAt}
        nowMs={nowMs}
        busy={busy}
        onRefresh={() => void scan()}
        onSettings={() => setSettingsOpen(true)}
        onMinimize={() => void minimize()}
      />
      <TabBar active={tab} onChange={setTab} />

      {scanNotice === null ? null : (
        <div className={`scan-notice ${scanNotice.tone}`} role="status">
          <span>{scanNotice.message}</span>
          <button
            type="button"
            className="notice-close"
            onClick={() => setScanNotice(null)}
            aria-label="Dismiss scan message"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      <Content>{content}</Content>
      <Footer window={overview?.window ?? null} timeZone={timeZone} />

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        appInfo={bundle?.appInfo ?? null}
        health={bundle?.health ?? null}
        privacy={bundle?.privacy ?? null}
        readOptions={stableReadOptions}
        busy={busy}
        onChangeDays={changeDays}
        onChangeTimeZone={changeTimeZone}
        onScan={() => void scan()}
      />

      {loading ? null : (
        <div className="sr-only" aria-live="polite">
          {bundle?.errors.overview === undefined
            ? "Munin data loaded."
            : `Munin could not read usage: ${bundle.errors.overview.message}`}
        </div>
      )}
    </div>
  );
}
