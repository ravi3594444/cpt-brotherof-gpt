"use client";
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { nanoid } from "nanoid";
import { Chat, useChat } from "@ai-sdk/react";
import type { FileUIPart } from "ai";
import {
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  Compass,
  Copy,
  ExternalLink,
  Globe2,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings2,
  Smartphone,
  SquarePen,
  Zap,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X,
  GitCompareArrows,
} from "lucide-react";
import {
  Sidebar,
  SidebarProvider,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LogoReveal } from "@/components/logo-reveal";
import { Elapsed, FollowNewQuestion, Thinking } from "@/components/thinking";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputSubmit,
  PromptInputFooter,
  usePromptInputAttachments,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { capThinking, MAX_PHOTOS, requestTurns, withoutOlderThinking } from "@/lib/conversation";
import { ACCESS_HEADER } from "@/lib/access";
import { historyPhotoUrl, preparePhoto } from "@/lib/photos";
import { SIDEBAR_BOOT_ATTRIBUTE, readSidebarOpen, saveSidebarOpen } from "@/lib/sidebar";
import { createChatRegistry, type ChatRegistry, type SaveInfo } from "@/lib/chat-registry";
import { applyDrafts, pendingDrafts, readDrafts, type Drafts } from "@/lib/history-drafts";
import {
  JobChatTransport,
  activeRunId,
  jobErrorShown,
  lastJob,
  mayHaveLostJob,
  wakePlan,
  withJobEnd,
} from "@/lib/research-job-client";
import {
  DEMO_QUESTION,
  PHOTO_SAMPLE,
  SUGGESTIONS,
  messageText,
  researchData,
  safeSourceUrl,
  thinkingData,
  type LocalThread,
  type ScoutMessage,
  type ScoutConfig,
  type ResearchData,
  type ResearchSource,
} from "@/lib/chat-types";

