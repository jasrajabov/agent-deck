import { execFile } from "node:child_process";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLAUDE_DIR = join(homedir(), ".claude");

export type Status = "working" | "waiting" | "idle" | "done" | "failed";

/** Token counts summed over every model call in one transcript. */
export interface Usage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** Model calls (assistant messages), not content blocks. */
  turns: number;
  /** Prompt size of the latest call: how full the context window is now. */
  context: number;
  model?: string;
}

export const emptyUsage = (): Usage => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0, context: 0 });
export const totalOf = (u: Usage) => u.input + u.cacheWrite + u.cacheRead + u.output;
export function addUsage(into: Usage, u: Usage): Usage {
  into.input += u.input;
  into.cacheWrite += u.cacheWrite;
  into.cacheRead += u.cacheRead;
  into.output += u.output;
  into.turns += u.turns;
  return into;
}

export interface Subagent {
  id: string;
  type: string;
  description: string;
  running: boolean;
  updatedAt: number;
  transcript: string;
  usage: Usage;
}

export interface Agent {
  key: string;
  /** Short id that `claude attach|logs|stop|rm` take. Background sessions only. */
  id?: string;
  sessionId: string;
  name: string;
  kind: "interactive" | "background";
  status: Status;
  cwd: string;
  pid: number;
  startedAt: number;
  detail?: string;
  tokens?: number;
  template?: string;
  transcript: string;
  /** The shown subagents: running ones plus the latest few that finished. */
  subagents: Subagent[];
  /** Every subagent the session ever spawned, for the usage breakdown. */
  allSubagents: Subagent[];
  /** The main thread alone. */
  usage: Usage;
  /** Main thread plus every subagent. */
  totalUsage: Usage;
}

export interface Activity {
  at?: string;
  icon: string;
  who: "you" | "claude" | "tool" | "state";
  text: string;
}

interface RawAgent {
  pid: number;
  id?: string;
  cwd: string;
  kind: "interactive" | "background";
  startedAt: number;
  sessionId: string;
  name: string;
  status: string;
  state?: string;
}

/** Claude Code names a project folder after its cwd, every non-alphanumeric character turned into "-". */
const projectDir = (cwd: string) => join(CLAUDE_DIR, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

function statusOf(raw: RawAgent): Status {
  const state = raw.state ?? "";
  if (state === "done") return "done";
  if (/fail|error|crash/.test(state)) return "failed";
  if (/input|blocked|permission|waiting/.test(state)) return "waiting";
  if (raw.status === "busy") return "working";
  // A background session that is still "working" but went idle is waiting on you.
  if (raw.kind === "background" && state === "working") return "waiting";
  return "idle";
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

interface UsageCache {
  /** Byte offset just past the last complete line read. */
  offset: number;
  /** Claude Code writes one entry per content block, each repeating the call's usage, so calls are keyed by message id. */
  calls: Map<string, [number, number, number, number]>;
  usage: Usage;
}
const usageCache = new Map<string, UsageCache>();

/** Reads only what was appended since the last call: transcripts grow to tens of MB and this runs every 2 s. */
export async function loadUsage(path: string): Promise<Usage> {
  let fh;
  try {
    fh = await open(path, "r");
    const { size } = await fh.stat();
    let cache = usageCache.get(path);
    if (!cache || size < cache.offset) {
      cache = { offset: 0, calls: new Map(), usage: emptyUsage() };
      usageCache.set(path, cache);
    }
    if (size === cache.offset) return cache.usage;
    let pos = cache.offset;
    let context = cache.usage.context;
    let model = cache.usage.model;
    const chunk = 4 << 20;
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(chunk, size - pos));
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const cut = data.lastIndexOf(10);
      if (cut < 0) {
        carry = data;
        continue;
      }
      carry = data.subarray(cut + 1);
      for (const line of data.subarray(0, cut).toString("utf8").split("\n")) {
        if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
        let entry: any;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const m = entry.message;
        const u = m?.usage;
        if (entry.type !== "assistant" || !u) continue;
        const call: [number, number, number, number] = [
          u.input_tokens ?? 0,
          u.cache_creation_input_tokens ?? 0,
          u.cache_read_input_tokens ?? 0,
          u.output_tokens ?? 0,
        ];
        cache.calls.set(m.id ?? entry.uuid, call);
        context = call[0] + call[1] + call[2];
        if (m.model && m.model !== "<synthetic>") model = m.model;
      }
    }
    // A half-written last line is read again next time.
    cache.offset = pos - carry.length;
    const usage = emptyUsage();
    for (const [i, cw, cr, o] of cache.calls.values()) {
      usage.input += i;
      usage.cacheWrite += cw;
      usage.cacheRead += cr;
      usage.output += o;
    }
    usage.turns = cache.calls.size;
    usage.context = context;
    usage.model = model;
    cache.usage = usage;
    return usage;
  } catch {
    return usageCache.get(path)?.usage ?? emptyUsage();
  } finally {
    await fh?.close();
  }
}

