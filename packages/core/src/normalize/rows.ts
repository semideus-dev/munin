/**
 * Raw SQLite row shapes used as the seam between @munin/local readers and
 * @munin/core normalization.
 *
 * These are transport types only. No mapping logic belongs here.
 */

export interface RawSessionV2Row {
  id: string;
  project_id: string;
  project_worktree: string | null;
  parent_id: string | null;
  title: string | null;
  directory: string | null;
  agent: string | null;
  model: string | null;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  time_created: number;
  time_updated: number;
}

export interface RawSessionMessageRow {
  id: string;
  session_id: string;
  seq: number;
  type: string;
  data_json: string | null;
  time_created: number | null;
  time_updated: number | null;
}

export interface RawToolProjectionRow {
  message_id: string;
  tool_id: string | null;
  tool_name: string | null;
  tool_input_json: string | null;
  tool_status: string | null;
  tool_output_chars: number | null;
}

export interface RawMessageTextLengthRow {
  message_id: string;
  text_chars: number;
}

export interface RawInstructionEntryRow {
  session_id: string;
  instruction_key: string;
  blob_hash: string;
  char_count: number | null;
}

export interface RawSessionV1Row {
  id: string;
  project_id: string | null;
  project_worktree: string | null;
  parent_id: string | null;
  title: string | null;
  directory: string | null;
  agent: string | null;
  model: string | null;
  time_created: number;
  time_updated: number;
}

export interface RawMessageV1Row {
  id: string;
  session_id: string;
  seq: number;
  type: string;
  time_created: number;
  time_updated: number;
}

export interface RawPartV1Row {
  id: string;
  message_id: string;
  seq: number;
  type: string;
  data_json: string | null;
  cost: number | null;
  tool_output_chars: number | null;
}
