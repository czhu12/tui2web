// Wire protocol shared by the CLI (agent), relay server and web viewer.
//
// Every WebSocket carries two kinds of frames:
//   - binary frames: raw terminal bytes (PTY output, or keystrokes going in)
//   - text frames:   JSON control messages defined below

/** scrypt hash of the user's password. Only the hash ever leaves the laptop. */
export type PasswordHash = {
  algo: 'scrypt';
  salt: string; // base64
  hash: string; // base64
  N: number;
  r: number;
  p: number;
  keylen: number;
};

// ---- agent (CLI) <-> relay ------------------------------------------------

export type AgentHello = {
  t: 'hello';
  command: string;
  cols: number;
  rows: number;
  password: PasswordHash | null;
};

/**
 * Sent instead of `hello` when reconnecting. If the relay no longer has the
 * session (it restarted or was redeployed), `restore` lets it recreate the
 * session under the same id and token, so existing links keep working.
 */
export type AgentResume = {
  t: 'resume';
  id: string;
  agentKey: string;
  cols: number;
  rows: number;
  restore: { token: string; command: string; password: PasswordHash | null };
};

/** The PTY's size changed (agent is the source of truth for size). */
export type AgentSize = { t: 'size'; cols: number; rows: number };

export type AgentExit = { t: 'exit'; code: number };

/**
 * The user disconnected the session from their computer. The relay forgets it
 * (screen and all) until the agent resumes it with `restore`, under the same
 * id and token.
 */
export type AgentPause = { t: 'pause' };

export type AgentToRelay = AgentHello | AgentResume | AgentSize | AgentExit | AgentPause;

export type RelayToAgent =
  | { t: 'registered'; id: string; agentKey: string; token: string; url: string }
  /** `restored`: the session was recreated, so the relay's screen copy is empty. */
  | { t: 'resumed'; restored: boolean }
  /** A viewer wants the PTY resized to fit its screen. */
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'error'; message: string };

// ---- viewer (browser) <-> relay -------------------------------------------

export type ViewerToRelay = { t: 'resize'; cols: number; rows: number };

export type RelayToViewer =
  | { t: 'hello'; command: string; cols: number; rows: number; agentConnected: boolean }
  /** Serialized screen + scrollback, so a new viewer sees the current state. */
  | { t: 'snapshot'; data: string }
  | { t: 'size'; cols: number; rows: number }
  | { t: 'agent'; connected: boolean }
  | { t: 'exit'; code: number };

/** WebSocket close codes the viewer acts on. */
export type CloseUnauthorized = 4401;
export type CloseNotFound = 4404;
/** The session was disconnected from its computer and will come back when it reconnects. */
export type ClosePaused = 4410;
export const CLOSE_UNAUTHORIZED: CloseUnauthorized = 4401;
export const CLOSE_NOT_FOUND: CloseNotFound = 4404;
export const CLOSE_PAUSED: ClosePaused = 4410;
