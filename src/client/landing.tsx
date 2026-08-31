/**
 * The landing surface — the page a first-time, signed-out visitor lands on.
 *
 * The direction contract for this surface is the HTML comment at the top of
 * index.html's <body>. The short version: this product's whole idea is that
 * many people talk at once into one agent's single conversation, and that any
 * write the agent wants goes to the room first. Claims about that are cheap,
 * so this page doesn't make them — each chapter runs the mechanism instead.
 * The demo rooms are synthetic and say so on their own chrome; every product
 * fact here comes from PRODUCT.md.
 *
 * Everything renders in a complete, readable state before any motion runs, so
 * a visitor with `prefers-reduced-motion`, a dead canvas, or JS mid-boot still
 * gets the whole page.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { ThemeToggle, type ThemeMode } from "./components";
import "./landing.css";

/* ------------------------------------------------------------------ hooks */

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** True once the element has been on screen. Entrances don't rewind. */
function useInView<T extends Element>(margin = "-12% 0px -12% 0px") {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver !== "function") {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setSeen(true);
            observer.disconnect();
          }
        }
      },
      { rootMargin: margin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [margin]);
  return [ref, seen] as const;
}

/**
 * Milliseconds elapsed since `active` went true, capped at `duration`.
 *
 * Reduced motion lands on the final frame immediately: the demos are content,
 * so the end state has to be reachable without the animation.
 */
function useTimeline(
  active: boolean,
  duration: number,
  reduced: boolean,
  nonce = 0,
): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!active) return;
    setT(0);
    if (reduced) {
      setT(duration);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const step = () => {
      const elapsed = performance.now() - start;
      setT(Math.min(elapsed, duration));
      if (elapsed < duration) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // `nonce` is the replay: bumping it restarts the run from zero.
  }, [active, duration, reduced, nonce]);
  return t;
}

/** Reveals a text string as if typed, from a timeline position. */
function typed(text: string, t: number, start: number, cps = 30): string {
  if (t <= start) return "";
  return text.slice(0, Math.floor(((t - start) / 1000) * cps));
}

/* ------------------------------------------------------------------ icons */

/* One icon language: 16px box, 1.5 stroke, round joins, currentColor. */
function Icon({ path, size = 16 }: { path: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {path}
    </svg>
  );
}

const IconCheck = () => <Icon path={<path d="M3 8.5 6.4 12 13 4.5" />} />;
const IconDeny = () => <Icon path={<path d="M4 4l8 8M12 4l-8 8" />} />;
const IconFolder = () => (
  <Icon
    path={
      <>
        <path d="M1.75 4.25a1 1 0 0 1 1-1h2.9l1.3 1.6h5.3a1 1 0 0 1 1 1v6.9a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1z" />
      </>
    }
  />
);
const IconBranch = () => (
  <Icon
    path={
      <>
        <circle cx="4.25" cy="3.5" r="1.75" />
        <circle cx="4.25" cy="12.5" r="1.75" />
        <circle cx="11.75" cy="6" r="1.75" />
        <path d="M4.25 5.25v5.5M11.75 7.75c0 2.1-1.7 3-3.4 3.2-1.3.2-2.4.4-3 1" />
      </>
    }
  />
);
const IconFile = () => (
  <Icon
    path={
      <>
        <path d="M9 1.75H4.25a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V5.5z" />
        <path d="M9 1.75V5.5h3.75" />
      </>
    }
  />
);
const IconClock = () => (
  <Icon
    path={
      <>
        <circle cx="8" cy="8" r="6.25" />
        <path d="M8 4.5V8l2.4 1.6" />
      </>
    }
  />
);

/* --------------------------------------------------------- hero canvas */

type Strand = {
  y0: number;
  bend: number;
  speed: number;
  phase: number;
  weight: number;
};

/**
 * The one authored motion moment: many inputs entering from the left, bending
 * toward a single point, and leaving as one channel. It is the product's
 * thesis drawn rather than stated, and the page's spine thread continues it.
 */