async function loadSubagents(dir: string): Promise<{ shown: Subagent[]; all: Subagent[] }> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".meta.json"));
  } catch {
    return { shown: [], all: [] };
  }
  const subs = await Promise.all(
    files.map(async (f): Promise<Subagent | undefined> => {
      const meta = await readJson<{ agentType?: string; description?: string; finished?: boolean }>(join(dir, f));
      if (!meta) return undefined;
      const transcript = join(dir, f.replace(".meta.json", ".jsonl"));
      const updatedAt = await stat(transcript).then(
        (s) => s.mtimeMs,
        () => 0,
      );
      return {
        id: f.replace(/^agent-/, "").replace(".meta.json", ""),
        type: meta.agentType ?? "agent",
        description: meta.description ?? "",
        // Claude Code only writes `finished` once a subagent ends; one silent for 20 minutes is presumed dead.
        running: !meta.finished && Date.now() - updatedAt < 20 * 60_000,
        updatedAt,
        transcript,
        usage: await loadUsage(transcript),
      };
    }),
  );
  // Running ones first, then the most recent few that finished.
  const all = subs.filter((s): s is Subagent => !!s).sort((a, b) => b.updatedAt - a.updatedAt);
  const running = all.filter((s) => s.running);
  return { shown: [...running, ...all.filter((s) => !s.running).slice(0, Math.max(0, 5 - running.length))], all };
}

export async function loadAgents(): Promise<Agent[]> {
  const { stdout } = await run("claude", ["agents", "--json", "--all"], { maxBuffer: 8 << 20 });
  const raws = JSON.parse(stdout) as RawAgent[];
  const agents = await Promise.all(
    raws.map(async (raw): Promise<Agent> => {
      const dir = projectDir(raw.cwd);
      const job = raw.id
        ? await readJson<{ detail?: string; tokens?: number; template?: string; state?: string }>(
            join(CLAUDE_DIR, "jobs", raw.id, "state.json"),
          )
        : undefined;
      const status = statusOf({ ...raw, state: raw.state ?? job?.state });
      const transcript = join(dir, `${raw.sessionId}.jsonl`);
      const [subs, usage] = await Promise.all([loadSubagents(join(dir, raw.sessionId, "subagents")), loadUsage(transcript)]);
      // A finished session has no live subagents, whatever their metadata says.
      if (status === "done" || status === "failed") for (const sub of subs.all) sub.running = false;
      const totalUsage = subs.all.reduce((t, s) => addUsage(t, s.usage), { ...usage });
      return {
        key: raw.sessionId,
        id: raw.id,
        sessionId: raw.sessionId,
        name: raw.name,
        kind: raw.kind,
        status,
        cwd: raw.cwd,
        pid: raw.pid,
        startedAt: raw.startedAt,
        detail: job?.detail,
        tokens: job?.tokens,
        template: job?.template,
        transcript,
        subagents: subs.shown,
        allSubagents: subs.all,
        usage,
        totalUsage,
      };
    }),
  );
  const rank: Record<Status, number> = { waiting: 0, working: 1, failed: 2, idle: 3, done: 4 };
  return agents.sort((a, b) => rank[a.status] - rank[b.status] || b.startedAt - a.startedAt);
}

/** Reads only the end of a transcript: they grow to tens of MB. */
async function tailLines(path: string, bytes = 160_000): Promise<string[]> {
  let fh;
  try {
    fh = await open(path, "r");
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } catch {
    return [];
  } finally {
    await fh?.close();
  }
}

// Transcripts can hold raw escape sequences; printed as-is they would steer the terminal.
const oneLine = (s: string, max = 220) => {
  const flat = s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function toolSummary(name: string, input: Record<string, unknown> = {}): string {
  const pick = input.description ?? input.command ?? input.file_path ?? input.pattern ?? input.query ?? input.url ?? input.skill;
  return pick ? `${name} · ${oneLine(String(pick), 160)}` : name;
}

export async function loadActivity(transcript: string, limit = 14, bytes?: number): Promise<Activity[]> {
  const out: Activity[] = [];
  for (const line of await tailLines(transcript, bytes)) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const at: string | undefined = entry.timestamp;
    const content = entry.message?.content;
    if (entry.type === "user" && !entry.isMeta) {
      if (typeof content === "string") {
        if (!content.startsWith("<")) out.push({ at, icon: "›", who: "you", text: oneLine(content) });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && !block.text.startsWith("<"))
            out.push({ at, icon: "›", who: "you", text: oneLine(block.text) });
        }
      }
    } else if (entry.type === "assistant" && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text.trim()) out.push({ at, icon: "◆", who: "claude", text: oneLine(block.text) });
        if (block.type === "tool_use") out.push({ at, icon: "⚙", who: "tool", text: toolSummary(block.name, block.input) });
      }
    }
  }
  return out.slice(-limit);
}

/** A background job's own timeline of status lines, newest last. */
export async function loadTimeline(id: string, limit = 8): Promise<Activity[]> {
  const lines = await tailLines(join(CLAUDE_DIR, "jobs", id, "timeline.jsonl"), 40_000);
  return lines
    .flatMap((l) => {
      try {
        const e = JSON.parse(l);
        return e.detail ? [{ at: e.at, icon: "◇", who: "state" as const, text: oneLine(e.detail) }] : [];
      } catch {
        return [];
      }
    })
    .slice(-limit);
}

export async function claude(args: string[], cwd?: string): Promise<string> {
  const { stdout, stderr } = await run("claude", args, { cwd, maxBuffer: 8 << 20 });
  return (stdout || stderr).trim();
}
