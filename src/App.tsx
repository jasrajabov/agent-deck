import { Box, type Key, Text, useApp, useInput, useStdout } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { basename } from "node:path";
import { homedir } from "node:os";
import {
  type Activity,
  type Agent,
  type Status,
  type Subagent,
  type Usage,
  addUsage,
  claude,
  emptyUsage,
  loadActivity,
  loadAgents,
  loadTimeline,
  totalOf,
} from "./data.js";

export type Exit = { type: "quit" } | { type: "attach"; id: string; name: string };

const C = {
  working: "#FF9F1C",
  waiting: "#FFD166",
  idle: "#8D99AE",
  done: "#06D6A0",
  failed: "#EF476F",
  sub: "#4CC9F0",
  accent: "#C77DFF",
  text: "#E6E9EF",
  dim: "#6B7280",
};

const LABEL: Record<Status, string> = {
  working: "working",
  waiting: "needs you",
  idle: "idle",
  done: "done",
  failed: "failed",
};

// Token mix: what each part of a transcript's usage is drawn in.
const MIX = [
  { key: "cacheRead", label: "cache read", color: C.sub },
  { key: "cacheWrite", label: "cache write", color: C.accent },
  { key: "input", label: "input", color: C.waiting },
  { key: "output", label: "output", color: C.done },
] as const;

/** AGENT_DECK_ICONS=plain swaps the emoji for single-width glyphs, for terminals that draw emoji badly. */
const PLAIN = process.env.AGENT_DECK_ICONS === "plain";
const SESSION_ICON = PLAIN ? { interactive: "▣", background: "◈" } : { interactive: "💻", background: "🚀" };

const TYPE_LOOK: [RegExp, string, string][] = [
  [/^explore/i, "🔭", "#4CC9F0"],
  [/^plan/i, "🧭", "#80FFDB"],
  [/^general|^claude$/i, "🤖", "#C77DFF"],
  [/^fork/i, "🍴", "#FFD166"],
  // Before "review", so ux-reviewer gets the design look; whole words, so "guide" isn't "ui".
  [/\b(ux|ui)\b|design|impeccable/i, "🎨", "#FF8FAB"],
  [/review/i, "🔍", "#F72585"],
  [/test/i, "🧪", "#06D6A0"],
  [/perf|bench/i, "📈", "#FF9F1C"],
  [/fetch|web|browse/i, "🌐", "#4895EF"],
  [/guide|doc/i, "📘", "#90E0EF"],
  [/research|search/i, "🔬", "#B5E48C"],
  [/setup|config|statusline/i, "🔧", "#ADB5BD"],
];
const SPARE_ICONS = ["🦊", "🐙", "🦉", "🐝", "🦄", "🐳", "🪐", "🧩", "🔮", "🌵", "🍄", "🐢"];
const SPARE_COLORS = ["#F72585", "#B5179E", "#4895EF", "#4CC9F0", "#80FFDB", "#FFD166", "#FF9F1C"];

/** A stable icon and colour per subagent type, so the same kind of agent always looks the same. */
function look(type: string): { icon: string; color: string } {
  const known = TYPE_LOOK.find(([re]) => re.test(type));
  if (known) return { icon: PLAIN ? "◆" : known[1], color: known[2] };
  let h = 0;
  for (const ch of type) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { icon: PLAIN ? "◆" : SPARE_ICONS[h % SPARE_ICONS.length]!, color: SPARE_COLORS[h % SPARE_COLORS.length]! };
}

const tok = (n: number) => {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
};
const heat = (n: number) => (n >= 50e6 ? C.failed : n >= 10e6 ? C.working : n >= 1e6 ? C.waiting : C.dim);
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "0%");
const shortModel = (m?: string) => m?.replace(/^claude-/, "");

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ICON: Record<Status, string> = { working: "", waiting: "◐", idle: "○", done: "✓", failed: "✗" };

const TABS = ["All", "Active", "Background", "Done", "Usage"] as const;
type Tab = (typeof TABS)[number];

type Row =
  | { kind: "agent"; key: string; agent: Agent }
  | { kind: "sub"; key: string; agent: Agent; sub: Subagent; last: boolean };

interface Field {
  text: string;
  cursor: number;
}

type Mode =
  | { type: "browse" }
  | { type: "search"; cursor: number }
  | { type: "new"; field: Field; cwd: string; draft: string; recall: number }
  | { type: "confirm"; action: "stop" | "rm"; agent: Agent }
  | { type: "logs"; title: string; items: Activity[]; offset: number };

const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const tilde = (p: string) => p.replace(homedir(), "~");
const project = (cwd: string) => {
  const wt = cwd.match(/\/([^/]+)\/\.claude\/worktrees\/([^/]+)/);
  return wt ? `${wt[1]}⎇${wt[2]}` : basename(cwd);
};
const clock = (iso?: string) => (iso ? new Date(iso).toTimeString().slice(0, 5) : "     ");

