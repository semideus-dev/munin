import type { HTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";

export function Card({
  children,
  className = "",
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & HTMLAttributes<HTMLElement>) {
  return (
    <section className={`card ${className}`.trim()} {...rest}>
      {children}
    </section>
  );
}

export function CardTitle({
  children,
  aside,
}: {
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="card-title">
      <h2>{children}</h2>
      {aside === undefined ? null : <span className="card-title-aside">{aside}</span>}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "fix" | "try" | "test" | "ok" | "warn" | "bad" | "cyan";
  title?: string;
}) {
  return (
    <span className={`badge ${tone}`} {...(title === undefined ? {} : { title })}>
      {children}
    </span>
  );
}

export function Metric({
  label,
  value,
  sub,
  mono = true,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className={`metric-value ${mono ? "mono" : ""}`}>{value}</span>
      {sub === undefined ? null : <span className="metric-sub">{sub}</span>}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  tone = "neutral",
}: {
  title: string;
  children?: ReactNode;
  tone?: "neutral" | "warn" | "bad";
}) {
  return (
    <div className={`empty-state ${tone}`}>
      <Icon name={tone === "bad" ? "alert" : "shield"} size={18} />
      <div>
        <div className="empty-title">{title}</div>
        {children === undefined ? null : <div className="empty-body">{children}</div>}
      </div>
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span className="spinner" role="status" aria-label={label}>
      <span className="spinner-dot" />
      <span className="spinner-dot" />
      <span className="spinner-dot" />
    </span>
  );
}

export function DetailRow({
  label,
  value,
  title,
}: {
  label: string;
  value: ReactNode;
  title?: string;
}) {
  return (
    <div className="detail-row">
      <span className="detail-label">{label}</span>
      <span className="detail-value mono" {...(title === undefined ? {} : { title })}>
        {value}
      </span>
    </div>
  );
}

export function Notice({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "warn" | "bad" | "ok";
}) {
  return <p className={`notice ${tone}`}>{children}</p>;
}
