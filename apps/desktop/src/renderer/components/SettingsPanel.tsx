import { useEffect, useRef } from "react";
import type { HealthDTO, PrivacyDTO } from "@munin/application";
import type { AppInfoDTO, ReadRequest } from "../../shared/ipc.js";
import { formatMoment, formatNumber } from "../../shared/view.js";
import { Icon } from "./Icon.js";

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  appInfo: AppInfoDTO | null;
  health: HealthDTO | null;
  privacy: PrivacyDTO | null;
  readOptions: ReadRequest;
  busy: boolean;
  onChangeDays: (days: number | undefined) => void;
  onChangeTimeZone: (tz: string | undefined) => void;
  onScan: () => void;
}

const WINDOWS: ReadonlyArray<{ label: string; days: number | undefined }> = [
  { label: "All", days: undefined },
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

export function SettingsPanel({
  open,
  onClose,
  appInfo,
  health,
  privacy,
  readOptions,
  busy,
  onChangeDays,
  onChangeTimeZone,
  onScan,
}: SettingsPanelProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const audit = privacy?.ledger.audit ?? null;

  return (
    <div
      className="overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header className="settings-head">
          <div>
            <h2 id="settings-title">Settings</h2>
            <p className="settings-sub">View options apply to this session.</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close settings"
            title="Close"
          >
            <Icon name="close" size={15} />
          </button>
        </header>

        <div className="settings-body">
          <section className="settings-section">
            <h3>Reporting window</h3>
            <div className="chip-row" role="group" aria-label="Reporting window">
              {WINDOWS.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className={`chip ${readOptions.days === option.days ? "active" : ""}`}
                  aria-pressed={readOptions.days === option.days}
                  onClick={() => onChangeDays(option.days)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="note">
              Uses Munin's existing read filter. It re-reads the source; it never scans or
              writes.
            </p>
          </section>

          <section className="settings-section">
            <h3>Time zone</h3>
            <div className="chip-row" role="group" aria-label="Day bucket time zone">
              <button
                type="button"
                className={`chip ${readOptions.tz === undefined || readOptions.tz === "UTC" ? "active" : ""}`}
                aria-pressed={readOptions.tz === undefined || readOptions.tz === "UTC"}
                onClick={() => onChangeTimeZone(undefined)}
              >
                UTC
              </button>
              <button
                type="button"
                className={`chip ${readOptions.tz === "local" ? "active" : ""}`}
                aria-pressed={readOptions.tz === "local"}
                onClick={() => onChangeTimeZone("local")}
              >
                Local
              </button>
            </div>
            <p className="note">Controls the report's day buckets and displayed range.</p>
          </section>

          <section className="settings-section">
            <h3>Source</h3>
            <dl className="settings-list">
              <dt>Database</dt>
              <dd className="mono">{health?.config.dbPath ?? "not loaded"}</dd>
              <dt>Origin</dt>
              <dd>{health?.config.dbOrigin ?? "—"}</dd>
              <dt>Schema</dt>
              <dd className="mono">{health?.source.schema ?? "—"}</dd>
              <dt>Size</dt>
              <dd className="mono">
                {health?.source.sizeBytes === undefined
                  ? "—"
                  : `${formatNumber(health.source.sizeBytes)} bytes`}
              </dd>
              <dt>State directory</dt>
              <dd className="mono">{health?.config.stateDir ?? "—"}</dd>
              <dt>Settings file</dt>
              <dd className="mono">{health?.config.settingsPath ?? "—"}</dd>
            </dl>
            <p className="note">
              Munin's settings file is written only by its existing apply/undo flows. This panel
              changes read filters, not persisted configuration.
            </p>
          </section>

          <section className="settings-section">
            <h3>Privacy</h3>
            <dl className="settings-list">
              <dt>Network</dt>
              <dd>No outbound requests (by design)</dd>
              <dt>Ledger audit</dt>
              <dd>
                {audit === null
                  ? "not loaded"
                  : audit === "pass"
                    ? `passed at ${privacy === null ? "—" : formatMoment(privacy.checkedAt, "local")}`
                    : audit === "empty"
                      ? "no ledger files yet"
                      : "failed"}
              </dd>
              <dt>Never reads</dt>
              <dd>{privacy === null ? "—" : privacy.neverReads.join(", ")}</dd>
              <dt>Retention</dt>
              <dd>{privacy?.retention ?? "—"}</dd>
            </dl>
          </section>

          <section className="settings-section">
            <h3>Runtime</h3>
            <dl className="settings-list">
              <dt>Munin</dt>
              <dd className="mono">{appInfo?.version ?? "—"}</dd>
              <dt>Electron</dt>
              <dd className="mono">{appInfo?.electron ?? "—"}</dd>
              <dt>Node</dt>
              <dd className="mono">{appInfo?.node ?? "—"}</dd>
              <dt>Chromium</dt>
              <dd className="mono">{appInfo?.chrome ?? "—"}</dd>
              <dt>Platform</dt>
              <dd className="mono">{appInfo?.platform ?? "—"}</dd>
              <dt>Packaged</dt>
              <dd>{appInfo === null ? "—" : appInfo.packaged ? "yes" : "no"}</dd>
            </dl>
          </section>

          <section className="settings-section">
            <h3>Maintenance</h3>
            <button type="button" className="text-button" onClick={onScan} disabled={busy}>
              <Icon name="refresh" size={13} />
              {busy ? "Scan in progress…" : "Run a scan now"}
            </button>
            <p className="note">
              Scans use the existing runtime and update Munin's derived state. Background
              monitoring is off.
            </p>
          </section>
        </div>
      </section>
    </div>
  );
}