/** Prompts sent from this deck, newest last, for ↑↓ recall. */
const sent: string[] = [];

/** Line-editor keys shared by the prompt box and search. Returns undefined for keys it doesn't own. */
function edit({ text, cursor }: Field, input: string, key: Key): Field | undefined {
  if (key.tab || key.return || key.escape || key.upArrow || key.downArrow || key.pageUp || key.pageDown) return undefined;
  const wordLeft = (i: number) => {
    while (i > 0 && text[i - 1] === " ") i--;
    while (i > 0 && text[i - 1] !== " ") i--;
    return i;
  };
  const wordRight = (i: number) => {
    while (i < text.length && text[i] === " ") i++;
    while (i < text.length && text[i] !== " ") i++;
    return i;
  };
  const cut = (from: number, to: number) => ({ text: text.slice(0, from) + text.slice(to), cursor: from });
  // Option+←→ arrive as meta+b / meta+f in most macOS terminals.
  if ((key.leftArrow && (key.meta || key.ctrl)) || (key.meta && input === "b")) return { text, cursor: wordLeft(cursor) };
  if ((key.rightArrow && (key.meta || key.ctrl)) || (key.meta && input === "f")) return { text, cursor: wordRight(cursor) };
  if (key.leftArrow) return { text, cursor: Math.max(0, cursor - 1) };
  if (key.rightArrow) return { text, cursor: Math.min(text.length, cursor + 1) };
  if (key.ctrl && input === "a") return { text, cursor: 0 };
  if (key.ctrl && input === "e") return { text, cursor: text.length };
  if (key.ctrl && input === "u") return cut(0, cursor);
  if (key.ctrl && input === "k") return cut(cursor, text.length);
  if ((key.ctrl && input === "w") || (key.meta && (key.backspace || key.delete))) return cut(wordLeft(cursor), cursor);
  // macOS Backspace reaches Ink as `delete`.
  if (key.backspace || key.delete) return cursor ? cut(cursor - 1, cursor) : { text, cursor };
  if (input && !key.ctrl && !key.meta) {
    // A paste arrives as one chunk; newlines would end up in a shell argument, so they become spaces.
    const add = input.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
    return { text: text.slice(0, cursor) + add + text.slice(cursor), cursor: cursor + add.length };
  }
  return undefined;
}

function inTab(a: Agent, tab: Tab) {
  if (tab === "Active") return a.status === "working" || a.status === "waiting" || a.subagents.some((s) => s.running);
  if (tab === "Background") return a.kind === "background";
  if (tab === "Done") return a.status === "done" || a.status === "failed";
  return true;
}

