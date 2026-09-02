/**
 * The landing surface, the page a first-time, signed-out visitor lands on.
 *
 * The direction contract for this surface is the HTML comment at the top of
 * index.html's <body>. The short version: this product's whole idea is that
 * many people talk at once into one agent's single conversation, and that any
 * write the agent wants goes to the room first. Claims about that are cheap,
 * so this page doesn't make them. Each chapter runs the mechanism instead.
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
  type PointerEvent as ReactPointerEvent,
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
const IconServer = () => (
  <Icon
    path={
      <>
        <rect x="1.9" y="2.4" width="12.2" height="4.6" rx="1.2" />
        <rect x="1.9" y="9" width="12.2" height="4.6" rx="1.2" />
        <path d="M4.4 4.7h.01M4.4 11.3h.01" />
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

/**
 * The line somebody sends after the turn has already started.
 *
 * It is the second half of this chapter's claim and the room's actual
 * behaviour: a message that arrives mid-turn is queued in the room's inbox and
 * drained into the next turn, rather than interrupting the one in flight.
 */
const LATE_LINE = { who: "Ana", text: "also: a test that the 401 body is unchanged" };

const FOLD_AT = 3200;
const TURN_AT = 3600;
const TOOL_AT = 4300;
const REPLY_AT = 5400;
const LATE_AT = 7000;
const MERGE_END = 12000;

