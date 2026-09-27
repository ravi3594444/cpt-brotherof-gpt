"use client";
import { useEffect, useId, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useStickToBottomContext } from "use-stick-to-bottom";

/** "8 s", or "2 min 5 s" from a minute on. */
export function formatSeconds(seconds: number) {
  const s = Math.floor(seconds);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
}

/** Seconds since this appeared, counted on from `from` milliseconds, once at least `after` seconds. */
export function Elapsed({ from = 0, after = 1, className }: { from?: number; after?: number; className?: string }) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => setMs(Date.now() - start), 250);
    return () => clearInterval(timer);
  }, []);
  const seconds = (from + ms) / 1000;
  return seconds >= after ? <span className={className}>{formatSeconds(seconds)}</span> : null;
}

/** Inside a Conversation: a new question brings it back to following the answer, even after a row opened. */
export function FollowNewQuestion({ asked }: { asked: boolean }) {
  const { scrollToBottom } = useStickToBottomContext();
  useEffect(() => {
    if (asked) void scrollToBottom();
  }, [asked, scrollToBottom]);
  return null;
}

/**
 * The Answer model's Thinking as one row: "Thinking…" with a live count while it thinks, then
 * "Thought for N s". A tap shows the thoughts as plain text. For use inside a Conversation.
 */
export function Thinking({
  text,
  thinking,
  stopped,
  ms,
  thoughts,
}: {
  text: string;
  /** A thought is streaming now. */
  thinking: boolean;
  /** The answer ended while a thought was unfinished. */
  stopped: boolean;
  /** How long the finished thoughts took. */
  ms?: number;
  /** How many thoughts there are, so the live count restarts from `ms` with each new one. */
  thoughts: number;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { stopScroll } = useStickToBottomContext();
  const box = useRef<HTMLDivElement>(null);
  // While a thought streams, the open box shows its newest line until the reader scrolls up in it.
  const follow = useRef(true);
  useEffect(() => {
    if (open && thinking && follow.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [open, thinking, text]);
  const label = thinking
    ? "Thinking…"
    : stopped
      ? "Thinking stopped"
      : ms === undefined
        ? "Thought for a moment"
        : `Thought for ${formatSeconds(Math.max(1, Math.round(ms / 1000)))}`;
  return (
    <div className={`thinking${open ? " open" : ""}`}>
      <button
        type="button"
        className="thinking-line"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          // Opens in place: the conversation stops following the bottom so the row stays in view,
          // until the next question.
          if (!open) {
            stopScroll();
            follow.current = true;
          }
          setOpen(!open);
        }}
      >
        <span className={`thinking-label${thinking ? " thinking-shimmer" : ""}`}>{label}</span>
        {thinking && <Elapsed key={thoughts} from={ms} className="thinking-time" />}
        <span className="sr-only"> (the AI model&apos;s thinking)</span>
        <ChevronRight size={15} className="trailing shrink-0" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={box}
          id={id}
          className="thinking-text"
          role="region"
          aria-label="The AI model's thinking"
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {text || "…"}
        </div>
      )}
    </div>
  );
}
