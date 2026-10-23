import type { ReactNode } from "react";
import type { SourceStatusDTO } from "@munin/application";
import { formatRelativeTime, formatWindowRange } from "../../shared/view.js";
import type { Window } from "@munin/core";
import { Icon, type IconName } from "./Icon.js";

export type TabId = "overview" | "optimize" | "usage" | "health";

export const TABS: ReadonlyArray<{ id: TabId; label: string; icon: IconName }> = [
  { id: "overview", label: "Overview", icon: "gauge" },
  { id: "optimize", label: "Optimize", icon: "bulb" },
  { id: "usage", label: "Usage", icon: "chart" },
  { id: "health", label: "Health", icon: "pulse" },
];

function toneOf(source: SourceStatusDTO | undefined): string {
  if (source === undefined) return "muted";
  if (source.status === "ready") return "ok";
  if (source.status === "missing") return "warn";
  return "bad";
}

export interface HeaderProps {
  source?: SourceStatusDTO;
  lastScanAt: string | null;
  nowMs: number;
  busy: boolean;
  onRefresh: () => void;
  onSettings: () => void;
  onMinimize: () => void;
}

export function Header({
  source,
  lastScanAt,
  nowMs,
  busy,
  onRefresh,
  onSettings,
  onMinimize,
}: HeaderProps) {
  const freshness =
    lastScanAt === null ? "No scan yet" : `Scanned ${formatRelativeTime(lastScanAt, nowMs)}`;
  return (
    <header className="header">
      <div className="brand">
        <span className="brand-badge" aria-hidden="true">
          M
        </span>
        <div className="brand-text">
          <span className="brand-name">Munin</span>
          <span className="brand-status">
            <span className={`status-dot ${busy ? "busy" : toneOf(source)}`} />
            <span>{busy ? "Scanning…" : freshness}</span>
          </span>
        </div>
      </div>
      <div className="header-actions">
        <button
          type="button"
          className={`icon-button ${busy ? "spinning" : ""}`}
          onClick={onRefresh}
          disabled={busy}
          aria-label={busy ? "Scan in progress" : "Scan now"}
          title={busy ? "Scan in progress" : "Scan now"}
        >
          <Icon name="refresh" size={15} />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onSettings}
          aria-label="Settings"
          title="Settings"
        >
          <Icon name="gear" size={15} />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onMinimize}
          aria-label="Minimize window"
          title="Minimize"
        >
          <Icon name="minimize" size={15} />
        </button>
      </div>
    </header>
  );
}

export interface TabBarProps {
  active: TabId;
  onChange: (tab: TabId) => void;
}

export function TabBar({ active, onChange }: TabBarProps) {
  return (
    <nav className="tabs" role="tablist" aria-label="Munin sections">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          data-tab={tab.id}
          aria-selected={active === tab.id}
          className={`tab ${active === tab.id ? "active" : ""}`}
          onClick={() => onChange(tab.id)}
        >
          <Icon name={tab.icon} size={15} />
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}

export interface FooterProps {
  window: Window | null;
  timeZone: string;
}

export function Footer({ window, timeZone }: FooterProps) {
  return (
    <footer className="footer">
      <span className="footer-policy" title="The OpenCode database is opened read-only; no telemetry.">
        <Icon name="shield" size={12} />
        Local only · read-only
      </span>
      <span className="footer-range">
        {window === null ? "No window" : formatWindowRange(window, timeZone)}
      </span>
    </footer>
  );
}

export function Content({ children }: { children: ReactNode }) {
  return (
    <main className="content" id="main-content">
      {children}
    </main>
  );
}
