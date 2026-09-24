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

/** Sent instead of `hello` when reconnecting to an existing session. */
export type AgentResume = {
  t: 'resume';
  id: string;
  agentKey: string;
  cols: number;
  rows: number;
};

/** The PTY's size changed (agent is the source of truth for size). */
export type AgentSize = { t: 'size'; cols: number; rows: number };

export type AgentExit = { t: 'exit'; code: number };

export type AgentToRelay = AgentHello | AgentResume | AgentSize | AgentExit;

export type RelayToAgent =
  | { t: 'registered'; id: string; agentKey: string; url: string }
  | { t: 'resumed' }
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
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_NOT_FOUND = 4404;