function HeroCanvas({ reduced }: { reduced: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let raf = 0;
    let visible = true;
    const pointer = { x: -1, y: -1, active: false };

    const strands: Strand[] = Array.from({ length: 26 }, (_, i) => ({
      y0: (i + 0.5) / 26,
      bend: 0.28 + ((i * 37) % 100) / 320,
      speed: 0.055 + ((i * 53) % 100) / 2600,
      phase: ((i * 71) % 100) / 100,
      weight: 0.35 + ((i * 29) % 100) / 190,
    }));

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    /** Convergence point: right of the headline column, vertically centred. */
    const focus = () => ({ x: width * 0.74, y: height * 0.52 });

    /** Position along one strand at s ∈ [0,1]. */
    const at = (strand: Strand, s: number) => {
      const f = focus();
      const startX = -width * 0.08;
      const startY = strand.y0 * height;
      let pull = 0;
      if (pointer.active) {
        const dy = startY - pointer.y;
        const dx = f.x - pointer.x;
        const near = Math.exp(-(dy * dy) / (2 * 150 * 150));
        pull = near * Math.max(-90, Math.min(90, -dx * 0.12));
      }
      const cx = startX + (f.x - startX) * strand.bend;
      const cy = startY + (f.y - startY) * 0.12 + pull;
      if (s <= 1) {
        const u = 1 - s;
        return {
          x: u * u * startX + 2 * u * s * cx + s * s * f.x,
          y: u * u * startY + 2 * u * s * cy + s * s * f.y,
        };
      }
      const over = s - 1;
      return { x: f.x + over * (width * 0.42), y: f.y + over * (height * 0.02) };
    };

    const drawStrand = (strand: Strand, alpha: number) => {
      ctx.beginPath();
      for (let s = 0; s <= 1.35; s += 0.045) {
        const p = at(strand, s);
        if (s === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = `rgba(122, 176, 240, ${alpha})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    };

    const frame = (time: number) => {
      ctx.clearRect(0, 0, width, height);
      const t = time / 1000;

      for (const strand of strands) drawStrand(strand, 0.075);

      // The channel every strand resolves into.
      const f = focus();
      ctx.beginPath();
      ctx.moveTo(f.x, f.y);
      ctx.lineTo(width * 1.2, f.y + height * 0.01);
      ctx.strokeStyle = "rgba(122, 176, 240, 0.22)";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      for (const strand of strands) {
        for (let k = 0; k < 2; k += 1) {
          const s =
            ((t * strand.speed + strand.phase + k * 0.5) % 1.35) * 1.0;
          const head = at(strand, s);
          const tail = at(strand, Math.max(0, s - 0.075));
          const fade =
            s < 0.06 ? s / 0.06 : s > 1.2 ? Math.max(0, (1.35 - s) / 0.15) : 1;
          const gradient = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
          gradient.addColorStop(0, "rgba(90, 167, 255, 0)");
          gradient.addColorStop(1, `rgba(150, 205, 255, ${0.85 * fade})`);
          ctx.beginPath();
          ctx.moveTo(tail.x, tail.y);
          ctx.lineTo(head.x, head.y);
          ctx.strokeStyle = gradient;
          ctx.lineWidth = strand.weight * (s > 1 ? 2.1 : 1.35);
          ctx.stroke();
        }
      }

      // The convergence itself, so the eye knows where the strands are going.
      ctx.beginPath();
      ctx.arc(f.x, f.y, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(178, 219, 255, 0.9)";
      ctx.fill();

      if (visible) raf = requestAnimationFrame(frame);
    };

    const still = () => {
      ctx.clearRect(0, 0, width, height);
      for (const strand of strands) drawStrand(strand, 0.16);
      const f = focus();
      ctx.beginPath();
      ctx.arc(f.x, f.y, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(178, 219, 255, 0.9)";
      ctx.fill();
    };

    const start = () => {
      if (reduced) {
        still();
        return;
      }
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    };

    resize();
    start();

    const onResize = () => {
      resize();
      if (reduced) still();
    };
    const onPointer = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      pointer.active = true;
    };
    const onLeave = () => {
      pointer.active = false;
    };

    // Nothing renders while the hero is off screen or the tab is hidden.
    const observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver((entries) => {
            visible = entries.some((entry) => entry.isIntersecting);
            if (visible) start();
            else cancelAnimationFrame(raf);
          })
        : null;
    observer?.observe(canvas);

    const onVisibility = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else if (visible) start();
    };

    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onPointer);
    window.addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reduced]);

  return <canvas className="lp-hero-canvas" ref={ref} aria-hidden="true" />;
}

/* ---------------------------------------------------------------- spine */

/** The hero's convergence, continued as one thread down the page. */
function Spine() {
  const fill = useRef<HTMLDivElement | null>(null);
  const head = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let raf = 0;
    let queued = false;
    const paint = () => {
      queued = false;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const progress = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      const px = progress * window.innerHeight;
      if (fill.current) fill.current.style.height = `${px}px`;
      if (head.current) {
        head.current.style.top = `${px}px`;
        head.current.style.opacity = progress > 0.01 ? "1" : "0";
      }
    };
    const onScroll = () => {
      if (queued) return;
      queued = true;
      raf = requestAnimationFrame(paint);
    };
    paint();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <div className="lp-spine" aria-hidden="true">
      <div className="lp-spine-fill" ref={fill} />
      <div className="lp-spine-head" ref={head} style={{ opacity: 0 }} />
    </div>
  );
}

/* -------------------------------------------------------- shared pieces */

function Reveal({
  children,
  delay,
  className,
}: {
  children: ReactNode;
  delay?: 1 | 2;
  className?: string;
}) {
  const [ref, seen] = useInView<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={`lp-reveal${className ? ` ${className}` : ""}`}
      data-in={seen}
      data-delay={delay}
    >
      {children}
    </div>
  );
}

function DemoPanel({
  label,
  right,
  children,
  className,
}: {
  label: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`lp-panel${className ? ` ${className}` : ""}`}>
      <div className="lp-panel-bar">
        <span className="lp-panel-label">
          {label}
          {/* Nothing on this page is a real room. PRODUCT.md records no
              evidence on hand, so every demo carries the marker rather than
              only the two that happen to show people. */}
          <span className="lp-synthetic">Illustration</span>
        </span>
        {right}
      </div>
      {children}
    </div>
  );
}

/* --------------------------------------------------- chapter 1: the merge */

const MERGE_LINES = [
  { who: "Ana", at: 0, text: "can we move the auth check into the middleware?" },
  { who: "Ravi", at: 500, text: "and drop the duplicate one in the handler" },
  { who: "Mia", at: 1100, text: "keep the 401 body identical though" },
];

const MERGE_REPLY =
  "One change, then. I'll lift the check into requireSession, delete the copy in the route handler, and leave the 401 body byte-for-byte the same.";

const FOLD_AT = 3200;
const TURN_AT = 3600;
const REPLY_AT = 5000;
const MERGE_END = 9200;

function ChapterMerge() {
  const reduced = useReducedMotion();
  const [ref, seen] = useInView<HTMLDivElement>("-20% 0px -20% 0px");
  const [run, setRun] = useState(0);
  // Replay restarts the clock; the key remounts the subtree so every CSS
  // transition in it runs again from its own start state.
  const t = useTimeline(seen, MERGE_END, reduced, run);
  const folded = t >= FOLD_AT;

  return (
    <div ref={ref}>
      <DemoPanel
        label="Sample room"
        right={
          <span className="lp-presence">
            <span className="lp-presence-dot" />3 here
          </span>
        }
      >
        <p className="lp-sr">
          Ana, Ravi and Mia each send a line at the same time. The three lines
          arrive as one turn, tagged with each speaker's name, and the agent
          answers the room once.
        </p>
        <div className="lp-merge" key={run} aria-hidden="true">
          <div className="lp-typers" data-folded={folded}>
            {MERGE_LINES.map((line) => {
              const shown = typed(line.text, t, line.at, 34);
              return (
                <div className="lp-typer" key={line.who} data-folded={folded}>
                  <span className="lp-typer-name">{line.who}</span>
                  <span className="lp-typer-text">
                    {shown}
                    {!folded && shown.length < line.text.length && t > line.at && (
                      <i className="lp-caret" />
                    )}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="lp-merge-join">
            <svg viewBox="0 0 52 200" preserveAspectRatio="none">
              {[38, 100, 162].map((y, i) => (
                <path
                  key={y}
                  d={`M0 ${y} C 26 ${y}, 26 100, 52 100`}
                  fill="none"
                  stroke="var(--line)"
                  strokeWidth="1.5"
                  style={{
                    opacity: folded ? 1 : 0.35,
                    transition: `opacity 400ms ${120 * i}ms ease-out`,
                  }}
                />
              ))}
            </svg>
          </div>

          <div className="lp-turnwrap">
            <div className="lp-turn">
              {MERGE_LINES.map((line, i) => (
                <span
                  className="lp-turn-line"
                  key={line.who}
                  style={{
                    opacity: t >= TURN_AT + i * 220 ? 1 : 0,
                    transition: "opacity 420ms ease-out",
                  }}
                >
                  <span className="lp-turn-tag">[{line.who}]:</span> {line.text}
                </span>
              ))}
            </div>
            <div className="lp-reply">
              <span className="lp-reply-who">Agent</span>
              <span className="lp-reply-text">
                {t < REPLY_AT ? (
                  t > TURN_AT + 900 ? (
                    <i className="lp-dots" />
                  ) : null
                ) : (
                  typed(MERGE_REPLY, t, REPLY_AT, 44)
                )}
              </span>
            </div>
          </div>
        </div>
        <div className="lp-panel-bar lp-panel-foot">
          <span>Three messages · one turn</span>
          <button
            type="button"
            className="lp-linkbtn"
            onClick={() => setRun((n) => n + 1)}
          >
            Replay
          </button>
        </div>
      </DemoPanel>
    </div>
  );
}

/* --------------------------------------------------- chapter 2: the vote */

type VoteKind = "approve" | "deny";

function ChapterVote() {
  const [mine, setMine] = useState<VoteKind | null>(null);
  const [others, setOthers] = useState<VoteKind[]>([]);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      for (const id of timers.current) clearTimeout(id);
    },
    [],
  );

  const cast = (kind: VoteKind) => {
    if (mine) return;
    setMine(kind);
    // Ana agrees, Ravi doesn't: the visitor's own vote is what decides it.
    timers.current.push(
      window.setTimeout(() => setOthers([kind]), 800),
      window.setTimeout(
        () => setOthers([kind, kind === "approve" ? "deny" : "approve"]),
        1600,
      ),
    );
  };

  const reset = () => {
    for (const id of timers.current) clearTimeout(id);
    timers.current = [];
    setMine(null);
    setOthers([]);
  };

  const all = mine ? [mine, ...others] : [];
  const approve = all.filter((v) => v === "approve").length;
  const deny = all.filter((v) => v === "deny").length;
  const settled = all.length === 3;
  const state = settled ? (approve > deny ? "applied" : "denied") : "open";

  const outcomeText = settled
    ? approve > deny
      ? "Approved 2–1 · the write went through"
      : "Denied 2–1 · nothing was written"
    : mine
      ? "Waiting on the room"
      : "Open · needs a majority";

  return (
    <DemoPanel
      label="Sample room"
      right={<span className="lp-presence">3 members · majority</span>}
    >
      <div className="lp-approval">
        <div className="lp-approval-top">
          <span className="lp-approval-tool">write_file</span>
          <span className="lp-approval-sub">src/server/auth.ts · 2 lines</span>
        </div>
        <div className="lp-diff" data-state={state}>
          <div className="lp-diff-row lp-diff-old">
            <span className="lp-diff-sign">−</span>
            <pre>if (!req.session) return json(401, {`{ error: "no session" }`});</pre>
          </div>
          <div className="lp-diff-row lp-diff-new">
            <span className="lp-diff-sign">+</span>
            <pre>await requireSession(req); // 401 body unchanged</pre>
          </div>
        </div>
        <div className="lp-votebar">
          <button
            type="button"
            className="lp-vote"
            data-kind="approve"
            data-cast={mine === "approve"}
            data-muted={mine !== null && mine !== "approve"}
            aria-disabled={mine !== null}
            onClick={() => cast("approve")}
          >
            <IconCheck />
            Approve
            <span className="lp-vote-count" data-num>
              {approve}
            </span>
          </button>
          <button
            type="button"
            className="lp-vote"
            data-kind="deny"
            data-cast={mine === "deny"}
            data-muted={mine !== null && mine !== "deny"}
            aria-disabled={mine !== null}
            onClick={() => cast("deny")}
          >
            <IconDeny />
            Deny
            <span className="lp-vote-count" data-num>
              {deny}
            </span>
          </button>
          <span className="lp-vote-spacer" />
          <span className="lp-outcome" data-state={state} role="status">
            <span className="lp-outcome-pip" />
            {outcomeText}
          </span>
        </div>
        {settled && (
          <button type="button" className="lp-linkbtn" onClick={reset}>
            Vote again
          </button>
        )}
      </div>
    </DemoPanel>
  );
}

/* -------------------------------------------- chapter 3: the durable turn */

const TURN_NODES = [
  { time: "14:02", label: "The agent proposes the write.", quiet: false },
  { time: "14:03", label: "Two votes land. One short.", quiet: false },
  { time: "—", label: "Everyone goes to lunch. The room hibernates.", quiet: true },
  { time: "16:41", label: "Mia opens the link and approves.", quiet: false },
  { time: "16:41", label: "The same turn resumes and finishes.", quiet: false },
];

function ChapterDurable() {
  const ref = useRef<HTMLDivElement | null>(null);
  const reduced = useReducedMotion();
  const [progress, setProgress] = useState(reduced ? 1 : 0);

  useEffect(() => {
    if (reduced) {
      setProgress(1);
      return;
    }
    let queued = false;
    let raf = 0;
    const paint = () => {
      queued = false;
      const node = ref.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const span = rect.height * 0.55 + window.innerHeight * 0.25;
      const travelled = window.innerHeight * 0.82 - rect.top;
      setProgress(Math.min(1, Math.max(0, travelled / span)));
    };
    const onScroll = () => {
      if (queued) return;
      queued = true;
      raf = requestAnimationFrame(paint);
    };
    paint();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [reduced]);

  const lit = Math.round(progress * TURN_NODES.length);

  return (
    <div ref={ref}>
      <DemoPanel
        label="One turn · four hours"
        right={
          <span className="lp-presence">
            <IconClock />
            persisted state
          </span>
        }
      >
        <div className="lp-timeline">
          <div className="lp-track">
            <div
              className="lp-track-fill"
              style={{ width: `${Math.min(100, progress * 100)}%` }}
            />
          </div>
          <ol className="lp-nodes">
            {TURN_NODES.map((node, i) => (
              <li
                className="lp-node"
                key={node.label}
                data-lit={i < lit}
                data-quiet={node.quiet}
              >
                <span className="lp-node-dot" />
                <span className="lp-node-time" data-num>
                  {node.time}
                </span>
                <span className="lp-node-label">{node.label}</span>
              </li>
            ))}
          </ol>
        </div>
      </DemoPanel>
    </div>
  );
}

/* ---------------------------------------------- chapter 4: the workspace */

const LOCAL_FILES = [
  { name: "auth.ts", path: "src/server/", tag: "edit" },
  { name: "session.test.ts", path: "test/", tag: "new" },
  { name: "middleware.ts", path: "src/server/", tag: null },
  { name: "README.md", path: "", tag: null },
];

function ChapterWorkspace() {
  const [kind, setKind] = useState<"local" | "github">("local");

  const swap = (next: "local" | "github") => {
    if (next === kind) return;
    const run = () => setKind(next);
    // Morphs the panel between the two providers where supported; a plain
    // state swap everywhere else.
    const start = (document as Document & {
      startViewTransition?: (cb: () => void) => void;
    }).startViewTransition;
    if (typeof start !== "function") {
      run();
      return;
    }
    // A second click while a transition is still settling rejects rather than
    // queueing; the swap itself has already happened, so absorb it.
    const transition = start.call(document, run) as
      | { finished?: Promise<unknown> }
      | undefined;
    void transition?.finished?.catch(() => {});
  };

  return (
    <div className="lp-chapter-demo">
      <div className="lp-seg" role="group" aria-label="Workspace provider">
        <button
          type="button"
          className="lp-seg-btn"
          aria-pressed={kind === "local"}
          onClick={() => swap("local")}
        >
          <IconFolder />
          Local folder
        </button>
        <button
          type="button"
          className="lp-seg-btn"
          aria-pressed={kind === "github"}
          onClick={() => swap("github")}
        >
          <IconBranch />
          GitHub
        </button>
      </div>

      <DemoPanel
        label={kind === "local" ? "Relayed from one member's machine" : "Connected repository"}
        right={
          <span className="lp-presence">
            <span className="lp-presence-dot" />
            {kind === "local" ? "host online" : "app installed"}
          </span>
        }
      >
        <div className="lp-ws">
          {kind === "github" && (
            <div className="lp-ws-head">
              <span className="lp-ws-branch">
                <IconBranch />
                collab/auth-middleware
              </span>
              <span>opened as a pull request</span>
            </div>
          )}
          {LOCAL_FILES.map((file) => (
            <div className="lp-ws-row" key={file.name}>
              <IconFile />
              <span>
                <span className="lp-ws-path">{file.path}</span>
                {file.name}
              </span>
              {file.tag && (
                <span className="lp-ws-tag" data-kind={file.tag}>
                  {file.tag === "new" ? "added" : "edited"}
                </span>
              )}
            </div>
          ))}
        </div>
      </DemoPanel>
    </div>
  );
}

/* ------------------------------------------- chapter 5: the room's settings */

const ANNOUNCEMENTS = [
  { time: "09:14", who: "Ana", what: "set the model to Opus 5" },
  { time: "09:15", who: "Ravi", what: "changed writes from auto-accept to a vote" },
  { time: "11:02", who: "Mia", what: "switched the workflow to Manager + workers" },
];

function ChapterRoom() {
  const [ref, seen] = useInView<HTMLDivElement>();
  return (
    <div className="lp-instrument" ref={ref}>
      <DemoPanel label="In the transcript, not in a settings drawer">
        <div className="lp-announce">
          {ANNOUNCEMENTS.map((line, i) => (
            <p
              className="lp-announce-line"
              key={line.what}
              data-in={seen}
              style={{ transitionDelay: `${i * 130}ms` }}
            >
              <span className="lp-announce-time" data-num>
                {line.time}
              </span>
              <span>
                <strong>{line.who}</strong> {line.what}
              </span>
            </p>
          ))}
        </div>
      </DemoPanel>
      <DemoPanel label="Room spend">
        <div className="lp-gaugewrap">
          <div className="lp-gauge-row">
            <span className="lp-gauge-value" data-num>
              41%
            </span>
            <span className="lp-gauge-cap">of today's room budget</span>
          </div>
          <div className="lp-gauge-track">
            <div
              className="lp-gauge-fill"
              style={{ transform: `scaleX(${seen ? 0.41 : 0})` }}
            />
          </div>
          <p className="lp-note">
            Tokens are the real bill, so the room watches them together in the
            header — not one person discovering the number later.
          </p>
        </div>
      </DemoPanel>
    </div>
  );
}

/* ----------------------------------------------------------------- page */

const PROVIDER_TEXT: Record<string, string> = {
  github: "Continue with GitHub",
  google: "Continue with Google",
};

/**
 * The apex page's ending: one field, posted to /api/waitlist.
 *
 * A repeat address is a success, not an error — the Worker treats a second
 * signup as a no-op — so there is no state here for "already on the list". The
 * confirmation does not repeat the address back: printing it leaves someone's
 * email sitting on a screen that may not be theirs alone, and it tells them
 * nothing they did not just type.
 */
function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [joined, setJoined] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const address = email.trim();
      if (!address || sending) return;
      setSending(true);
      setProblem(null);
      try {
        const res = await fetch("/api/waitlist", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: address }),
        });
        if (!res.ok) {
          setProblem(
            res.status === 400
              ? "That doesn't look like an email address."
              : "Couldn't save that just now. Try again in a moment.",
          );
          return;
        }
        setJoined(true);
      } catch {
        setProblem("Couldn't reach the server. Try again in a moment.");
      } finally {
        setSending(false);
      }
    },
    [email, sending],
  );

  if (joined) {
    return (
      <p className="lp-close-done" role="status">
        <span className="lp-close-done-pip" aria-hidden="true" />
        <span>You're on the list. We'll email you when Huddle.AI opens.</span>
      </p>
    );
  }

  return (
    <>
      <form className="lp-close-form" onSubmit={submit}>
        <input
          type="email"
          value={email}
          maxLength={254}
          required
          autoComplete="email"
          inputMode="email"
          placeholder="you@work.com"
          aria-label="Email address"
          onChange={(e) => setEmail(e.target.value)}
        />
        <button
          type="submit"
          className="lp-btn lp-btn--primary"
          disabled={!email.trim() || sending}
        >
          {sending ? "Joining…" : "Join the waitlist"}
        </button>
      </form>
      {problem && (
        <p className="lp-close-error" role="alert">
          {problem}
        </p>
      )}
    </>
  );
}

/**
 * How the page ends. The argument above the fold is the same on both
 * hostnames — it is the same product either way — so the two differ only in
 * what they ask for at the bottom: app.huddleai.org asks for a room, and
 * huddleai.org, which nobody can sign into yet, asks for an email.
 */
export type LandingCta =
  | {
      kind: "app";
      providers: string[];
      onSignIn: (provider: string) => void;
      onCreate: (name: string) => void;
      initialName: string;
      busy: boolean;
      problem: string | null;
    }
  | { kind: "waitlist" };

export function LandingPage({
  cta,
  theme,
  onToggleTheme,
}: {
  cta: LandingCta;
  theme: ThemeMode;
  onToggleTheme: () => void;
}) {
  const reduced = useReducedMotion();
  const [name, setName] = useState(cta.kind === "app" ? cta.initialName : "");
  const [lifted, setLifted] = useState(false);
  const usable = useMemo(
    () => (cta.kind === "app" ? cta.providers.filter((p) => p in PROVIDER_TEXT) : []),
    [cta],
  );
  const needsSignIn = usable.length > 0;
  // The one label that has to agree in three places: the nav, the hero button
  // and the promise the close section then keeps.
  const actionText =
    cta.kind === "waitlist"
      ? "Join the waitlist"
      : needsSignIn
        ? "Sign in and open a room"
        : "Create a room";

  useEffect(() => {
    const onScroll = () => setLifted(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const toStart = useCallback(() => {
    document.getElementById("start")?.scrollIntoView({
      behavior: reduced ? "auto" : "smooth",
      block: "start",
    });
  }, [reduced]);

  return (
    <div className="lp">
      <Spine />

      <nav className="lp-nav" data-lifted={lifted}>
        <div className="lp-nav-inner">
          <span className="lp-nav-mark">
            <img src="/collab-logo.svg" alt="" width={28} height={28} />
            <span className="lp-nav-name">Huddle.AI</span>
          </span>
          <span className="lp-nav-actions">
            <ThemeToggle theme={theme} onToggle={onToggleTheme} />
            <button type="button" className="lp-btn lp-btn--small" onClick={toStart}>
              {cta.kind === "waitlist"
                ? "Join the waitlist"
                : needsSignIn
                  ? "Sign in"
                  : "Create a room"}
            </button>
          </span>
        </div>
      </nav>

      <header className="lp-hero">
        <HeroCanvas reduced={reduced} />
        <div className="lp-hero-inner">
          <h1 className="lp-h1">
            <span className="lp-h1-quiet">One agent.</span>
            Shared by the whole room.
          </h1>
          <p className="lp-lead">
            Several people, one conversation, one history. When the agent wants
            to change a file, it asks the room first.
          </p>
          <div className="lp-hero-actions">
            <button
              type="button"
              className="lp-btn lp-btn--primary"
              onClick={toStart}
            >
              {actionText}
            </button>
            <a className="lp-btn lp-btn--ghost" href="#merge">
              See how a turn works
            </a>
          </div>
          <p className="lp-hero-meta">
            <span className="lp-hero-pip" />
            Everyone talks at once · nothing is dropped · writes go to a vote
          </p>
        </div>
        <span className="lp-cue">
          <span className="lp-cue-rail" />
          Scroll
        </span>
      </header>

      <main>
        <section className="lp-act" id="merge">
          <div className="lp-inner lp-chapter">
            <Reveal className="lp-chapter-head">
              <h2 className="lp-h2">Three people typed at once. The agent got one message.</h2>
              <p className="lp-body">
                Every line is tagged with who said it and folded into a single
                turn. Anything sent while the agent is working queues up and
                joins the next one — no turn is split down the middle, and
                nothing anyone says is quietly discarded.
              </p>
            </Reveal>
            <Reveal delay={1}>
              <ChapterMerge />
            </Reveal>
          </div>
        </section>

        <section className="lp-act lp-act--stage">
          <div className="lp-inner lp-chapter lp-chapter--split">
            <Reveal className="lp-chapter-head">
              <h2 className="lp-h2">A write is a proposal.</h2>
              <p className="lp-body">
                When the agent reaches for a file or the shared document, the
                call stops and becomes something the room can see and vote on.
                Rooms that would rather move fast can set auto-accept and let
                writes through — but that is a decision the room makes out loud,
                not a default it discovers afterwards.
              </p>
              <p className="lp-note">Cast a vote below. Yours decides it.</p>
            </Reveal>
            <Reveal delay={1}>
              <ChapterVote />
            </Reveal>
          </div>
        </section>

        <section className="lp-act">
          <div className="lp-inner lp-chapter">
            <Reveal className="lp-chapter-head">
              <h2 className="lp-h2">The turn waits. Even if you don't.</h2>
              <p className="lp-body">
                A paused turn isn't a request held open somewhere hoping you
                come back. It's saved state. The room can go quiet for hours,
                the last vote can arrive from someone else's phone, and the same
                turn picks up exactly where it stopped.
              </p>
            </Reveal>
            <Reveal delay={1}>
              <ChapterDurable />
            </Reveal>
          </div>
        </section>

        <section className="lp-act lp-act--tint">
          <div className="lp-inner lp-chapter lp-chapter--split lp-chapter--split-rev">
            <Reveal className="lp-chapter-head">
              <h2 className="lp-h2">Point it at a folder. Or at a repo.</h2>
              <p className="lp-body">
                A room can work against a folder on one member's machine,
                relayed live to everyone else, or against a GitHub repository
                through a connected app — branches, contents, pull requests. The
                voting rule doesn't change with the provider.
              </p>
            </Reveal>
            <Reveal delay={1}>
              <ChapterWorkspace />
            </Reveal>
          </div>
        </section>

        <section className="lp-act">
          <div className="lp-inner lp-chapter">
            <Reveal className="lp-chapter-head">
              <h2 className="lp-h2">Settings belong to the room, not to you.</h2>
              <p className="lp-body">
                The model, the spend policy and the workflow are shared, and
                every change is announced in the transcript with the name of
                whoever made it. Changes only land while the agent is idle, so
                nobody moves the floor mid-turn.
              </p>
            </Reveal>
            <Reveal delay={1}>
              <ChapterRoom />
            </Reveal>
          </div>
        </section>

        <section className="lp-act lp-act--stage" id="start">
          {cta.kind === "waitlist" ? (
            <div className="lp-inner lp-close">
              <h2 className="lp-h2 lp-close-h">Not open yet. Get the link when it is.</h2>
              <p className="lp-lead">
                Leave an email and you'll get a link as soon as Huddle.AI opens.
                Nothing else arrives at that address.
              </p>
              <WaitlistForm />
              <p className="lp-note">
                Rooms are private — only the people you send the link to can get
                in. A room nobody is using hibernates until someone comes back.
              </p>
            </div>
          ) : (
          <div className="lp-inner lp-close">
            <h2 className="lp-h2 lp-close-h">Open a room. Send one link.</h2>
            <p className="lp-lead">
              Rooms are private — only the people you send the link to can get
              in. A room nobody is using hibernates until someone comes back.
            </p>

            {needsSignIn ? (
              <div className="lp-providers">
                {usable.map((provider) => (
                  <button
                    key={provider}
                    type="button"
                    className="lp-btn lp-btn--primary"
                    onClick={() => cta.onSignIn(provider)}
                  >
                    {PROVIDER_TEXT[provider]}
                  </button>
                ))}
              </div>
            ) : (
              <form
                className="lp-close-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  cta.onCreate(name);
                }}
              >
                <input
                  value={name}
                  maxLength={32}
                  placeholder="Your name"
                  aria-label="Your name"
                  onChange={(e) => setName(e.target.value)}
                />
                <button
                  type="submit"
                  className="lp-btn lp-btn--primary"
                  disabled={!name.trim() || cta.busy}
                >
                  {cta.busy ? "Creating…" : "Create a room"}
                </button>
              </form>
            )}
            {cta.problem && <p className="lp-close-error">{cta.problem}</p>}
            <p className="lp-note">
              {needsSignIn
                ? "We only read your name and avatar. Nothing is posted on your behalf."
                : "Your name is how the room tags what you say — every message is attributed, so everyone can see who asked for what."}
            </p>
          </div>
          )}
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-foot-inner">
          <img src="/collab-logo.svg" alt="" width={20} height={20} />
          <span>Rooms, transcripts and votes live in one durable object per room.</span>
          <span className="lp-foot-spacer" />
          <a href="https://github.com/yjm7vj/collab_ai">Source on GitHub</a>
        </div>
      </footer>
    </div>
  );
}
