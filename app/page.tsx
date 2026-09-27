"use client";
import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { nanoid } from "nanoid";
import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type FileUIPart } from "ai";
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
import { MAX_PHOTOS, requestTurns } from "@/lib/conversation";
import { ACCESS_HEADER } from "@/lib/access";
import { historyPhotoUrl, preparePhoto } from "@/lib/photos";
import { SIDEBAR_BOOT_ATTRIBUTE, readSidebarOpen, saveSidebarOpen } from "@/lib/sidebar";
import {
  DEMO_QUESTION,
  PHOTO_SAMPLE,
  SUGGESTIONS,
  messageText,
  researchData,
  safeSourceUrl,
  type LocalThread,
  type ScoutMessage,
  type ScoutConfig,
  type ResearchData,
  type ResearchSource,
} from "@/lib/chat-types";

const STORAGE_KEY = "scout-threads-v1";
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
      if (Array.isArray(raw))
        // Device-local history loads after hydration: reading localStorage while
        // rendering would make the first client render differ from the server HTML.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setThreads(
          raw
            .filter(
              (t) =>
                typeof t.id === "string" &&
                typeof t.title === "string" &&
                Array.isArray(t.messages),
            )
            .slice(0, 30),
        );
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
    if (loaded) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(threads));
      } catch {
        toast.error("Your browser could not save this conversation.");
      }
    }
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
  const saveThread = useCallback((id: string, messages: ScoutMessage[]) => {
    if (!messages.length) return;
    const title = messageText(
      messages.find((m) => m.role === "user") || messages[0],
    ).slice(0, 80);
    const stored = messages.map((m) => ({
      ...m,
      parts: m.parts.map((p) => (p.type === "file" ? { ...p, url: historyPhotoUrl(p.url) } : p)),
    }));
    setThreads((prev) =>
      [
        { id, title, messages: stored, updatedAt: Date.now() },
        ...prev.filter((t) => t.id !== id),
      ].slice(0, 30),
    );
  }, []);
  const removeThread = (thread: LocalThread) => {
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
        onSave={saveThread}
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
  activeId,
  onNew,
  onHistory,
  onSelect,
  onDemo,
  onSettings,
}: {
  threads: LocalThread[];
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
            threads.slice(0, 8).map((t) => (
              <button
                className={`history-item ${t.id === activeId ? "selected" : ""}`}
                key={t.id}
                onClick={act(() => onSelect(t.id))}
              >
                <MessageSquare size={14} className="shrink-0" />
                <span>{t.title}</span>
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
  onSave,
  onSettings,
  onNew,
}: {
  id: string;
  initialMessages: ScoutMessage[];
  initialPrompt: string;
  config: ScoutConfig;
  onSave: (id: string, m: ScoutMessage[]) => void;
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
  const [chat] = useState(
    () =>
      new Chat<ScoutMessage>({
        id,
        messages: initialMessages,
        transport: new DefaultChatTransport({
          api: "/api/chat",
          headers: () => accessHeaders(),
          prepareSendMessagesRequest: ({ messages, body }) => ({
            body: {
              ...body,
              messages: requestTurns(messages),
            },
          }),
        }),
      }),
  );
  const { messages, sendMessage, regenerate, status, stop, error, clearError } =
    useChat<ScoutMessage>({ chat });
  const busy = status === "submitted" || status === "streaming";
  const requestBody = { webEnabled, preview, engine };
  const sentInitial = useRef(false);
  useEffect(() => {
    if (messages.length && (status === "ready" || status === "error"))
      onSave(id, messages);
  }, [messages, status, id, onSave]);
  useEffect(
    () => () => {
      const wasBusy = chat.status === "submitted" || chat.status === "streaming";
      void chat.stop();
      if (chat.messages.length && wasBusy) onSave(id, chat.messages);
    },
    [chat, id, onSave],
  );
  const submit = useCallback(
    async (text: string, options: { webEnabled?: boolean; files?: FileUIPart[] } = {}) => {
      const clean = text.trim();
      const attached = (options.files ?? []).slice(0, MAX_PHOTOS);
      if ((!clean && !attached.length) || chat.status === "submitted" || chat.status === "streaming") return;
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
            if (chat.status === "submitted" || chat.status === "streaming")
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
          status={status}
          onStop={() => {
            void stop();
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
                {status === "submitted" && (
                  <div className="progress-strip">
                    <LoaderCircle size={17} className="spin" />
                    {preview || config.demo ? "Opening a sample answer…" : "Thinking…"}
                  </div>
                )}
                {error && (
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
  // Failed research the model was told about is incomplete; a request cut off or cancelled stopped it.
  const label = incomplete
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
        : data.queries[0] || "Finding relevant sources";
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
              {active && i === data.steps!.length - 1
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
