/**
 * The preload bridge exposes a closed set of methods and nothing else: no
 * generic `invoke`, no filesystem, no shell, no Node globals.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  ActivityDTO,
  FindingDetailDTO,
  FindingListDTO,
  HealthDTO,
  OverviewDTO,
  PrivacyDTO,
  ScanDTO,
  SessionDetailDTO,
  SourceStatusDTO,
  UsageOverviewDTO,
} from "@munin/application";
import {
  IPC_CHANNELS,
  IPC_EVENTS,
  type AppInfoDTO,
  type FindingRequest,
  type IpcResult,
  type MuninBridge,
  type ReadRequest,
  type ScanRequest,
  type SessionRequest,
} from "../shared/ipc.js";

function invoke<T>(channel: string, request: unknown): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, request) as Promise<IpcResult<T>>;
}

const bridge: MuninBridge = {
  getOverview: (request?: ReadRequest) => invoke<OverviewDTO>(IPC_CHANNELS.overview, request),
  getFindings: (request?: ReadRequest) => invoke<FindingListDTO>(IPC_CHANNELS.findings, request),
  getFinding: (request: FindingRequest) =>
    invoke<FindingDetailDTO | null>(IPC_CHANNELS.finding, request),
  getUsage: (request?: ReadRequest) => invoke<UsageOverviewDTO>(IPC_CHANNELS.usage, request),
  getSessionDetail: (request: SessionRequest) =>
    invoke<SessionDetailDTO | null>(IPC_CHANNELS.session, request),
  getActivity: (request?: ReadRequest) => invoke<ActivityDTO>(IPC_CHANNELS.activity, request),
  getHealth: (request?: ReadRequest) => invoke<HealthDTO>(IPC_CHANNELS.health, request),
  getPrivacyStatus: (request?: ReadRequest) =>
    invoke<PrivacyDTO>(IPC_CHANNELS.privacy, request),
  runScan: (request?: ScanRequest) => invoke<ScanDTO>(IPC_CHANNELS.scan, request),
  getAppInfo: () => invoke<AppInfoDTO>(IPC_CHANNELS.appInfo, undefined),
  minimize: () => invoke<null>(IPC_CHANNELS.minimize, undefined),
  getSourceStatus: (request?: ReadRequest) =>
    invoke<SourceStatusDTO>(IPC_CHANNELS.sourceStatus, request),
  onScanEvent: (listener: (scan: ScanDTO) => void) => {
    const wrapped = (_event: IpcRendererEvent, scan: ScanDTO): void => listener(scan);
    ipcRenderer.on(IPC_EVENTS.scan, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.scan, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("munin", bridge);
