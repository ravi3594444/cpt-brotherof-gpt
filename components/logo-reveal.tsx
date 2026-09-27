"use client";
import { useEffect, useRef, useState } from "react";

// Lucide's "earth" icon (Scout's Globe2 mark, ISC license), drawn one stroke at a time.
const STROKES = [
  "M21.54 15H17a2 2 0 0 0-2 2v4.54",
  "M7 3.34V5a3 3 0 0 0 3 3a2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17",
  "M11 21.95V18a2 2 0 0 0-2-2a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05",
];
const WORD = "scout";
// Matches the CSS timeline: the fade-out ends at 1.65 s.
const INTRO_MS = 1700;
const SKIP_MS = 180;

/**
 * The logo reveal shown once per app load. CSS plays it from the first paint,
 * even before the app hydrates; this component adds tap- or key-to-skip and
 * removes it when done. It never shows when the device asks for reduced motion.
 */
export function LogoReveal() {
  const [phase, setPhase] = useState<"playing" | "leaving" | "gone">("playing");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(() => setPhase("gone"), reduced ? 0 : INTRO_MS);
    ref.current?.setAttribute("data-skippable", "");
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (phase === "leaving") {
      const timer = setTimeout(() => setPhase("gone"), SKIP_MS);
      return () => clearTimeout(timer);
    }
    if (phase === "playing") {
      const skip = () => setPhase("leaving");
      window.addEventListener("keydown", skip);
      return () => window.removeEventListener("keydown", skip);
    }
  }, [phase]);
  if (phase === "gone") return null;
  return (
    <div
      ref={ref}
      className={`logo-reveal${phase === "leaving" ? " leaving" : ""}`}
      aria-hidden="true"
      onPointerDown={() => setPhase("leaving")}
    >
      <div className="logo-reveal-glow" />
      <div className="logo-reveal-mark">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <circle className="logo-stroke" cx="12" cy="12" r="10" pathLength={1} />
          {STROKES.map((d, i) => (
            <path key={d} className="logo-stroke" d={d} pathLength={1} style={{ animationDelay: `${0.28 + i * 0.1}s` }} />
          ))}
        </svg>
        <span className="logo-word">
          {[...WORD].map((letter, i) => (
            <span key={i} style={{ animationDelay: `${0.45 + i * 0.06}s` }}>{letter}</span>
          ))}
          <span className="logo-dot">.</span>
        </span>
      </div>
    </div>
  );
}