function ChapterMerge() {
  const reduced = useReducedMotion();
  const [ref, seen] = useInView<HTMLDivElement>("-20% 0px -20% 0px");
  const [run, setRun] = useState(0);
  // Replay restarts the clock; the key remounts the subtree so every CSS
  // transition in it runs again from its own start state.
  const t = useTimeline(seen, MERGE_END, reduced, run);
  const folded = t >= FOLD_AT;
  const queued = t >= LATE_AT;

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
          reach the agent as one turn, tagged with each speaker&rsquo;s name, and
          the agent answers the room once. A fourth line, sent while the agent is
          still working, waits in the room&rsquo;s inbox and joins the next turn.
        </p>
        <div className="lp-merge" key={run} aria-hidden="true">
          {/* One column, reused rather than emptied: the three lines leave, and
              what arrived while the agent was busy takes their place. The fan
              stays drawn: the queued line is going to merge into a turn the
              same way the three did, so the picture is still true of it. */}
          <div className="lp-mergecol">
            <div className="lp-typers" data-folded={folded}>
              {MERGE_LINES.map((line) => {
                const shown = typed(line.text, t, line.at, 34);
                return (
                  <div className="lp-msg" key={line.who} data-folded={folded}>
                    <span className="lp-msg-who">{line.who}</span>
                    <span className="lp-msg-body">
                      {shown}
                      {!folded && shown.length < line.text.length && t > line.at && (
                        <i className="lp-caret" />
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="lp-inbox" data-in={queued}>
              <span className="lp-inbox-head">
                <IconClock />
                Inbox · 1 waiting
              </span>
              <div className="lp-msg">
                <span className="lp-msg-who">{LATE_LINE.who}</span>
                <span className="lp-msg-body">{LATE_LINE.text}</span>
              </div>
              <p className="lp-inbox-note">
                Sent while the agent was working. It joins the next turn instead
                of splitting this one.
              </p>
            </div>
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
            <span className="lp-turn-cap">One turn, as the agent receives it</span>
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
            <div className="lp-agent">
              <span className="lp-agent-who">Agent</span>
              {t >= TOOL_AT && (
                <span className="lp-tool">
                  <span className="lp-tool-name">Read File</span>
                  <span className="lp-tool-sum">src/server/auth.ts</span>
                  <span
                    className="lp-pip"
                    data-status={t >= REPLY_AT ? "ok" : "running"}
                  />
                  <span className="lp-tool-status">
                    {t >= REPLY_AT ? "Done" : "Running"}
                  </span>
                  {t >= REPLY_AT && <span className="lp-tool-hint">34 Lines</span>}
                </span>
              )}
              <span className="lp-agent-text">
                {t < REPLY_AT ? (
                  t > TURN_AT + 800 ? (
                    <i className="lp-dots" />
                  ) : null
                ) : (
                  typed(MERGE_REPLY, t, REPLY_AT, 46)
                )}
              </span>
            </div>
          </div>
        </div>
        <div className="lp-panel-bar lp-panel-foot">
          <span>Four messages · two turns · none dropped</span>
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

/**
 * The three answers a gate actually takes, named as the room names them.
 *
 * `grant` is an approval that also asks for the same call to stop needing a
 * vote for a while, so it counts toward approval and is counted again on its
 * own. See `Vote` and `tally` in `src/shared/protocol.ts`.
 */
type VoteKind = "approve" | "deny" | "grant";

/**
 * Three voters present, so the bar is two.
 *
 * `thresholdFor` is a strict majority of the voting-eligible people in the
 * room, and approve and deny clear the same bar, which is why the third
 * person here never has to vote at all once two agree. Viewers are left out of
 * the count entirely rather than merely barred from voting.
 */
const VOTERS = 3;
const BAR = 2;

/** The standing approval `grant` asks for, as the room's own header reports it. */
const GRANT_WINDOW_MINUTES = 15;
const GRANT_USES = 10;

function ChapterVote() {
  const [mine, setMine] = useState<VoteKind | null>(null);
  const [second, setSecond] = useState<VoteKind | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const cast = (kind: VoteKind) => {
    if (mine) return;
    setMine(kind);
    // Ravi answers the same way, which takes it to the bar. Mia is still in the
    // room and never votes: two agreeing is the whole decision.
    timer.current = window.setTimeout(() => setSecond(kind), 900);
  };

  const reset = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setMine(null);
    setSecond(null);
  };

  const all = [mine, second].filter((v): v is VoteKind => v !== null);
  const approve = all.filter((v) => v === "approve" || v === "grant").length;
  const deny = all.filter((v) => v === "deny").length;
  const grant = all.filter((v) => v === "grant").length;
  const settled = approve >= BAR || deny >= BAR;
  const state = settled ? (approve >= BAR ? "applied" : "denied") : "open";
  const standing = settled && grant >= BAR;

  const outcomeText = settled
    ? approve >= BAR
      ? `Approved ${approve} of ${BAR} · the edit was applied`
      : `Denied ${deny} of ${BAR} · nothing was written`
    : mine
      ? `Waiting on the room · 1 of ${BAR}`
      : `Open · ${BAR} of ${VOTERS} decides it`;

  return (
    <DemoPanel
      label="Sample room"
      right={<span className="lp-presence">{VOTERS} voters · {BAR} to decide</span>}
    >
      <div className="lp-approval">
        <div className="lp-approval-top">
          <span className="lp-approval-tool">Edit File</span>
          <span className="lp-approval-sub">
            Move the auth check into requireSession
          </span>
        </div>
        <div className="lp-approval-path">
          File: <code>src/server/auth.ts</code>
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
              {approve}/{BAR}
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
              {deny}/{BAR}
            </span>
          </button>
          {/* The third answer, sitting with the other two rather than in a
              menu. It is a vote, and it needs the same two people. */}
          <button
            type="button"
            className="lp-vote"
            data-kind="grant"
            data-cast={mine === "grant"}
            data-muted={mine !== null && mine !== "grant"}
            aria-disabled={mine !== null}
            onClick={() => cast("grant")}
          >
            <IconClock />
            Approve &amp; stop asking
            <span className="lp-vote-count" data-num>
              {grant}/{BAR}
            </span>
          </button>
        </div>
        <div className="lp-outcome-row">
          <span className="lp-outcome" data-state={state} role="status">
            <span className="lp-outcome-pip" />
            {outcomeText}
          </span>
          {settled && (
            <button type="button" className="lp-linkbtn" onClick={reset}>
              Vote again
            </button>
          )}
        </div>
        {standing && (
          <div className="lp-grants" role="status">
            <span className="lp-grants-head">Running without asking</span>
            <span className="lp-grant">
              <span className="lp-grant-tool">edit_file</span>
              <span className="lp-grant-hint" data-num>
                {GRANT_WINDOW_MINUTES} min left · {GRANT_USES} of {GRANT_USES} uses
              </span>
            </span>
            <span className="lp-grant-note">
              It lapses on its own, and anyone in the room can take it back
              before then.
            </span>
          </div>
        )}
      </div>
    </DemoPanel>
  );
}

/* -------------------------------------------- chapter 3: the durable turn */

const TURN_NODES = [
  { time: "14:02", label: "The agent asks to edit auth.ts.", quiet: false },
  { time: "14:03", label: "Ravi approves. One short of the two it needs.", quiet: false },
  { time: "", label: "Everyone goes to lunch. The room hibernates.", quiet: true },
  { time: "16:41", label: "Mia opens the link and approves.", quiet: false },
  { time: "16:41", label: "The same turn resumes and the edit lands.", quiet: false },
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
          {/* The track is made of the nodes' own segments rather than drawn
              once behind them, so the hours nothing happened can be a dashed
              stretch instead of a gap the eye reads as an error. */}
          <ol className="lp-nodes">
            {TURN_NODES.map((node, i) => (
              <li
                className="lp-node"
                key={node.label}
                data-lit={i < lit}
                data-quiet={node.quiet}
              >
                <span className="lp-node-rail">
                  <span className="lp-node-dot" />
                </span>
                <span className="lp-node-time" data-num>
                  {node.time}
                </span>
                <span className="lp-node-label">{node.label}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="lp-panel-bar lp-panel-foot">
          <span>Saved state, not a held-open request</span>
          <span className="lp-presence">resumed in a later invocation</span>
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
        {/* A workspace is one person's disk or one team's repository, so the
            room's transcript being shared does not make its contents shared. */}
        <div className="lp-panel-bar lp-panel-foot">
          <span>Owners and admins see contents</span>
          <span className="lp-presence">editors and viewers see the path</span>
        </div>
      </DemoPanel>
    </div>
  );
}

/* ----------------------------------------- chapter 4b: workflow builder */

/**
 * The room's agent graph, at the size a page can read.
 *
 * One fixed coordinate space holds the whole canvas: positions AND card sizes
 * are in these units, and the container carries the same aspect ratio, so the
 * wires attach to the cards' real edges at every width. Positioning cards in
 * percentages while sizing them in pixels is what left the wires hanging in
 * space, because nothing could work out where a card's right edge was.
 *
 * The chapter runs the room's other way of editing a graph as well: the
 * workflow chat drafts a change from a sentence, so the demo types one and the
 * canvas gains the agent it asked for. The visitor can send their own line
 * instead, which applies the same change rather than pretending to draft a
 * different one.
 */
const WF_CANVAS = { w: 760, h: 392 };
const WF_CARD = { w: 168, h: 120 };

type DemoServer = {
  name: string;
  url: string;
  /** Whose credential the server runs on. Both modes are real. */
  mode: string;
};

type WorkflowCard = {
  id: string;
  title: string;
  model: string;
  /** Fits the card's two lines. */
  brief: string;
  /** The whole brief, for the inspector, which has the room for it. */
  detail: string;
  x: number;
  y: number;
  lead?: boolean;
  /** False until the chat has drafted it onto the canvas. */
  drafted?: boolean;
  servers: DemoServer[];
};

const WORKFLOW_CARDS: WorkflowCard[] = [
  {
    id: "lead",
    title: "Planner",
    model: "Opus 5",
    brief: "Breaks the request into focused tasks.",
    detail:
      "Breaks the request into focused tasks and synthesises what comes back. Weighs the critic's notes before using a finding.",
    x: 16,
    y: 136,
    lead: true,
    servers: [],
  },
  {
    id: "research",
    title: "Researcher",
    model: "Haiku 4.5",
    brief: "Reads sources properly, not skimming.",
    detail:
      "Reads sources properly rather than skimming. Quotes and cites. Shares none of the lead's context, so the brief has to stand on its own.",
    x: 296,
    y: 36,
    servers: [
      { name: "Linear", url: "mcp.linear.app/mcp", mode: "Shared by the room" },
      { name: "Sentry", url: "mcp.sentry.dev/mcp", mode: "Each person's own" },
    ],
  },
  {
    id: "critic",
    title: "Critic",
    model: "Sonnet 5",
    brief: "Checks the result before it returns.",
    detail:
      "Checks the work for factual errors, unsupported claims, and parts of the brief it did not answer. Does not rewrite it.",
    x: 576,
    y: 236,
    servers: [],
  },
  {
    id: "factcheck",
    title: "Fact checker",
    model: "Haiku 4.5",
    brief: "Verifies each claim against its source.",
    detail:
      "Takes every claim the researcher made and checks it against the source it cites. Reports the ones that do not hold rather than rewriting them.",
    x: 576,
    y: 36,
    drafted: true,
    servers: [],
  },
];

/**
 * Three of the four link kinds change what actually runs; the fourth only
 * changes what the agents are told. The room's own editor draws that
 * distinction, so the page does too. A link that looked like wiring but only
 * reworded a prompt would be a lie about the system.
 */
const WF_KINDS = [
  { kind: "delegates", label: "delegates to" },
  { kind: "reviews", label: "is reviewed by" },
  { kind: "handoff", label: "hands off to" },
  { kind: "custom", label: "relates to" },
];

const WF_EDGES = [
  { id: "e1", from: "lead", to: "research", kind: "delegates", drafted: false },
  { id: "e2", from: "research", to: "critic", kind: "reviews", drafted: false },
  { id: "e3", from: "research", to: "factcheck", kind: "reviews", drafted: true },
];

/** What the chat types, and what the canvas then does about it. */
const WF_ASK = "Add a fact checker after the researcher.";

const ASK_AT = 700;
const SEND_AT = 2600;
const WF_REPLY_AT = 3500;
const DRAFT_AT = 4100;
const WF_END = 11000;

const wfPct = (value: number, of: number) => `${(value / of) * 100}%`;

function ChapterWorkflowBuilder() {
  const reduced = useReducedMotion();
  const [seenRef, seen] = useInView<HTMLDivElement>("-15% 0px -15% 0px");
  const [run, setRun] = useState(0);
  const t = useTimeline(seen, WF_END, reduced, run);

  const [cards, setCards] = useState(WORKFLOW_CARDS);
  const [selected, setSelected] = useState("lead");
  const [typedPrompt, setTypedPrompt] = useState("");
  // Once the visitor takes the field, the script stops driving it.
  const [manual, setManual] = useState(false);
  const [sentByHand, setSentByHand] = useState(false);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);

  const scripted = !manual && !sentByHand;
  const sent = sentByHand || (scripted && t >= SEND_AT);
  const sending = scripted && t >= SEND_AT && t < WF_REPLY_AT;
  const replied = sentByHand || (scripted && t >= WF_REPLY_AT);
  const drafted = sentByHand || (scripted && t >= DRAFT_AT);

  const asked = sentByHand ? typedPrompt || WF_ASK : WF_ASK;
  const field = sent ? "" : scripted ? typed(WF_ASK, t, ASK_AT, 30) : typedPrompt;

  const live = cards.filter((card) => !card.drafted || drafted);
  const liveEdges = WF_EDGES.filter((edge) => !edge.drafted || drafted);
  const byId = (id: string) => live.find((card) => card.id === id);
  const active = byId(selected) ?? live[0]!;

  const clampX = (v: number) => Math.max(0, Math.min(WF_CANVAS.w - WF_CARD.w, v));
  const clampY = (v: number) => Math.max(0, Math.min(WF_CANVAS.h - WF_CARD.h, v));

  const startDragging = (event: ReactPointerEvent<HTMLButtonElement>, card: WorkflowCard) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    const scale = box.width / WF_CANVAS.w;
    dragRef.current = {
      id: card.id,
      offsetX: (event.clientX - box.left) / scale - card.x,
      offsetY: (event.clientY - box.top) / scale - card.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelected(card.id);
  };

  const moveCard = (event: ReactPointerEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    const drag = dragRef.current;
    if (!canvas || !drag) return;
    const box = canvas.getBoundingClientRect();
    const scale = box.width / WF_CANVAS.w;
    const x = clampX((event.clientX - box.left) / scale - drag.offsetX);
    const y = clampY((event.clientY - box.top) / scale - drag.offsetY);
    setCards((current) =>
      current.map((item) => (item.id === drag.id ? { ...item, x, y } : item)),
    );
  };

  const finishDragging = () => {
    dragRef.current = null;
  };

  const updateWorkflow = (event: FormEvent) => {
    event.preventDefault();
    if (!field.trim() && !typedPrompt.trim()) return;
    setSentByHand(true);
  };

  const replay = () => {
    setCards(WORKFLOW_CARDS);
    setSelected("lead");
    setTypedPrompt("");
    setManual(false);
    setSentByHand(false);
    setRun((n) => n + 1);
  };

  /**
   * Right edge of the source to the left edge of the target, which is how the
   * room's own editor lays a wire out. Both points come from the cards' live
   * positions, so dragging one moves the wire with it.
   */
  const wireOf = (edge: (typeof WF_EDGES)[number]) => {
    const from = byId(edge.from);
    const to = byId(edge.to);
    if (!from || !to) return null;
    const x1 = from.x + WF_CARD.w;
    const y1 = from.y + WF_CARD.h / 2;
    const x2 = to.x;
    const y2 = to.y + WF_CARD.h / 2;
    const bend = Math.max(28, Math.abs(x2 - x1) / 2);
    return {
      id: edge.id,
      kind: edge.kind,
      drafted: edge.drafted,
      d: `M${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
      mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 },
    };
  };

  const wires = liveEdges
    .map(wireOf)
    .filter((w): w is NonNullable<ReturnType<typeof wireOf>> => w !== null);

  return (
    <div className="lp-workflow-builder" ref={seenRef}>
      <div className="lp-workflow-builder-head">
        <strong>Shape the team around the task.</strong>
        <span className="lp-workflow-head-right">
          <span className="lp-workflow-count" data-num>
            {live.length} of 8 agents · {liveEdges.length} of 16 links
          </span>
          <button type="button" className="lp-linkbtn" onClick={replay}>
            Replay
          </button>
        </span>
      </div>

      <div className="lp-workflow-layout">
        <aside className="lp-workflow-chat">
          <span className="lp-workflow-chat-label">Workflow chat</span>
          <h3>Describe the change instead of drawing it.</h3>
          <p>
            The room can ask for a new teammate, a different model, or another
            link in plain language, and the draft comes back for review.
          </p>
          <div className="lp-workflow-thread">
            {sent && <div className="lp-workflow-bubble">{asked}</div>}
            {sending && (
              <div className="lp-workflow-pending" role="status">
                <i className="lp-dots" />
              </div>
            )}
            {replied && (
              <div className="lp-workflow-result" role="status">
                Added Fact checker on Haiku 4.5, reviewing the researcher.
                Drafted for review.
              </div>
            )}
          </div>
          <form className="lp-workflow-form" onSubmit={updateWorkflow}>
            <span className="lp-workflow-field">
              <input
                value={field}
                onChange={(event) => {
                  setManual(true);
                  setTypedPrompt(event.target.value);
                }}
                placeholder="Describe a change"
                aria-label="Describe a workflow change"
              />
              {scripted && !sent && t > ASK_AT && field.length < WF_ASK.length && (
                <i className="lp-caret" aria-hidden="true" />
              )}
            </span>
            <button type="submit" className="lp-btn lp-btn--primary" disabled={sending}>
              {sending ? "Updating…" : "Update workflow"}
            </button>
          </form>
        </aside>

        <div
          className="lp-workflow-canvas"
          ref={canvasRef}
          onPointerMove={moveCard}
          onPointerUp={finishDragging}
          onPointerCancel={finishDragging}
        >
          <svg
            className="lp-workflow-lines"
            viewBox={`0 0 ${WF_CANVAS.w} ${WF_CANVAS.h}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              {WF_KINDS.map((k) => (
                <marker
                  key={k.kind}
                  id={`lp-wf-arrow-${k.kind}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" className={`lp-wire-${k.kind}`} />
                </marker>
              ))}
            </defs>
            {wires.map((w) => (
              <path
                key={w.id}
                d={w.d}
                className={`lp-workflow-wire lp-wire-${w.kind}`}
                data-new={w.drafted === true}
                markerEnd={`url(#lp-wf-arrow-${w.kind})`}
              />
            ))}
          </svg>

          {wires.map((w) => (
            <span
              key={w.id}
              className={`lp-workflow-link lp-wire-${w.kind}`}
              data-new={w.drafted === true}
              style={{
                left: wfPct(w.mid.x, WF_CANVAS.w),
                top: wfPct(w.mid.y, WF_CANVAS.h),
              }}
              aria-hidden="true"
            >
              {WF_KINDS.find((k) => k.kind === w.kind)?.label}
            </span>
          ))}

          {live.map((card) => (
            <button
              type="button"
              className="lp-workflow-card"
              data-lead={card.lead === true}
              data-new={card.drafted === true}
              data-selected={selected === card.id}
              aria-pressed={selected === card.id}
              aria-label={`${card.title}, ${card.lead ? "lead" : "teammate"}, on ${card.model}`}
              key={card.id}
              style={{
                left: wfPct(card.x, WF_CANVAS.w),
                top: wfPct(card.y, WF_CANVAS.h),
                width: wfPct(WF_CARD.w, WF_CANVAS.w),
                height: wfPct(WF_CARD.h, WF_CANVAS.h),
              }}
              onClick={() => setSelected(card.id)}
              onPointerDown={(event) => startDragging(event, card)}
              onKeyDown={(event) => {
                if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
                event.preventDefault();
                const step = event.shiftKey ? 40 : 16;
                setCards((current) =>
                  current.map((item) =>
                    item.id === card.id
                      ? {
                          ...item,
                          x: clampX(
                            item.x +
                              (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0),
                          ),
                          y: clampY(
                            item.y +
                              (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0),
                          ),
                        }
                      : item,
                  ),
                );
              }}
            >
              <span className="lp-workflow-card-top">
                <strong>{card.title}</strong>
                {card.lead && <span className="lp-workflow-badge">Lead</span>}
              </span>
              <small>{card.model}</small>
              <span className="lp-workflow-card-brief">{card.brief}</span>
              {card.servers.length > 0 && (
                <span className="lp-workflow-card-tools">
                  <IconServer />
                  {card.servers.length} MCP
                </span>
              )}
            </button>
          ))}
          <div className="lp-workflow-legend" aria-label="Workflow link colors">
            {WF_KINDS.map((k) => (
              <span className="lp-workflow-legend-item" key={k.kind}>
                <span className={`lp-workflow-swatch lp-wire-${k.kind}`} />
                {k.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="lp-workflow-inspect" aria-live="polite">
        <div className="lp-workflow-inspect-agent">
          <span className="lp-workflow-inspect-head">
            <strong>{active.title}</strong>
            <span className="lp-workflow-chip">{active.model}</span>
          </span>
          <p>{active.detail}</p>
        </div>
        <div className="lp-workflow-inspect-servers">
          <span className="lp-workflow-inspect-label">MCP servers</span>
          {active.servers.length === 0 ? (
            <p className="lp-workflow-empty">
              None on this agent. Pick the researcher to see two.
            </p>
          ) : (
            <ul>
              {active.servers.map((server) => (
                <li key={server.name}>
                  <span className="lp-workflow-server-top">
                    <IconServer />
                    <strong>{server.name}</strong>
                    <span className="lp-workflow-mode">{server.mode}</span>
                  </span>
                  <span className="lp-workflow-server-url">{server.url}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <p className="lp-note">
        A tool on somebody else's server can do anything, and the room has no way
        to tell a read from a write among them, so an MCP call goes to the same
        vote a file write does.
      </p>
    </div>
  );
}

/* ------------------------------------------- chapter 5: the room's settings */

/**
 * Four lines out of a real transcript, in the shape the room actually writes
 * them: who did it, the verb, then the settled configuration after the dash.
 * The last one has no author because nothing anyone did caused it. The room
 * compacts itself when the conversation outgrows the window.
 */
const ANNOUNCEMENTS = [
  {
    time: "09:14",
    who: "Ana",
    what: "changed the setup",
    detail: "manager · Opus 5 directing Haiku 4.5 · effort high · up to 5 workers (auto)",
  },
  {
    time: "09:31",
    who: "Ravi",
    what: "changed what the agent may do",
    detail:
      "ask first · majority · votes on write_doc, edit_doc, write_file, edit_file, delete_file, mcp",
  },
  {
    time: "11:02",
    who: "Mia",
    what: "changed the workflow",
    detail:
      "custom · Lead on Opus 5 · 3 teammates (Researcher A, Researcher B, Critic) · 4 links",
  },
  {
    time: "14:20",
    who: null,
    what: "Compacted 32 earlier messages",
    detail: "the conversation passed 120,000 tokens. The last 12 are kept verbatim.",
  },
];

/** The header gauge's real numbers: what has been sent, and what it cost. */
const GAUGE = { used: 84_300, limit: 120_000, usd: "0.412" };

function ChapterRoom() {
  const [ref, seen] = useInView<HTMLDivElement>();
  return (
    <div className="lp-instrument" ref={ref}>
      <DemoPanel label="In the transcript, not in a settings drawer">
        <div className="lp-announce">
          {ANNOUNCEMENTS.map((line, i) => (
            <p
              className="lp-announce-line"
              key={line.what + line.time}
              data-in={seen}
              style={{ transitionDelay: `${i * 130}ms` }}
            >
              <span className="lp-announce-time" data-num>
                {line.time}
              </span>
              <span className="lp-announce-body">
                <span className="lp-announce-what">
                  {line.who ? (
                    <>
                      <strong>{line.who}</strong> {line.what}
                    </>
                  ) : (
                    line.what
                  )}
                </span>
                <span className="lp-announce-detail"> — {line.detail}</span>
              </span>
            </p>
          ))}
        </div>
      </DemoPanel>
      <DemoPanel label="Room header">
        <div className="lp-gaugewrap">
          <div className="lp-gauge-row">
            <span className="lp-gauge-value" data-num>
              {GAUGE.used.toLocaleString("en-US")}
            </span>
            <span className="lp-gauge-cap" data-num>
              of {GAUGE.limit.toLocaleString("en-US")} tokens
            </span>
            <span className="lp-gauge-cost" data-num>
              ${GAUGE.usd}
            </span>
          </div>
          <div className="lp-gauge-track">
            <div
              className="lp-gauge-fill"
              style={{ transform: `scaleX(${seen ? GAUGE.used / GAUGE.limit : 0})` }}
            />
          </div>
          <p className="lp-note">
            The conversation is the bill. Every turn re-sends all of it. Both
            numbers sit in the room&rsquo;s header where everyone can see them,
            and when the prompt outgrows the window the room compacts the older
            half and keeps the last twelve messages verbatim.
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
 * A repeat address is a success, not an error. The Worker treats a second
 * signup as a no-op, so there is no state here for "already on the list". The
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
 * hostnames. It is the same product either way, so the two differ only in
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
                Every line is tagged with who said it and folded into one turn,
                so the agent answers the room rather than the last person to
                press enter. A line sent while it is still working waits in the
                room&rsquo;s inbox and joins the next turn. No turn is split
                down the middle, and nothing anyone says is quietly discarded.
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
                call stops and becomes something the room can see. There are
                three answers, not two: approve it, deny it, or approve it and
                stop being asked for a while. A room in a hurry can move the
                whole policy to auto-accept, out loud, in the transcript, never
                as a default it discovers afterwards.
              </p>
              <p className="lp-note">
                Cast a vote. Two of the three people here settle it either way.
              </p>
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
                A paused turn isn&rsquo;t a request held open somewhere hoping
                you come back. It is saved state. The room can go quiet for
                hours and hibernate, the deciding vote can arrive from someone
                else&rsquo;s phone in a different invocation, and the same turn
                picks up exactly where it stopped.
              </p>
            </Reveal>
            <Reveal delay={1}>
              <ChapterDurable />
            </Reveal>
          </div>
        </section>

        <section className="lp-act lp-act--stage lp-act--workflow" id="team">
          <div className="lp-inner lp-chapter">
            <Reveal className="lp-chapter-head">
              <h2 className="lp-h2">Agents can work together in one workflow.</h2>
              <p className="lp-body">
                Build a team for the room instead of relying on one agent to do
                everything. A lead agent can break work into focused tasks,
                coordinate teammates, and bring their results back into the
                same shared conversation.
              </p>
            </Reveal>
            <Reveal delay={1}>
              <div className="lp-feature-grid">
                <article className="lp-feature-card"><h3>One lead, several specialists</h3><p>Up to eight agents and sixteen links, or the two built-in shapes if the room would rather not draw one.</p></article>
                <article className="lp-feature-card"><h3>Everyone sees the same turn</h3><p>Delegated work returns into the room&rsquo;s one conversation, with the reviewer&rsquo;s notes attached to the result the lead receives.</p></article>
                <article className="lp-feature-card"><h3>Durable by default</h3><p>A turn is saved state, so a fan-out can pause on a vote and finish hours later in a different invocation.</p></article>
              </div>
            </Reveal>
            <Reveal delay={2}>
              <ChapterWorkflowBuilder />
            </Reveal>
          </div>
        </section>

        <section className="lp-act lp-act--tint lp-act--mcp">
          <div className="lp-inner lp-chapter">
            <Reveal className="lp-chapter-head">
              <span className="lp-feature-kicker">MCP servers</span>
              <h2 className="lp-h2">Give workflows the tools they need.</h2>
              <p className="lp-body">
                MCP servers stay in their own section so the workflow stays easy
                to read. Pick an approved server from the catalogue, grant it to
                an agent, and decide whether it uses a shared credential or each
                person's own. MCP calls still go through the room's vote.
              </p>
            </Reveal>
            <Reveal delay={1}>
              <div className="lp-feature-grid lp-mcp-box">
                <article className="lp-feature-card"><h3>MCP catalogue</h3><p>Browse approved servers such as Linear, Stripe, Sentry, and Cloudflare without memorizing connection URLs.</p></article>
                <article className="lp-feature-card"><h3>Scoped grants</h3><p>Grant a server to a specific agent and keep access limited to the user and room that approved it.</p></article>
                <article className="lp-feature-card"><h3>Visible and reviewable</h3><p>Tool calls, approvals, and outcomes remain in the room history, with access that can be taken back.</p></article>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="lp-act lp-act--tint">
          <div className="lp-inner lp-chapter lp-chapter--split">
            <Reveal className="lp-chapter-head">
              <h2 className="lp-h2">Point it at a folder. Or at a repo.</h2>
              <p className="lp-body">
                A room can work against a folder on one member's machine,
                relayed live to everyone else, or against a GitHub repository
                through a connected app with branches, contents, and pull requests. The
                voting rule doesn't change with the provider. The built-in code
                workspace lets the room browse and edit both public and private
                repositories without leaving the conversation.
              </p>
            </Reveal>
            <Reveal delay={1}>
              <ChapterWorkspace />
            </Reveal>
          </div>
        </section>

        <section className="lp-act">
          <div className="lp-inner lp-chapter lp-chapter--split">
            <Reveal className="lp-chapter-head">
              <h2 className="lp-h2">See where the work is happening.</h2>
              <p className="lp-body">
                When teammates use the IDE, the room can show the file they
                opened, where their cursor is, and what they saved. It gives
                everyone a shared sense of progress without taking control away
                from the person doing the work.
              </p>
            </Reveal>
            <Reveal delay={1}>
              <div className="lp-activity-demo">
                <div><span className="lp-activity-avatar">M</span><strong>Mia</strong><span>opened</span><code>src/server/room.ts</code></div>
                <div><span className="lp-activity-avatar lp-activity-avatar--alt">J</span><strong>Jordan</strong><span>editing line 148</span><code>src/client/RoomView.tsx</code></div>
                <div><span className="lp-activity-dot" /><strong>Huddle.AI</strong><span>indexed 42 code passages</span></div>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="lp-act">
          <div className="lp-inner lp-chapter">
            <Reveal className="lp-chapter-head">
              <h2 className="lp-h2">Settings belong to the room, not to you.</h2>
              <p className="lp-body">
                The model, the permissions and the workflow belong to the room,
                and every change is announced in the transcript with the name of
                whoever made it and the setup it landed on. Changes only take
                while the agent is idle, so nobody moves the floor mid-turn.
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
                Rooms are private. Only the people you send the link to can get
                in. A room nobody is using hibernates until someone comes back.
              </p>
            </div>
          ) : (
          <div className="lp-inner lp-close">
            <h2 className="lp-h2 lp-close-h">Open a room. Send one link.</h2>
            <p className="lp-lead">
              Rooms are private. Only the people you send the link to can get
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
                : "Your name is how the room tags what you say. Every message is attributed, so everyone can see who asked for what."}
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
          <details className="lp-legal" id="privacy">
            <summary>Privacy policy</summary>
            <div className="lp-legal-body">
              <p>Huddle.AI uses the information needed to provide shared rooms, including your display name and, when you sign in with a provider, your profile avatar. Messages, agent activity, votes, and room settings are shared with members of that room.</p>
              <p>If you connect a local folder or GitHub repository, the agent can process the files you authorize. File content may appear in the room transcript when the room has permission to view it. Do not connect data you are not authorized to share.</p>
              <p>We do not ask for provider passwords. OAuth credentials and workspace access are handled by the connected service and are not displayed in the room. Contact the Huddle.AI team with privacy questions.</p>
            </div>
          </details>
          <details className="lp-legal" id="terms">
            <summary>Terms and conditions</summary>
            <div className="lp-legal-body">
              <p>By using Huddle.AI, you agree to use it lawfully, respect the access rights of other people, and only connect repositories, folders, and documents you are authorized to use.</p>
              <p>Room owners and admins control membership, connected workspaces, and agent permissions. Review proposed changes before approving them. Huddle.AI does not guarantee that agent output or code changes are correct, secure, or suitable for production.</p>
              <p>You are responsible for your account activity, the data you share, and any changes you approve. We may change or suspend the service to protect users or maintain the platform.</p>
            </div>
          </details>
        </div>
      </footer>
    </div>
  );
}
