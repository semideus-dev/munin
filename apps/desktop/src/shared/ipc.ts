/**
 * The typed IPC contract shared by the main process, the preload bridge and the
 * renderer.
 *
 * Everything crossing the bridge is plain JSON: DTOs on success, one safe error
 * object on failure. No stacks, causes, prompt text, message bodies or tool
 * payloads are representable here. The bridge is an explicit allowlist, not a
 * generic invoke.
 */
import type {
  ActivityDTO,
  FindingDetailDTO,
  FindingListDTO,
  HealthDTO,
  OverviewDTO,
  PrivacyDTO,
  ScanDTO,
  ServiceErrorDTO,
  SessionDetailDTO,
  SourceStatusDTO,
  UsageOverviewDTO,
} from "@munin/application";

export const IPC_CHANNELS = {
  overview: "munin:overview",
  findings: "munin:findings",
  finding: "munin:finding",
  usage: "munin:usage",
  session: "munin:session",
  activity: "munin:activity",
  health: "munin:health",
  privacy: "munin:privacy",
  sourceStatus: "munin:source-status",
  scan: "munin:scan",
  appInfo: "munin:app-info",
  minimize: "munin:minimize",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export const IPC_CHANNEL_LIST: readonly IpcChannel[] = Object.values(IPC_CHANNELS);

/** Main-process to renderer events. Not callable from the renderer. */
export const IPC_EVENTS = {
  scan: "munin:event-scan",
} as const;

/**
 * The only read filters the renderer may send. The main process validates this
 * shape again; the bridge is not a trust boundary.
 */
export interface ReadRequest {
  days?: number;
  project?: string;
  tz?: string;
}

export interface FindingRequest extends ReadRequest {
  rule: string;
}

export interface SessionRequest extends ReadRequest {
  sessionId: string;
}

export interface ScanRequest extends ReadRequest {
  /** Re-read every source session instead of resuming from the cursor. */
  full?: boolean;
}

export interface AppInfoDTO {
  name: string;
  version: string;
  electron: string;
  node: string;
  chrome: string;
  platform: string;
  packaged: boolean;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: ServiceErrorDTO };

export interface MuninBridge {
  getOverview(request?: ReadRequest): Promise<IpcResult<OverviewDTO>>;
  getFindings(request?: ReadRequest): Promise<IpcResult<FindingListDTO>>;
  getFinding(request: FindingRequest): Promise<IpcResult<FindingDetailDTO | null>>;
  getUsage(request?: ReadRequest): Promise<IpcResult<UsageOverviewDTO>>;
  getSessionDetail(request: SessionRequest): Promise<IpcResult<SessionDetailDTO | null>>;
  getActivity(request?: ReadRequest): Promise<IpcResult<ActivityDTO>>;
  getHealth(request?: ReadRequest): Promise<IpcResult<HealthDTO>>;
  getPrivacyStatus(request?: ReadRequest): Promise<IpcResult<PrivacyDTO>>;
  runScan(request?: ScanRequest): Promise<IpcResult<ScanDTO>>;
  getAppInfo(): Promise<IpcResult<AppInfoDTO>>;
  minimize(): Promise<IpcResult<null>>;
  /** Background scan events (tray or another window). Returns an unsubscribe fn. */
  onScanEvent(listener: (scan: ScanDTO) => void): () => void;
  /** Kept for callers that only need source availability. */
  getSourceStatus(request?: ReadRequest): Promise<IpcResult<SourceStatusDTO>>;
}