const STORAGE_KEY = "scout-threads-v1";
// Answers still being written, saved apart from the history (see lib/history-drafts.ts).
const DRAFTS_KEY = "scout-drafts-v1";
let drafts: Drafts<ScoutMessage> = {};
// Answers save as they stream, so saving that keeps failing is shown once, not every second.
const failingKeys = new Set<string>();
function write(key: string, value?: unknown) {
  if (value === undefined) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(value));
}
function store(key: string, value?: unknown, smaller?: () => unknown) {
  try {
    try {
      write(key, value);
    } catch (error) {
      if (!smaller) throw error;
      // Out of room: a smaller copy still saves.
      write(key, smaller());
    }
    failingKeys.delete(key);
    return true;
  } catch {
    if (!failingKeys.size) toast.error("Your browser could not save this conversation.");
    failingKeys.add(key);
    return false;
  }
}
// Show every source as a card, up to the most any research engine returns.
const MAX_SOURCE_CARDS = 8;
type Suggestion = (typeof SUGGESTIONS)[number] | typeof PHOTO_SAMPLE;
const PHOTO_ONLY_QUESTION = "What's in this photo?";
const ENGINE_NAMES: Record<NonNullable<ResearchData["engine"]>, string> = {
  browser_use: "Browser Use Cloud",
  kernel: "Kernel",
  vision_agent: "Vision agent",
  tavily: "Search API",
};
// Photos waiting in the question box, before they are sent.
function ComposerPhotos() {
  const { files, remove } = usePromptInputAttachments();
  if (!files.length) return null;
  return (
    <div className="composer-photos" role="list" aria-label="Attached photos">
      {files.map((file) => (
        <div className="composer-photo" role="listitem" key={file.id}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a local blob preview */}
          <img src={file.url} alt={file.filename || "Attached photo"} />
          <button type="button" aria-label="Remove photo" onClick={() => remove(file.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
// Unlike AI Elements' own item, this lets the menu close so the photos are not hidden behind it.
function AddPhotosItem() {
  const { openFileDialog } = usePromptInputAttachments();
  return (
    <DropdownMenuItem onSelect={() => openFileDialog()}>
      <ImageIcon size={16} />
      Add photos
    </DropdownMenuItem>
  );
}
// Sending is allowed with typed text, attached photos, or both.
function ComposerSend({
  busy,
  hasText,
  status,
  onStop,
}: {
  busy: boolean;
  hasText: boolean;
  status: React.ComponentProps<typeof PromptInputSubmit>["status"];
  onStop: () => void;
}) {
  const { files } = usePromptInputAttachments();
  return (
    <PromptInputSubmit
      status={status}
      onStop={onStop}
      disabled={!busy && !hasText && !files.length}
      className="send-button"
      aria-label={busy ? "Stop research" : "Send question"}
    >
      {busy ? <Square size={14} fill="currentColor" /> : <ArrowUp size={19} />}
    </PromptInputSubmit>
  );
}
function SuggestionIcon({ icon }: { icon: Suggestion["icon"] }) {
  if (icon === "globe") return <Globe2 size={16} />;
  if (icon === "compare") return <GitCompareArrows size={16} />;
  if (icon === "image") return <ImageIcon size={16} />;
  return <BookOpen size={16} />;
}
const INITIAL_CONFIG: ScoutConfig = {
  access: "open",
  demo: true,
  modelConnected: false,
  searchConnected: false,
  modelName: "Scout",
  engines: { browserUse: false, kernel: false, visionAgent: false, tavily: false, jev: false, vision: false },
};
// The workspace access code, remembered on this device (or for this visit
// when the browser blocks storage) and sent with every request.
const ACCESS_STORAGE_KEY = "scout-access-code";
let accessCodeThisVisit = "";
function savedAccessCode() {
  try {
    return localStorage.getItem(ACCESS_STORAGE_KEY) || accessCodeThisVisit;
  } catch {
    return accessCodeThisVisit;
  }
}
function rememberAccessCode(code: string) {
  accessCodeThisVisit = code;
  try {
    if (code) localStorage.setItem(ACCESS_STORAGE_KEY, code);
    else localStorage.removeItem(ACCESS_STORAGE_KEY);
  } catch {
    /* kept for this visit only */
  }
}
function accessHeaders(code = savedAccessCode()): Record<string, string> {
  return code ? { [ACCESS_HEADER]: code } : {};
}
async function fetchConfig(code?: string): Promise<ScoutConfig | null> {
  try {
    const response = await fetch("/api/config", { headers: accessHeaders(code) });
    return response.ok ? ((await response.json()) as ScoutConfig) : null;
  } catch {
    return null;
  }
}
type Chats = ChatRegistry<Chat<ScoutMessage>>;
const isBusy = (status: Chat<ScoutMessage>["status"]) => status === "submitted" || status === "streaming";
// Research jobs the server found for Conversations whose job id this device never got.
const foundJobs = new Map<string, string>();
const jobOf = (id: string, chat: Chat<ScoutMessage>) => activeRunId(chat.messages) ?? foundJobs.get(id);
// Each Chat's transport, which reads its Research job and carries on by itself after a lost connection.
const transports = new WeakMap<Chat<ScoutMessage>, JobChatTransport>();
// Each Chat's next try at reading its job again, after its transport gave up.
const retries = new Map<Chat<ScoutMessage>, { tries: number; timer?: ReturnType<typeof setTimeout> }>();
/**
 * The app came back, went online, or opened a Conversation: a Chat reading its Research job is only
 * woken, so an Answer on screen never restarts. A Chat with no live read (after a reload, or a read
 * that gave up) reads the job's Answer again from the start of its stream, which replaces what it shows.
 */
function reconnect(id: string, chat: Chat<ScoutMessage>, chats: Chats) {
  const transport = transports.get(chat);
  const plan = wakePlan({ status: chat.status, runId: jobOf(id, chat), live: !!transport?.link().live });
  if (plan === "wake") return transport?.wake();
  if (plan !== "resume") return;
  clearTimeout(retries.get(chat)?.timer);
  // A Chat off screen may have been let go by the registry; it keeps saving under its Conversation.
  chats.get(id, () => chat);
  chat.clearError();
  void chat.resumeStream();
}
/** After its transport gave up, tries again a little later while the page is on screen and online. */
function retryLater(id: string, chat: Chat<ScoutMessage>, chats: Chats) {
  const retry = retries.get(chat) ?? { tries: 0 };
  retries.set(chat, retry);
  clearTimeout(retry.timer);
  retry.timer = setTimeout(() => {
    if (document.visibilityState === "visible" && navigator.onLine) reconnect(id, chat, chats);
  }, Math.min(30_000, 2000 * 2 ** retry.tries++));
}
/** Stops a Conversation's Research job on the server; the Chat stops reading it separately. */
function cancelJob(runId: string) {
  void fetch(`/api/jobs/${encodeURIComponent(runId)}/cancel`, { method: "POST", headers: accessHeaders() }).catch(() => {});
}
/**
 * The Chat for a Conversation. It reads on across a Research job's response windows, and through a
 * lost connection, by itself.
 */
function createChat(id: string, messages: ScoutMessage[], chats: Chats) {
  const transport = new JobChatTransport({
    api: "/api/chat",
    headers: () => accessHeaders(),
    prepareSendMessagesRequest: ({ id, messages, body }) => ({
      body: {
        ...body,
        id,
        messages: requestTurns(messages),
      },
    }),
    runId: () => jobOf(id, chat),
    // The server keeps a job's stream for a day; after that the Answer is gone.
    onGone: () => setTimeout(() => {
      foundJobs.delete(id);
      chat.messages = withJobEnd(chat.messages, "expired");
    }),
  });
  const chat: Chat<ScoutMessage> = new Chat<ScoutMessage>({
    id,
    messages,
    transport,
    onError: (error) => {
      const runId = jobOf(id, chat);
      if (runId && !jobErrorShown(error, runId)) retryLater(id, chat, chats);
    },
    onFinish: ({ isError }) => {
      if (lastJob(chat.messages)) foundJobs.delete(id);
      if (!isError) retries.delete(chat);
    },
  });
  transports.set(chat, transport);
  return chat;
}
function AccessGate({ onUnlock }: { onUnlock: (code: string) => Promise<boolean> }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  return (
    <main className="access-gate">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setChecking(true);
          setError("");
          const unlocked = await onUnlock(code.trim());
          setChecking(false);
          if (!unlocked) setError("That code isn't right. Check it and try again.");
        }}
      >
        <Mark size={38} />
        <h1>Enter your access code</h1>
        <p>This Scout workspace is private. Ask its owner for the code.</p>
        <input
          type="password"
          aria-label="Access code"
          autoComplete="current-password"
          autoFocus
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        {error && <p className="access-error" role="alert">{error}</p>}
        <Button type="submit" disabled={!code.trim() || checking}>
          {checking ? "Checking…" : "Continue"}
        </Button>
      </form>
    </main>
  );
}
function Mark({ size = 33 }: { size?: number }) {
  return <Globe2 size={size} strokeWidth={1.4} className="brand-mark" />;
}
function domain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Source";
  }
}

export default function Home() {
  const [threads, setThreads] = useState<LocalThread[]>([]);
  const [activeId, setActiveId] = useState("initial");
  const [loaded, setLoaded] = useState(false);
  const [config, setConfig] = useState<ScoutConfig>(INITIAL_CONFIG);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      if (Array.isArray(raw)) {
        drafts = readDrafts(localStorage.getItem(DRAFTS_KEY));
        // Device-local history loads after hydration: reading localStorage while
        // rendering would make the first client render differ from the server HTML.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setThreads(
          applyDrafts(
            raw
              .filter(
                (t) =>
                  typeof t.id === "string" &&
                  typeof t.title === "string" &&
                  Array.isArray(t.messages),
              )
              .slice(0, 30),
            drafts,
            // A Research job still writing an Answer reconnects when its Conversation opens.
          ).map((t: LocalThread) => ({ ...t, activeRunId: activeRunId(t.messages) })),
        );
      }
    } catch {
      /* local storage can be disabled */
    }
    setSidebarOpen(readSidebarOpen());
    setActiveId(nanoid());
    setLoaded(true);
    void fetchConfig().then((data) => data && setConfig(data));
  }, []);
  useEffect(() => {
    // The mark set in <head> held the saved rail until the saved state was loaded.
    if (loaded) document.documentElement.removeAttribute(SIDEBAR_BOOT_ATTRIBUTE);
  }, [loaded]);
  const changeSidebar = useCallback((open: boolean) => {
    setSidebarOpen(open);
    saveSidebarOpen(open);
  }, []);
  useEffect(() => {
    // Out of room: older conversations give up their thinking so this one still saves.
    if (!loaded || !store(STORAGE_KEY, threads, () => withoutOlderThinking(threads))) return;
    // Drafts the history now holds are done with.
    const pending = pendingDrafts(threads, drafts);
    if (Object.keys(pending).length === Object.keys(drafts).length) return;
    drafts = pending;
    store(DRAFTS_KEY, Object.keys(pending).length ? pending : undefined);
  }, [threads, loaded]);
  const newChat = useCallback((prompt = "") => {
    setInitialPrompt(prompt);
    setActiveId(nanoid());
    setHistoryOpen(false);
  }, []);
  const selectThread = (id: string) => {
    setInitialPrompt("");
    setActiveId(id);
    setHistoryOpen(false);
  };
  const saveThread = useCallback((id: string, messages: ScoutMessage[], { started, running }: SaveInfo) => {
    if (!messages.length) return;
    const title = messageText(
      messages.find((m) => m.role === "user") || messages[0],
    ).slice(0, 80);
    const stored = messages.map((m) => capThinking({
      ...m,
      parts: m.parts.map((p) => (p.type === "file" ? { ...p, url: historyPhotoUrl(p.url) } : p)),
    }));
    const updatedAt = Date.now();
    const runId = activeRunId(messages);
    // An answer still being written saves as a draft; the history is written when it starts and ends.
    if (running && !started) {
      drafts = { ...drafts, [id]: { updatedAt, messages: stored } };
      store(DRAFTS_KEY, drafts);
      return;
    }
    setThreads((prev) => {
      const thread: LocalThread = { id, title, messages: stored, updatedAt, ...(runId && { activeRunId: runId }) };
      // Starting an answer (a question or Try again) moves its conversation to the top; more of an
      // answer, or reconnecting to its Research job, keeps it in place.
      const starts = started && messages.at(-1)?.role === "user";
      if (!starts && prev.some((t) => t.id === id)) return prev.map((t) => (t.id === id ? thread : t));
      return [thread, ...prev.filter((t) => t.id !== id)].slice(0, 30);
    });
  }, []);
  // Each conversation's Chat lives here, not in its view, so answers keep running
  // when another conversation is on screen.
  const [chats] = useState(() => createChatRegistry<ScoutMessage, Chat<ScoutMessage>>({ save: saveThread }));
  const chatsRunning = useSyncExternalStore(chats.subscribe, chats.running, chats.running);
  // A Conversation whose Research job still runs shows as answering, also before its Chat reconnects.
  const running = useMemo(() => {
    const jobs = threads.filter((t) => t.activeRunId && !chatsRunning.includes(t.id)).map((t) => t.id);
    return jobs.length ? [...chatsRunning, ...jobs] : chatsRunning;
  }, [chatsRunning, threads]);
  useEffect(() => {
    // A reload or a closed app ends every running answer; keep what each has written.
    // A Research job goes on without it.
    const keep = () => flushSync(() => chats.flush());
    const hidden = () => document.visibilityState === "hidden" && keep();
    // Back on screen, resumed by Android, or back online: reads waiting to reconnect try now, and a
    // Research job's Answer with no live read reads its job again. A healthy Answer is left alone.
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      for (const [id, chat] of chats.entries()) reconnect(id, chat, chats);
    };
    window.addEventListener("pagehide", keep);
    document.addEventListener("visibilitychange", hidden);
    document.addEventListener("visibilitychange", wake);
    document.addEventListener("resume", wake);
    window.addEventListener("online", wake);
    return () => {
      window.removeEventListener("pagehide", keep);
      document.removeEventListener("visibilitychange", hidden);
      document.removeEventListener("visibilitychange", wake);
      document.removeEventListener("resume", wake);
      window.removeEventListener("online", wake);
    };
  }, [chats]);
  const removeThread = (thread: LocalThread) => {
    // Deleting a Conversation stops its Research job too.
    const chat = chats.entries().find(([id]) => id === thread.id)?.[1];
    const runId = (chat && activeRunId(chat.messages)) || thread.activeRunId;
    if (runId) cancelJob(runId);
    chats.remove(thread.id);
    setThreads((prev) => prev.filter((t) => t.id !== thread.id));
    if (activeId === thread.id) newChat();
    toast("Conversation removed", {
      action: {
        label: "Undo",
        onClick: () => setThreads((prev) => [thread, ...prev].slice(0, 30)),
      },
    });
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setHistoryOpen(true);
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "o"
      ) {
        e.preventDefault();
        newChat();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [newChat]);
  const unlock = useCallback(async (code: string) => {
    rememberAccessCode(code);
    const data = await fetchConfig(code);
    if (data) setConfig(data);
    if (data?.access === "granted") return true;
    rememberAccessCode("");
    return false;
  }, []);
  const forgetAccess = async () => {
    // Stopping a Research job needs the code, so every job is stopped before it is forgotten.
    const stopping = chats.entries().filter(([, chat]) => activeRunId(chat.messages));
    for (const [, chat] of stopping) cancelJob(activeRunId(chat.messages)!);
    for (const t of threads) if (t.activeRunId && !chats.has(t.id)) cancelJob(t.activeRunId);
    chats.stopAll();
    for (const [, chat] of stopping) chat.messages = withJobEnd(chat.messages, "stopped");
    rememberAccessCode("");
    setSettingsOpen(false);
    const data = await fetchConfig("");
    if (data) setConfig(data);
  };
  if (config.access === "required")
    return (
      <>
        <LogoReveal />
        <AccessGate onUnlock={unlock} />
        <Toaster theme="dark" position="top-center" />
      </>
    );
  return (
    <>
    <LogoReveal />
    <SidebarProvider
      className="scout-app"
      open={sidebarOpen}
      onOpenChange={changeSidebar}
      style={{ "--sidebar-width": "252px", "--sidebar-width-icon": "60px" } as React.CSSProperties}
    >
      <AppSidebar
        threads={threads}
        running={running}
        activeId={activeId}
        onNew={() => newChat()}
        onHistory={() => setHistoryOpen(true)}
        onSelect={selectThread}
        onDemo={() => newChat(DEMO_QUESTION)}
        onSettings={() => setSettingsOpen(true)}
      />
      <ChatWorkspace
        key={activeId}
        id={activeId}
        initialMessages={threads.find((t) => t.id === activeId)?.messages || []}
        initialPrompt={initialPrompt}
        config={config}
        chats={chats}
        onSettings={() => setSettingsOpen(true)}
        onNew={() => newChat()}
      />
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="modal-heading">
              Your conversations
            </DialogTitle>
            <DialogDescription>Saved on this device.</DialogDescription>
          </DialogHeader>
          <input
            className="history-search"
            aria-label="Search conversations"
            placeholder="Search your conversations…"
            value={historyQuery}
            onChange={(e) => setHistoryQuery(e.target.value)}
          />
          <div className="history-dialog-list">
            {threads
              .filter((t) =>
                t.title.toLowerCase().includes(historyQuery.toLowerCase()),
              )
              .map((t) => (
                <div className="history-dialog-item" key={t.id}>
                  <button onClick={() => selectThread(t.id)}>{t.title}</button>
                  <button
                    className="icon-button"
                    aria-label={`Delete ${t.title}`}
                    onClick={() => removeThread(t)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            {threads.filter((t) =>
              t.title.toLowerCase().includes(historyQuery.toLowerCase()),
            ).length === 0 && (
              <p className="dialog-help py-7 text-center">
                {threads.length
                  ? "No matching conversations."
                  : "Your first question starts a new conversation."}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="modal-heading">
              Your Scout workspace
            </DialogTitle>
            <DialogDescription>
              Your private research assistant and its research engines.
            </DialogDescription>
          </DialogHeader>
          <div>
            <div className="connection-row">
              <Sparkles size={19} />
              <div>
                <strong>AI model</strong>
                <p>
                  {config.modelConnected
                    ? config.modelName
                    : "OpenAI-compatible provider"}
                </p>
              </div>
              <span className="connection-status">
                {config.modelConnected ? "Connected" : "Not connected"}
              </span>
            </div>
            <div className="connection-row">
              <Globe2 size={19} />
              <div>
                <strong>Browser Use Cloud</strong>
                <p>Managed browser with an agent for complex navigation</p>
              </div>
              <span className="connection-status">
                {config.engines.browserUse ? "Connected" : "Add key"}
              </span>
            </div>
            <div className="connection-row">
              <Compass size={19} />
              <div>
                <strong>Kernel</strong>
                <p>Separate cloud browser for quick page reading</p>
              </div>
              <span className="connection-status">
                {config.engines.kernel ? "Connected" : "Add key"}
              </span>
            </div>
            <div className="connection-row">
              <Zap size={19} />
              <div>
                <strong>JEV</strong>
                <p>Fast route selection when two research engines are connected</p>
              </div>
              <span className="connection-status">
                {config.engines.jev ? "Connected" : "Optional"}
              </span>
            </div>
            <div className="connection-row">
              <ImageIcon size={19} />
              <div>
                <strong>Vision model</strong>
                <p>Describes photos and drives the vision agent&apos;s browser</p>
              </div>
              <span className="connection-status">
                {config.engines.vision ? "Connected" : "Optional"}
              </span>
            </div>
            <div className="connection-row">
              <Smartphone size={19} />
              <div>
                <strong>On-phone browser</strong>
                <p>Native Android browser and local model path</p>
              </div>
              <span className="connection-status">Planned</span>
            </div>
            <div className="connection-row">
              <ShieldCheck size={19} />
              <div>
                <strong>Conversation history</strong>
                <p>Stored in this browser, on this device</p>
              </div>
              <span className="connection-status">Local</span>
            </div>
            {config.access === "granted" && (
              <div className="connection-row">
                <KeyRound size={19} />
                <div>
                  <strong>Access code</strong>
                  <p>Saved on this device</p>
                </div>
                <button className="connection-action" onClick={() => void forgetAccess()}>
                  Forget
                </button>
              </div>
            )}
          </div>
          <p className="dialog-help">
            Browser Use Cloud and Kernel each need their own server key. JEV is a separate hosted decision service, not an on-phone model. Sample mode lets you try citations before a browser is connected. Phone browser control needs a native Android build and an on-device model.
          </p>
          <Button onClick={() => setSettingsOpen(false)} variant="secondary">
            Got it
          </Button>
        </DialogContent>
      </Dialog>
      <Toaster theme="dark" position="top-center" />
    </SidebarProvider>
    </>
  );
}

function AppSidebar({
  threads,
  running,
  activeId,
  onNew,
  onHistory,
  onSelect,
  onDemo,
  onSettings,
}: {
  threads: LocalThread[];
  running: readonly string[];
  activeId: string;
  onNew: () => void;
  onHistory: () => void;
  onSelect: (id: string) => void;
  onDemo: () => void;
  onSettings: () => void;
}) {
  const { open, setOpen, setOpenMobile } = useSidebar();
  const act = (f: () => void) => () => {
    f();
    setOpenMobile(false);
  };
  const openButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (wasOpen.current === open) return;
    wasOpen.current = open;
    // Folding or opening hides whatever had focus in the sidebar, so focus moves to
    // the button that undoes the change, whether a button or Ctrl/Cmd+B did it.
    if (document.activeElement?.closest(".scout-sidebar"))
      (open ? closeButton : openButton).current?.focus();
  }, [open]);
  const fold = (nextOpen: boolean, event: React.MouseEvent<HTMLButtonElement>) => {
    // A click leaves nothing focused, so no label pops up on the rail away from the pointer.
    if (event.detail !== 0) event.currentTarget.blur();
    setOpen(nextOpen);
  };
  return (
    <Sidebar collapsible="icon" className="scout-sidebar">
      <SidebarHeader className="sidebar-top">
        <div className="brand-row">
          <button className="brand" onClick={act(onNew)} aria-label="Scout home">
            <Mark />
            scout<span className="text-primary text-xl -ml-1">.</span>
          </button>
          <SideIconButton
            ref={closeButton}
            label="Close sidebar"
            className="icon-button sidebar-close"
            onClick={(event) => fold(false, event)}
          >
            <PanelLeftClose size={19} />
          </SideIconButton>
        </div>
        <Button variant="outline" className="new-chat" onClick={act(onNew)}>
          <Plus size={17} />
          New conversation<span className="shortcut">↗</span>
        </Button>
      </SidebarHeader>
      <SidebarContent>
        <div className="nav-section">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                className="side-item"
                isActive={threads.every((t) => t.id !== activeId)}
                onClick={act(onNew)}
              >
                <Compass size={18} />
                <span>Ask Scout</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton className="side-item" onClick={act(onHistory)}>
                <Search size={18} />
                <span>Search chats</span>
                <span className="shortcut">⌘ K</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <p className="sidebar-label">YOUR CONVERSATIONS</p>
          {threads.length === 0 ? (
            <p className="sidebar-note">A fresh space for your next idea.</p>
          ) : (
            threads.filter((t, i) => i < 8 || running.includes(t.id)).map((t) => (
              <button
                className={`history-item ${t.id === activeId ? "selected" : ""}`}
                key={t.id}
                onClick={act(() => onSelect(t.id))}
              >
                <MessageSquare size={14} className="shrink-0" />
                <span>{t.title}</span>
                {running.includes(t.id) && (
                  <LoaderCircle size={14} className="spin shrink-0 ml-auto text-primary" role="img" aria-label="Still answering" />
                )}
              </button>
            ))
          )}
        </div>
      </SidebarContent>
      <SidebarFooter className="side-footer">
        <button className="history-item !px-0" onClick={act(onDemo)}>
          <BookOpen size={17} />
          <span>Explore a research example</span>
        </button>
        <div className="h-px bg-sidebar-border" />
        <button className="workspace-button" onClick={act(onSettings)}>
          <span className="avatar">S</span>
          <span>
            <strong>Your workspace</strong>
            <small>Personal</small>
          </span>
          <Settings2 size={16} className="ml-auto text-muted-foreground" />
        </button>
      </SidebarFooter>
      {/* Desktop only: the folded sidebar, shown instead of everything above. */}
      <div className="sidebar-rail">
        <SideIconButton
          ref={openButton}
          label="Open sidebar"
          className="rail-button rail-open"
          onClick={(event) => fold(true, event)}
        >
          <Mark size={24} />
          <PanelLeftOpen size={20} className="rail-open-icon" />
        </SideIconButton>
        <SideIconButton label="New conversation" className="rail-button" onClick={onNew}>
          <SquarePen size={19} />
        </SideIconButton>
        <SideIconButton label="Search chats" className="rail-button" onClick={onHistory}>
          <Search size={19} />
        </SideIconButton>
        <SideIconButton label="Explore a research example" className="rail-button" onClick={onDemo}>
          <BookOpen size={19} />
        </SideIconButton>
        <div className="rail-running-list">
          {threads
            .filter((t) => running.includes(t.id))
            .map((t) => (
              <SideIconButton
                key={t.id}
                label={`Still answering: ${t.title}`}
                className="rail-button rail-running"
                aria-current={t.id === activeId ? "page" : undefined}
                onClick={() => onSelect(t.id)}
              >
                <LoaderCircle size={18} className="spin" />
              </SideIconButton>
            ))}
        </div>
        <SideIconButton label="Workspace settings" className="rail-button rail-settings" onClick={onSettings}>
          <span className="avatar">S</span>
        </SideIconButton>
      </div>
    </Sidebar>
  );
}
// An icon-only sidebar button: screen readers read its label, and hovering shows it.
function SideIconButton({
  label,
  ...props
}: React.ComponentProps<"button"> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} {...props} />
      </TooltipTrigger>
      {/* Hidden at once when its button folds away, instead of fading at the corner. */}
      <TooltipContent side="right" sideOffset={10} hideWhenDetached>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function ChatWorkspace({
  id,
  initialMessages,
  initialPrompt,
  config,
  chats,
  onSettings,
  onNew,
}: {
  id: string;
  initialMessages: ScoutMessage[];
  initialPrompt: string;
  config: ScoutConfig;
  chats: ChatRegistry<Chat<ScoutMessage>>;
  onSettings: () => void;
  onNew: () => void;
}) {
  const [webSelected, setWebEnabled] = useState(true);
  // Sample mode starts on until a research engine is connected; the switch overrides it.
  const [previewChoice, setPreview] = useState<boolean | null>(null);
  const preview = previewChoice ?? !config.searchConnected;
  const [engine, setEngine] = useState<"auto" | "browser_use" | "kernel" | "vision_agent" | "tavily">("auto");
  const webAvailable = preview || config.searchConnected;
  const webEnabled = webSelected && webAvailable;
  const [input, setInput] = useState("");
  const [readerOpen, setReaderOpen] = useState(false);
  const [readerSources, setReaderSources] = useState<ResearchSource[]>([]);
  const [copied, setCopied] = useState("");
  // The Chat outlives this view, so switching conversations leaves its answer running.
  const [chat] = useState(() => chats.get(id, () => createChat(id, initialMessages, chats)));
  const { messages, sendMessage, regenerate, status, stop, error, clearError, setMessages } =
    useChat<ScoutMessage>({ chat });
  const transport = transports.get(chat)!;
  const link = useSyncExternalStore(transport.subscribe, transport.link, transport.link);
  // A Research job keeps writing the Answer while the connection to it is lost, so it still runs.
  const runId = activeRunId(messages);
  const job = lastJob(messages);
  const streaming = status === "submitted" || status === "streaming";
  const busy = streaming || !!runId;
  // Said only while no chunk has come for a few seconds and Scout is really reconnecting, never
  // under an Answer that is streaming.
  const reconnectingToJob = !!runId && !jobErrorShown(error, runId) &&
    (link.reconnecting || (!link.live && status === "error"));
  const requestBody = { webEnabled, preview, engine };
  const sentInitial = useRef(false);
  useEffect(() => chats.show(id), [chats, id]);
  // Opening a Conversation whose Research job is still running reads its Answer, unless its Chat is
  // already reading it.
  useEffect(() => {
    reconnect(id, chat, chats);
  }, [id, chat, chats]);
  // An Answer cut off mid-research on a device that never got its job id: the server may know it.
  const lookedUp = useRef(false);
  useEffect(() => {
    if (!config.durable || lookedUp.current || isBusy(chat.status) || activeRunId(chat.messages) || !mayHaveLostJob(chat.messages)) return;
    lookedUp.current = true;
    void fetch(`/api/chats/${encodeURIComponent(id)}/job`, { headers: accessHeaders() })
      .then((response) => (response.ok ? (response.json() as Promise<{ runId?: string | null }>) : undefined))
      .then((found) => {
        if (!found?.runId) return;
        foundJobs.set(id, found.runId);
        reconnect(id, chat, chats);
      })
      .catch(() => {});
  }, [config.durable, id, chat, chats]);
  const submit = useCallback(
    async (text: string, options: { webEnabled?: boolean; files?: FileUIPart[] } = {}) => {
      const clean = text.trim();
      const attached = (options.files ?? []).slice(0, MAX_PHOTOS);
      if ((!clean && !attached.length) || isBusy(chat.status) || activeRunId(chat.messages)) return;
      let files: FileUIPart[];
      try {
        files = await Promise.all(attached.map(preparePhoto));
      } catch (error) {
        toast.error("That photo could not be opened. Try a JPEG, PNG, or WebP photo.");
        throw error; // PromptInput keeps the photos so the user can retry.
      }
      clearError();
      setInput("");
      return sendMessage(
        { text: clean || PHOTO_ONLY_QUESTION, ...(files.length ? { files } : {}) },
        {
          body: {
            // A photo with no typed words has nothing to search the web for.
            webEnabled: clean ? (options.webEnabled ?? webEnabled) : false,
            preview,
            engine,
          },
        },
      );
    },
    [chat, sendMessage, clearError, webEnabled, preview, engine],
  );
  useEffect(() => {
    if (initialPrompt && !sentInitial.current) {
      sentInitial.current = true;
      void submit(initialPrompt);
    }
  }, [initialPrompt, submit]);
  useEffect(() => {
    type ToolContext = {
      registerTool: (
        tool: object,
        options: { signal: AbortSignal },
      ) => void | Promise<void>;
    };
    const context = (document as Document & { modelContext?: ToolContext })
      .modelContext;
    if (!context?.registerTool) return;
    const controller = new AbortController();
    void Promise.resolve(
      context.registerTool(
        {
          name: "research_question",
          title: "Research a question",
          description:
            "Submit a question to Scout. Scout researches the web with visible steps when the question needs it, and returns the completed answer with any sources; sample responses when demo mode is enabled.",
          inputSchema: {
            type: "object",
            properties: {
              question: { type: "string", minLength: 1, maxLength: 6000 },
            },
            required: ["question"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input: unknown) => {
            if (
              !input ||
              typeof input !== "object" ||
              !("question" in input) ||
              typeof input.question !== "string" ||
              !input.question.trim() ||
              input.question.length > 6000
            )
              throw new Error(
                "A question between 1 and 6000 characters is required.",
              );
            if (isBusy(chat.status) || activeRunId(chat.messages))
              throw new Error("A research task is already running.");
            if (!webAvailable)
              throw new Error("Web research is not connected yet.");
            setWebEnabled(true);
            await submit(input.question, { webEnabled: true });
            const answer = chat.messages.findLast(
              (m) => m.role === "assistant",
            );
            return {
              answer: answer ? messageText(answer) : "",
              sources: answer ? researchData(answer)?.sources || [] : [],
              demo: preview || config.demo,
            };
          },
        },
        { signal: controller.signal },
      ),
    ).catch(() => {});
    return () => controller.abort();
  }, [chat, submit, config.demo, preview, webAvailable]);
  const openSources = (sources: ResearchSource[]) => {
    setReaderSources(sources);
    setReaderOpen(true);
  };
  const copy = async (m: ScoutMessage) => {
    try {
      const sources = researchData(m)?.sources || [];
      await navigator.clipboard.writeText(
        messageText(m) +
          (sources.length
            ? "\n\nSources\n" +
              sources.map((s, i) => `${i + 1}. ${s.title}: ${s.url}`).join("\n")
            : ""),
      );
      setCopied(m.id);
      toast.success("Answer copied with sources");
    } catch {
      toast.error("Copy isn’t available in this browser.");
    }
  };
  const composer = (
    <PromptInput
      onSubmit={({ text, files }: PromptInputMessage) => submit(text, { files })}
      className="composer"
      accept="image/jpeg,image/png,image/webp"
      multiple
      maxFiles={MAX_PHOTOS}
      maxFileSize={20 * 1024 * 1024}
      onError={({ code }) =>
        toast(
          code === "max_files"
            ? `Add up to ${MAX_PHOTOS} photos per question.`
            : code === "max_file_size"
              ? "Photos can be up to 20 MB."
              : "Scout accepts JPEG, PNG, and WebP photos.",
        )
      }
    >
      <ComposerPhotos />
      <PromptInputTextarea
        aria-label={messages.length ? "Ask a follow-up" : "Ask Scout anything"}
        placeholder={messages.length ? "Ask a follow-up" : "Ask anything"}
        value={input}
        maxLength={6000}
        onChange={(e) => setInput(e.target.value)}
      />
      <PromptInputFooter className="composer-footer">
        <div className="composer-tools">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="composer-icon" aria-label="More options" disabled={busy}>
                <Plus size={20} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" sideOffset={10} className="composer-menu">
              <AddPhotosItem />
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={preview || config.demo}
                disabled={config.demo}
                onCheckedChange={(checked) => setPreview(checked === true)}
              >
                <Sparkles size={16} />
                Sample answers
              </DropdownMenuCheckboxItem>
              {config.demo && (
                <p className="composer-menu-note">
                  On until an AI model is connected to this workspace.
                </p>
              )}
              {!preview && config.searchConnected && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Research engine</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={engine}
                    onValueChange={(value) => setEngine(value as typeof engine)}
                  >
                    <DropdownMenuRadioItem value="auto">Auto</DropdownMenuRadioItem>
                    {config.engines.browserUse && <DropdownMenuRadioItem value="browser_use">Browser Use Cloud</DropdownMenuRadioItem>}
                    {config.engines.kernel && <DropdownMenuRadioItem value="kernel">Kernel</DropdownMenuRadioItem>}
                    {config.engines.visionAgent && <DropdownMenuRadioItem value="vision_agent">Vision agent</DropdownMenuRadioItem>}
                    {config.engines.tavily && <DropdownMenuRadioItem value="tavily">Search API</DropdownMenuRadioItem>}
                  </DropdownMenuRadioGroup>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            className={`web-chip ${webEnabled ? "active" : ""}`}
            aria-label="Search the web"
            aria-pressed={webEnabled}
            title={webAvailable ? undefined : "Add a Browser Use Cloud or Kernel key to search the web"}
            disabled={busy || !webAvailable}
            onClick={() => setWebEnabled(!webSelected)}
          >
            <Globe2 size={16} />
            <span>Web</span>
          </button>
        </div>
        <ComposerSend
          busy={busy}
          hasText={!!input.trim()}
          status={busy && !streaming ? "streaming" : status}
          onStop={() => {
            // Stop ends the Research job on the server, then the Chat's own read of it.
            const stopping = activeRunId(chat.messages);
            if (stopping) cancelJob(stopping);
            void stop();
            if (stopping) setMessages((current) => withJobEnd(current, "stopped"));
            toast("Stopped");
          }}
        />
      </PromptInputFooter>
    </PromptInput>
  );
  return (
    <main className="main-shell">
      <header className="topbar">
        <SidebarTrigger className="mobile-menu" />
        <span className="topbar-title">Scout</span>
        {(preview || config.demo) && (
          <button className="mode-badge" onClick={onSettings}>
            Sample
          </button>
        )}
        <div className="header-right">
          <button className="icon-button topbar-new" onClick={onNew} aria-label="New conversation">
            <SquarePen size={19} />
          </button>
        </div>
      </header>
      <div className="workspace">
        {messages.length === 0 ? (
          <div className="empty-workspace">
            <div className="home">
              <div className="home-hero">
                <Mark size={34} />
                <h1>What do you want to research?</h1>
              </div>
              <div className="home-composer">{composer}</div>
              <div className="suggestion-chips">
                {(preview || config.demo ? [SUGGESTIONS[0], SUGGESTIONS[1], PHOTO_SAMPLE] : SUGGESTIONS).map((s) => (
                  <button className="suggestion-chip" key={s.text} onClick={() => void submit(s.text)}>
                    <SuggestionIcon icon={s.icon} />
                    <span>{s.text}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <>
            <Conversation className="conversation">
              <ConversationContent className="conversation-inner">
                {messages.map((message, index) => {
                  const research = researchData(message);
                  const text = messageText(message);
                  const isLast = index === messages.length - 1;
                  const thinking = message.role === "assistant" ? thinkingData(message) : undefined;
                  const live = busy && isLast;
                  const thinkingRow = thinking && ((thinking.streaming && live) || thinking.text) ? (
                    <Thinking
                      text={thinking.text}
                      thinking={thinking.streaming && live}
                      stopped={thinking.streaming && !live}
                      ms={message.metadata?.thinkingMs}
                      thoughts={thinking.thoughts}
                    />
                  ) : null;
                  const suggestions = message.parts.find(
                    (p) => p.type === "data-suggestions",
                  )?.data as string[] | undefined;
                  return message.role === "user" ? (
                    <Message
                      from="user"
                      key={message.id}
                      className="user-message"
                    >
                      {message.parts.some((p) => p.type === "file") && (
                        <div className="user-photos">
                          {message.parts.map((p, i) =>
                            p.type !== "file" ? null : p.url ? (
                              // eslint-disable-next-line @next/next/no-img-element -- the user's own photo
                              <img key={i} src={p.url} alt={p.filename || "Attached photo"} />
                            ) : (
                              <span key={i} className="photo-placeholder">Photo</span>
                            ),
                          )}
                        </div>
                      )}
                      <MessageContent className="!text-base !leading-7 !rounded-2xl">
                        {text}
                      </MessageContent>
                    </Message>
                  ) : (
                    <Message
                      from="assistant"
                      key={message.id}
                      className="assistant-message"
                    >
                      {(research?.demo || message.metadata?.demo) && (
                        <span className="assistant-tag">Sample answer</span>
                      )}
                      {thinking?.beforeResearch && thinkingRow}
                      {research && (
                        <ResearchActivity data={research} active={busy && isLast} />
                      )}
                      {!!research?.sources.length && (
                          <div className="source-cards" role="list" aria-label="Sources">
                            {research.sources.slice(0, MAX_SOURCE_CARDS).map((s, i) => (
                              <a
                                className="source-card"
                                role="listitem"
                                key={s.url}
                                href={safeSourceUrl(s.url)}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {s.image && (
                                  <img
                                    className="source-image"
                                    src={s.image}
                                    alt={s.title}
                                    loading="lazy"
                                    referrerPolicy="no-referrer"
                                  />
                                )}
                                <div className="source-domain">
                                  <span className="source-number">{i + 1}</span>
                                  <span className="truncate">
                                    {domain(s.url)}
                                  </span>
                                  <ArrowUpRight
                                    size={12}
                                    className="shrink-0 ml-auto"
                                  />
                                </div>
                                <span className="source-title">{s.title}</span>
                              </a>
                            ))}
                          </div>
                      )}
                      {thinking && !thinking.beforeResearch && thinkingRow}
                      {text && (
                        <MessageContent className="!w-full !overflow-visible">
                          <MessageResponse
                            className="answer-body"
                            linkSafety={{
                              enabled: true,
                              onLinkCheck: (url: string) =>
                                !!research?.sources.some(
                                  (source) => source.url === url,
                                ),
                            }}
                            isAnimating={busy && isLast}
                          >
                            {text}
                          </MessageResponse>
                        </MessageContent>
                      )}
                      {text && (
                        <div className="answer-actions">
                          <button
                            className="icon-button"
                            aria-label="Copy answer"
                            onClick={() => void copy(message)}
                          >
                            {copied === message.id ? (
                              <Check size={16} />
                            ) : (
                              <Copy size={16} />
                            )}
                          </button>
                          {!!research?.sources.length && (
                            <button
                              className="icon-button"
                              aria-label="Read source details"
                              onClick={() => openSources(research.sources)}
                            >
                              <BookOpen size={16} />
                            </button>
                          )}
                          <span className="answer-stamp">
                            {research?.demo || message.metadata?.demo
                              ? "Preview · sample content"
                              : research?.sources.length
                                ? `${research.sources.length} sources explored`
                                : "Scout"}
                          </span>
                        </div>
                      )}
                      {!busy && isLast && suggestions?.length ? (
                        <div className="followups">
                          {suggestions.map((s) => (
                            <button
                              className="followup"
                              key={s}
                              onClick={() => void submit(s)}
                            >
                              {s}
                              <Plus size={16} className="shrink-0" />
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </Message>
                  );
                })}
                {status === "submitted" && !runId && (
                  <div className="progress-strip">
                    <LoaderCircle size={17} className="spin" />
                    {preview || config.demo ? "Opening a sample answer…" : "Thinking…"}
                    <Elapsed after={3} className="progress-time" />
                  </div>
                )}
                {reconnectingToJob && (
                  <div className="progress-strip" role="status">
                    <LoaderCircle size={17} className="spin" />
                    Scout is still researching. Reconnecting…
                  </div>
                )}
                {!busy && job?.end === "expired" && (
                  <div className="error-banner" role="alert">
                    This answer is no longer available. Scout keeps research for a day.
                    <Button
                      variant="ghost"
                      className="mt-2"
                      onClick={() => void regenerate({ body: requestBody })}
                    >
                      Try again
                    </Button>
                  </div>
                )}
                {error && jobErrorShown(error, runId) && (
                  <div className="error-banner" role="alert">
                    {error.message ||
                      "The request could not be completed. Please try again."}
                    <Button
                      variant="ghost"
                      className="mt-2"
                      onClick={() => {
                        clearError();
                        void regenerate({ body: requestBody });
                      }}
                    >
                      Try again
                    </Button>
                  </div>
                )}
              </ConversationContent>
              {/* Only a new question: reading a job's Answer again keeps the reader where they are. */}
              <FollowNewQuestion asked={status === "submitted" && messages.at(-1)?.role === "user"} />
              <ConversationScrollButton className="bg-card border-border" />
            </Conversation>
            <div className="bottom-composer">{composer}</div>
            <div className="footer-note">
              {preview || config.demo
                ? "Sample answers · no live research"
                : "Scout can make mistakes. Check the sources."}
            </div>
          </>
        )}
      </div>
      <Sheet open={readerOpen} onOpenChange={setReaderOpen}>
        <SheetContent className="w-full sm:max-w-[460px]">
          <SheetHeader className="p-6">
            <SheetTitle className="text-xl">Behind the answer</SheetTitle>
            <SheetDescription>
              {readerSources.length} sources · Open a page to check the
              original.
            </SheetDescription>
          </SheetHeader>
          <div className="reader-body">
            {readerSources.map((s, i) => (
              <article className="reader-source" key={s.url}>
                <span className="source-domain">
                  SOURCE {i + 1} · {domain(s.url)}
                </span>
                <a
                  href={safeSourceUrl(s.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {s.title}
                  <ExternalLink size={15} className="shrink-0" />
                </a>
                {s.image && (
                  <img
                    className="reader-image"
                    src={s.image}
                    alt={s.title}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                )}
                <p>{s.content}</p>
                {s.read && (
                  <small className="text-primary text-xs">
                    Page content read
                  </small>
                )}
              </article>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </main>
  );
}
function ResearchActivity({
  data,
  active,
}: {
  data: ResearchData;
  active: boolean;
}) {
  // Steps show while research runs, then fold into one line; a tap reopens them.
  const [openChoice, setOpen] = useState<boolean | null>(null);
  const open = openChoice ?? active;
  const incomplete = !active && data.phase !== "complete";
  // Failed research the model was told about is incomplete, also while the answer is still coming;
  // a request cut off or cancelled stopped it.
  const label = data.failed || incomplete
    ? data.failed ? "Research incomplete" : "Research stopped"
    : data.demo
      ? data.phase === "complete"
        ? "Sample research complete"
        : "Exploring the sample research"
      : data.phase === "searching"
        ? "Searching the web"
        : data.phase === "reading"
          ? "Reading relevant pages"
          : data.phase === "writing"
            ? "Putting the answer together"
            : "Research complete";
  const engine = data.engine ? ENGINE_NAMES[data.engine] : "";
  const detail = data.sources.length
    ? `${data.sources.length} ${data.sources.length === 1 ? "source" : "sources"}${engine ? ` · ${engine}` : ""}`
    : data.engine === "browser_use" ? "Browser Use Cloud is navigating"
      : data.engine === "kernel" ? "Kernel is reading pages"
      : data.engine === "vision_agent" ? "Vision agent is browsing"
        : data.queries.at(-1) || "Finding relevant sources";
  return (
    <div className={`agent-activity ${open ? "open" : ""}`}>
      <button
        type="button"
        className="activity-line"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {active ? (
          <LoaderCircle size={16} className="spin shrink-0" />
        ) : incomplete ? (
          <Square size={14} className="shrink-0" />
        ) : (
          <Check size={16} className="shrink-0" />
        )}
        <span className="activity-label">{label}</span>
        <span className="activity-detail">{detail}</span>
        <ChevronRight size={15} className="trailing shrink-0" />
      </button>
      {/* Its own line, so a reason or a partial result is never cut off. */}
      {data.warning && <p className="activity-warning">{data.warning}</p>}
      {open && !!data.steps?.length && (
        <ol className="agent-steps" aria-label="Research actions">
          {data.steps.map((step, i) => (
            <li key={i}>
              {/* A research try that failed is not a finished step. */}
              {step.startsWith("Research did not finish")
                ? <Square size={11} className="step-failed" />
                : active && i === data.steps!.length - 1
                  ? <LoaderCircle size={13} className="spin" />
                  : <Check size={13} />}
              <span>{step}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