export function App({ onExit }: { onExit: (e: Exit) => void }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ cols: stdout.columns ?? 120, rows: stdout.rows ?? 40 });
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<Tab>("All");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>({ type: "browse" });
  const [toast, setToast] = useState<{ text: string; color: string }>();
  const [activity, setActivity] = useState<Activity[]>([]);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns, rows: stdout.rows });
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
  }, [stdout]);

  const busy = useRef(false);
  const refresh = useCallback(async () => {
    // A slow `claude agents` must not stack polls on top of each other.
    if (busy.current) return;
    busy.current = true;
    try {
      setAgents(await loadAgents());
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : String(e));
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = setInterval(refresh, 2000);
    const spin = setInterval(() => setFrame((f) => f + 1), 100);
    return () => {
      clearInterval(poll);
      clearInterval(spin);
    };
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const rows = useMemo(() => {
    const q = query.toLowerCase();
    const out: Row[] = [];
    for (const agent of agents) {
      if (!inTab(agent, tab)) continue;
      const hay = `${agent.name} ${agent.cwd} ${agent.subagents.map((s) => s.description).join(" ")}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      out.push({ kind: "agent", key: agent.key, agent });
      if (collapsed.has(agent.key)) continue;
      agent.subagents.forEach((sub, i) =>
        out.push({ kind: "sub", key: `${agent.key}/${sub.id}`, agent, sub, last: i === agent.subagents.length - 1 }),
      );
    }
    return out;
  }, [agents, tab, query, collapsed]);

  const index = Math.max(
    0,
    rows.findIndex((r) => r.key === selected),
  );
  const current = rows[index];

  useEffect(() => {
    if (rows.length && !rows.some((r) => r.key === selected)) setSelected(rows[0]!.key);
  }, [rows, selected]);

  // Detail pane: the background job's own timeline when it has one, otherwise the transcript tail.
  useEffect(() => {
    if (!current) return setActivity([]);
    let live = true;
    const load = async () => {
      const items =
        current.kind === "sub"
          ? await loadActivity(current.sub.transcript)
          : current.agent.id
            ? [...(await loadTimeline(current.agent.id, 4)), ...(await loadActivity(current.agent.transcript, 10))]
            : await loadActivity(current.agent.transcript);
      if (live) setActivity(items);
    };
    void load();
    const t = setInterval(load, 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [current?.key]);

  // Where a new background agent can start: every folder a session runs in, the deck's own folder last.
  const folders = useMemo(() => {
    const seen = [...agents].sort((a, b) => b.startedAt - a.startedAt).map((a) => a.cwd);
    return [...new Set([...seen, process.cwd()])];
  }, [agents]);

  const say = (text: string, color = C.accent) => setToast({ text, color });

  const act = async (label: string, args: string[], cwd?: string) => {
    say(`${label}…`, C.dim);
    try {
      const out = await claude(args, cwd);
      say(out.split("\n")[0] || `${label}: done`, C.done);
    } catch (e) {
      say(`${label} failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`, C.failed);
    }
    void refresh();
  };

  useInput((input, key) => {
    if (mode.type === "search") {
      if (key.return || key.escape) return setMode({ type: "browse" });
      const next = edit({ text: query, cursor: mode.cursor }, input, key);
      if (next) {
        setQuery(next.text);
        setMode({ type: "search", cursor: next.cursor });
      }
      return;
    }
    if (mode.type === "new") {
      if (key.escape) return setMode({ type: "browse" });
      if (key.return) {
        const prompt = mode.field.text.trim();
        setMode({ type: "browse" });
        if (prompt) {
          if (sent.at(-1) !== prompt) sent.push(prompt);
          void act(`Starting background agent in ${project(mode.cwd)}`, ["--bg", prompt], mode.cwd);
        }
        return;
      }
      if (key.tab) {
        const i = folders.indexOf(mode.cwd);
        const step = key.shift ? folders.length - 1 : 1;
        return setMode({ ...mode, cwd: folders[(i + step) % folders.length]! });
      }
      if (key.upArrow || key.downArrow) {
        const recall = Math.max(-1, Math.min(sent.length - 1, mode.recall + (key.upArrow ? 1 : -1)));
        if (recall === mode.recall) return;
        const text = recall < 0 ? mode.draft : sent[sent.length - 1 - recall]!;
        return setMode({ ...mode, recall, field: { text, cursor: text.length } });
      }
      const field = edit(mode.field, input, key);
      if (field) setMode({ ...mode, field, ...(mode.recall < 0 ? { draft: field.text } : {}) });
      return;
    }
    if (mode.type === "confirm") {
      setMode({ type: "browse" });
      if (input === "y" && mode.agent.id) {
        void act(mode.action === "stop" ? `Stopping ${mode.agent.name}` : `Removing ${mode.agent.name}`, [
          mode.action,
          mode.agent.id,
        ]);
      }
      return;
    }
    if (mode.type === "logs") {
      const page = Math.max(5, size.rows - 8);
      if (key.escape || input === "q" || input === "l") return setMode({ type: "browse" });
      if (key.upArrow || input === "k") return setMode({ ...mode, offset: Math.min(mode.items.length - 1, mode.offset + 1) });
      if (key.downArrow || input === "j") return setMode({ ...mode, offset: Math.max(0, mode.offset - 1) });
      if (key.pageUp || input === "u") return setMode({ ...mode, offset: Math.min(mode.items.length - 1, mode.offset + page) });
      if (key.pageDown || input === "d") return setMode({ ...mode, offset: Math.max(0, mode.offset - page) });
      return;
    }

    if (input === "q" || (key.ctrl && input === "c")) {
      onExit({ type: "quit" });
      return exit();
    }
    if (key.upArrow || input === "k") return rows.length && setSelected(rows[Math.max(0, index - 1)]!.key);
    if (key.downArrow || input === "j") return rows.length && setSelected(rows[Math.min(rows.length - 1, index + 1)]!.key);
    if (key.tab) return setTab(TABS[(TABS.indexOf(tab) + (key.shift ? TABS.length - 1 : 1)) % TABS.length]!);
    if (/^[1-5]$/.test(input)) return setTab(TABS[Number(input) - 1]!);
    if (input === "u") return setTab(tab === "Usage" ? "All" : "Usage");
    if (input === "/") return setMode({ type: "search", cursor: query.length });
    if (key.escape && query) return setQuery("");
    if (input === "r") return void refresh();
    if (input === "n") {
      const cwd = current?.agent.cwd ?? process.cwd();
      return setMode({ type: "new", field: { text: "", cursor: 0 }, cwd, draft: "", recall: -1 });
    }
    // The Usage view lists no rows to act on.
    if (!current || tab === "Usage") return;

    const agent = current.agent;
    if (key.leftArrow || input === "h") {
      setCollapsed((s) => new Set(s).add(agent.key));
      return setSelected(agent.key);
    }
    if (key.rightArrow || input === "e") {
      return setCollapsed((s) => {
        const next = new Set(s);
        next.delete(agent.key);
        return next;
      });
    }
    const needsBg = (what: string) => {
      if (agent.id) return true;
      say(`${what} works on background sessions; ${agent.name} runs in its own terminal`, C.waiting);
      return false;
    };
    if (key.return || input === "a") {
      if (!needsBg("Attach")) return;
      onExit({ type: "attach", id: agent.id!, name: agent.name });
      return exit();
    }
    if (input === "l") {
      const title = current.kind === "sub" ? current.sub.description || current.sub.type : agent.name;
      const transcript = current.kind === "sub" ? current.sub.transcript : agent.transcript;
      loadActivity(transcript, 600, 3_000_000).then(
        (items) => setMode({ type: "logs", title, items, offset: 0 }),
        (e) => say(`History failed: ${e.message}`, C.failed),
      );
    }
    if (input === "x" && needsBg("Stop")) setMode({ type: "confirm", action: "stop", agent });
    if (input === "d" && needsBg("Remove")) setMode({ type: "confirm", action: "rm", agent });
  });

  const counts = useMemo(() => {
    const c: Record<Status, number> = { working: 0, waiting: 0, idle: 0, done: 0, failed: 0 };
    for (const a of agents) c[a.status]++;
    return {
      ...c,
      subs: agents.reduce((n, a) => n + a.subagents.filter((s) => s.running).length, 0),
      tokens: agents.reduce((n, a) => n + totalOf(a.totalUsage), 0),
    };
  }, [agents]);

  const spinner = SPIN[frame % SPIN.length]!;
  const listWidth = Math.max(38, Math.min(64, Math.floor(size.cols * 0.44)));
  // One row short of the terminal: at full height Ink clears the screen on every frame, which flickers.
  const height = size.rows - 1;
  const promptWidth = size.cols - 2;
  const promptLines = mode.type === "new" ? promptRows(mode.field, promptWidth) : 0;
  const bodyHeight = Math.max(8, height - 5 - (promptLines ? promptLines + 3 : 0));

  return (
    <Box flexDirection="column" width={size.cols} height={height}>
      <Header counts={counts} spinner={spinner} />
      <Box paddingX={1} gap={1}>
        {TABS.map((t, i) => (
          <Text key={t} color={t === tab ? "#0E1116" : C.dim} backgroundColor={t === tab ? C.accent : undefined} bold={t === tab}>
            {` ${i + 1} ${t === "Usage" && !PLAIN ? "📊 " : ""}${t} `}
          </Text>
        ))}
        <Box flexGrow={1} />
        {mode.type === "search" || query ? (
          <Box flexShrink={0}>
            <Text color={mode.type === "search" ? C.waiting : C.dim}>
              {"/ "}
              {mode.type === "search" ? <Cursor field={{ text: query, cursor: mode.cursor }} /> : query}
            </Text>
          </Box>
        ) : null}
      </Box>

      <Box height={bodyHeight}>
        {mode.type === "logs" ? (
          <Logs mode={mode} height={bodyHeight} />
        ) : tab === "Usage" ? (
          <UsageView agents={agents} height={bodyHeight} width={size.cols} />
        ) : (
          <>
            <List rows={rows} index={index} width={listWidth} height={bodyHeight} spinner={spinner} error={error} />
            <Detail row={current} activity={activity} height={bodyHeight} spinner={spinner} />
          </>
        )}
      </Box>

      {mode.type === "new" ? <PromptBox mode={mode} width={promptWidth} lines={promptLines} /> : null}
      <Footer mode={mode} toast={toast} current={current} />
    </Box>
  );
}

function Header({ counts, spinner }: { counts: Record<Status, number> & { subs: number; tokens: number }; spinner: string }) {
  const chip = (n: number, icon: string, label: string, color: string) =>
    n > 0 ? (
      <Text key={label} color={color}>
        {icon} {n} {label}
      </Text>
    ) : null;
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text>
        <Text color={C.working} bold>
          AGENT
        </Text>
        <Text color={C.sub} bold>
          {" "}
          DECK
        </Text>
        <Text color={C.dim}> · Claude Code</Text>
      </Text>
      <Box gap={2}>
        {chip(counts.waiting, "◐", "need you", C.waiting)}
        {chip(counts.working, spinner, "working", C.working)}
        {chip(counts.subs, "↳", "subagents", C.sub)}
        {chip(counts.idle, "○", "idle", C.idle)}
        {chip(counts.done, "✓", "done", C.done)}
        {chip(counts.failed, "✗", "failed", C.failed)}
        {counts.tokens ? (
          <Text color={heat(counts.tokens)}>
            Σ {tok(counts.tokens)} <Text color={C.dim}>tok</Text>
          </Text>
        ) : null}
        <Text color={C.dim}>{new Date().toTimeString().slice(0, 8)}</Text>
      </Box>
    </Box>
  );
}

function StatusIcon({ status, spinner }: { status: Status; spinner: string }) {
  return <Text color={C[status]}>{status === "working" ? spinner : ICON[status]}</Text>;
}

function List(props: { rows: Row[]; index: number; width: number; height: number; spinner: string; error?: string }) {
  const { rows, index, width, height, spinner, error } = props;
  const visible = Math.max(1, height - 2);
  const start = Math.min(Math.max(0, index - Math.floor(visible / 2)), Math.max(0, rows.length - visible));
  const slice = rows.slice(start, start + visible);

  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor={C.dim} paddingX={1}>
      {error ? <Text color={C.failed}>✗ {error}</Text> : null}
      {!error && rows.length === 0 ? <Text color={C.dim}>No agents here. Press n to start one in the background.</Text> : null}
      {slice.map((row, i) => {
        const on = start + i === index;
        const bg = on ? "#1F2633" : undefined;
        if (row.kind === "agent") {
          const a = row.agent;
          return (
            <Box key={row.key} height={1}>
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                <Text backgroundColor={bg} wrap="truncate">
                  <Text color={on ? C.accent : C.dim}>{on ? "▌" : " "}</Text>
                  <StatusIcon status={a.status} spinner={spinner} /> {SESSION_ICON[a.kind]}{" "}
                  <Text color={C.text} bold={on}>
                    {a.name}
                  </Text>
                  <Text color={C.dim}> {project(a.cwd)}</Text>
                </Text>
              </Box>
              <Box flexShrink={0}>
                <Text color={heat(totalOf(a.totalUsage))}>{tok(totalOf(a.totalUsage)).padStart(7)}</Text>
                <Text color={C.dim}>{ago(a.startedAt).padStart(5)}</Text>
              </Box>
            </Box>
          );
        }
        const s = row.sub;
        return (
          <Box key={row.key} height={1}>
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Text backgroundColor={bg} wrap="truncate">
                <Text color={on ? C.accent : C.dim}>{on ? "▌" : " "}</Text>
                <Text color={C.dim}> {row.last ? "└─" : "├─"} </Text>
                <Text color={s.running ? C.sub : C.done}>{s.running ? spinner : "✓"}</Text> {look(s.type).icon}{" "}
                <Text color={s.running ? look(s.type).color : C.dim}>{s.type}</Text>
                <Text color={s.running ? C.text : C.dim}> {s.description}</Text>
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text color={C.dim}>{tok(totalOf(s.usage)).padStart(7)}</Text>
              <Text color={C.dim}>{ago(s.updatedAt).padStart(5)}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Box width={10}>
        <Text color={C.dim}>{label}</Text>
      </Box>
      <Text wrap="truncate">{children}</Text>
    </Box>
  );
}

const WHO_COLOR = { you: C.waiting, claude: C.text, tool: C.sub, state: C.accent };

function ActivityLine({ item }: { item: Activity }) {
  return (
    <Text wrap="truncate">
      <Text color={C.dim}>{clock(item.at)} </Text>
      <Text color={WHO_COLOR[item.who]}>{item.icon} </Text>
      <Text color={item.who === "claude" ? C.text : WHO_COLOR[item.who]}>{item.text}</Text>
    </Text>
  );
}

function Detail({ row, activity, height, spinner }: { row?: Row; activity: Activity[]; height: number; spinner: string }) {
  if (!row) return <Box flexGrow={1} borderStyle="round" borderColor={C.dim} />;
  const a = row.agent;
  const status: Status = row.kind === "sub" ? (row.sub.running ? "working" : "done") : a.status;
  const usage = row.kind === "sub" ? row.sub.usage : a.totalUsage;
  const info: React.ReactNode[] = [];

  if (row.kind === "sub") {
    const { icon, color } = look(row.sub.type);
    info.push(
      <Field key="agent" label="agent">
        {icon} <Text color={color}>{row.sub.type}</Text>
      </Field>,
      <Field key="parent" label="parent">
        {SESSION_ICON[a.kind]} {a.name}
      </Field>,
      <Field key="active" label="active">
        {ago(row.sub.updatedAt)} ago
      </Field>,
    );
  } else {
    info.push(
      <Field key="kind" label="kind">
        {SESSION_ICON[a.kind]} <Text color={a.kind === "background" ? C.sub : C.working}>{a.kind}</Text>
        {a.template ? <Text color={C.dim}> · {a.template}</Text> : null}
      </Field>,
      <Field key="where" label="where">
        {tilde(a.cwd)}
      </Field>,
      <Field key="up" label="up">
        {ago(a.startedAt)} · pid {a.pid}
        {a.id ? ` · id ${a.id}` : ""}
      </Field>,
    );
    if (a.detail)
      info.push(
        <Field key="now" label="now">
          <Text color={C.accent}>{a.detail}</Text>
        </Field>,
      );
    if (a.allSubagents.length)
      info.push(
        <Field key="subs" label="subagents">
          <Text color={C.sub}>{a.allSubagents.filter((s) => s.running).length} running</Text>
          <Text color={C.dim}> · {a.allSubagents.length} spawned</Text>
        </Field>,
      );
  }

  if (usage.turns) {
    info.push(
      <Field key="tokens" label="tokens">
        <Text bold color={heat(totalOf(usage))}>
          {tok(totalOf(usage))}
        </Text>
        <Text color={C.dim}>
          {" "}
          · {usage.turns} calls · {tok(usage.output)} out · ctx {tok(usage.context)}
          {usage.model ? ` · ${shortModel(usage.model)}` : ""}
        </Text>
      </Field>,
      <Field key="mix" label="mix">
        <MixBar usage={usage} width={24} />
        <Text color={C.dim}> {pct(usage.cacheRead, totalOf(usage))} cached</Text>
      </Field>,
    );
  }

  // Who used what: the main thread against each subagent it spawned.
  if (row.kind === "agent" && a.allSubagents.length) {
    const total = totalOf(a.totalUsage) || 1;
    const shares = [
      { key: "main", icon: SESSION_ICON[a.kind], label: "main thread", color: C.text, n: totalOf(a.usage) },
      ...a.allSubagents.map((s) => ({ key: s.id, ...look(s.type), label: s.description || s.type, n: totalOf(s.usage) })),
    ].sort((x, y) => y.n - x.n);
    const top = shares.slice(0, Math.min(5, Math.max(2, Math.floor(height / 6))));
    info.push(<Text key="gap-who"> </Text>, <Text key="who" color={C.dim}>── who used what ──</Text>);
    for (const s of top)
      info.push(
        <Box key={`who-${s.key}`}>
          <Box flexShrink={0}>
            <Meter value={s.n} max={total} width={12} color={s.color} />
            <Text color={C.dim}>{pct(s.n, total).padStart(5)} </Text>
            <Text color={s.color}>{tok(s.n).padStart(6)} </Text>
          </Box>
          <Text wrap="truncate">
            {s.icon} {s.label}
          </Text>
        </Box>,
      );
    if (shares.length > top.length)
      info.push(
        <Text key="who-more" color={C.dim}>
          {"             "}+{shares.length - top.length} more · {tok(shares.slice(top.length).reduce((n, s) => n + s.n, 0))}
        </Text>,
      );
  }

  // Border, title, the blank under it, and the activity heading with its blank.
  const room = Math.max(1, height - 2 - 2 - info.length - 2);

  return (
    <Box flexGrow={1} flexDirection="column" borderStyle="round" borderColor={C[status]} paddingX={1}>
      <Text wrap="truncate">
        <StatusIcon status={status} spinner={spinner} /> {row.kind === "sub" ? look(row.sub.type).icon : SESSION_ICON[a.kind]}{" "}
        <Text bold color={C.text}>
          {row.kind === "sub" ? row.sub.description || row.sub.type : a.name}
        </Text>
        <Text color={C[status]}>
          {"  "}
          {row.kind === "sub" ? (row.sub.running ? "running" : "finished") : LABEL[status]}
        </Text>
      </Text>
      <Text> </Text>
      {info}
      <Text> </Text>
      <Text color={C.dim}>── recent activity ──</Text>
      {activity.length === 0 ? <Text color={C.dim}>nothing yet</Text> : null}
      {activity.slice(-room).map((item, i) => (
        <ActivityLine key={i} item={item} />
      ))}
    </Box>
  );
}

/** A horizontal bar on a dim track, with eighth-block precision at the tip. */
function Meter({ value, max, width, color }: { value: number; max: number; width: number; color: string }) {
  const eighths = max > 0 ? Math.round((Math.min(value, max) / max) * width * 8) : 0;
  const full = Math.floor(eighths / 8);
  const tip = eighths % 8 ? "▏▎▍▌▋▊▉"[(eighths % 8) - 1]! : "";
  return (
    <Text>
      <Text color={color}>
        {"█".repeat(full)}
        {tip}
      </Text>
      <Text color="#2A3140">{"░".repeat(Math.max(0, width - full - (tip ? 1 : 0)))}</Text>
    </Text>
  );
}

/** Stacked bar of a usage's cache read / cache write / input / output. Every non-zero part gets at least one cell. */
function MixBar({ usage, width }: { usage: Usage; width: number }) {
  const total = totalOf(usage);
  if (!total) return <Text color="#2A3140">{"░".repeat(width)}</Text>;
  const parts = MIX.map((m) => ({ ...m, n: usage[m.key] }));
  const cells = parts.map((p) => (p.n ? Math.max(1, Math.round((p.n / total) * width)) : 0));
  // Give back what the minimums overspent, from the widest part.
  let over = cells.reduce((x, y) => x + y, 0) - width;
  while (over-- > 0) cells[cells.indexOf(Math.max(...cells))]!--;
  return (
    <Text>
      {parts.map((p, i) => (
        <Text key={p.key} color={p.color}>
          {"█".repeat(Math.max(0, cells[i]!))}
        </Text>
      ))}
    </Text>
  );
}

function Legend() {
  return (
    <Box gap={2}>
      {MIX.map((m) => (
        <Text key={m.key}>
          <Text color={m.color}>■</Text>
          <Text color={C.dim}> {m.label}</Text>
        </Text>
      ))}
    </Box>
  );
}

function UsageView({ agents, height, width }: { agents: Agent[]; height: number; width: number }) {
  const total = agents.reduce((t, a) => addUsage(t, a.totalUsage), emptyUsage());
  const sum = totalOf(total);
  const sessions = [...agents].sort((x, y) => totalOf(y.totalUsage) - totalOf(x.totalUsage));
  const top = totalOf(sessions[0]?.totalUsage ?? emptyUsage()) || 1;

  // By agent type across every session; main threads count under their session kind.
  const byType = new Map<string, { icon: string; color: string; usage: Usage; runs: number }>();
  const bump = (key: string, icon: string, color: string, u: Usage) => {
    const e = byType.get(key) ?? { icon, color, usage: emptyUsage(), runs: 0 };
    addUsage(e.usage, u);
    e.runs++;
    byType.set(key, e);
  };
  for (const a of agents) {
    bump(a.kind === "background" ? "main · background" : "main · interactive", SESSION_ICON[a.kind], C.text, a.usage);
    for (const s of a.allSubagents) bump(s.type, look(s.type).icon, look(s.type).color, s.usage);
  }
  const types = [...byType.entries()].sort((x, y) => totalOf(y[1].usage) - totalOf(x[1].usage));
  const typeTop = totalOf(types[0]?.[1].usage ?? emptyUsage()) || 1;

  const leftWidth = Math.max(44, Math.floor(width * 0.5));
  const rows = Math.max(1, height - 3);
  const typeRows = Math.max(1, height - 11);

  return (
    <>
      <Box flexDirection="column" width={leftWidth} borderStyle="round" borderColor={C.dim} paddingX={1}>
        <Text color={C.accent} bold>
          sessions by tokens <Text color={C.dim}>· main thread + subagents</Text>
        </Text>
        {sessions.length === 0 ? <Text color={C.dim}>No sessions yet.</Text> : null}
        {sessions.slice(0, rows).map((a) => {
          const n = totalOf(a.totalUsage);
          return (
            <Box key={a.key}>
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                <Text wrap="truncate">
                  {SESSION_ICON[a.kind]} <Text color={C.text}>{a.name}</Text>
                  <Text color={C.dim}> {project(a.cwd)}</Text>
                </Text>
              </Box>
              <Box flexShrink={0}>
                <Text> </Text>
                <Meter value={n} max={top} width={10} color={heat(n) === C.dim ? C.idle : heat(n)} />
                <Text color={heat(n)}>{tok(n).padStart(7)}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
      <Box flexGrow={1} flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1}>
        <Text>
          <Text color={C.accent} bold>
            all sessions
          </Text>
          <Text color={C.dim}> · {agents.length} listed</Text>
        </Text>
        <Text>
          <Text bold color={heat(sum)}>
            {tok(sum)}
          </Text>
          <Text color={C.dim}>
            {" "}
            tokens · {total.turns} calls · {tok(total.output)} written
          </Text>
        </Text>
        <MixBar usage={total} width={Math.max(16, width - leftWidth - 6)} />
        {MIX.map((m) => (
          <Text key={m.key} wrap="truncate">
            <Text color={m.color}>■ </Text>
            <Text color={C.dim}>{m.label.padEnd(12)}</Text>
            <Text color={C.text}>{tok(total[m.key]).padStart(7)}</Text>
            <Text color={C.dim}>{pct(total[m.key], sum).padStart(5)}</Text>
          </Text>
        ))}
        <Text> </Text>
        <Text color={C.accent} bold>
          by agent type
        </Text>
        {types.slice(0, typeRows).map(([type, e]) => {
          const n = totalOf(e.usage);
          return (
            <Box key={type}>
              <Box flexShrink={0}>
                <Meter value={n} max={typeTop} width={10} color={e.color} />
                <Text color={e.color}>{tok(n).padStart(7)} </Text>
              </Box>
              <Text wrap="truncate">
                {e.icon} <Text color={e.color}>{type}</Text>
                <Text color={C.dim}>
                  {" "}
                  ×{e.runs} · {tok(e.usage.output)} out
                </Text>
              </Text>
            </Box>
          );
        })}
      </Box>
    </>
  );
}

/** The text with the character under the cursor drawn inverse. */
function Cursor({ field }: { field: Field }) {
  const { text, cursor } = field;
  // Ink doesn't re-measure a Text when a nested text node appears (empty → non-empty), so it would keep its old
  // width and clip; a new key per length remounts it and measures afresh.
  return (
    <Text key={text.length}>
      {text.slice(0, cursor)}
      <Text inverse>{text[cursor] ?? " "}</Text>
      {text.slice(cursor + 1)}
    </Text>
  );
}

const PROMPT_MAX_LINES = 4;
/** How many lines the prompt's text takes inside a box `width` wide: border and padding take 4, "› " takes 2. */
function promptRows(field: Field, width: number) {
  const per = Math.max(10, width - 6);
  return Math.min(PROMPT_MAX_LINES, Math.max(1, Math.ceil((field.text.length + 1) / per)));
}

function PromptBox({ mode, width, lines }: { mode: Extract<Mode, { type: "new" }>; width: number; lines: number }) {
  const per = Math.max(10, width - 6);
  const { text, cursor } = mode.field;
  // Past the line cap, show the window of text around the cursor.
  const cap = per * PROMPT_MAX_LINES - 1;
  const from = text.length + 1 > cap ? Math.max(0, Math.min(cursor - Math.floor(cap / 2), text.length + 1 - cap)) : 0;
  const shown = { text: text.slice(from, from + cap), cursor: cursor - from };
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.working} paddingX={1} marginX={1} width={width}>
      <Box height={1}>
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text wrap="truncate">
            <Text color={C.working} bold>
              {SESSION_ICON.background} new background agent
            </Text>
            <Text color={C.dim}> in </Text>
            <Text color={C.sub} bold>
              {project(mode.cwd)}
            </Text>
            <Text color={C.dim}> {tilde(mode.cwd)}</Text>
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={C.dim}>
            {"  "}
            {mode.recall >= 0 ? `history ${mode.recall + 1}/${sent.length} · ` : ""}
            {text.length} chars
          </Text>
        </Box>
      </Box>
      <Box height={lines}>
        <Box width={2} flexShrink={0}>
          <Text color={C.working} bold>
            ›
          </Text>
        </Box>
        {text ? (
          <Text wrap="wrap">
            {from > 0 ? <Text color={C.dim}>…</Text> : null}
            <Cursor field={shown} />
          </Text>
        ) : (
          <Text>
            <Text inverse> </Text>
            <Text color={C.dim}>What should it do? e.g. "fix the failing tests and open a draft PR"</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}

export function Logs({ mode, height }: { mode: Extract<Mode, { type: "logs" }>; height: number }) {
  const visible = Math.max(1, height - 3);
  const end = Math.max(Math.min(visible, mode.items.length), mode.items.length - mode.offset);
  const items = mode.items.slice(Math.max(0, end - visible), end);
  return (
    <Box flexGrow={1} flexDirection="column" borderStyle="round" borderColor={C.sub} paddingX={1}>
      <Text wrap="truncate">
        <Text color={C.sub} bold>
          history · {mode.title}
        </Text>
        <Text color={C.dim}>
          {"  "}
          {end}/{mode.items.length}
        </Text>
      </Text>
      {items.map((item, i) => (
        <ActivityLine key={i} item={item} />
      ))}
    </Box>
  );
}

function Footer({ mode, toast, current }: { mode: Mode; toast?: { text: string; color: string }; current?: Row }) {
  const key = (k: string, label: string, color = C.accent) => (
    <Text key={k + label}>
      <Text color={color} bold>
        {k}
      </Text>
      <Text color={C.dim}> {label}</Text>
    </Text>
  );
  let body: React.ReactNode;
  if (mode.type === "confirm") {
    body = (
      <Text color={C.failed}>
        {mode.action === "stop" ? "Stop" : "Remove"} {mode.agent.name}? <Text bold>y</Text> to confirm, any key to cancel
      </Text>
    );
  } else if (mode.type === "new") {
    body = (
      <Box gap={2}>
        {[
          key("⏎", "start", C.working),
          key("esc", "cancel"),
          key("tab", "folder"),
          key("↑↓", "history"),
          key("⌥←→", "word"),
          key("^W", "del word"),
          key("^U", "clear"),
        ]}
      </Box>
    );
  } else if (mode.type === "logs") {
    body = <Box gap={2}>{[key("↑↓", "scroll"), key("u/d", "page"), key("esc", "back")]}</Box>;
  } else if (mode.type === "search") {
    body = <Box gap={2}>{[key("type", "to filter"), key("←→", "move"), key("^U", "clear"), key("⏎/esc", "done")]}</Box>;
  } else {
    const bg = current?.kind === "agent" && !!current.agent.id;
    body = (
      <Box gap={2}>
        {[
          key("↑↓", "move"),
          key("←→", "fold"),
          key("⏎", "attach", bg ? C.accent : C.dim),
          key("l", "history"),
          key("x", "stop", bg ? C.accent : C.dim),
          key("n", "new"),
          key("/", "search"),
          key("u", "usage"),
          key("tab", "view"),
          key("q", "quit"),
        ]}
      </Box>
    );
  }
  return (
    <Box paddingX={1} flexDirection="column">
      <Text color={toast?.color ?? C.dim} wrap="truncate">
        {toast?.text ?? " "}
      </Text>
      {body}
    </Box>
  );
}
