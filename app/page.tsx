"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { nanoid } from "nanoid";
import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import {
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  Compass,
  Copy,
  ExternalLink,
  Globe2,
  LoaderCircle,
  MessageSquare,
  Plus,
  Search,
  Settings2,
  Smartphone,
  Zap,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
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
import { Switch } from "@/components/ui/switch";
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
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import {
  Sources,
  SourcesTrigger,
  SourcesContent,
  Source,
} from "@/components/ai-elements/sources";
import {
  DEMO_QUESTION,
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
// PromptInput resets its <form> on every submit, and a Radix Switch inside a form
// snaps back to its mount-time value on reset. The composer's switches are
// settings, not form fields, so point their form attribute at an id no form has.
const OUTSIDE_PROMPT_FORM = "scout-composer-settings";
const INITIAL_CONFIG: ScoutConfig = {
  demo: true,
  modelConnected: false,
  searchConnected: false,
  modelName: "Scout",
  engines: { browserUse: false, kernel: false, tavily: false, jev: false },
};
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
    setActiveId(nanoid());
    setLoaded(true);
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => setConfig(data as ScoutConfig))
      .catch(() => {});
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
    setThreads((prev) =>
      [
        { id, title, messages, updatedAt: Date.now() },
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
  return (
    <SidebarProvider
      className="scout-app"
      style={{ "--sidebar-width": "252px" } as React.CSSProperties}
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
                <p>Fast route selection when both browsers are connected</p>
              </div>
              <span className="connection-status">
                {config.engines.jev ? "Connected" : "Optional"}
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
  const { setOpenMobile } = useSidebar();
  const act = (f: () => void) => () => {
    f();
    setOpenMobile(false);
  };
  return (
    <Sidebar className="scout-sidebar">
      <SidebarHeader className="sidebar-top">
        <button className="brand" onClick={act(onNew)} aria-label="Scout home">
          <Mark />
          scout<span className="text-primary text-xl -ml-1">.</span>
        </button>
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
    </Sidebar>
  );
}

function ChatWorkspace({
  id,
  initialMessages,
  initialPrompt,
  config,
  onSave,
  onSettings,
}: {
  id: string;
  initialMessages: ScoutMessage[];
  initialPrompt: string;
  config: ScoutConfig;
  onSave: (id: string, m: ScoutMessage[]) => void;
  onSettings: () => void;
}) {
  const [webSelected, setWebEnabled] = useState(true);
  // Sample mode starts on until a research engine is connected; the switch overrides it.
  const [previewChoice, setPreview] = useState<boolean | null>(null);
  const preview = previewChoice ?? !config.searchConnected;
  const [engine, setEngine] = useState<"auto" | "browser_use" | "kernel" | "tavily">("auto");
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
          prepareSendMessagesRequest: ({ messages, body }) => ({
            body: {
              ...body,
              messages: messages.slice(-16).map((m) => ({
                id: m.id,
                role: m.role,
                parts: m.parts.filter((p) => p.type === "text"),
              })),
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
    (text: string, options?: { webEnabled?: boolean }) => {
      const clean = text.trim();
      if (!clean || chat.status === "submitted" || chat.status === "streaming") return;
      clearError();
      setInput("");
      return sendMessage(
        { text: clean },
        { body: { webEnabled, preview, engine, ...options } },
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
            "Submit a question to Scout. Starts visible web research and returns the completed answer with sources; sample responses when demo mode is enabled.",
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
  const latestResearch = messages.map(researchData).findLast(Boolean);
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
      onSubmit={({ text }: PromptInputMessage) => submit(text)}
      className="composer"
      maxFiles={0}
      onError={() =>
        toast("Paste a page URL into your question to research it.")
      }
    >
      <PromptInputTextarea
        aria-label={messages.length ? "Ask a follow-up" : "Ask Scout anything"}
        placeholder={
          messages.length
            ? "Ask a follow-up…"
            : "Ask anything, or paste a link to explore…"
        }
        value={input}
        maxLength={6000}
        onChange={(e) => setInput(e.target.value)}
      />
      <PromptInputFooter className="composer-footer">
        <div className="composer-tools">
          <label className={`search-mode ${webEnabled ? "active" : ""}`}>
            <Globe2 size={15} />
            <span>Search the web</span>
            <Switch
              aria-label="Search the web"
              form={OUTSIDE_PROMPT_FORM}
              checked={webEnabled}
              onCheckedChange={setWebEnabled}
              disabled={busy || !webAvailable}
              size="sm"
              className="ml-1"
            />
          </label>
          <label className={`search-mode ${preview ? "active" : ""}`}>
            <Sparkles size={14} />
            <span>Sample</span>
            <Switch
              aria-label="Sample research"
              form={OUTSIDE_PROMPT_FORM}
              checked={preview || config.demo}
              onCheckedChange={setPreview}
              disabled={busy || config.demo}
              size="sm"
              className="ml-1"
            />
          </label>
          {!preview && config.searchConnected && (
            <select
              className="engine-picker"
              aria-label="Research engine"
              value={engine}
              onChange={(e) => setEngine(e.target.value as typeof engine)}
              disabled={busy}
            >
              <option value="auto">Auto browser</option>
              {config.engines.browserUse && <option value="browser_use">Browser Use Cloud</option>}
              {config.engines.kernel && <option value="kernel">Kernel</option>}
              {config.engines.tavily && <option value="tavily">Search API</option>}
            </select>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="research-caption">
            <ShieldCheck size={13} />
            {webEnabled ? preview ? "Sample sources" : "Answers with sources" : "Chat without search"}
          </span>
          <PromptInputSubmit
            status={status}
            onStop={() => {
              void stop();
              toast("Research stopped");
            }}
            disabled={!busy && !input.trim()}
            className="send-button"
            aria-label={busy ? "Stop research" : "Send question"}
          >
            {busy ? (
              <Square size={14} fill="currentColor" />
            ) : (
              <ArrowUp size={19} />
            )}
          </PromptInputSubmit>
        </div>
      </PromptInputFooter>
    </PromptInput>
  );
  return (
    <main className="main-shell">
      <header className="topbar">
        <SidebarTrigger className="mobile-menu" />
        <span className="topbar-title">Scout</span>
        <span className="topbar-slash">/</span>
        <span className="topbar-label">Your research companion</span>
        <div className="header-right">
          <button className="mode-badge" onClick={onSettings}>
            {preview || config.demo
              ? "Sample mode"
              : config.searchConnected
                ? "Connected"
                : "Live chat"}
          </button>
          {latestResearch?.sources.length ? (
            <button
              className="icon-button"
              onClick={() => openSources(latestResearch.sources)}
              aria-label="Open sources"
            >
              <BookOpen size={18} />
            </button>
          ) : (
            <button
              className="icon-button"
              onClick={onSettings}
              aria-label="About Scout"
            >
              <CircleHelp size={18} />
            </button>
          )}
        </div>
      </header>
      <div className="workspace">
        {messages.length === 0 ? (
          <div className="empty-workspace">
            <div className="welcome">
              <div className="welcome-symbol">
                <Mark size={30} />
                <span>A world of answers, a question away.</span>
              </div>
              <h1>
                Follow your curiosity.
                <br />
                <span>Find your next answer.</span>
              </h1>
              <p className="welcome-subtitle">
                Ask a question. Explore the web. See the sources.
              </p>
              {composer}
              <div className="suggestion-grid">
                {SUGGESTIONS.map((s) => (
                  <button
                    className="suggestion"
                    key={s.text}
                    onClick={() => void submit(s.text)}
                  >
                    {s.icon === "globe" ? (
                      <Globe2 size={20} />
                    ) : s.icon === "compare" ? (
                      <GitCompareArrows size={20} />
                    ) : (
                      <BookOpen size={20} />
                    )}
                    <span className="suggestion-title">{s.label}</span>
                    <span className="suggestion-category">{s.category}</span>
                  </button>
                ))}
              </div>
              {(preview || config.demo) && (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                  <button
                    className="try-demo"
                    onClick={() => void submit(DEMO_QUESTION)}
                  >
                    <Sparkles size={13} />
                    Try a sample research question
                    <ArrowUpRight size={13} />
                  </button>
                  <button
                    className="try-demo"
                    onClick={() => void submit("Show me a photo source card")}
                  >
                    <BookOpen size={13} />
                    Preview an image source card
                    <ArrowUpRight size={13} />
                  </button>
                </div>
              )}
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
                      <div className="assistant-heading">
                        <Mark size={25} />
                        <span>Scout</span>
                        {(research?.demo || message.metadata?.demo) && (
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            Sample answer
                          </span>
                        )}
                      </div>
                      {research && (
                        <ResearchActivity
                          data={research}
                          active={busy && isLast}
                          onOpen={() => openSources(research.sources)}
                        />
                      )}{" "}
                      {!!research?.sources.length && (
                        <>
                          <div className={`source-cards ${research.sources.some((s) => s.image) ? "has-images" : ""}`}>
                            {research.sources.slice(0, 3).map((s, i) => (
                              <a
                                className="source-card"
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
                          <Sources>
                            <SourcesTrigger
                              count={research.sources.length}
                              className="text-[13px]"
                            />
                            <SourcesContent>
                              {research.sources.map((s, i) => (
                                <Source
                                  key={s.url}
                                  href={safeSourceUrl(s.url)}
                                  title={`${i + 1}. ${s.title}`}
                                />
                              ))}
                            </SourcesContent>
                          </Sources>
                        </>
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
                    {preview || config.demo
                      ? "Opening a sample answer…"
                      : webEnabled
                        ? "Starting your research…"
                        : "Thinking…"}
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
          </>
        )}
        <div className="footer-note">
          {preview || config.demo
            ? "Sample mode · Example answers and source links. Turn Sample off for live chat."
            : config.searchConnected
              ? "Scout can make mistakes. Check the sources that matter."
              : "Live chat is connected. Web research is waiting for a browser key."}
        </div>
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
  onOpen,
}: {
  data: ResearchData;
  active: boolean;
  onOpen: () => void;
}) {
  const incomplete = !active && data.phase !== "complete";
  const label = incomplete
    ? "Research stopped"
    : data.demo
      ? data.phase === "complete"
        ? "Sample research complete"
        : "Exploring the sample research"
      : incomplete
        ? "Research interrupted"
        : data.phase === "searching"
          ? "Searching the web"
          : data.phase === "reading"
            ? "Reading relevant pages"
            : data.phase === "writing"
              ? "Putting the answer together"
              : "Research complete";
  return (
    <div className="agent-activity">
      <button
        type="button"
        className="progress-strip w-full text-left"
        onClick={onOpen}
        aria-label="View research sources"
      >
        {active ? (
          <LoaderCircle size={17} className="spin shrink-0" />
        ) : incomplete ? (
          <Square size={16} />
        ) : (
          <Check size={17} className="shrink-0" />
        )}
        <span>
          {label}
          <small>
            {data.sources.length
              ? `${data.sources.length} ${data.sources.length === 1 ? "source" : "sources"}${data.engine ? ` · ${data.engine === "browser_use" ? "Browser Use Cloud" : data.engine === "kernel" ? "Kernel" : "Search API"}` : ""}`
              : data.engine === "browser_use" ? "Browser Use Cloud is navigating"
                : data.engine === "kernel" ? "Kernel is reading pages"
                : data.queries[0] || "Finding relevant sources"}
            {data.warning ? ` · ${data.warning}` : ""}
          </small>
        </span>
        <ChevronRight size={16} className="trailing shrink-0" />
      </button>
      {!!data.steps?.length && (
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
