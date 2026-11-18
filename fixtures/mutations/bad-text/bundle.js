(function () {
    'use strict';

    /**
     * Thrown by a tracked read whose value is currently pending (an async memo /
     * `createSignal(asyncFn)` / projection / store derivation that hasn't settled
     * yet). Surfacing through the reactive graph is what suspends the consumer
     * scope — the nearest enclosing `<Loading>` boundary catches the throw and
     * renders its fallback until the source resolves.
     *
     * App code rarely catches this directly; `<Loading>` is the canonical
     * handler. The error type is exposed for advanced cases — e.g. interop layers
     * that bridge Solid's pending-throw protocol to a different async strategy,
     * or tests that want to assert on the suspension shape.
     *
     * @example
     * ```ts
     * // Advanced: distinguish "not ready yet" from a real error in custom
     * // boundary plumbing. App code should rely on `<Loading>` / `<Errored>`.
     * try {
     *   const value = readReactiveSource();
     * } catch (err) {
     *   if (err instanceof NotReadyError) throw err; // re-throw to suspend
     *   reportError(err);
     * }
     * ```
     */
    class NotReadyError extends Error {
      constructor(r) {
        // Control-flow throw: it happens on every read of a pending source, so in
        // production skip V8's eager stack capture (proportional to stack depth —
        // real cost under SSR) by zeroing the V8-specific stackTraceLimit around
        // super(). Dev keeps the stack for debuggability; non-V8 engines (no
        // stackTraceLimit) take the plain path.
        const o = Error;
        const t = o.stackTraceLimit;
        if (t) o.stackTraceLimit = 0;
        super();
        if (t) o.stackTraceLimit = t;
        this.source = r;
      }
    }
    class StatusError extends Error {
      constructor(r, o) {
        // Best-effort message: formatting must never replace the original (#4112).
        try {
          var t = String(o instanceof Error ? o.message : o);
        } catch {}
        super(t, {
          cause: o
        });
        this.source = r;
      }
    }

    /** Return the user's error from an internal status wrapper. */
    function unwrapStatusError(r) {
      return r instanceof StatusError ? r.cause : r;
    }

    const REACTIVE_NONE = 0;
    const REACTIVE_CHECK = 1 << 0;
    const REACTIVE_DIRTY = 1 << 1;
    const REACTIVE_RECOMPUTING_DEPS = 1 << 2;
    const REACTIVE_IN_HEAP = 1 << 3;
    const REACTIVE_IN_HEAP_HEIGHT = 1 << 4;

    /** L2 — the node sits on its owner's parked frame (`_x._pendingFirstChild`):
     * it is the displayed frame until the owner's commit disposes it. Set by
     * `markDisposal` over the parked subtree; carried through every per-pass
     * flag wipe (#3543). Scheduling reads it once, at the heap pop: a zombie's
     * recompute is deferred past the seam (`deferZombie`). */
    const REACTIVE_ZOMBIE = 1 << 5;
    const REACTIVE_DISPOSED = 1 << 6;

    /** L2 — this pass read the future (a tracked read of a CONFIG_HELD node).
     * Lives for the pass only: set by `read`, consumed by `recompute`'s publish
     * (a first pass that read the future is born held, A29), wiped with the
     * pass's other per-pass bits. */
    const REACTIVE_JOINED = 1 << 7;
    const REACTIVE_SNAPSHOT_STALE = 1 << 8;
    const REACTIVE_LAZY = 1 << 9;
    const REACTIVE_MANUAL_WRITE = 1 << 10;

    /** L2, rule 3 — the node's LAST pass was a render effect's read of the
     * future as committed (`frameRead`): the frame shows the committed world
     * beside a future it also derives from, and re-derives at the landing.
     * Survives its own pass's wipe; the next pass's wipe clears it (a pass that
     * re-derived the frame — in the future, or without the held read — owes the
     * landing nothing). The landing consumes it (the transaction's `_reruns`). */
    const REACTIVE_FRAME_READ = 1 << 11;

    /**
     * A dependency write landed while this subscriber was mid-recompute — a
     * nested pull committed beneath one of its reads (#3037). The heap refuses
     * RECOMPUTING nodes, so recompute's tail consumes this latch and reschedules:
     * values the pass read before the nested commit are stale. Only set for
     * links validated this pass (gen-current): a write to an untouched link is
     * either re-read later in the pass (fresh) or trimmed with it (not a dep).
     */
    const REACTIVE_MISSED_WAKE = 1 << 12;

    /** A `refresh()` asked this node to re-ask its question (A19 exc. 2, A24):
     * consumed by the next pass, which — going pending — classifies its flight
     * quiet (`_x._reask`). */
    const REACTIVE_REASK = 1 << 13;

    /** The pass was served a node's ambient staging — written this flush, not
     * held. If the flush parks, the pass is the frame's with it (the same sync
     * frame as the async): a verdict read cannot break it out. Per pass. */
    const REACTIVE_STAGED_READ = 1 << 14;

    /** Lanes — the node (a lane's member) was dirtied by the lane's own
     * re-staging (a re-guess, lane work re-derived): its next pass is the
     * lane's from the start (`recompute`), not a stale reader's re-run by an
     * unrelated write (#3460). Consumed by the pass. */
    const REACTIVE_LANE_DIRTY = 1 << 16;

    /** Lanes (plan sec. 28) — the pass read a lane's value as lane work (`enterLane`): a
     * tracked derivation's read of displayed optimism, a verdict read routed
     * into the holder's verdict lane. A pass in a lane's seat that read none of
     * its world has left the lane (`recompute`'s tail). Per pass. */
    const REACTIVE_LANE_READ = 1 << 17;

    /** Lanes (plan sec. 28) — a render effect in the frame's seat was served the screen
     * for a lane's node (`laneRead`: a stale reader of a lane that has not
     * shown). Its pass computing exactly what it last applied has nothing to
     * run — an effect has no comparator, and the guess's notification is not a
     * change it can see. Per pass. */
    const REACTIVE_SCREEN_READ = 1 << 18;

    /** A verdict reader whose probe was answered before the flush had a
     * transaction (verdict.ts `watchVerdict`): the seam re-runs it even if a
     * later read of the same pass routed it into a verdict lane — that was not
     * the probe's answer (lanes.ts). Per pass. */
    const REACTIVE_PROBE_UNANSWERED = 1 << 19;

    /** An observation-lifecycle node found unobserved by a settle (#2934) while
     * a pass of it was already queued — a source's landing re-enqueued the
     * `_blocked` reader it walks (`settlePendingSource`). The release waits for
     * that pass: a memo nobody read has still produced what the flushes it
     * missed gave it (D-22, #4474), so the queued pass runs, then `recompute`'s
     * tail releases the node. Survives the head wipe; the tail consumes it. */
    const REACTIVE_RELEASE_AFTER = 1 << 22;

    /** A computed its own owner reads (a memo reading the memo it created): the
     * owner sits below it (heights put owners first), so a wake of it wakes the
     * owner too — the owner's pass re-creates it and is what its readers see. */
    const REACTIVE_OWNER_READS = 1 << 23;

    // Static configuration bits packed into Owner/Computed/Signal _config.
    const CONFIG_OWNED_WRITE = 1 << 0;
    const CONFIG_NO_SNAPSHOT = 1 << 1;
    const CONFIG_TRANSPARENT = 1 << 2;
    const CONFIG_IN_SNAPSHOT_SCOPE = 1 << 3;
    const CONFIG_CHILDREN_FORBIDDEN = 1 << 4;
    const CONFIG_AUTO_DISPOSE = 1 << 5;
    const CONFIG_SYNC = 1 << 6;

    // CARVE 3: REACTIVE_ZOMBIE, CONFIG_AUTHORITATIVE_READ, CONFIG_DIRECT_COMMIT,
    // CONFIG_HELD_CHILDREN, CONFIG_INPUTS_PUBLISHED and CONFIG_ADOPTED_UNFLUSHED
    // (transaction holds, zombies, until()'s authoritative view) went with the
    // transactions.
    // L2 (step 2): four bits, all maintained by the node's commit.
    /** The node has a pass awaiting commit: its live children (and `_disposal`)
     * are that pass's and were never shown — a re-pass tears them down on the
     * spot, while the frame parked on `_x._pendingFirstChild` keeps waiting for
     * the commit. Set by `recompute` when it queues the node. */
    const CONFIG_STAGED = 1 << 7;

    /** The node's staged state is in the future: the flush that staged it
     * parked. A write to it, a tracked read of it by a derivation, or a pass
     * over a derivation holding it joins the future (the flush parks). Render
     * effects are the frame, not derivations (rule 3): reading it outside a
     * parking flush they see the committed value and hold nothing, and are
     * re-derived at the landing. Set at the park seam on every staged node. */
    const CONFIG_HELD = 1 << 8;

    /** A member of the uncommitted frame a held pass built (ruling A): set at
     * the park seam on every computed under a staged node (`holdFrame`). Never
     * shown, it has no screen: its reads are its transaction's, whichever flush
     * runs it (`bornInto`, #4010). Cleared by its commit. */
    const CONFIG_HELD_FRAME = 1 << 20;

    /** A15's reveal corollary (#3305): a commit published this flight's inputs
     * beneath it — the node was pending, nothing staged, when it committed — so
     * its committed value is torn against the visible frame. A render effect
     * revealing it cannot be a stale reader: it observes the flight (pends,
     * holds) instead of showing the pre-flight value. Outlives the flight that
     * earned it for as long as the node stays pending, and no longer: the
     * commit that lands a value clears it. */
    const CONFIG_INPUTS_PUBLISHED = 1 << 10;

    /** Lanes (plan sec. 28) — the node has a lane's value (`_x._lane`): a written guess
     * (CONFIG_GUESS) or a lane pass's derivation of one. Its lane is
     * `_x._transaction`. The gate to the lane arm of `read`; `_value` stays the
     * committed truth and `_pendingValue` a transaction's staging throughout —
     * a value's world is where it lives, never a bit. */
    const CONFIG_OVERRIDE = 1 << 11;

    /** A store slot node (`slotSignal`): a leaf, presence, container or deep
     * witness of a store target. One literal, no `_x` at birth; the last-one-out
     * sweep dispatches it to the store's shared release hook (graph.ts) instead
     * of a per-node `_unobserved` closure. */
    const CONFIG_SLOT_NODE = 1 << 12;

    /** D-41: the staged value in `_pendingValue` is an error — an
     * answer of the held frame, published at its landing like a value. */
    const CONFIG_STAGED_ERROR = 1 << 21;

    /** Lanes — the node carries a written guess (`optimisticWrite`): its own
     * source recomputing it, or a plain write landing on it, is the truth
     * (`supersede`). A lane's derived staging is not. */
    const CONFIG_GUESS = 1 << 13;

    /** The node's pass read a verdict (`isPending`/`latest`): a dependency going
     * pending is a question for its next pass — the verdict changed — so the
     * propagation re-derives it instead of marking it pending (as a kept-tail
     * link does, A30). Set at the window, never cleared: a reader that stopped
     * asking re-derives once and goes pending through its own read. The same
     * bit as REACTIVE_PROBED: a pass's probe (or a read of a verdict memo,
     * core.ts `read`) carries into the config at its end without a shift. */
    const CONFIG_VERDICT = 1 << 15;

    /** A dependency's status is a question for this node's pass, not a fact
     * about its current one: the propagation re-derives it instead of marking
     * it, for errors as for pending (as CONFIG_VERDICT). A boundary's output
     * (show the content, or the fallback) and its `on` node (boundaries.ts); a
     * promise over an expression (`resolve`/`until`, signals.ts: the pass reads
     * the error and rejects, or re-asks a pending source). */
    const CONFIG_REDERIVE = 1 << 14;

    /** An answered `createDeferred` node (deferred.ts): held because a
     * downstream hold staged its landing, its re-pass is a lagging question,
     * not an answer, and joins no transaction (D-40). */
    const CONFIG_LAGS = 1 << 19;

    // Presence bits (stage-3 hot-path monomorphism, DESIGN-PATCH-CHANNEL §11b):
    // optional per-node slots (_overrideValue, _pendingSignal/_latestValueComputed,
    // _snapshotValue, _optimisticLane) are NOT part of every node's hidden class —
    // reading a missing property defeats V8's inline caches on the hottest write/
    // notify loops. These bits live on the always-present `_config` so hot paths
    // pay one monomorphic masked read and only touch the optional field when its
    // installer flagged it. Bits are STICKY ("may be set") — the guarded field
    // read remains authoritative.
    const CONFIG_HAS_SNAPSHOT = 1 << 9;

    /** Fresh-pull reader (awaitable `refresh()`'s waiter effect): a read of a
     * dirty source recomputes it inline even when the height gate defers to the
     * flush. Closes the same-flush ordering race where a waiter created
     * alongside a refresh() mark read the PRE-re-ask value as settled and
     * delivered stale; with the pull, the waiter either parks on the re-ask's
     * pending window (async — woken by the settle walk, which runs on every
     * landing including equal-value ones) or serves its sync answer. resolve()
     * deliberately keeps that race — its contract is "first settled value"
     * (#2930), not "next quiescent state". */
    const CONFIG_FRESH_READ = 1 << 16;

    /** A28 (4): the node was written inside a recompute that ran OUTSIDE a flush
     * (a creation-time compute — boundary machinery, a mapArray's first run). Such
     * a write is promoted at that recompute's end: readers in the same block see
     * it. Cleared when the next flush begins; set only on that rare path. */
    const CONFIG_PROMOTED = 1 << 22;

    /** The frame (rule 3, D-3): a render effect (set at creation, as
     * `EFFECT_RENDER << 23` — keep the two in step), and a boundary's tree and
     * output (boundaries.ts) — structure between the content and the render
     * effect that shows it, not a user derivation of the content. Outside a
     * hold's own flush it reads that hold's values as committed and is
     * re-derived at its landing, and a re-pass of it publishes mainline: it
     * joins nothing, so two mounts under one boundary made in separate flushes
     * keep their holds apart (D-4, S-5 rows 1′–3′, #4283). */
    const CONFIG_FRAME = 1 << 23;

    /** The node's last answering pass registered a flight: an async memo. Kept
     * by the verdict engine alone (verdict.ts `holdWork`), which reads it. */
    const CONFIG_ASYNC = 1 << 29;
    const STATUS_PENDING = 1 << 0;
    const STATUS_ERROR = 1 << 1;
    const STATUS_UNINITIALIZED = 1 << 2;

    /** An error that answered a node's first read (no value has ever landed):
     * the error, not UNINITIALIZED, is its status while shown, but a re-ask
     * makes it uninitialized-pending again — it still has no value (#4244). */
    const STATUS_NO_VALUE = 1 << 3;

    /** `catchHook`'s answer when the catcher is a boundary re-armed by
     * `on` (truthy, as any catch): what it collects is its own, not the hold's. */
    const CAUGHT_REARMED = 2;
    const EFFECT_RENDER = 1;
    const EFFECT_USER = 2;
    const EFFECT_TRACKED = 3;
    const NOT_PENDING = {};
    const SUPPORTS_PROXY = typeof Proxy === "function";
    const defaultContext = {};

    /**
     * Brand symbol used by `Refreshable<T>` values (projection stores, async
     * memos) to expose their underlying computation to `refresh()`. Not part of
     * the user-facing API.
     *
     * @internal
     */
    const $REFRESH = Symbol("refresh");
    const NewSet = Set;

    // L2 (step 2): the parked frame. A pass parks the previous frame's children
    // and `_disposal` list on `_x._pendingFirstChild` / `_x._pendingDisposal`
    // (`parkChildren`, core.ts); they keep reacting until the node's commit
    // disposes them (`zombie` walk below) or the owner dies. `markDisposal` flags
    // the parked subtree REACTIVE_ZOMBIE: the splice guard and the reawaken path
    // key off it, and the heap defers a zombie's recompute past the seam (no
    // second heap — the deferral list in scheduler.ts).
    function markDisposal(e) {
      let n = e.pe;
      while (n) {
        n.R |= REACTIVE_ZOMBIE;
        markDisposal(n);
        n = n.Ge;
      }
    }

    // The first error a cleanup threw, boxed so a thrown `undefined` still
    // counts. A throwing cleanup stops neither its siblings nor the rest of the
    // tree: every cleanup runs. The error is rethrown once the teardown is over:
    // by a root's dispose call outside a flush (`disposeRootSelf`), otherwise when
    // the flush ends (`flush`; `runCleanup` schedules one), so a flush is never
    // left half-applied. A halt drops it: the error that halted is the one
    // reported, and a stale one must not surface from a later, unrelated dispose.
    let cleanupError;

    /** Runs a cleanup or `unobserved` hook; a throw is collected, not raised. @internal */
    function runCleanup(e) {
      try {
        e();
      } catch (e) {
        cleanupError ||= [e];
        schedule();
      }
    }

    /** Rethrows the error `runCleanup` collected, once; `drop` discards it. @internal */
    function rethrowCleanupError(e) {
      const n = cleanupError;
      cleanupError = undefined;
      if (n && !e) throw n[0];
    }
    function disposeChildren(e, n = false, r) {
      const t = e.R;
      if (t & REACTIVE_DISPOSED) return;
      // A parked frame dies with its owner (#3024): the commit that would retire
      // it never comes once the node is DISPOSED, so it drains here or its
      // cleanups never run and it stays subscribed, rerunning in a torn-down
      // tree (#3561). Death only (`self`): a re-pass leaves the frame reacting
      // until the commit.
      if (n) {
        if (!r && e.T !== null && (e.T.me !== null || e.T.Le !== null)) disposeChildren(e, false, true);
        e.R = t | REACTIVE_DISPOSED;
        if (e.X) {
          clearInFlight(e);
          // A death that can unblock the future (L2, `futureBlocked`): a held
          // flight's — a transaction's or a lane's (its `_x._transaction`) — or a
          // stale reader's (REACTIVE_FRAME_READ — a frame that derived from one).
          // An idle pending queue would also pin it until an unrelated flush.
          // Nothing else re-examines a dead node, so make sure a seam comes.
          if (e.m & STATUS_PENDING && e.T?.Re != null || t & REACTIVE_FRAME_READ || pendingNodes.length) schedule();
        }
      }
      // Typed as a computed so the loop needs no cast alias (the minifier keeps one).
      let l = r ? e.T.me : e.pe;
      if (r) e.T.me = null;else e.pe = null;
      while (l) {
        // Owner teardown is death regardless of the child's own lifecycle
        // (#3024): strip AUTO_DISPOSE so a post-disposal read freezes at the
        // last committed value instead of reawakening in a torn-down tree.
        // Runs before the recursion so already-dormant children (whose
        // disposeChildren call early-returns on REACTIVE_DISPOSED) die too.
        // Only unobserved()'s own node keeps its dormancy — it is never in
        // this loop; its children are rebuilt fresh on reawaken.
        l.l &= ~CONFIG_AUTO_DISPOSE;
        // Heap removal must not be gated on `_deps`: a dependency-free
        // computation queued by refresh() has a null dep list but still sits in
        // the dirty heap, and left there the post-disposal flush recomputes it —
        // recompute() rewriting `_flags` clears REACTIVE_DISPOSED and the node
        // comes back to life (post-unmount runs, leaked cleanups, #2983).
        // deleteFromHeap self-guards on the in-heap flags (and tolerates plain
        // Owners, whose _flags is undefined), so no gate here.
        deleteFromHeap(l, dirtyQueue);
        clearDeps(l);
        // The chain is detached above so a node a cleanup links mid-drain lands
        // on the fresh head and survives. Pointing each drained child's prev at
        // itself routes its later splice onto the detached chain, never the head,
        // and keeps the dev owner-chain-head invariant honest for those children.
        l.Me = l;
        disposeChildren(l, true);
        // Read after, not before: a sibling this disposal made dormant spliced
        // itself out of the detached chain, and a cleanup may then have linked
        // it at the fresh head, which rewrote the `_nextSibling` a pre-read
        // would still be holding.
        l = l.Ge;
      }
      if (!r) e.be = 0;
      // O(1) splice out of parent's chain on individual dispose. Skipped during
      // batch dispose (parent already disposed) and for a zombie (it sits on the
      // parent's parked frame, drained whole by the commit). We leave
      // node._nextSibling intact so outer walks that already advanced past us
      // still reach later siblings.
      if (n && !r && !(t & REACTIVE_ZOMBIE) && e._parent !== null && !(e._parent.R & REACTIVE_DISPOSED)) {
        const n = e.Me;
        const r = e.Ge;
        if (n !== null) n.Ge = r;else e._parent.pe = r;
        if (r !== null) r.Me = n;
        e.Me = null;
      }
      runDisposal(e, r);
      // Final effect-returned cleanup fires at true disposal, after `_disposal`
      // to mirror rerun ordering (compute-phase teardown first, cleanup last).
      if (n && e.ze) {
        const n = e.ze;
        e.ze = undefined;
        runCleanup(n);
      }
    }
    function linkChild(e, n) {
      const r = e.pe;
      n.Me = null;
      n.Ge = r;
      if (r !== null) r.Me = n;
      e.pe = n;
    }
    function runDisposal(e, n) {
      // Detach the list BEFORE running it (#3601), as `_cleanup` is (#2813). A
      // cleanup that disposes an ancestor re-enters this node through the death
      // walk while the loop is still running; with the list still attached, that
      // walk ran every entry a second time. Detached, the re-entrant drain finds
      // nothing. The same shape latched a throwing cleanup: the list survived the
      // throw and every later drain re-ran and re-threw it.
      const r = n ? e.T.Le : e.ke;
      if (!r) return;
      if (n) e.T.Le = null;else e.ke = null;
      if (Array.isArray(r)) {
        // Unwind order (#3572, restores 1.x #1562): later registrations run
        // before earlier ones. Children have already been disposed by the caller,
        // so with LIFO a body that registers cleanup before creating its children
        // tears down after them — the same order a per-component owner gives.
        for (let e = r.length - 1; e >= 0; e--) {
          runCleanup(r[e]);
        }
      } else {
        runCleanup(r);
      }
    }
    function childId(e, n) {
      while (e.l & CONFIG_TRANSPARENT && e._parent) e = e._parent;
      if (e.id != null) return formatId(e.id, e.be++ );
      throw new Error();
    }

    /**
     * Allocates and returns the next stable child id for `owner`. Used by
     * hydration plumbing and `createUniqueId`. Not part of the user-facing API.
     *
     * @internal
     */
    function getNextChildId(e) {
      return childId(e);
    }

    /**
     * The id a freshly-created node inherits: an explicit `options.id` wins;
     * transparent nodes share their parent's id; otherwise the parent's next
     * child id is consumed (or `undefined` outside an id-carrying tree).
     */
    function inheritId(e, n, r) {
      return e?.id ?? (n ? r?.id : r?.id != null ? getNextChildId(r) : undefined);
    }
    function formatId(e, n) {
      const r = n.toString(36),
        t = r.length - 1;
      return e + (t ? String.fromCharCode(64 + t) : "") + r;
    }

    /**
     * Low-level: registers `fn` as a disposal callback on the current owner.
     * Most code should use `onCleanup()` from `solid-js`, which adds dev-mode
     * checks. `cleanup()` is the unchecked primitive used by internals; `owner`
     * (internal) targets a specific owner's disposal list instead of the ambient
     * one.
     */
    function cleanup(e, n = context) {
      if (!n) return e;
      if (!n.ke) n.ke = e;else if (Array.isArray(n.ke)) n.ke.push(e);else n.ke = [n.ke, e];
      return e;
    }
    function disposeRootSelf(e = true) {
      disposeChildren(this, e);
      // Outside a flush the dispose call rethrows; inside one, the flush does.
      // Kept out of `disposeChildren`, whose hot path it slows.
      if (cleanupError && !globalQueue.Y) rethrowCleanupError();
    }

    /**
     * Creates a fresh owner attached as a child of the current owner (or as a
     * detached root if there is none). Used by framework internals to group
     * cleanups; app code should use `createRoot()` (host a reactive scope outside
     * a component) or `runWithOwner()` (re-enter a captured owner).
     *
     * @internal
     */
    function createOwner(e) {
      const n = context;
      const r = e?.transparent ?? false;
      // Prod and observe boilerplates (see core.ts computed()). The observe
      // literal carries the `_name` and `_loc` slots the rendering layer fills
      // with the component label and JSX site (`owner._name = "<App>"`,
      // `owner._loc = "src/App.tsx:3:5"`) — slots, so labelling a root is a
      // plain store rather than a shape fork between labelled and plain roots.
      const t = {
        id: inheritId(e, r, n),
        l: r ? CONFIG_TRANSPARENT : 0,
        // Present from birth: disposeChildren marks death here on roots too, and
        // a first store of a missing property is a shape transition plus a
        // properties-store allocation per root — on a 100×4 table teardown that
        // was 12 KB and most of disposal's time (2026-10-17).
        R: REACTIVE_NONE,
        Qe: true,
        Ke: n?.Qe ? n.Ke : n,
        pe: null,
        Ge: null,
        Me: null,
        ke: null,
        A: n?.A || defaultContext,
        be: 0,
        T: null,
        _parent: n,
        dispose: disposeRootSelf
      };
      if (n) linkChild(n, t);
      return t;
    }

    /**
     * Creates a reactive root — an owner scope with its own `dispose()`. A root
     * created inside an existing owner is owned by it and is disposed when the
     * parent is disposed; call `dispose()` to tear it down earlier. To create a
     * root that outlives its creator, detach explicitly:
     * `runWithOwner(null, () => createRoot(...))`. Pass `id` to seed hydration
     * ids for the tree it owns.
     *
     * `dispose()` tears down every signal, memo, effect, and `onCleanup`
     * registered inside the root.
     *
     * Use this to host long-lived reactive scopes outside of a component (custom
     * controllers, app bootstrapping, tests). Inside a component, prefer
     * letting Solid's component lifecycle own things.
     *
     * @example
     * ```ts
     * // At module level there is no owner, so this root lives until disposed.
     * const dispose = createRoot(dispose => {
     *   const [n, setN] = createSignal(0);
     *   createEffect(() => n(), value => console.log(value));
     *   setInterval(() => setN(x => x + 1), 1000);
     *   return dispose;
     * });
     *
     * // Later, to tear everything down:
     * dispose();
     *
     * // Inside an owner (component, effect, another root), detach explicitly
     * // if the root must outlive its creator:
     * const detached = runWithOwner(null, () => createRoot(d => d));
     * ```
     *
     * @description https://docs.solidjs.com/reference/solid-js/advanced/owner-introspection/create-root
     */
    function createRoot$1(e, n) {
      const r = createOwner(n);
      // A bound function, not an arrow: an arrow would share this scope, which
      // holds `init`, so keeping `dispose` would keep `init` and all it closes
      // over alive (#4095).
      return runWithOwner(r, () => e(disposeRootSelf.bind(r, true)));
    }

    let laneStageHook = null;

    /** core.ts `frameRead` served lane work or a verdict reader a held node's
     * committed value (lanes.ts `laneServed`). */
    let laneServedHook = null;

    /** A guess was written (guesses.ts `optimisticWrite`): the arms only a guess
     * reaches (CONFIG_GUESS) — a build without `createOptimistic` or
     * `createOptimisticStore` never sets it, and its bundler folds them. */
    let guessing = false;
    let freshHook = null;

    /** Verdicts (verdict.ts). */
    let observeFlightHook = null;

    /** D-25's hold work (verdict.ts `holdWork`): on `source` going pending,
     * whether verdict reader `n` waits on it instead of re-deriving. */
    let holdWorkHook = null;

    /** D-8 (verdict engine), at the flush: the readers a tick netting to its
     * starting value woke are let go (verdict.ts `revert`). */
    let revertHook = null;
    let externalUntrackHook = undefined;

    /** Live transactions — opened, unmerged, not landed. Scanned at every seam
     * while non-empty; nothing on the plain path. */
    const transactions = [];

    /** Observe tier: this flush parked its transaction (`holdStart` fired). */
    let holding = false;

    /** A transaction (listed here) or a lane (lanes.ts lists its own). */
    function newTransaction(e, o = null) {
      const n = {
        ln: [],
        rn: [[], []],
        fn: [],
        eo: null,
        _parent: o,
        P: e,
        Pe: null,
        tt: 0,
        nt: false,
        nn: null,
        Ue: false,
        un: false,
        I: null
      };
      transactions.push(n);
      return n;
    }

    // Lanes (plan sec. 28, 2026-10-02; lanes.ts). A lane is "a new base of a transition":
    // the sub-frame an optimistic write opens in the transition of the frame it
    // is made in. It sees the screen plus its own guesses (plan sec. 19), breaks out of
    // the parent's hold — its effects run now — and holds itself if its own
    // derivations hit async. It ends when the parent lands: a guess reverts to
    // the truth it covered, or lands as the truth that superseded it. A frame
    // that does not park has nothing to be optimistic over: the write is void.

    // The seat of a pass is its node's: a node carrying a lane's value runs as
    // the lane's whoever dirtied it; a derivation's tracked read of a lane's
    // value moves its pass into the lane; a leaf's never does (it reads the
    // screen). Lane work's values go to the lane slot, its runs to the lane's
    // queues; the rest of the frame is the flush's.
    /** The lane the running pass is work of; set at `recompute`'s head from the
     * node, moved by a derivation's lane read, saved and restored around the
     * pass. */
    let passLane = null;

    /** The transaction this flush parks into: set by the first join, merged
     * with every further one. Consumed at the seam. A join outside a flush (a
     * mount's pending observer, a write to a held node, an action opening)
     * schedules the seam that consumes it: membership is the tick's — the same
     * synchronous frame — and the next tick's writes are not this one's. */
    let flushTransaction = null;

    /** The transaction the passes running OUTSIDE a flush this tick derive from
     * (a mainline mount, a mainline re-pass): the passes' own (A29, creation-
     * time form — "the entry is the pass's alone"): their results are staged
     * into it, and nothing else in the tick is — a write made after the mount
     * is a mainline write, a render effect mounted beside it a stale reader.
     * Inside a flush, or in a tick that already has its transaction (an
     * action's body), the frame joins instead (`flushTransaction`) — except a
     * first pass a loading boundary that has not shown content catches (`own`,
     * A29's boundary exemption, #3540): it is the boundary's, not the tick's,
     * and a flush that has joined nothing keeps it pass-scoped as outside one.
     * Cleared by the flush the join schedules, and at the end of a flush that
     * set it. */
    let passTx = null;
    function joinPassTx(e, o) {
      if (globalQueue.Y && !o || flushTransaction !== null) return joinFuture(e);
      if (passTx === null) passTx = resolveTx(e);else merge$1(resolveTx(e), passTx);
      schedule();
    }

    /** The transaction holding a node (CONFIG_HELD set), resolved through
     * merges; the path is compressed. */
    function txOf(e) {
      return e.T.Re = resolveTx(e.T.Re);
    }

    /** `t` resolved through merges while it is still parked or open; null once
     * it has landed. */
    function liveTx(e) {
      e = resolveTx(e);
      return transactions.indexOf(e) !== -1 ? e : null;
    }
    function resolveTx(e) {
      while (e.eo !== null) e = e.eo;
      return e;
    }
    function joinFuture(e) {
      const o = flushTransaction;
      if (o === null) {
        flushTransaction = e === null ? newTransaction(false) : resolveTx(e);
      } else if (e !== null) merge$1(resolveTx(e), o);
      if (!globalQueue.Y) schedule();
    }
    function merge$1(e, o) {
      // Both ends resolved: a stale pointer to a transaction already merged
      // into the other would close a cycle `resolveTx` never leaves.
      e = resolveTx(e);
      o = resolveTx(o);
      if (e === o || e.P || o.P) return;
      e.eo = o;
      o.tt += e.tt;
      o.nt ||= e.nt;
      append(o.ln, e.ln);
      append(o.rn[0], e.rn[0]);
      append(o.rn[1], e.rn[1]);
      append(o.fn, e.fn);
      if (e.I !== null) append(o.I ??= [], e.I);
      transactions.splice(transactions.indexOf(e), 1);
    }

    /** A15: a hold is a property of the async node — observed pending by a
     * render reader. A transaction is blocked while a node it holds, in flight,
     * has one: a pending render effect (the frame itself), or a pending held
     * node a render effect reads. A stale reader served the committed value
     * never went pending, but derives from the flight all the same (#3494) and
     * is still linked to it; a memo between them is pending, and held, too — so
     * one hop of `_subs` is the chain. Reads of the reader's LAST pass only (the
     * link's generation is the pass's): a tail kept for A30 — the committed
     * frame's dependency, awaiting the run that retires it — is not a read of
     * the flight, and a reader that stopped reading releases it (O3, #3494).
     * An errored pass (NotReady included) did not stop: it never got there, and
     * its full list stands (A30) — the reads it did not reach still observe. A
     * flight nobody renders holds nothing (A29). Only the nodes `t` still owns
     * count: one a lane took over since is the lane's to wait on. A guess whose
     * own truth is in flight blocks the lane's parent, not the lane — it stands
     * in for the flight (A17: "visible until its own fetch settles"). */
    function blocked(e) {
      // The transaction being judged (a lane consulted on its behalf judges for
      // it): a zombie whose removal it stages is moot for it alone (`onScreen`).
      const o = judge;
      judge ??= e;
      // An action still running in it holds it open (action.ts). Its lanes
      // (lanes.ts): a lane under `t` blocks it while blocked itself.
      const n = e.tt !== 0 || blockedBy(e.ln, e) || false;
      judge = o;
      return n;
    }
    let judge = null;

    /** A source the pending node waits on that is `t`'s (held by it, or by no
     * one) — not another transaction's or lane's work. Itself, when it is the
     * source. */
    function ownSource(e, o) {
      const n = e.T?.se;
      if (n === undefined) return true;
      for (const e of n) {
        const n = e.T?.Re;
        if (n == null || resolveTx(n) === o) return true;
      }
      return false;
    }
    function blockedBy(e, o, n = false) {
      for (let t = 0; t < e.length; t++) {
        const l = e[t];
        if (!(l.m & STATUS_PENDING) || l.R & REACTIVE_DISPOSED || l.l & CONFIG_GUESS || l.T.Re !== null && txOf(l) !== o || n && !ownSource(l, o) ||
        // A guess lane's member waiting on re-asks only (`reasks`) keeps what
        // it shows, and a `refresh()` holds nothing new (D-34 ¶3): it does not
        // keep the lane's other work off the screen (#4834: a memo over the
        // shown guess and a fresh answer stayed on its stale committed value).
        guessing) continue;
        // The frame's own pending observer (off screen: this one holds nothing;
        // the next listed node may).
        if (l.i === EFFECT_RENDER) {
          // #4544 (F-6): a frame born into the hold that is pending on what a
          // settled verdict reader's display-ahead value asked for (`read`,
          // CONFIG_AHEAD) does not hold it; the reader re-derives at the
          // landing, and the frame with it. A lane's reveal still waits (S-29).
          if (onScreen(l, judge ?? o)) return true;
          continue;
        }
        for (let e = l.o; e !== null; e = e.t) {
          const n = e.u;
          // A frame reader: a render effect, or a stale reader of the flight
          // (REACTIVE_FRAME_READ — a verdict reader, `observeFlight`; lane work,
          // `frameRead`): served committed instead of going pending, it derives
          // from the flight all the same and is re-derived at the landing — the
          // frame's observation survives its reader becoming a lane's (a guess
          // over a held window, V5/A17). A probe alone does not hold. A
          // boundary showing content forwards the pending (its output pending,
          // CONFIG_REDERIVE): transparent, its readers hold through it (A33; the
          // lane-membership ruling, 2026-10-05). An output that never committed
          // shows nothing — a mount the frame has not revealed — and holds
          // nothing.
          if ((n.i === EFFECT_RENDER && n.m & STATUS_PENDING && true || n.R & REACTIVE_FRAME_READ || n.l & CONFIG_REDERIVE && n.m === STATUS_PENDING) && (e.Ne === n.de || n.T?.U != null) && !(n.R & REACTIVE_DISPOSED) && onScreen(n, judge ?? o)) return true;
        }
      }
      return false;
    }

    /** A frame reader whose say counts for `t`'s hold — `t` the transaction
     * being judged: not a zombie whose removal `t` stages (A15 #3463: a re-ask
     * in the unmount frame lands its pending on the zombie it unmounts — the
     * compiled <Show> of #3372; a zombie blocks every other judgment while it
     * is visible, a lane's reveal included: only the commit that disposes it
     * makes its say moot), and not behind a fallback (A33: a boundary showing its fallback is the display of
     * everything under it, so a reader there is not on screen and holds
     * nothing — boundaries.ts). */
    function onScreen(e, o) {
      return !(e.R & REACTIVE_ZOMBIE && removalStagedBy(e, o));
    }

    /** A15 (#3463): a reader whose removal is staged — a zombie, parked by a
     * pass awaiting its commit — is still on screen and live for every hold,
     * except the transaction staging its removal: for that one its say is moot
     * (done, and the commit disposes it; not done, and it stays parked). The
     * staging transaction is the one holding the pass that parked the frame:
     * the nearest non-zombie ancestor. */
    function removalStagedBy(e, o) {
      while (e?.R & REACTIVE_ZOMBIE) e = e._parent;
      return e?.l & CONFIG_HELD && e.T?.Re != null && txOf(e) === resolveTx(o);
    }

    /** Unchanged passes this flush whose stale dependency tail awaits the
     * flush's verdict (A30, #3469): trimmed when the flush commits, kept when
     * it parks — the committed frame still derives from the previous pass's
     * dependencies, and a write to one of them must reach the node until a
     * committing pass replaces it. */
    const heldTrims = [];
    function heldTrim(e) {
      heldTrims.push(e);
    }

    /** Zombies popped from the dirty heap this flush (`deferZombie`). The seam
     * decides their fate: a park cancels them (the writes that dirtied them are
     * held with it); a commit runs the survivors — the ones whose owner is still
     * awaiting its commit — in height order, after the commits that would have
     * disposed them (#3546). No second heap: the list is the deferral. */
    const deferredZombies = [];
    function deferZombie(e) {
      deleteFromHeap(e, dirtyQueue);
      e.R &= -4;
      deferredZombies.push(e);
    }

    /** Put a staged node in a transaction: flagged, stamped, on its landing
     * list. */
    function holdNode(e, o) {
      e.l |= CONFIG_HELD;
      list(e, o);
    }

    /** Put a node on a transaction's list, once: a node's `_transaction` is the
     * transaction whose `_nodes` it is on (every site that sets one does the
     * other), so a re-pass, a re-landing or a re-staging adds nothing. */
    function list(e, o) {
      const n = ext(e);
      if (n.Re === o) return;
      n.Re = o;
      o.ln.push(e);
    }

    /** Hold the (uncommitted) frame under a held pass: every computed in the
     * live child chain, recursively. Plain owners are walked through, not held
     * — nothing reads or re-passes them. Once per park, over the parked frames
     * only; recomputes pay nothing for it. A lane's node in the frame (listed on
     * a lane: a verdict reader broken out of this very hold — display-ahead — or
     * a derivation of a guess, CONFIG_OVERRIDE; a lane pass's effect) is the
     * lane's, as the seam's own loop has it: "lane work never makes its node
     * transaction work" (A15, #3698). Re-listed here it would carry the lane's
     * value on the transaction's list, where the landing nulls its transaction
     * and `dissolveLane` no longer finds it — a lane node with no lane, which the
     * next read of it trips over (`laneRead` → `txOf`). Its frame is the lane's
     * too (ruling A: a lane pass's children are the lane's), revealed and
     * retired at the lane's seam. */
    function holdFrame(e, o) {
      for (let n = e.pe; n !== null; n = n.Ge) {
        if (n.T?.Re?.P) continue;
        if (n.X !== undefined) {
          if (!(n.l & CONFIG_HELD)) holdNode(n, o);
          n.l |= CONFIG_HELD_FRAME;
        }
        holdFrame(n, o);
      }
    }
    const dirtyQueue = {
      et: new Array(2e3).fill(undefined),
      p: false,
      Fe: 0,
      Et: 0
    };
    let clock = 0;
    let scheduled = false;
    let halted = false;
    let haltNotified = false;
    let syncDepth = 0;
    const MAINLINE_QUESTION = 2147483647;
    function schedule() {
      if (halted) {
        notifyHalted();
        return;
      }
      if (scheduled) return;
      scheduled = true;
      if (!syncDepth && !globalQueue.Y) {
        queueMicrotask(flush);
      }
    }
    const HALTED = "[REACTIVITY_HALTED]";
    function haltReactivity(e) {
      if (halted) return;
      halted = true;
      // A cleanup error collected before the halt is dropped (owner.ts).
      rethrowCleanupError(true);
      let o = HALTED;
      // Surface the cause here too: callers rethrow it, but a creation-time throw
      // unwinds through ancestor recomputes that convert it to status instead of
      // surfacing it (#2884), so the rethrow alone cannot guarantee visibility.
      // Where the platform has one, hand the cause to its uncaught-error channel
      // (`reportError` → `error` event → window.onerror / error monitoring): a
      // halt that only reaches console.error leaves a page that LOOKS alive with
      // nothing an app or its telemetry can act on (#3338 — an uncaught throw
      // during the hydration render). The rethrow may reach the top as well in
      // the non-swallowed cases; a duplicate report beats a silent one.
      const n = e !== undefined && globalThis.reportError;
      n || e === undefined ? console.error(o) : console.error(o, e);
      n && n(e);
    }

    // Logs on the first write after a halt so a frozen interaction is traceable.
    function notifyHalted() {
      if (haltNotified) return;
      haltNotified = true;
      console.error(HALTED);
    }
    class GlobalQueue {
      rn = [[], []];
      Y = false;
      flush() {
        if (this.Y) return;
        this.Y = true;
        // A28: companions of nodes written since the last flush mirror the
        // flushed world — re-synced inside the running window (the write is
        // "flushed" from here on).
        resyncUnflushedCompanions();
        passLane = null;
        passTx = null;
        try {
          // Sweep before the heap: unobserved() pulls swept nodes out of it, so
          // a dormant memo dirtied in the same tick is reclaimed instead of
          // recomputed; late subscribers (an effect reading a swept memo this
          // flush) revive it, which is the pay-for-use contract.
          sweepDormant();
          if (revertHook) ;
          runHeap(dirtyQueue, GlobalQueue._e);
          this.settle();
          clock++;
          // A write the commit sweep staged with no subscriber to dirty is work
          // too — the next round commits it.
          scheduled = dirtyQueue.Et >= dirtyQueue.Fe || pendingNodes.length !== 0;
          this.run(EFFECT_RENDER);
          this.run(EFFECT_USER);
          if (false && holding) ;
          if (false && !scheduled) ;
          if (false) ;
        } finally {
          this.Y = false;
          passTx = null;
        }
      }
      /** L2 — the seam: end of the pure phase. Commit this flush's staged nodes,
       * or park them with the transaction the flush joined; then land every
       * transaction no frame is waiting on. The landing flush is an ordinary
       * flush: the settle walk (async.ts) re-ran the parked readers in its pure
       * phase, and here no flight the transaction holds has a frame deriving
       * from it (`blocked`). */
      settle() {
        const e = flushTransaction;
        flushTransaction = null;
        // A lane's own flush (its flight landing, its reveal) parks nothing: the
        // lane's work reached it per pass; the frame's plain writes commit.
        // (Resolved: a guess over another transaction's guess merged them.)
        const o = e !== null && !e.P ? resolveTx(e) : null;
        if (o !== null) {
          // `t._nodes` grows under the walk (holdFrame pushes); the bound is
          // this flush's list, which does not.
          const e = pendingNodes.length;
          for (let n = 0; n < e; n++) {
            const e = pendingNodes[n];
            // Already held: the pass that re-staged it joined its transaction,
            // which is `t` (or merged into it). Lane work is the lane's (a
            // pending mark propagated onto it queued it here too).
            if (!(e.l & (CONFIG_HELD | CONFIG_OVERRIDE)) && (e.T === null || e.T.Re === null || !e.T.Re.P)) {
              // A loading source — pending with nothing staged and no committed
              // value (A16, A19 exc. 1: uninitialized is loading, not pending)
              // that is not an observer — is nobody's frame: not held. Its
              // first landing is commit #0, not a resumption of this frame, and
              // a write that reaches it later overlaps nothing (#2937: the
              // stale stamp was the bridge that entangled unrelated updates
              // with a never-resolving flight). Its observers are held and
              // wait on its flight (`blocked`).
              if (e.ue === NOT_PENDING && e.m & STATUS_UNINITIALIZED && e.i !== EFFECT_RENDER) continue;
              // A34 (2): a tick whose writes net to the committed value made no
              // proposal (`setShow(false); setShow(true)` on a committed true) —
              // not staged, not held, pends nothing; a later write to it is
              // plain mainline. (A node already held stays held when written
              // back: A34 (1).)
              if (e.ue !== NOT_PENDING && !(e.m & (STATUS_PENDING | STATUS_UNINITIALIZED)) && e.T?.me == null && e.T?.Le == null &&
              // A recovery to the last good value is a change of answer
              // (D-41): the error it replaces stays the display until it
              // commits, so it is held, not netted.
              !e.T?.Te &&
              // The comparator last: a pass that created children (an object
              // owning a fresh async memo, #4111) must not have it read them.
              // A NotReady read there is a change (`isSame`).
              isSame(e, e.le, e.ue)) {
                e.ue = NOT_PENDING;
                e.l &= ~CONFIG_STAGED;
                continue;
              }
              holdNode(e, o);
            }
            // A held pass's frame is held with it (ruling A, O2): the children it
            // created are the transaction's — they compute, and a pass over them
            // or a write that reaches them joins; they effect at the landing.
            if (e.l & CONFIG_STAGED) holdFrame(e, o);
          }
          pendingNodes.length = 0;
          // (This flush's runs are stashed with `t` below — after the landings,
          // so a `t` that lands at this very seam runs them first, ahead of
          // the runs it held from earlier flushes.)
          // The batch joins: the writes that dirtied these are held with it — a
          // zombie never displays that world. A verdict reader among them does
          // (#3444: `latest()` inside a branch a held Show is removing peers
          // through like the same read outside): it re-runs now, as the
          // holder's verdict lane's work — before the lane seams, which reveal
          // it (nothing commits this seam that could dispose it).
          // (Verdict readers exist only with the verdict engine installed.)
          deferredZombies.splice(0);
          // The unchanged passes' tails stay linked (A30, #3469): their inputs
          // are held, and the committed frame still derives from them — no trim.
        } else {
          commitPendingNodes();
          // The flush committed: an unchanged pass's stale tail goes now. Not
          // after a later pass this flush that threw (NotReady included — it
          // keeps its full list, `_depsTail` marking where it stopped) or that
          // left an effect owing a run (`runEffect` trims when the run applies):
          // `recompute`'s own gates.
          for (let e = 0; e < heldTrims.length; e++) {
            const o = heldTrims[e];
            if (o.T?.U == null && !o.Ae) trimStaleDeps(o);
          }
        }
        // The list is the flush's either way. Reset only when there is something
        // to reset (`stagedReaders` below likewise): `length = 0` is a runtime
        // call even on an empty array, and the plain flush — no unchanged pass,
        // no lane work — has nothing in either.
        if (heldTrims.length) heldTrims.length = 0;
        // Lanes: a blocked one parks its frame (its own flight is up); an
        // unblocked one reveals this round's work. Then land every transaction
        // no frame is waiting on — its lanes end with it. Backwards: a landing
        // removes its entry.
        // This flush's own runs, the lanes' reveals, and the landings' held runs
        // are collected apart and ordered below.
        const n = this.rn;
        let t = null;
        this.rn = [[], []];
        for (let e = transactions.length - 1; e >= 0; e--) {
          const o = transactions[e];
          if (blocked(o)) continue;
          transactions.splice(e, 1);
          land(o);
          // A landing's commits can dispose a zombie a transaction judged above
          // was blocked on (#3463: live "until the commit that disposes it") —
          // judge them again.
          e = transactions.length;
        }
        // Marks declared outside a transaction: the flush that carried them
        // parked (something async below) — the window is the frame's, the marks
        // are its transaction's; else they release at the seam, verdict-only,
        // nothing to show (affects.ts).
        const l = o && liveTx(o);
        // The effect phase: lane work first (displayed ahead of the frame), then
        // this flush's runs, then the runs the landings held from earlier
        // flushes — as one pass would have queued them (#3540: a shell
        // re-derived at the landing before a boundary swap held since the
        // write; #3528: a display-ahead swap before the count it is shown
        // beside). A parked frame's runs wait with its transaction instead: the
        // effect phase applies a committed frame.
        const s = l !== null;
        for (let e = 0; e < 2; e++) {
          if (s) append(l.rn[e], n[e]);
          // The plain flush — no reveal, no landing, not parked — has nothing to
          // order around its own runs: they are the queue as they stand (the
          // same array, not a copy; `run` takes it whole). Every other seam
          // builds the ordered queue above.
          this.rn[e] = s || t?.[e].length || this.rn[e].length ? ([]).concat(s ? [] : n[e], this.rn[e]) : n[e];
        }
        if (deferredZombies.length !== 0) {
          // Survivors are the displayed frame of a held pass: they rerun for the
          // live write, parents before children.
          const e = deferredZombies.splice(0).sort((e, o) => e.he - o.he);
          for (let o = 0; o < e.length; o++) {
            if (!(e[o].R & REACTIVE_DISPOSED)) recompute(e[o]);
          }
        }
      }
      run(e) {
        const o = this.rn[e - 1];
        if (o.length) {
          this.rn[e - 1] = [];
          runQueue(o, e);
        }
      }
      enqueue(e, o, n = passLane) {
        // Lane work's runs are the lane's: they run at its reveal, not with
        // the frame (which may park). A lane pass that read the frame's own
        // staging is the frame's (`recompute` passes null): its run waits with
        // the frame. So is a run given a transaction that is not a lane (a
        // first run born held, `effect()`).
        if (e) (n?.P ? n : this).rn[e - 1].push(o);
        schedule();
      }
      /** Status reaching the root: pending is absorbed (the root mount defers —
       * dev records it for the ASYNC_OUTSIDE_LOADING_BOUNDARY FYI); an error is
       * unhandled (`false` → the caller halts).
       *
       * L2: this is where a transaction is registered. Pending that reaches an
       * observer (a render effect: the frame) is a frame that cannot show — the
       * flush parks, and the transaction waits on the flight while a frame
       * derives from it (`blocked`). Pending nobody observes holds nothing: a
       * memo in flight that no frame reads is not a frame waiting. (Base: the
       * queue's `_asyncReporters`, INV-3's one registration site.)
       *
       * A boundary between the observer and the root (boundaries.ts) is asked
       * first: a fallback catches what is not ready under it, and the root
       * never hears of it. */
      notify(e, o, n, t) {
        if (o & STATUS_PENDING) {
          if (n & STATUS_PENDING) {
            // A pass that went pending holds its frame: the async's own
            // synchronous frame is not ready (A15 reveal corollary: a reveal
            // that discovers a flight whose inputs are visible holds and joins
            // it; one whose inputs are held is a stale reader and never gets
            // here — `read` serves it the committed value). The frame's, not the
            // observer's: a render effect belongs to whoever dirtied its pass
            // (A15 shared-hole, #3407) — one held by T1 and re-run by T2's write
            // pends for T2's flight, and the two stay parallel; a frame that is
            // T1's already joined T1 through the write or the memo that made it
            // so. Outside a flush — root setup, a mount — the frame is the
            // mount's: its pending observers are one transaction, and a flight
            // started in it resumes it when it lands (maintainer, #3461: "part
            // of the same one"); what the mount published synchronously stays
            // published. Lane work going pending holds the lane, not the frame:
            // `blocked(lane)` finds it in the lane's staging ("if further async
            // downstream is hit it holds like its own transition").
            if (passLane === null) joinFuture(null);
          }
          return true;
        }
        return false;
      }
    }

    /** A15's stale readers: a frame whose LAST pass read a held node as
     * committed re-derives on the landed world — next round, after the commits.
     * One re-derived since (any later pass cleared the bit: in the transaction,
     * or without the held read) owes nothing. A run this transaction stashed
     * for it is void (#3322: an effect has one value slot, and the stale pass
     * overwrote the value that run was for) — the re-derivation's run replaces
     * it. Truthy when an effect re-derives (`land`). */
    function reruns(e) {
      let o;
      for (let n = 0; n < e.fn.length; n++) {
        const t = e.fn[n];
        // An errored reader's display is its error (D-39): the landing gives it
        // nothing to re-derive, and a re-run would be a read that retries the
        // errored source (#3945) — unless that source is errored no longer: the
        // reader was served a shown error the landing replaces (`throwShown`).
        // Nor is the reader's own error: its pass threw over the committed value
        // of what the landing carries, served as the screen (A10; a lane's node
        // reading its parent's hold, or a pass with no value yet reading a
        // staging, `stagedScreen`) — the landing is the new answer, and the
        // reader re-derives on it (A15; D-39). A first load read so has no other
        // run: its error would stay the screen (async-gen 91501 #1158, #119).
        // A boundary's structure (its tree, its output: CONFIG_FRAME, no effect
        // type) re-derives all the same: what it read as the screen is the
        // content the landing replaces, and only its pass links the new content
        // whose recovery must reach it (D-3, D-39, #4405).
        const l = t.T?.U?.source;
        if (t.R & REACTIVE_DISPOSED || t.m & STATUS_ERROR && (t.i || !(t.l & CONFIG_FRAME)) && l !== t && (l?.m ?? STATUS_ERROR) & STATUS_ERROR) continue;
        if (t.R & REACTIVE_FRAME_READ || observeFlightHook) {
          // A memo re-deriving its own error holds the release as an effect
          // does (`land`): run first, the held runs showed that error beside a
          // frame about to replace it (#4407; #4284: the grouping never changes
          // the screen). So does a memo the landing holds (CONFIG_HELD: its
          // staged value is in this frame): the held runs read it, so shown
          // first they showed the stale pass the re-derivation replaces — one
          // frame reveals the change (F-1, A15; #4648). And any other: a memo
          // that asks, or one over it (D-25: a memo over a verdict memo is a
          // verdict reader), was served the screen and asked the screen's
          // question (F-6, S-51); it asks the landed world's now — the held
          // runs park with that flight, never shown beside the answer it
          // replaces.
          o = 1;
          // A lane's reveal leaves the mark to the transaction: a reader that
          // also read a held node as committed (`staleReader`) still observes
          // that flight until it re-runs — cleared here, the transaction landed
          // at this seam with the flight up and voided the reveal's run (#4397).
          if (!e.P) t.R &= ~REACTIVE_FRAME_READ;
          t.Ae = false;
          // Its frame is replaced by the re-derivation: a run one of its
          // children queued this flush (re-run by the same landing) is for the
          // frame being replaced — void too (#3404).
          for (let e = t.pe; e !== null; e = e.Ge) if (e.i) e.Ae = false;
          enqueueSub(t);
        }
      }
      e.fn.length = 0;
      return o;
    }

    /** The landing: the held frame becomes the frame. */
    function land(e) {
      const o = reruns(e);
      // Old children die in the commits (cleanups first), then the stashed
      // effects run ahead of this flush's own. A node a lane took over since
      // (a guess written over the staged truth) is the lane's to land.
      for (let o = 0; o < e.ln.length; o++) {
        const n = e.ln[o];
        if (n.T.Re === null || txOf(n) !== e) continue;
        n.T.Re = null;
        commitPendingNode(n);
      }
      // A cleanup those commits ran that wrote a node `u` still held joined
      // `u`, which has left `transactions`: the write is this landing's, and
      // the next flush must not park in it (#4089).
      if (flushTransaction === e) flushTransaction = null;
      // An effect re-derives next round (`reruns`): the held runs wait for it
      // (D-9, the A15 reveal corollary, #4071). Its re-derivation can discover a
      // flight — a stale reader whose mainline pass stopped reading it, now
      // reading the landed world — and a landing that showed its runs first
      // would reveal the held write beside a frame that can only show its old
      // value. Queued last in this effect phase, the release hands them to the
      // next round's own runs, ahead of the re-derivation's: they show with it,
      // or park with it in the hold its pending opens. The commits stand.
      if (o) globalQueue.rn[1].push(() => releaseQueues(e));else releaseQueues(e);
    }

    /** The held runs join this flush's effect phase after its own runs (the
     * landing's re-passes, in height order): the frame's effects run as one
     * pass would have queued them — a shell re-derived at the landing before a
     * boundary swap held since the write (#3540's log order). */
    function releaseQueues(e) {
      for (let o = 0; o < 2; o++) {
        append(globalQueue.rn[o], e.rn[o]);
        e.rn[o] = [];
      }
    }

    /** `a.push(...b)` without the argument-count limit. */
    function append(e, o) {
      for (let n = 0; n < o.length; n++) e.push(o[n]);
    }

    /** Nodes staged this flush (`_pendingValue` set), committed at its end. */
    const pendingNodes = [];

    /** A15's stale reader: `c` was served the committed value of a node `t`
     * holds (a render effect, a verdict reader, lane work) and is re-derived
     * after `t`'s landing (`_reruns`). Called per read of a held node, so `t`'s
     * list holds one entry per such read, not one per pass: `reruns` re-runs the
     * reader at its first entry and skips the rest by the cleared flag. (A dedupe
     * here costs ~17-30 B minified in every client bundle, which the 10 KB
     * compiled floor cannot take; the repeats are inert and short-lived — the
     * list empties at the landing.) */
    function staleReader(e, o) {
      // On each hold the pass reads committed from: one pass can read two (a memo
      // the flush's hold stages, a row another action's hold keeps), and each
      // landing re-runs it. Guarded by the flag alone, the reader was listed on
      // the first hold only and missed the second's landing (#4932).
      o.fn.push(e);
      e.R |= REACTIVE_FRAME_READ;
    }
    function queuePendingNode(e) {
      pendingNodes.push(e);
      if (!globalQueue.Y) markUnflushedStaged();
      // A28
    }

    /** §12d: bumped by every recompute and every new subscriber edge. A node's
     * staged-rewrite skip is sound only while NOTHING recomputed or linked since
     * its last notify — a mid-batch pull can clean a marked subscriber, and a
     * skipped re-write would leave it stale. */
    let notifyEpoch = 0;
    function bumpNotifyEpoch() {
      notifyEpoch++;
    }
    function insertSubs(e) {
      // §12d: stamp before walking — setSignal's staged-rewrite fast path skips
      // the next walk for this node while the epoch holds (marking is idempotent).
      e.we = notifyEpoch;
      // Presence bits gate the optional-slot probes (see constants.ts): one
      // masked read of the always-present _config instead of missing-property
      // lookups in the hottest notify loop.
      const o = e.l;
      const n = (o & CONFIG_HAS_SNAPSHOT) !== 0 && e.T?.De !== undefined;
      for (let o = e.o; o !== null; o = o.t) {
        const t = o.u;
        // Missed-wake latch (#3037): this write is landing while the subscriber
        // is mid-recompute (a nested pull committing beneath its reads), and the
        // heap refuses RECOMPUTING nodes. A gen-current link means the pass
        // already validated this dep — the value it read is now stale — so latch
        // for recompute's tail to reschedule. Untouched links need no latch (the
        // pass either re-reads them fresh or trims them), and neither does the
        // tail link: it is the read IN FLIGHT — read() links before it pulls, so
        // this very commit is what that read returns.
        // A signal's read returned before any write to it — the pass's own
        // owned write to what it just read is a missed wake too (F-10).
        if (t.R & REACTIVE_RECOMPUTING_DEPS && o.Ne === t.de && (o !== t._ || !e.X)) t.R |= REACTIVE_MISSED_WAKE;
        if (n && t.l & CONFIG_IN_SNAPSHOT_SCOPE) {
          t.R |= REACTIVE_SNAPSHOT_STALE;
          continue;
        }
        enqueueSub(t);
        if (t.R & REACTIVE_OWNER_READS) markNode(t._parent, REACTIVE_CHECK);
      }
    }

    /** An effect owes a run: marked, and its bound runner queued in its phase. */
    function queueEffectRun(e) {
      e.Ae = true;
      globalQueue.enqueue(e.i, e.W ??= GlobalQueue.q.bind(null, e));
    }

    /** A staged value becomes the node's value: truthy when one was staged. */
    function applyStaged(e) {
      return e.ue !== NOT_PENDING && (e.le = e.ue, e.ue = NOT_PENDING);
    }
    function superseded(e) {
      return !(e.m & STATUS_UNINITIALIZED) && !!e.T?.Ee && !e.T.Ve && (e.ue = NOT_PENDING, true);
    }
    function commitPendingNode(e) {
      // L2: the commit is where a pass, held or not, stops being uncommitted —
      // unless it has no answer yet. A pass still in flight (pending, nothing
      // staged) stays uncommitted: a re-pass disposes its children on the spot,
      // and the frame it parked stays the frame until a pass of this node
      // commits a value.
      if (!e.X) {
        e.l &= -385;
        applyStaged(e);
        return;
      }
      // Computeds only from here (`_statusFlags` is not a signal field). A
      // commit beneath a flight publishes its inputs (A15 reveal corollary,
      // #3305): a reveal of it must observe, not show the pre-flight value.
      // A staged answer to a question a later pass of this hold replaced, its
      // own flight up for the new one, is not the frame's: the hold lands on the
      // answer to its own question (F-2, 2026-11-12) — the node stays in flight
      // on the committed value, and the stale staging goes.
      // (A cold helper: inline, the arm cost the commit loop its inlining.)
      const o = (e.m & STATUS_PENDING) !== 0 && (e.ue === NOT_PENDING || superseded(e));
      const n = e.l & CONFIG_STAGED_ERROR;
      // An answer commits: the error it replaces leaves the display (D-41).
      if (!o && e.T) e.T.Te = null;
      e.l = o ? e.l & -1048833 | CONFIG_INPUTS_PUBLISHED : e.l & -3147137;
      // D-41: the staged answer is an error — published now, when a value would
      // show, through the ordinary error path (`stageError`). Its readers first
      // see it in the cycle after this seam: a tracked re-read there is not a
      // retry (`read`), or a boundary re-derived by it would retry it forever.
      if (n) {
        const o = e.ue;
        e.ue = NOT_PENDING;
        e.ie = clock + 1;
        notifyStatus(e, STATUS_ERROR, o);
      } else if (applyStaged(e)) {
        // A node born staged (recompute) initializes at this commit.
        e.m &= ~STATUS_UNINITIALIZED;
        // A quiet re-ask's classification survives its landing and dies with
        // the landed value's commit (A19 exc. 2, #3178): verdict-quiet through
        // the reveal. (The sweep of a node still in flight is not a landing.)
        // The A28 stash goes with it.
        if (e.T != null) e.T.Ve = false, e.T.je = NOT_PENDING;
        // An effect with a staged value was born held (L2): its first run is
        // this commit's, not its creation's (A29) — queue it now.
        if (e.i && e.i !== EFFECT_TRACKED) queueEffectRun(e);
      }
      // The committed value is the first observable answer for a loading-window
      // node — the window closes here, not at compute time (#2990). Unconditional
      // store to an always-present computed slot.
      e.Ie = false;
      e.R &= ~REACTIVE_MANUAL_WRITE;
      // The dependencies of the pass that produced the value are the frame's now:
      // the previous frame's tail goes (A30, #3410; `recompute` left it for a
      // staged pass). Only after a clean pass: `_error` is cleared by a clean
      // pass or by the node's own landing (whose pass was clean), so a set
      // `_error` means the last pass threw, kept its full list, and `_depsTail`
      // marks where it stopped.
      if (e.T?.U == null) trimStaleDeps(e);
      if (!(e.m & STATUS_PENDING)) e.m &= ~STATUS_UNINITIALIZED;
      // L2: the children this commit publishes are the frame's now — the frame
      // they replace, parked by the pass (`recompute`), goes.
      if (!o && e.T != null && (e.T.me !== null || e.T.Le !== null)) GlobalQueue.Ce(e, false, true);
    }
    function commitPendingNodes() {
      for (let e = 0; e < pendingNodes.length; e++) {
        const o = pendingNodes[e];
        // A node a lane pass re-staged this round is the lane's to reveal; one
        // a transaction holds (born held by a mainline pass, `passTx`) is that
        // transaction's to commit, at its landing.
        if (!(o.l & (CONFIG_OVERRIDE | CONFIG_HELD))) commitPendingNode(o);
      }
      pendingNodes.length = 0;
    }
    const globalQueue = new GlobalQueue();
    function flush(e) {
      if (e) {
        syncDepth++;
        try {
          return e();
        } finally {
          // Decrement even if the drain throws (a throwing effect): a leaked
          // syncDepth would stop `schedule()` from ever queuing a microtask again.
          try {
            flush();
          } finally {
            syncDepth--;
          }
        }
      }
      if (globalQueue.Y) {
        return;
      }
      if (halted) return;
      while (scheduled) {
        globalQueue.flush();
      }
      // A cleanup that threw during the drain, now that the drain is complete
      // (owner.ts).
      rethrowCleanupError();
    }
    function runQueue(e, o) {
      for (let n = 0; n < e.length; n++) e[n](o);
    }

    /**
     * Schedule one subscriber to re-run on the next flush: inserted into the
     * dirty heap with the `_min` cursor pulled down. Tracked effects ride the
     * heap too — the heap visit is their (empty) compute phase, which hands the
     * callback to the user queue once the pass has committed (see
     * GlobalQueue._update, #3291).
     */
    function enqueueSub(e) {
      if (dirtyQueue.Fe > e.he) dirtyQueue.Fe = e.he;
      insertIntoHeap(e, dirtyQueue);
    }
    function actualInsertIntoHeap(e, t) {
      const E = (e._parent?.Qe ? e._parent.Ke?.he : e._parent?.he) ?? -1;
      if (E >= e.he) e.he = E + 1;
      const n = e.he;
      const I = t.et[n];
      if (I === undefined) t.et[n] = e;else {
        const t = I.We;
        t.ve = e;
        e.We = t;
        I.We = e;
      }
      if (n > t.Et) t.Et = n;
    }
    function insertIntoHeap(e, t) {
      let E = e.R;
      // RECOMPUTING refusals are not always losses: a genuinely missed wake (a
      // write to a link this pass already validated) is latched link-side in
      // insertSubs as REACTIVE_MISSED_WAKE for recompute's tail (#3037).
      if (E & (REACTIVE_IN_HEAP | REACTIVE_RECOMPUTING_DEPS)) return;
      if (E & REACTIVE_CHECK) {
        e.R = E & -4 | REACTIVE_DIRTY | REACTIVE_IN_HEAP;
      } else {
        e.R = E | REACTIVE_IN_HEAP;
        // An unmarked node entering an already-marked heap is marked on the
        // spot, keeping the markHeap memo valid. `_marked` is only reset by
        // runHeap, so a write between two mid-tick pulls (read-time markHeap +
        // updateIfNecessary) would otherwise leave this node unmarked and every
        // downstream pull stale until the next flush (#2922: the second
        // `latest()` returned the first write's value). Invalidating the memo
        // instead re-walked the WHOLE heap on the next pull — with N effects
        // parked in the heap for a synchronous mount (each row writing a ref
        // signal its effect subscribes to), mounting N rows was O(N²) (#3350).
        // markNode's own guard skips an already-DIRTY node.
        if (t.p) markNode(e);
      }
      if (!(E & REACTIVE_IN_HEAP_HEIGHT)) actualInsertIntoHeap(e, t);
    }
    function insertIntoHeapHeight(e, t) {
      let E = e.R;
      if (E & (REACTIVE_IN_HEAP | REACTIVE_RECOMPUTING_DEPS | REACTIVE_IN_HEAP_HEIGHT)) return;
      e.R = E | REACTIVE_IN_HEAP_HEIGHT;
      actualInsertIntoHeap(e, t);
    }
    function deleteFromHeap(e, t) {
      const E = e.R;
      if (!(E & (REACTIVE_IN_HEAP | REACTIVE_IN_HEAP_HEIGHT))) return;
      e.R = E & -25;
      const n = e.he;
      if (e.We === e) t.et[n] = undefined;else {
        const E = e.ve;
        const I = t.et[n];
        const i = E ?? I;
        if (e === I) t.et[n] = E;else e.We.ve = E;
        i.We = e.We;
      }
      e.We = e;
      e.ve = undefined;
    }
    function markHeap(e) {
      if (e.p) return;
      e.p = true;
      for (let t = 0; t <= e.Et; t++) {
        for (let E = e.et[t]; E !== undefined; E = E.ve) {
          if (E.R & REACTIVE_IN_HEAP) markNode(E);
        }
      }
    }
    function markNode(e, t = REACTIVE_DIRTY) {
      const E = e.R;
      if ((E & (REACTIVE_CHECK | REACTIVE_DIRTY)) >= t) return;
      e.R = E & -4 | t;
      for (let t = e.o; t !== null; t = t.t) {
        markNode(t.u, REACTIVE_CHECK);
      }
    }
    function runHeap(e, t) {
      e.p = false;
      for (e.Fe = 0; e.Fe <= e.Et; e.Fe++) {
        let E = e.et[e.Fe];
        while (E !== undefined) {
          if (E.R & REACTIVE_IN_HEAP) t(E);else adjustHeight(E, e);
          E = e.et[e.Fe];
        }
      }
      e.Et = 0;
    }
    function adjustHeight(e, t) {
      deleteFromHeap(e, t);
      let E = e.he;
      for (let t = e.C; t; t = t.G) {
        const e = t.S;
        if (e.X && e.he >= E) E = e.he + 1;
      }
      if (e.he !== E) {
        e.he = E;
        liftOwned(e, E);
        // (Not an owner reading it: it sits below its child by construction,
        // REACTIVE_OWNER_READS, and a seat below the cursor is never visited.)
        for (let E = e.o; E !== null; E = E.t) if (E.u !== e._parent) insertIntoHeapHeight(E.u, t);
      }
    }

    /**
     * A raised node's owned computations (through roots) move above it (#4848).
     * The heap places a node above its direct owner only, at insert, so an owner
     * raised after its children's birth left a grandchild at or below it, to run
     * before the owner whose run disposes it. Paid when a height changes, never
     * per insert. A child waiting in the heap keeps its seat this pass (its next
     * insert lifts it above its owner); what it owns moves either way.
     */
    function liftOwned(e, t) {
      for (let E = e.pe; E; E = E.Ge) if (E.Qe) liftOwned(E, t);else if (E.he <= t) {
        // A child waiting in the heap moves with it: left at its seat it runs
        // before the owner whose run disposes it.
        const e = E.R & (REACTIVE_IN_HEAP | REACTIVE_IN_HEAP_HEIGHT);
        deleteFromHeap(E, dirtyQueue);
        E.he = t + 1;
        if (e) (e & REACTIVE_IN_HEAP ? insertIntoHeap : insertIntoHeapHeight)(E, dirtyQueue);
        liftOwned(E, t + 1);
      }
    }

    /** The store's shared slot-node release handler (store/store.ts installs it
     * once) — a live binding read directly by the sweep site: no wrapper frame,
     * no null check (a CONFIG_SLOT_NODE node existing implies the store module
     * loaded and registered it). */
    let slotUnobservedHook;

    // https://github.com/stackblitz/alien-signals/blob/v2.0.3/src/system.ts#L100
    function unlinkSubs(e) {
      const n = e.S;
      const l = e.G;
      const o = e.t;
      const s = e.en;
      if (o !== null) o.en = s;else n.Ze = s;
      if (s !== null) s.t = o;else {
        n.o = o;
        if (o === null) {
          // Store slot nodes dispatch to the ONE shared hook — no per-node
          // unobserved closure, no NodeExtension to hold it.
          // A user hook that throws is collected like a cleanup (owner.ts): the
          // unlink and the teardown around it carry on.
          if (n.l & CONFIG_SLOT_NODE) slotUnobservedHook(n);else if (n.T?.Ye) runCleanup(n.T.Ye);
          // No more subscribers; only tear down if CONFIG_AUTO_DISPOSE is set.
          // A pending node is exempt: its in-flight async work is an observer —
          // tearing down would orphan the work and re-execute it on the next
          // read. The settle path runs this same last-one-out check when that
          // observer releases (the untracked-read dormancy sweep guards on
          // pending identically).
          // During a pass's teardown of its unfinished frame, the release waits
          // for the pass to end (`deferredReleases`, #4142).
          // (No cast alias for `dep`: the minifier keeps one.)
          n.X && n.l & CONFIG_AUTO_DISPOSE && !(n.R & REACTIVE_ZOMBIE) && !(n.m & STATUS_PENDING) && (deferredReleases ? deferredReleases.push(n) : unobserved(n));
        }
      }
      return l;
    }
    function trimStaleDeps(e) {
      const n = e._;
      let l = n !== null ? n.G : e.C;
      if (l !== null) {
        do {
          l = unlinkSubs(l);
        } while (l !== null);
        if (n !== null) n.G = null;else e.C = null;
      }
    }

    // Shared by unobserved() and the disposeChildren child loop. The truthy guard
    // (not `!== null`) matters: plain Owners in a child chain have no _deps field,
    // and skipping early also avoids adding one (hidden-class churn) via the
    // null-out below. With `_depsTail` cleared, `trimStaleDeps` unlinks the whole
    // list and nulls `_deps`.
    function clearDeps(e) {
      if (e.C) {
        e._ = null;
        trimStaleDeps(e);
      }
    }

    /**
     * Last-one-out releases held back while a pass tears down the frame of an
     * earlier pass that never committed (#4142). The pass is about to rebuild
     * the same children, which read the same lazy nodes again. Released on the
     * spot, a lazy async memo whose only reader was the old frame's child memo
     * was torn down, re-ran on the new child's read, went pending, and the cycle
     * repeated forever. `recompute` collects them around that teardown and
     * releases what is still unobserved when the pass ends.
     */
    let deferredReleases = null;
    const deferReleases = e => deferredReleases = e;
    function unobserved(e) {
      deleteFromHeap(e, dirtyQueue);
      clearDeps(e);
      disposeChildren(e, true);
    }

    /**
     * Deferred dormancy for never-observed auto-dispose computeds (#3078).
     *
     * An untracked top-level read of a subscriber-less observation-lifecycle memo
     * used to call unobserved() inline at the end of read(). That kept the leak
     * closed (the compute links the memo into its deps' sub lists — without a
     * teardown point a never-observed memo is retained by its sources forever;
     * upstream alien-signals has exactly this retention), but it made reads
     * destructive: each read disposed the node, the next read revived it with a
     * full recompute in whatever ambient transition/lane context happened to be
     * current, so consecutive reads could return different answers with no write
     * in between.
     *
     * Instead, reads queue the node here and the scheduler sweeps at the top of
     * the next flush (before runHeap, so a same-tick dirtying is reclaimed
     * instead of recomputed). Reads become idempotent within a tick (the node
     * stays alive and serves its cache, uniform with observed memos) while
     * reclamation still happens within one microtask — the enqueue site arms
     * schedule(), so a flush is guaranteed even when no other work is queued.
     */
    const dormantNodes = new NewSet();
    function sweepDormant() {
      if (dormantNodes.size === 0) return;
      for (const e of dormantNodes) {
        // Re-validate at sweep time: the node may have gained a subscriber (its
        // lifecycle is the unlinkSubs cascade now), gone pending (in-flight async
        // is an observer; the settle path re-runs last-one-out), lost its
        // AUTO_DISPOSE bit (owner teardown strips it, #3024), or already been
        // torn down.
        if (!e.o && e.l & CONFIG_AUTO_DISPOSE && !(e.m & STATUS_PENDING) && !(e.R & (REACTIVE_DISPOSED | REACTIVE_ZOMBIE))) {
          unobserved(e);
        }
      }
      dormantNodes.clear();
    }

    // https://github.com/stackblitz/alien-signals/blob/v2.0.3/src/system.ts#L52
    function link(e, n) {
      const l = n._;
      if (l !== null && l.S === e) return;
      let o = null;
      const s = n.R & REACTIVE_RECOMPUTING_DEPS;
      if (s) {
        o = l !== null ? l.G : n.C;
        if (o !== null && o.S === e) {
          o.Ne = n.de;
          n._ = o;
          return;
        }
      }
      // A link stamped with the current pass generation was created or reused
      // in-order during this recompute, i.e. it already sits in the validated
      // [deps.._depsTail] prefix — the O(1) equivalent of scanning the dep list
      // (the old alien-signals `isValidLink` walk, O(n²) when a computation
      // re-reads earlier deps non-consecutively, e.g. store leaf reads).
      const r = e.Ze;
      if (r !== null && r.u === n && (!s || r.Ne === n.de)) return;
      const t = n._ = e.Ze = {
        S: e,
        u: n,
        G: o,
        en: r,
        t: null,
        Ne: n.de
      };
      if (l !== null) l.G = t;else n.C = t;
      if (r !== null) r.t = t;else e.o = t;
      // New subscriber edge: staged-rewrite skips (§12d) must not miss it.
      bumpNotifyEpoch();
    }

    // The lazily-created Set is the ONE container for pending sources. Its
    // predecessor — a singular slot promoted to a Set on the second source —
    // created dual state whose migration invariant was easy to break: a third
    // overlapping source landed beside the Set and removePendingSource refused
    // to clear it, stranding the Set members' pending forever (#2893).
    function addPendingSource(e, n) {
      if (e.T?.se?.has(n)) return false;
      (ext(e).se ??= new NewSet()).add(n);
      return true;
    }
    function removePendingSource(e, n) {
      const t = e.T?.se;
      if (!t?.delete(n)) return false;
      if (!t.size) e.T.se = undefined;
      return true;
    }

    // Drops a node's flight reference without touching anything else: the one
    // form shared by the disposal and loading-window sites.
    function clearInFlight(e) {
      if (e.T !== null) e.T.Ee = null;
    }
    function clearPendingSources(e) {
      // This set is node-owned and never shared; dropping the sole reference
      // releases the set and every entry without a redundant clear() walk.
      if (e.T !== null) e.T.se = undefined;
    }

    // A rejection-pending only resolves through the settle sweep over the
    // SOURCE's subscribers, so it is retryable iff a tracked read created that
    // edge: a dep that IS the source, or one whose own pending chain carries it
    // (pending sources propagate the origin node, so this covers any depth).
    // Also guards branch-local recovery: another dependency may still need the source.
    function retryReaches(e, n) {
      for (let t = e.C; t; t = t.G) {
        const e = t.S;
        if (e === n || e.T?.se?.has(n)) return true;
      }
      return false;
    }

    /**
     * A loading-window node hit an unready source (sync throw in recompute, or a
     * NotReadyError-rejected flight): register for the source's settle — the
     * settlePendingSource walk runs off `_pendingSources` + `_blocked` alone —
     * with NO read-visible pending status and no downstream propagation. Commit
     * #0 keeps serving.
     */
    function parkLoadingWindow(e, n) {
      ext(e).fe = true;
      if (n.source) addPendingSource(e, n.source);
      // A settled error is the node's answer ("the error stays the answer until
      // this retry can actually run") — the park must not replace it: reads
      // throw `_error` while STATUS_ERROR is set, and overwriting it here leaks
      // a pending-class NotReadyError from a read-invisible park (#2989).
      if (!(e.m & STATUS_ERROR)) setPendingError(e, n.source, n);
    }
    function setPendingError(e, n, t) {
      if (!n) {
        if (e.T !== null) e.T.U = null;
        return;
      }
      // The given error when it names this source, else the current one when it
      // does (rewritten unchanged), else a fresh one.
      const r = t instanceof NotReadyError && t.source === n ? t : e.T?.U;
      ext(e).U = r instanceof NotReadyError && r.source === n ? r : new NotReadyError(n);
    }
    function forEachDependent(e, n) {
      for (let t = e.o; t !== null; t = t.t) n(t.u, t);
    }

    /** Each dependent reachable from `el`, depth first. `fn` sees every arrival,
     * `seen` when an earlier branch already walked the node (a diamond); the
     * node's dependents are walked once, on its first arrival unless `fn`
     * returns false (then it stays unmarked: a later branch may walk it). */
    function walkDependents(e, n) {
      const t = new NewSet();
      const visit = e => {
        const r = t.has(e);
        if (n(e, r) !== false && !r) {
          t.add(e);
          forEachDependent(e, visit);
        }
      };
      forEachDependent(e, visit);
    }

    // Queue a node to re-run on the next flush (used both when a pending source
    // settles and when an `isPending` observer must re-evaluate after a real error):
    // shared scheduling helper in heap.ts (tracked effects bypass the heap).
    // Settle-time counterpart of unlinkSubs' last-one-out check. A lazy node that
    // loses its last subscriber while STATUS_PENDING is exempt from autodispose
    // (the in-flight work is an observer), so whatever CLEARS that pending state
    // must run the release — otherwise the node stays linked and recomputes
    // forever with zero subscribers (#2934). The node's own promise/iterator
    // callbacks handle their own release (settleAutodispose in handleAsync); this
    // covers derivatively-pending dependents, which have no callbacks of their own.
    // A node whose pass is already queued (the settle walk re-enqueued a
    // `_blocked` reader) is released at that pass's tail, not before it: the
    // release would pull the pass back out of the heap, and the node would wake
    // later with no value for the landing it missed (D-22, #4474).
    function releaseIfSettledUnobserved(e) {
      if (e.X && e.l & CONFIG_AUTO_DISPOSE && !e.o && !(e.R & REACTIVE_ZOMBIE) && !(e.m & STATUS_PENDING)) e.R & REACTIVE_IN_HEAP ? e.R |= REACTIVE_RELEASE_AFTER : unobserved(e);
    }

    // Error-path sweep: notifyStatus(STATUS_ERROR) clears dependents' pending
    // sources through its own recursion (no per-node settle callback), so after
    // the propagation completes, walk the same graph for stranded lazy nodes.
    // Collect-then-release so unobserved() never unlinks under the walk.
    function releaseSettledDependents(e) {
      let n;
      walkDependents(e, (e, t) => {
        if (!t && !e.o && e.l & CONFIG_AUTO_DISPOSE) (n ??= []).push(e);
      });
      if (n) for (const e of n) releaseIfSettledUnobserved(e);
    }

    // Error-dimension twin of settlePendingSource's blocked re-enqueue (#2949):
    // a node in STATUS_ERROR that recovers by recomputing to an UNCHANGED value
    // fires no value notification — the recovery is completely silent. But a
    // dependent that re-ran during the error window consumed its dirty flag and
    // committed nothing (the fresh sibling values it read were absorbed into an
    // errored run), so its committed value is stale. The propagated error is one
    // object identity down the whole dependent tree, and holding it is exactly
    // the "blocked on this error" marker — re-enqueue those holders so they
    // re-run: fresh values commit and flow, and a dependent with another
    // still-broken source simply re-errors. Pending recovery uses
    // settlePendingSource to clear inherited status and retry blocked readers.
    // Walks the full dependent graph
    // (releaseSettledDependents shape): identity holders can sit below an
    // intermediate whose own error state has since been scrubbed or replaced
    // (e.g. an error boundary's tree node).
    /** D-41: an error a pass of a held node found is an answer of
     * that frame — it ends the wait like a value and shows when a value would.
     * Staged like one: `_pendingValue` carries it (CONFIG_STAGED_ERROR), readers
     * in the hold derive from it (`serve` throws it), and the commit publishes
     * it through the ordinary error path (`commitPendingNode` → `notifyStatus`),
     * dependents included. Not for a lane pass, nor a node with no shown value
     * (born held — its error has no frame to wait behind): those publish now,
     * as before. Returns whether the error was staged. */
    function stageError(e, n, t) {
      // Held, or — for a pass's own throw — derived from a staging of a flush
      // (REACTIVE_STAGED_READ is this pass's; a landing after the pass cannot
      // read it, the flush it read a staging of has committed or parked since).
      // Staged whether or not the flush has joined a hold yet: a pass that runs
      // before its async sibling joins is the seam's to decide, like a value
      // (#4109). A flush that parks nothing publishes it at its commit (S-38).
      // Not a projection's derive: its readers learn its error through the
      // family, which the commit's publish never reaches (#4189).
      if (!(e.l & CONFIG_HELD || t && e.R & REACTIVE_STAGED_READ && globalQueue.Y && !e.rr) || passLane) return false;
      // The node answered (an error ends the wait — no longer pending, nor
      // blocked); a shown error stays its display until the commit.
      clearPendingSources(e);
      if (e.T) e.T.fe = false;
      if (!((e.m &= STATUS_ERROR | STATUS_UNINITIALIZED) & STATUS_ERROR)) setPendingError(e);
      e.ue = n instanceof StatusError ? n : new StatusError(e, n);
      e.l |= CONFIG_STAGED | CONFIG_STAGED_ERROR;
      // Readers parked on the flight re-run and derive from the staging; the
      // verdict readers the walk wakes need a flush (#4106); the derivations it
      // reaches carry the staging (`settlePendingSource`).
      settlePendingSource(e);
      schedule();
      return true;
    }
    function settleErroredDependents(e, n) {
      let t = false;
      walkDependents(e, (e, r) => {
        if (!r && e.T?.U === n) {
          enqueueSub(e);
          t = true;
        }
      });
      if (t) schedule();
    }

    // Retire `source` from pending state along the dependent graph rooted at `el`.
    // By default, `el` is the source whose flight settled or was superseded.
    // With a distinct `source`, `el` is a recovered computation that dropped it:
    // the source may still be pending, so dependents with another path to it stay pending.
    function settlePendingSource(e, n = e) {
      // Landing and branch recovery already cleared el's own set. Superseded
      // re-parks can retain an abandoned self entry (source === el), which must
      // retire in the same walk as its propagated copies.
      removePendingSource(e, n);
      let t = false;
      let r;
      walkDependents(e, (o, s) => {
        if (
        // A node an earlier branch settled (a diamond) takes only this early
        // return's verdict re-run / staged-error mark, as the walk did before
        // it was shared.
        s ||
        // A conditional dropped this source, but another dependency can still
        // carry it. Only retire pending state inherited through the recovered
        // branch. Deliberately NOT marked visited on this early return: the
        // carrying dependency may itself be a later branch of this same walk
        // (two unchanged memos converging), and its visit must be free to
        // re-examine this node once that branch has retired the source.
        n !== e && retryReaches(o, n) || !removePendingSource(o, n))
          // A19: a verdict reader holds no pending of its own (it was re-derived
          // when the source went pending, `propagateStatus`), and a landing
          // equal to the committed value notifies nobody — the source settling
          // is its verdict changing: it runs again. (Verdict readers exist only
          // with the verdict engine installed.)
          // D-41: a derivation of a staged error carries it (verdict.ts `stageMark`).
          return false;
        o.ie = clock;
        const i = o.T?.se?.values().next().value;
        // STATUS_ERROR + pending sources only coexist via an errored loading
        // window's park (notifyStatus(STATUS_ERROR) clears pending sources
        // otherwise): the settled error stays the answer through the settle —
        // nulling it here would have reads throw `null` until the re-enqueued
        // retry lands, or lose it entirely if that retry parks again (#2989).
        const f = o.m & STATUS_ERROR;
        if (i) {
          if (!f) setPendingError(o, i);
        } else {
          o.m &= ~STATUS_PENDING;
          if (!f) setPendingError(o);
          // L2: a landing resumes the transaction waiting on it (maintainer: "it
          // resumes the sync frame") — a held reader's re-pass over the landed
          // value is that transaction's work, and the flush that carries it
          // parks into it. A lane's held reader is the lane's (D-37): the flush
          // never takes a lane as its transaction (#4440).
          if (o.l & CONFIG_HELD) joinFuture(txOf(o));
          if (o.T?.fe) {
            enqueueSub(o);
            t = true;
          }
          if (o.T !== null) o.T.fe = false;
          // Fully settled with nobody watching: release candidate (#2934). Checked
          // again at release time — deferred so unobserved() can't unlink subs
          // lists this walk is still iterating.
          if (!o.o && o.l & CONFIG_AUTO_DISPOSE) (r ??= []).push(o);
        }
      });
      // A node the enqueueSub above queued is released at that pass's tail
      // (`releaseIfSettledUnobserved`, REACTIVE_RELEASE_AFTER): the landing's
      // pass is its — released first, it woke later with no value for it
      // (#4474).
      if (r) for (const e of r) releaseIfSettledUnobserved(e);
      if (t) schedule();
    }

    // Object-thenable detection (Promises/A+ shape).
    function isThenable(e) {
      return e != null && typeof e === "object" && typeof e.then === "function";
    }

    /** Fire and clear a node's iterator-flight cancellation hook (#3122). */
    function releaseFlightTeardown(e) {
      const n = e.T?.Se;
      if (n != null) {
        e.T.Se = null;
        n();
      }
    }
    function handleAsync(e, n, t,
    // The flight rejected (after the node's status is set): a projection
    // tells its leaves' readers, who are not the node's dependents
    // (store/projection.ts). `pending`: a NotReady rejection — the node is
    // pending on another source, not errored.
    r) {
      let o = false;
      let s = false;
      if (typeof n === "object" && n !== null) {
        untrack(() => {
          o = n[Symbol.asyncIterator];
          s = !o && isThenable(n);
        });
      }
      if (!s && !o) {
        if (e.T !== null) {
          e.T.Ee = null;
        }
        // A sync landing is the first real answer for a loadingValue node.
        e.Ie = false;
        return n;
      }
      // Flight replacement relies on recompute's supersede release for iterator
      // teardown (#3122): every handleAsync call — including the projection
      // self-registration — runs during a recompute of `el`, which has already
      // fired _flightTeardown. A future non-recompute registration path must
      // release it here before overwriting _inFlight.
      ext(e).Ee = n;
      // The question this flight answers (A18 provenance, lanes.ts): the action
      // whose slice asked it; mainline is always the current question.
      e.T.ce = MAINLINE_QUESTION;
      // The run that asked this flight read every input without throwing: an
      // input still in flight was masked for it (an active override, A17), so
      // pending state those inputs propagated onto the node earlier does not
      // describe this answer. Drop it — the flight is the node's pending now.
      // The landing retires only the flight's own entry (landStatus, #3373), so
      // an entry that survived here would hold the node past its own answer.
      e.T.se = undefined;
      let i;
      const handleError = t => {
        if (e.T?.Ee !== n) return;
        // NotReadyError from rejected promises should be treated as pending, not error
        let o = t instanceof NotReadyError;
        if (o && e.Ie) {
          // Loading window: the flight died waiting on an unready source. Keep
          // serving commit #0 — same parking as recompute's catch for sync
          // dependency throws. The dead flight is released so the clock-gated
          // error-retry pull (updateIfNecessary) can also re-ask.
          clearInFlight(e);
          parkLoadingWindow(e, t);
          e.ie = clock;
          return;
        }
        // D-41: a held node's error is staged (`stageError`) — a derived
        // store's derive's too: its family publishes it at the commit
        // (store/projection.ts `errorFamily`, #4489).
        if (o || !stageError(e, t)) {
          notifyStatus(e, o ? STATUS_PENDING : STATUS_ERROR, t);
          // The error is this pass's answer, published now: it replaces the shown
          // frame as a value's commit would (`commitPendingNode`), so the frame
          // the pass parked goes instead of waiting for a later success. A no-op
          // when nothing is parked.
          if (!o) disposeChildren(e, false, true);
        }
        // A NotReady rejection is a landing into another pending source. The
        // rejected flight will never settle its self entry, so transfer ownership
        // after notifyStatus has propagated the replacement source.
        if (o) settlePendingSource(e);
        e.ie = clock;
        // A real error settles derivatively-pending dependents (notifyStatus
        // cleared their pending sources), so stranded lazy ones release here —
        // the error twin of settlePendingSource's release (#2934).
        if (!o) releaseSettledDependents(e);
      };
      const asyncWrite = (r, o) => {
        if (e.T?.Ee !== n) return;
        // If the node was dirtied by a newer write (optimistic override or regular),
        // skip this stale async result — the upcoming flush will recompute the node
        // with the new value, creating a fresh Promise that supersedes this one.
        // Not a first answer (D-22, F-9): it resolved before the write — only its
        // reaction ran after — so it is a produced value, and the flush that
        // re-asks lands it first (the node is answered, then re-asked). Only
        // `latest`/`isPending` tell such a node from one with no value, so the
        // landing is the verdict engine's (`holdWorkHook`).
        if (e.R & REACTIVE_DIRTY && true) return;
        e.m & STATUS_UNINITIALIZED;
        landStatus(e);
        {
          // CARVE 2: the override-covered landing (hold + A18 supersession) and the
          // lane-routed landing (derived override, lane effect queue) went with
          // the optimistic engine; every landing is the plain setSignal. A node
          // already held stages its answer into that hold (`setSignal`). Its
          // comparator throw is contained there (`isSame`, A3).
          setSignal(e, () => r);
        }
        // First real answer landing: the window closes when the answer becomes
        // OBSERVABLE. A direct commit is observable now; a staged write
        // (`_pendingValue` set inside setSignal) is not — commitPendingNode closes
        // the window when the flush commits it, so no one-frame pulse can leak to
        // observers between the landing and its commit (#2990).
        if (e.ue === NOT_PENDING) {
          e.Ie = false;
          // The landing published: the dependency tail the flight's pass left
          // linked goes now (A30, #3410). A staged landing has not replaced the
          // committed frame yet; `commitPendingNode` trims it.
          trimStaleDeps(e);
        }
        settlePendingSource(e);
        schedule();
        // An answer that lands while a write's flush is queued resolved before
        // that flush was queued, with every answer whose reaction is queued ahead
        // of it: the write's flush carries them all (F-10), each answered, then
        // re-asked (D-22). Flushed here, it would re-ask the write's other async
        // before their answers' reactions ran, and drop them (#4495). Only
        // `latest`/`isPending` tell an answered-then-reasked node from one with
        // no value, so it is the verdict engine's (`holdWorkHook`). A stream's
        // next pull waits for its landing's flush.
        flush();
        o?.();
      };
      // A pending node's in-flight promise is an observer: `unlinkSubs` skips
      // autodispose while STATUS_PENDING so subscriber churn can't orphan the
      // work (a lazy async memo would otherwise tear down and re-execute — one
      // fetch per suspended re-read). Settling is that observer's release, so
      // it runs the same last-one-out check the other release sites run.
      // Returns whether the node released, so the iterator branch can stop
      // pulling values instead of pumping an unobserved stream forever (#2935).
      const settleAutodispose = () => {
        if (e.l & CONFIG_AUTO_DISPOSE && !e.o && !(e.m & STATUS_PENDING)) {
          unobserved(e);
          return true;
        }
        return false;
      };
      // Consumes an AsyncIterable as this flight's value stream. Two postures:
      // LIVE (called synchronously from this read — the compute returned an
      // iterable directly, or a sync-settled thenable held one), where the
      // initial drain may stash a sync first yield for the caller to return and
      // close registration uses the ambient owner; and DEFERRED (the flattening
      // path — a thenable resolved to an iterable in a later microtask), where
      // there is no caller to serve and no ambient owner: sync-settled steps
      // write through asyncWrite, and close registration targets `owner` (el
      // itself) directly. Returns whether a sync answer landed (first yield or
      // empty completion) — meaningful only in the live posture.
      const consumeIterator = (t, r) => {
        const o = t[Symbol.asyncIterator]();
        let s = false;
        let f = false;
        let u = !r;
        const close = () => {
          if (f) return;
          f = true;
          try {
            const e = o.return?.();
            if (isThenable(e)) e.then(undefined, () => {});
          } catch {}
        };
        cleanup(close, r);
        // Flight-identity cancellation (#3122): the registration above is the
        // owner-death backstop; the teardown slot fires at the _inFlight release
        // sites so supersede stops this stream immediately. Assigned, not
        // chained (chaining here costs every app bytes): it replaces any
        // `onSupersede` teardown this run registered earlier, which then falls
        // back to the owner-cleanup channel. A returned `from()` is unaffected:
        // `close` calls its `return()`, which runs its own teardown.
        ext(e).Se = close;
        // Release check before each next pull: an unobserved lazy node must tear
        // down (its close above runs via disposal, closing the iterator) instead
        // of pumping the stream forever with zero subscribers (#2935).
        // Later pulls run from an async continuation with no compute catch above
        // them: a throw invoking the protocol (next(), the step's then) settles
        // as this flight's error instead of escaping as a rejection (#4112).
        const iterateOrRelease = () => {
          try {
            if (!settleAutodispose()) iterate();
          } catch (e) {
            handleError(e);
          }
        };
        const iterate = () => {
          let t,
            r,
            l = false,
            a = false,
            S = true;
          // Protocol tolerance, matching `for await`: `await` unwraps whatever
          // next() returns — a thenable OR a bare IteratorResult. Real producers
          // use the bare form as a promise-free fast path when a value is already
          // buffered (seroval's deserialized streams do), so a bare result is
          // assimilated as an already-settled step instead of crashing on `.then`.
          const E = o.next();
          const c = isThenable(E) ? E : {
            then: e => void e(E)
          };
          c.then(r => {
            // The sync stash only serves the INITIAL drain (handleAsync's caller
            // consumes syncValue / throws NotReady from it). A sync-settled step
            // after an async gap — seroval buffering values between pulls, a
            // sync-thenable producer mid-stream — has no caller reading the
            // stash: it must write through the async path or the value is
            // silently dropped. (The deferred posture never has a caller, so
            // initialRead starts false there and everything writes through.)
            if (S && u) {
              t = r;
              l = true;
              if (r.done) f = true;
            } else if (e.T?.Ee !== n) {
              return;
            } else if (!r.done) {
              s = true;
              asyncWrite(r.value, iterateOrRelease);
            } else {
              f = true;
              if (s) {
                schedule();
                flush();
              } else {
                // Empty completion settles like the immediately-done sync path.
                asyncWrite(undefined);
              }
              settleAutodispose();
            }
          }, t => {
            if (S && u) {
              r = t;
              a = true;
            } else if (e.T?.Ee === n) {
              f = true;
              handleError(t);
              settleAutodispose();
            }
          });
          S = false;
          if (a) {
            // Match the promise branch, but only rethrow during the initial read.
            f = true;
            handleError(r);
            if (u) throw r;
            return true;
          }
          if (l && !t.done) {
            i = t.value;
            s = true;
            return iterate();
          }
          return l && t.done;
        };
        const l = iterate();
        // Later iterate() calls run from asyncWrite, where rethrowing would be unhandled.
        u = false;
        return s || l;
      };
      // Landed-synchronously verdict for a LIVE iterator drain; null when no live
      // drain ran (plain promise flight, or a deferred flatten). Drives the
      // shared NotReady/loading tail below.
      let f = null;
      // Flatten one async level: a thenable that RESOLVES to an AsyncIterable —
      // the shape every async stub returning a stream produces — consumes as the
      // stream itself rather than settling on the iterable object. One level
      // only: A+ `then` already collapses nested thenables, so the resolved
      // value is never itself a thenable.
      const flattenIfIterable = (e, n) => {
        let t = false;
        if (typeof e === "object" && e !== null) {
          untrack(() => {
            t = e[Symbol.asyncIterator];
          });
        }
        if (!t) return false;
        i = undefined;
        const r = consumeIterator(e, n);
        if (!n) f = r;
        return true;
      };
      if (s) {
        let t = false,
          r = false,
          o,
          s = true;
        n.then(r => {
          if (s) {
            i = r;
            t = true;
          } else {
            // Flattening consumes the stream as the value: each yield lands
            // through asyncWrite under this flight's identity; the first one
            // clears pending exactly like a plain promise resolution would.
            // Disposed nodes never start a pump (their disposal list already
            // ran, so nothing could close the iterator). Consumption starts in
            // a microtask where the ambient owner is gone, so the close
            // registers on el's own disposal list. Iterator setup here has no
            // compute catch above it: a protocol throw settles as this
            // flight's error (#4112).
            try {
              if (e.T?.Ee === n && !(e.R & REACTIVE_DISPOSED) && flattenIfIterable(r, e)) return;
              asyncWrite(r);
            } catch (e) {
              handleError(e);
            }
            settleAutodispose();
          }
        }, e => {
          if (s) {
            o = e;
            r = true;
          } else {
            handleError(e);
            settleAutodispose();
          }
        });
        s = false;
        if (r) {
          // Settle through the same status path an async rejection uses, then
          // unwind the in-progress synchronous read so the errored node isn't
          // momentarily read as `undefined`.
          handleError(o);
          throw o;
        } else if (!t) {
          // Not landed: the shared tail below suspends, or — loading window —
          // serves commit #0 (first-flight work on a loadingValue node is
          // loading-class, invisible to boundaries; the flight itself is already
          // registered in _inFlight and lands through asyncWrite). A promise is
          // never an iterator, so nothing between here and there runs.
          f = false;
        } else if (!flattenIfIterable(i)) {
          // Synchronously-resolved promise: the first real answer landed.
          e.Ie = false;
        }
        // A sync-resolved promise holding an AsyncIterable flattened LIVE (we
        // are still inside the synchronous read): full initial-drain semantics
        // apply and the shared tail below settles the verdict.
      }
      if (o) flattenIfIterable(n);
      if (f !== null) {
        if (!f) {
          // Loading window: serve commit #0 instead of suspending.
          if (e.Ie) return e.le;
          throw new NotReadyError(context);
        }
        // A sync first yield (or immediate empty completion) is the first real
        // answer; async yields clear inside asyncWrite.
        e.Ie = false;
      }
      return i;
    }
    function clearStatus(e, n = false) {
      if (e.T?.se) clearPendingSources(e);
      if (e.T?.fe) e.T.fe = false;
      e.m = n ? 0 : e.m & STATUS_UNINITIALIZED;
      if (e.T?.U) setPendingError(e);
      const t = statusNotifierOf(e);
      if (t) t.call(e);
    }

    /**
     * Status clear for a flight LANDING (asyncWrite). A landing answers the
     * node's OWN question — it retires the node's self entry, not the pending
     * state its sources propagated onto it. An input re-asked while this flight
     * was up (a second write to the signal feeding `a` while `b`'s first flight
     * is in the air, #3373) marks `b` pending on `a` by propagation, with `b`'s
     * flight still current: nothing superseded it (the re-ask only changed `a`'s
     * status, not yet its value), so the landing arrives, and a full clear made
     * `b` answer with the stale value — the newer signal committed beside the
     * older derived value (`2 / 1`) for the gap (#3376).
     * With another source still pending the node stays derivatively pending on
     * it; the landed value is written below (the staged answer is still the
     * answer for the inputs it was asked with) and the input's own settle
     * releases it, or its value change recomputes the node into a fresh flight.
     * `_blocked` clears like a full clear: a landing that passed the `_inFlight`
     * guard was not superseded by a re-run (recompute nulls `_inFlight` first),
     * so the flag is the flight's own registration throw — the input settling
     * unchanged must not re-run the node (an extra flight for the same inputs).
     * The node is already STATUS_PENDING in that branch (only notifyStatus fills
     * the set, with status; a loading-window park cannot coexist with a live
     * flight since registration drops the set), so the flags only change when
     * the first landing retires UNINITIALIZED. `_error` must move off self: a
     * reader thrown NotReady(self) would park on a retired entry. Companions
     * keep their verdict (pending before and after; the write re-syncs them).
     */
    function landStatus(e, n = false) {
      const t = e.T?.se;
      // (The full clear below drops the set whether or not self was retired first.)
      if (t && (t.delete(e), t.size)) {
        e.T.fe = false;
        if (n) e.m = STATUS_PENDING;
        setPendingError(e, t.values().next().value);
      } else clearStatus(e, n);
    }
    function notifyStatus(e, n, t) {
      // Wrap regular errors to track source node
      if (n === STATUS_ERROR && !(t instanceof StatusError) && !(t instanceof NotReadyError)) t = new StatusError(e, t);
      const r = n === STATUS_PENDING && t instanceof NotReadyError && t.source;
      // (CARVE 2: the lane assignment went with the engine.)
      if (r) {
        // D-41: a re-ask of a shown error keeps it the display (`_shownError`).
        if (e.m & STATUS_ERROR) e.T.Te = e.T.U;
        addPendingSource(e, r);
      } else clearPendingSources(e);
      // An error answering a node with no value marks it so; a re-ask of it
      // (pending, from a source or not) is uninitialized again — still no
      // value; a write (STATUS_NONE) gives it one.
      e.m = n | (n === STATUS_ERROR ? e.m & (STATUS_UNINITIALIZED | STATUS_NO_VALUE) ? STATUS_NO_VALUE : 0 : n === STATUS_PENDING && e.m & STATUS_NO_VALUE ? STATUS_UNINITIALIZED : e.m & STATUS_UNINITIALIZED);
      // A propagated pending keeps its current source so readers park on the
      // distinct pending source.
      if (r) setPendingError(e, r, t);else ext(e).U = t;
      const o = statusNotifierOf(e);
      if (o) {
        o.call(e);
        return;
      }
      propagateStatus(e, n, t);
    }

    /** The dependents' half of `notifyStatus`: `el`'s status reaches each
     * subscriber as a propagated mark (or a re-derive). On its own for a store
     * family's leaves, which are not the derive's dependents — the family
     * propagates the derive's status from each leaf to the leaf's readers
     * (store/projection.ts `wakeFamily`), exactly as a memo's would reach its. */
    function propagateStatus(e, n, t) {
      const r = n === STATUS_PENDING && t instanceof NotReadyError && t.source;
      forEachDependent(e, (o, s) => {
        o.ie = clock;
        // A pending mark on a kept-tail link re-derives the subscriber instead of
        // marking it (A30, #3494 review; fuzzer latest-1 #2141; #3519 review).
        // Past `_depsTail` lie the committed frame's deps, kept by A30 because
        // that frame still derives from them while the pass that dropped them is
        // staged. A source going pending there is a question for the node's NEXT
        // pass, not a fact about its current one. Re-derived, the pass decides:
        // it reads the dep and registers through its own read, or reads neither
        // and is done. Clears and errors still ride every link. A link inside the prefix carries the
        // pass's generation (`link()`), so the test is O(1); mid-pass the prefix
        // is what the pass has read so far, and the heap refuses a recomputing
        // node — a dep it has yet to reach registers through its own read.
        // A verdict reader likewise (CONFIG_VERDICT), for either status: the
        // dependency going pending or erroring changed what `isPending`/`latest`
        // answer, so its pass runs again — it decides, breaking out as the
        // verdict lane's, going pending through a plain read of its own, or
        // answering an errored source (`isPending` false; `latest` throws it).
        // Inheriting the error would make a probe's reader errored. A boundary's
        // output (CONFIG_REDERIVE, boundaries.ts) the same: content or fallback
        // is its pass's call.
        // Not one D-25 makes the hold's work (verdict.ts `holdWork`): an async
        // memo with no verdict window of its own reads a verdict memo's value,
        // and that source going pending changes none of its reads — re-derived,
        // it is served the committed value it already derived from (A10) and
        // asks that question again. It waits on the source like any derivation
        // (F-9), and asks its next question once, at the landing (#4397).
        // A node carrying a staged error re-derives on a pending mark: its
        // source asks again, and the staging it carried is not the answer
        // (#4109, `stageMark`).
        if (o.l & CONFIG_REDERIVE || holdWorkHook || n === STATUS_PENDING && s.Ne !== o.de) {
          // A source that settled (an error, a sync value) is one the re-derived
          // pass no longer waits on: retire it from the subscriber's pending
          // sources here, as the marked path does through `notifyStatus` and a
          // landing does through the settle walk. Left in place, the entry
          // outlives the pass — a re-park on a second source keeps it (the
          // re-park sweep in `recompute` sees the dep it still reads) — and that
          // source's landing finds it as `remaining`: the subscriber stays
          // pending on a source that will never settle, and its boundary never
          // releases (found while shadowing the seat table).
          // Its dependents carry the entry too (propagated through it): a
          // re-derive to the same value notifies none of them, so the walk
          // retires it there as well — left, a render effect behind a verdict
          // memo stayed pending on the source and held its frame (an Errored
          // fallback's `isPending` ternary after a reset).
          if (n !== STATUS_PENDING && removePendingSource(o, e)) settlePendingSource(o, e);
          enqueueSub(o);
          schedule();
          return;
        }
        // Already pending on this source (a re-ask of its flight): the status is
        // unchanged and nothing re-notifies. The re-asking write is held with the
        // flight the observer waits on (fuzzer #3446 P1): the propagation joins
        // the observer's transaction. An independent render effect in the same
        // frame still passes through — its pass is the frame's (#3372, compiled
        // shape: the unmount it stages makes the observer a zombie whose say is
        // moot for this transaction, A15 #3463).
        if (r && o.T?.se?.has(r)) {
          if (passLane === null && (o.l & (CONFIG_HELD | CONFIG_OVERRIDE)) === CONFIG_HELD && globalQueue.Y && true) joinFuture(txOf(o));
          return;
        }
        if (r || n !== STATUS_PENDING && (o.T?.U !== t || o.T?.se)) {
          // The marked subscriber is queued for the commit sweep so its status
          // bookkeeping (loading window, uninitialized clear) runs with the flush
          // — with the lane, when the pass propagating is the lane's work and
          // the dependent's pending is the lane's own flight (`laneStage`).
          // (No answer: a pending propagation leaves a written guess a guess.)
          {
            queuePendingNode(o);
            // A15 (#3443): pending propagates onto a held memo without
            // recomputing it, and the propagation itself enters the memo's
            // transaction — the flight flows into a memo that transaction
            // holds, so the write that started it is held with it. A render
            // effect's membership is its pass's (`notify`), never sticky.
            if (n === STATUS_PENDING && (o.l & (CONFIG_HELD | CONFIG_OVERRIDE)) === CONFIG_HELD && !o.i) joinFuture(txOf(o));
          }
          notifyStatus(o, n, t);
          // A derived store's derive (store/projection.ts): marked, not re-run —
          // its leaves' readers are not its dependents, so the family walks them.
          o.rr?.st(n, t);
        }
      });
    }

    // The heap's per-node step. A tracked effect's heap visit is its compute
    // phase — empty, like a user effect whose compute reads nothing — and hands
    // the callback to the user queue. Routing the wake through the heap, rather
    // than straight into the queue at notify time, is what orders the run after
    // the commit regardless of which phase the write came from: a write in a
    // render-effect callback stages its value for the next pass, but a wake pushed
    // directly into the user queue ran in the SAME pass, read the old value, and
    // nothing re-notified it when the value landed (#3291).
    GlobalQueue._e = e => {
      if (e.i === EFFECT_TRACKED) {
        deleteFromHeap(e, dirtyQueue);
        e.Ae = true;
        globalQueue.enqueue(EFFECT_USER, e.Z);
      }
      // L2: a zombie's fate is the seam's — its owner's commit disposes it, or
      // the park cancels the pass (the write that dirtied it is held). It runs
      // only past a seam that left it alive (a live write to a frame whose
      // owner is held in the future). Its lane's own re-staging is a live write
      // (REACTIVE_LANE_DIRTY — a lane shows ahead of any park): it runs now, as
      // the lane's work, for the reveal this seam (#3463).
      else if (e.R & REACTIVE_ZOMBIE && !(e.R & REACTIVE_LANE_DIRTY)) deferZombie(e);
      // A lane frame's member (parked by a lane pass, #3698) follows mainline
      // writes only: a lane's dirty on it is cancelled — the lane's apply retires
      // it, and the pass that replaced it already decided what that screen shows
      // (#4137: a `<Show>` branch withdrawn by its own lane re-ran on a falsy
      // condition).
      // (Lanes exist only with the lane engine installed: folded away without.)
      else recompute(e);
    };
    GlobalQueue.Ce = disposeChildren;
    let tracking = false;
    let context = null;
    function recompute(e, t = false) {
      // §12d: any recompute can clean a marked subscriber — invalidate skips.
      bumpNotifyEpoch();
      const n = e.i;
      let o;
      // CARVE 2: lane posture resolution (OPTIMISTIC_DIRTY, derived-override
      // re-derivation, lane adoption through deps) went with the optimistic engine.
      // An error a pass staged, which this pass replaces (`valueChanged`).
      const a = e.l & CONFIG_STAGED_ERROR;
      if (!t) {
        deleteFromHeap(e, dirtyQueue);
        if (e.T !== null) {
          e.T.Ee = null;
          // Supersede is where an iterator flight dies (#3122): close it now.
          // Idempotent with the cleanup-channel close.
          releaseFlightTeardown(e);
        }
        // L2: a pass over a held derivation joins its transaction — the
        // propagation that reached this node reached the transaction, and this
        // pass's answer replaces the held one there. A node held with nothing
        // staged — pending when its flush parked, or a member of a held frame —
        // joins all the same. Not a render effect (rule 3): it is the frame.
        // Re-run outside its transaction's flush it publishes mainline — the
        // value it staged there is superseded (`frameRead` remembers it for the
        // landing). A frame born into the transaction (`bornInto`: never run,
        // A29, or mounted by a pass of it still awaiting its commit, #4010) keeps
        // staging: live writes keep it current, it effects at the swap (ruling
        // A).
        // A boundary's structure (CONFIG_FRAME) is the frame like a render
        // effect: it publishes mainline outside its transaction's flush (#4283).
        if (e.l & CONFIG_HELD) {
          const t = txOf(e);
          // Held by a blocked lane: the frame joins nothing — a lane never holds
          // a sync write (#3460). The pass is the lane's if it reads the lane's
          // world (`read`), and has left it otherwise.
          // An answered deferred node's re-pass is a lagging question (D-40):
          // it joins nothing, so the write that reached it commits mainline.
          // `EFFECT_RENDER << 23` is CONFIG_FRAME (a render effect, a boundary's
          // tree and output), spelled from the effect type as at creation.
          // A verdict reader born into `tx` (`bornInto`: never committed) is the
          // hold's own work, whatever it asked before (D-25): it joins like any
          // held pass, so what it mounts is the hold's (D-13, #4467).
          if (t.P || e.l & CONFIG_LAGS) ;else if (!(e.l & (CONFIG_VERDICT | EFFECT_RENDER << 23)) || observeFlightHook) joinPassTx(t, freshHook?.(e, e.m & STATUS_UNINITIALIZED));else if (t !== flushTransaction && !(e.m & STATUS_UNINITIALIZED || e.l & CONFIG_HELD_FRAME)) {
            // Published mainline, it is not held: the frame this pass builds is
            // replaced on the spot (#3404) — this flush's commit retires the
            // committed frame the held pass had parked (`commitPendingNode`),
            // after the new frame's first runs, and the held pass's own
            // children die below (`disposeChildren`). The landing re-derives a
            // fresh held frame for the reveal (`_reruns`).
            // Not held any more, whichever frame reader it is: its readers read
            // the value this pass publishes — those that read the staging it
            // supersedes re-derive, even when it publishes the committed value
            // back (no change to notify them by): their held runs carry the
            // superseded frame, and the landing would apply them (#4378).
            if ((e.ue) !== NOT_PENDING) insertSubs(e);
            e.ue = NOT_PENDING;
            e.l &= ~CONFIG_HELD;
          }
        }
        // The previous pass's frame. If that pass is still awaiting its commit
        // (CONFIG_STAGED) its children were never shown and die on the spot — the
        // frame parked before it stays parked. Otherwise they ARE the frame:
        // park them until this pass commits. Tracked effects run after the seam
        // and own nothing to park.
        if (n === EFFECT_TRACKED || e.l & CONFIG_STAGED) {
          // A lazy node only those children read is released when this pass
          // ends, if the pass doesn't read it again (#4142). A cleanup or
          // `unobserved` hook that throws here neither stops the pass nor skips
          // that drain: its error is rethrown when the flush ends (owner.ts).
          const t = deferredReleases;
          deferReleases(o = []);
          disposeChildren(e);
          deferReleases(t);
        } else if (e.pe !== null || e.ke !== null) parkChildren(e);
        if (e.l & CONFIG_STAGED_ERROR) {
          e.ue = NOT_PENDING;
          e.l ^= CONFIG_STAGED_ERROR;
        }
      }
      const _ = e.m & STATUS_UNINITIALIZED;
      // Capture both error and pending status before the compute clears them.
      // A conditional can drop its pending source and recover to an unchanged
      // value, leaving blocked dependents outside that source’s settle walk.
      const I = e.m & STATUS_ERROR && e.T?.U;
      const N = (e.m & STATUS_PENDING) !== 0;
      const u = N && e.T?.se;
      // Pending SOURCE-hood, captured before the compute clears status: a node
      // whose own flight parked dependents self-registers in _pendingSources
      // (notifyStatus, isSource). If this recompute supersedes that flight and
      // settles synchronously, those dependents settle HERE — asyncWrite's
      // settlePendingSource walk never runs for a landing that was preempted
      // (#3181).
      const f = e.T?.se?.has(e);
      // D-41: this pass's error is staged, not published (`stageError`).
      let T = false;
      // A19 exc. 2: a `refresh()` re-asks the question already answered — quiet
      // for the verdict — unless the question in flight is a new one, which the
      // re-ask does not launder (a poll during a quiet confirm stays quiet).
      // Nor a guess's new question whose answer is still held (#4336: an
      // action's refresh after an outside input change has not committed it).
      // A held user write is not an answer (REACTIVE_MANUAL_WRITE): the refresh
      // over it asks the same question (D-34 ¶3), so its readers stay the
      // re-ask's and a later lane's guess reaches them (#4887, #4888).
      let S = (e.R & REACTIVE_REASK) !== 0 && !((e.m & STATUS_PENDING || e.ue !== NOT_PENDING && !(e.R & REACTIVE_MANUAL_WRITE)) && e.T !== null && !e.T.Ve);
      const A = context;
      context = e;
      e._ = null;
      e.de++;
      // REACTIVE_ZOMBIE is position: it says the node sits on its owner's parked
      // frame, and the splice/reawaken paths key off it. A zombie reruns for
      // live writes until the commit that disposes it, so every per-pass wipe
      // — here, the finally below, updateIfNecessary — carries it (#3543).
      // A settle found this node unobserved while this pass was queued
      // (REACTIVE_RELEASE_AFTER): the release is this pass's tail's (#4474).
      const c = e.R & REACTIVE_RELEASE_AFTER;
      e.R = REACTIVE_RECOMPUTING_DEPS | e.R & (REACTIVE_ZOMBIE | REACTIVE_REASK);
      e.ie = clock;
      // The pass's previous value: its staging (a lane node's is its lane's,
      // lanes.ts), else the committed one.
      let R = e.ue !== NOT_PENDING ? e.ue : e.le;
      let C = e.he;
      let O = false;
      // L2: did this pass read the future (REACTIVE_JOINED, set by read) — or,
      // a lane's mount, a staging of this flush (#3851, #4166)?
      let d = false;
      let D = tracking;
      tracking = true;
      try {
        // (The CONFIG_SYNC fast arm is prod-only: a dev build takes the general
        // arm for every node, so the D-42 check there sees sync nodes too.)
        if (!false && e.l & CONFIG_SYNC) {
          R = e.X(R);
          if (e.T !== null) e.T.Ee = null;
          e.Ie = false;
        } else {
          // A projection's body self-registers its flight through handleAsync
          // (with the commit as setter): its undefined return is not a sync
          // answer, and the outer handleAsync must not clobber the registration.
          const t = e.T?.Ee;
          const n = e.X(R);
          const o = typeof n === "object" && n !== null;
          const E = e.T?.Ee !== t;
          // D-42 (dev): the body returned after a reactive read threw into it —
          // the catch around that read ran and swallowed (CAUGHT_REACTIVE_READ),
          // unless what returned is the flight the throw became (async.ts judges
          // that at its settle). Before handleAsync: a pending flight throws out.
          if (false) ;
          R = E || !o ? n : handleAsync(e, n);
          if (!E && !o) {
            if (e.T !== null) {
              e.T.Ee = null;
              if (holdWorkHook) ;
            }
            // A sync (non-object) return is the first real answer; async-shaped
            // results clear inside handleAsync at their own landing points, and a
            // self-registered flight clears when its own handleAsync lands.
            e.Ie = false;
          }
        }
        // On a status-free node clearStatus is a guaranteed no-op: every field
        // its body gates on is either _statusFlags or lives in the cold
        // extension — no extension, no status to clear. (_x from an unrelated
        // installer just makes clearStatus a cheap re-verified no-op.)
        // Lane work this pass served the committed value of a flight still in
        // the air keeps the pending it had: the lane breaks out of the flight
        // (A31), the node's world does not — a boundary waiting on it keeps its
        // fallback (F-4, #4862; lanes.ts `laneServed`). (Behind the hook: a
        // build without the lane engine folds the arm away.)
        if ((e.m !== 0 || e.T !== null) && !(laneServedHook && e.m & STATUS_PENDING && laneServedHook(e, null, true))) clearStatus(e, t);
      } catch (t) {
        const n = t instanceof NotReadyError;
        if (n && e.Ie) {
          // Loading window with an unready sync dependency: register for the
          // source's settle (the settlePendingSource walk runs off
          // _pendingSources + _blocked alone) but take NO read-visible pending
          // status and no downstream propagation — the committed loading value
          // keeps serving. If the
          // node is currently errored the error stays the answer until this
          // retry can actually run.
          parkLoadingWindow(e, t);
        } else {
          // D-41: a pass of a held node, or one that read a staging of this
          // flush, stages its error (`stageError`).
          if (n || !(T = stageError(e, t, true))) {
            if (n) ext(e).fe = true;
            notifyStatus(e, n ? STATUS_PENDING : STATUS_ERROR, t);
            // The replacement source is fully propagated now. If no new flight
            // re-owned self, retire the superseded flight and its dependent copies.
            if (n && f && !e.T?.Ee) settlePendingSource(e);
          }
          // A re-park drops what the earlier pass carried (#3456): a source this
          // pass no longer reaches — its branch switched, or a fresh flight
          // replaced the inputs' pending with its own — stays copied onto
          // dependents that reached it only through here, and its landing walk
          // stops at this node (nothing left to retire) before it finds them. A
          // dependent then waits forever on a flight it has no path to. The
          // re-park twin of the unchanged-value recovery sweep below; dependents
          // with another path keep the source (retryReaches). A staged error
          // answered what the pass carried: the same. A source still in the set
          // is dropped too once it is no longer pending and no dep reaches it: a
          // re-park that keeps the set adds to it, so a stale entry survives the
          // pass — a first answer staged in place of its flight (uninitialized
          // until its commit, so its own settle walk waits) leaves the copy here
          // while the readers in between re-derive clean (#4541). A still-pending
          // source has its own settle walk to come, so it is kept without the
          // deps walk (S carried × D deps per re-park otherwise).
          if ((n || T) && u) for (const t of u) if (t !== e && !(e.T?.se?.has(t) && (t.m & STATUS_PENDING || retryReaches(e, t)))) settlePendingSource(e, t);
        }
      } finally {
        tracking = D;
        // Consume the missed-wake latch (#3037, set by insertSubs): a dep write
        // landed beneath this pass on a link it had already validated. The wipe
        // below must not key off DIRTY/CHECK — the read-time pull protocol
        // (markNode(c) in read()) marks the running node as part of ordinary
        // bookkeeping, and those marks are correctly discarded here.
        O = (e.R & REACTIVE_MISSED_WAKE) !== 0;
        // A mount's staged read joins it — except a nested derivation left
        // pending: no render effect reaches it yet, so it holds nothing and
        // reaches no boundary (Reader, #4203), whatever it read — a memo the
        // mount bore held over the staging included, at any depth (#4340). A
        // reader that does is caught.
        d = !!(e.R & (REACTIVE_JOINED));
        // REACTIVE_DISPOSED survives too (#3621): the pass may have disposed its
        // own owner (a memo calling its root's `dispose()`, a cleanup doing so
        // #3601/#3606), and `disposeChildren` set the flag on this node
        // reentrantly. Dropped, the node read as live — `refresh()` re-ran it
        // and `isDisposed()` lied. REACTIVE_FRAME_READ (A15 stale reader) is
        // this pass's verdict for the landing; the next pass's wipe at the top
        // clears it.
        e.R = e.R & (REACTIVE_ZOMBIE | REACTIVE_DISPOSED | REACTIVE_FRAME_READ | REACTIVE_STAGED_READ | REACTIVE_LANE_READ | REACTIVE_SCREEN_READ | REACTIVE_PROBE_UNANSWERED) | (t ? e.R & REACTIVE_SNAPSHOT_STALE : 0);
        context = A;
        if (o) for (const e of o) releaseIfSettledUnobserved(e);
        if (e.T !== null) e.T.Ve = S && (e.m & STATUS_PENDING) !== 0;
      }
      // A node that died during its own pass (#3621) is dead at the end of it,
      // and the pass is void. Its owner's teardown already unlinked its deps,
      // removed it from the heap and ran its cleanups; what remains is what the
      // body did AFTER the `dispose()` call: reads that re-linked the dead node
      // to its sources (unlinked here — the leak that kept it re-running in a
      // torn-down tree), a flight it may have started (retired: the landing
      // checks `_inFlight` identity), and the value it returned. That value is
      // NOT published: a dead node freezes at its last committed value (#3024),
      // so nothing is staged, committed, or propagated to subscribers, and an
      // effect's run is not enqueued (runEffect would refuse it anyway). The
      // attribution frame opened at the top is still closed.
      if (e.R & REACTIVE_DISPOSED) {
        clearDeps(e);
        clearInFlight(e);
        return;
      }
      // The lane this pass is work of, if any: its seat (the node's, its
      // creator's, or the one a lane read moved it into). A pass in a lane's
      // seat that read none of the lane's world has left it: its result is the
      // frame's (a derivation whose branch no longer reaches the guess). A
      // guess is written, not derived — it never leaves this way.
      let p = null ;
      // Listed before its staging, a pending pass included (the lane's own
      // flight is the lane's); false: the pass left the lane (lanes.ts).
      const G = !!e.T?.U || T;
      if (!G) {
        // INV-11 (#3330): the equality gate compares against the slot this run
        // publishes to — the staged `_pendingValue` when staged (a lane node
        // entering the lane this pass has none: `laneStage` voided a frame
        // staging; what the screen shows is the gate), else the committed value.
        const o = e.ue === NOT_PENDING;
        const E = !o ? e.ue : e.le;
        // A throwing comparator is contained inside `isSame` (A3, #2837; #4111).
        // A pass replacing an error this node staged is a new answer, even the
        // committed value (D-41: a recovery equal to the last good value is a
        // change): the slot it publishes to held the error, and the readers that
        // derived from it — `latest()` throws it — re-derive (#4403).
        // A first value already staged this frame is that slot too: a re-pass
        // equal to it changes nothing, though the node stays uninitialized until
        // the commit (#4540).
        // The transaction this flush (or tick) has joined, if any.
        const s = flushTransaction ?? passTx;
        const l = o && _ && !n || !!e.T?.Te ||
        // A recovery to the last good value in a flush that has joined a
        // hold is a change of answer (D-41, S-53): staged, the error it
        // replaces stays the display until the frame reveals, and `latest`
        // shows the recovery ahead. Unheld, the silent recovery below is the
        // same screen.
        !!(I && s) || !!a ||
        // Lane work on a node a held pass created (its owner's staging is the
        // frame's, not yet revealed): it has no screen, so the lane's value is
        // a change, whatever its first pass published (#3835, F-11).
        p !== null || !isSame(e, E, R);
        // Effects use `_equals: false` (no per-effect closure). The side effects that
        // the equals closure used to perform — flagging the effect dirty and enqueueing
        // its runner — happen here instead. `!create` matches the previous `initialized`
        // gate: the explicit recompute(node, true) inside effect() does not enqueue, so
        // effect() can call its runner synchronously for the first run.
        if (n && l &&
        // A stale reader of a lane (REACTIVE_SCREEN_READ) that computed what it
        // last applied owes no run (lanes.ts).
        !(e.R & REACTIVE_SCREEN_READ && !e.Ae && Object.is(e.ge, R)) &&
        // A re-staging pass owes no run: the commit replays the effect (#3802).
        o) {
          e.Ae = !e.T?.U;
          // Reuse one bound runner per effect — runEffect no-ops on a stale
          // `_modified`, so re-enqueueing the same function is harmless.
          // Lane work's run is the lane's (released at its reveal). A first
          // pass's run is `effect()`'s to queue, a lane's node's too (into this
          // pass's lane, its transaction now): `defer` skips it there (#4557).
          if (!t) globalQueue.enqueue(n, e.W ??= GlobalQueue.q.bind(null, e), p);
        }
        // Lanes. A written guess's own pass from the frame: its source
        // recomputed it — the truth (A18: "the source is whatever recomputes the
        // node"). It stages under the lane's parent whether or not it changed (a
        // confirm is a landing too — the lane's end commits it) and notifies
        // only a correction: an equal truth re-runs nothing (lanes.ts). (As the
        // lane's own work the lane judged it — `laneStage`.)
        // (The hook first: a build without lanes folds the arm away.)
        if (G) ;else if (l) {
          // L2: a first pass is born held — staged, committed with the
          // transaction, its effect's first run the landing's (A29; `effect()`
          // skips the synchronous first run on a staged value) — when the flush
          // has joined a transaction and either the pass read a held node (it
          // derives from that world — the join merged the node's transaction
          // into the flush's), or — a verdict lane's mount, mainline — read a
          // staging of this flush (the same world before the seam parks it; the
          // mount is not shown ahead of it: #3851), or a pass created it (ruling
          // A: a held pass's children are the transaction's). Any other mount
          // that read a staging does not join by being new (2026-10-07): it
          // publishes and re-derives if the flush parks. A node created outside any pass
          // that read only the committed world (root setup, a mount, an effect
          // callback) is nobody's frame and publishes directly, as does a first
          // pass that runs before anything joins: the pass's input, not a verdict
          // after it. An effect still carrying an uncommitted staged value
          // re-stages: the commit applies the latest pass, not the born-held one.
          if (t ? !(s !== null && (d || creatorPass(A)?.R & REACTIVE_JOINED)) : n && e.ue === NOT_PENDING) {
            // A first pass publishes directly. So does an effect: its value slot
            // is private (only its own run reads it), and the staging round-trip
            // (queuePendingNode + commitPendingNodes) paid per effect on the
            // plain path is pure overhead.
            // NOTE (stage-3, 2026-08-21): a quiet-world MEMO direct-commit was
            // attempted here and REVERTED — memo staging is load-bearing beyond
            // transitions: mid-batch pulls (read-triggered recomputes before
            // sources commit) must see the fresh value while PLAIN reads stay
            // committed until flush (#3009 purity). The pending round-trip is
            // that separation; it cannot be skipped on any path a pull can reach.
            e.le = R;
          } else {
            e.ue = R;
            // D-39: a staged recovery keeps the error it replaces the display
            // until it commits (`commitPendingNode`), as a write over one does
            // (`setMemo`).
            if (I) e.T.Te = I;
            // Born held: in the transaction from birth, so a read of it this
            // tick is a read of its world (the mount-during-a-hold case), not
            // only after the seam parks it.
            if (t) {
              holdNode(e, s);
              // Born into the future: no committed value until the landing
              // (`commitPendingNode` initializes it) — every reader of it
              // derives from the future (`read`), an untracked one throws
              // (A19 exc. 1).
              e.m |= STATUS_UNINITIALIZED;
            }
          }
          // insertSubs only walks _subs (no scheduling of its own), so a
          // subscriber-less node has nothing to notify.
          // Lane work re-staged: the lane's members re-derive as its work
          // (`laneDirty` notifies them first).
          if (e.o !== null) insertSubs(e);
        } else if (e.he != C) {
          for (let t = e.o; t !== null; t = t.t) insertIntoHeapHeight(t.u, dirtyQueue);
        }
        // Silent recovery: errored → unchanged value fires no notification, but
        // dependents still holding the propagated error consumed their dirty flag
        // in an errored run and may sit on stale commits (#2949). Changed-value
        // recoveries ride insertSubs above; a comparator throw re-errored the node
        // (el._x?._error re-set), so this only runs on a genuinely clean recovery.
        if (!l && !e.T?.U) {
          if (I) settleErroredDependents(e, I);
          // Self-registration (this node's own superseded flight) is the #3181
          // sweep's business below — retiring it here too would walk twice.
          if (u) for (const t of u) if (t !== e) settlePendingSource(e, t);
        }
        // #3181: a synchronous settle supersedes the old landing callback, so
        // recompute owns its pending-source sweep. An uninitialized node without
        // a replacement source still has no truth to reveal and must stay parked.
        if (f && !(e.m & (STATUS_PENDING | STATUS_UNINITIALIZED))) settlePendingSource(e);
      }
      // A first pass that went pending where the born-held arm would have held
      // its value (it read a held node, or a verdict lane's mount read a staging,
      // #3851) is held like it: its answer is the hold's, and the hold waits
      // for it (A29, #3800). A boundary that has not shown content catches it
      // and it is held all the same — its answer reveals no earlier than the
      // hold's commit (D-12) — but the hold does not wait for it: its only
      // readers are behind the fallback (`_hidden`; F-4, #3540). A boundary
      // re-armed by `on` owns what it collects outright (D-14): not held. Only
      // an effect is caught: a derivation left pending is no reader (Reader,
      // D-12) — held, so its answer is the hold's and a render effect reading
      // it joins, but it reaches no boundary, and the commit waits for it only
      // through such a reader (`blockedBy`, #4542).
      if (t && p === null && d && e.m & STATUS_PENDING) {
        const t = flushTransaction ?? passTx;
        t && !t.P && (n && freshHook?.(e) === CAUGHT_REARMED || holdNode(e, t));
      }
      // Dependencies are the committed frame's until it is replaced (A30, #3410):
      // a pass that staged its value leaves the previous pass's tail linked for
      // `commitPendingNode` to trim, so a write to a dependency the committed
      // value still derives from reaches this node until the commit. A pass that
      // published directly, or changed nothing, trims now. An errored pass (a
      // throw, NotReady included, or a comparator throw above) keeps its full
      // list as before — `_depsTail` marks where it stopped — and the commit
      // skips it by the same `_error`. An effect's frame is the run its value is
      // applied by, not the value slot (#3438): a pass that still owes a run
      // (`_modified`) has not replaced what the last run published, so its tail
      // waits for `runEffect` to trim once the run applies. A pass that changed
      // nothing replaced nothing either (#3469): it cannot know at its tail
      // whether the flush that ran it will park with its inputs held, so the
      // trim waits on the flush's verdict (`heldTrim`: trimmed at the commit,
      // kept at a park — one spurious recompute at most). A creation pass and a
      // tracked effect trim now: their frames are replaceable like a direct
      // commit, and a tracked effect's spurious run would be user-visible.
      // Lane work's staging is the lane's, revealed at its seam (lanes.ts), not
      // a commit of this flush: its tail is judged as an unchanged pass's.
      if (!e.T?.U && (e.ue === NOT_PENDING) && !(n && e.Ae)) {
        if (t || n === EFFECT_TRACKED) trimStaleDeps(e);else heldTrim(e);
      }
      // A staged value, a parked frame (L2: the commit retires it), or status the
      // commit sweep must settle (a pending or uninitialized pass), queues the
      // node for this flush's commit. A first pass queues only when pending or
      // born held: otherwise its value published directly. A queued pass's
      // children are uncommitted (CONFIG_STAGED) until that commit.
      if (e.ue !== NOT_PENDING || e.T !== null && (e.T.me !== null || e.T.Le !== null) || (e.m & (STATUS_PENDING | STATUS_UNINITIALIZED)) !== 0 && (!t || (e.m & STATUS_PENDING) !== 0)) {
        e.l |= CONFIG_STAGED;
        // Lane work is the lane's to reveal (its seam), not this flush's commit.
        queuePendingNode(e);
      }
      // Missed-wake reschedule (see the finally above): values this pass read
      // before the nested commit are stale, so run again now that the heap will
      // accept the node. Equality gates stop same-value landings from cascading,
      // and a re-run only latches again if another nested commit changes a dep
      // beneath it — convergent unless deps genuinely keep changing.
      if (O) {
        enqueueSub(e);
        schedule();
      }
      // The release a settle deferred past this pass (#2934, #4474): the node
      // has produced what the landing gave it — staged above, committed at the
      // seam — and is reclaimed now if still unobserved and settled; a pass that
      // went pending is an observer's again (its landing releases it), and one
      // re-queued above is released at that pass's tail.
      if (c) releaseIfSettledUnobserved(e);
    }
    function updateIfNecessary(e) {
      // Never re-enter a node that is currently computing: its dep bookkeeping
      // (_depsTail/_depGen) is live, and a nested recompute would corrupt it.
      // A mid-pass mark stays latched for recompute's own tail to reschedule
      // (#3037); readers meanwhile serve the values the pass has so far.
      // Never recompute a DISPOSED node either: recompute rewrites _flags and
      // would resurrect it (#2983) — readers serve its last value.
      if (e.R & (REACTIVE_RECOMPUTING_DEPS | REACTIVE_DISPOSED)) return;
      if (e.R & REACTIVE_CHECK) {
        for (let t = e.C; t; t = t.G) {
          const n = t.S;
          if (n.X) {
            updateIfNecessary(n);
          }
          if (e.R & REACTIVE_DIRTY) {
            break;
          }
        }
      }
      if (e.R & REACTIVE_DIRTY || e.T?.U && e.ie < clock && !e.T?.Ee) {
        recompute(e);
      }
      // The guard above refused an already-disposed node; the recompute it just
      // ran may have disposed it (#3621) — carry the flag, or it comes back alive.
      // The manual-write mark is state, not scheduling (#3612, A34 rule B): it
      // says the node's staging is a PROPOSAL, lifted by a pass that re-derives
      // or by the commit — a pull that recomputed nothing must not. Nor may it
      // erase the last pass's verdicts for the landing (a stale reader's
      // REACTIVE_FRAME_READ — a verdict reader pulled by a sibling before the
      // landing lost its re-derivation; the lane reads likewise).
      e.R = e.R & (REACTIVE_SNAPSHOT_STALE | REACTIVE_IN_HEAP | REACTIVE_IN_HEAP_HEIGHT | REACTIVE_ZOMBIE | REACTIVE_DISPOSED | REACTIVE_MANUAL_WRITE | REACTIVE_FRAME_READ | REACTIVE_STAGED_READ | REACTIVE_LANE_READ | REACTIVE_SCREEN_READ | REACTIVE_PROBE_UNANSWERED);
    }
    function computed(e, t) {
      const n = t?.transparent ?? false;
      // `in` (not `!== undefined`): an explicit `loadingValue: undefined` on a
      // `T | undefined` node is a real commit #0. The typeof guard tolerates
      // non-object option values that older call shapes force through `as any`.
      const o = t !== null && typeof t === "object" && "loadingValue" in t;
      // Two literals, one per tier, selected at build time (the observe flag is
      // a literal after replacement; the untaken branch is dead code). The observe
      // literal is the prod literal plus its `_name` and `_loc` slots — slots in
      // the boilerplate, because a post-construction `self._name = …` forces a
      // hidden-class transition and an out-of-object property store on EVERY node
      // (measured: the whole of the observe tier's creation overhead). Keep the
      // two in sync — the dist artifact test pins observe's key set to prod's
      // plus the slots.
      const E = {
        id: inheritId(t, n, context),
        l: (n ? CONFIG_TRANSPARENT : 0) | (t?.ownedWrite ? CONFIG_OWNED_WRITE : 0) | (!context || t?.lazy ? CONFIG_AUTO_DISPOSE : 0) | (t?.sync ? CONFIG_SYNC : 0) | (t?.ae ? CONFIG_NO_SNAPSHOT : 0) | (t?.xe ?? 0) | (0),
        ye: t?.equals ?? isEqual,
        ke: null,
        A: context?.A ?? defaultContext,
        be: 0,
        X: e,
        le: o ? t.loadingValue : undefined,
        he: 0,
        ve: undefined,
        We: null,
        C: null,
        _: null,
        de: 0,
        o: null,
        Ze: null,
        _parent: context,
        Ge: null,
        Me: null,
        pe: null,
        R: t?.lazy ? REACTIVE_LAZY : REACTIVE_NONE,
        // A loadingValue node is born committed: commit #0 is already in _value.
        m: o ? 0 : STATUS_UNINITIALIZED,
        ie: clock,
        ue: NOT_PENDING,
        we: -1,
        Ie: o,
        // Cold machinery (async slots) lives one hop away in the lazily-allocated extension — the core literal MUST
        // stay under V8's in-object boundary (§12: past ~39 fields every
        // allocation spills to a backing store and creation cost ~4x's).
        T: null
      };
      if (t?.unobserved) ext(E).Ye = t.unobserved;
      setupComputedNode(E, t);
      return E;
    }

    /** Lazily allocate a node's cold extension (ONE shape for signals and
     * computeds — `_x` access stays monomorphic). Installers write through
     * this; hot paths read `el._x?._field` gated by the _config presence bits.
     * Never call ext() just to store a field's default. */
    function ext(e) {
      return e.T ??= {
        Ee: null,
        Se: null,
        U: undefined,
        fe: undefined,
        se: undefined,
        Ye: undefined,
        De: undefined,
        me: null,
        Le: null,
        Re: null,
        Ve: false,
        je: NOT_PENDING,
        Be: -1,
        ce: 0,
        Ue: false,
        I: 0,
        Te: null
      };
    }
    function joinPass(e, t) {
      e.R |= REACTIVE_JOINED;
      // A new memo's first pass is the hold's work (born held) but not the
      // tick's: a render effect that reads it decides — under a boundary that
      // catches it, the boundary's; otherwise the tick joins the hold (#3540:
      // the reader's position, not where the memo was created). Its catch, if
      // any, is at its staging.
      if (t.m & STATUS_UNINITIALIZED || e.i !== EFFECT_RENDER) joinPassTx(txOf(t), !e.i && e.m & STATUS_UNINITIALIZED || freshHook?.(e));
    }

    /** A15's stale reader (shared-hole and reveal corollaries): a render effect
     * reading a node held by a transaction that is not the flush's. It is served
     * the committed value — a pending one's too — publishes mainline, and is
     * re-derived after that transaction's landing (`_reruns`,
     * REACTIVE_FRAME_READ) so the frame catches up with it once it is the
     * committed world. Not a frame born into that transaction (held and never
     * committed — created by one of its held passes, A29; `bornInto`): that
     * one reads its transaction's values and keeps staging. Not of a flight
     * whose inputs are already visible (CONFIG_INPUTS_PUBLISHED, #3305): its
     * committed value would tear against them, so the reveal observes the
     * flight instead. Once per pass.
     *
     * Lane work is a stale reader too (maintainer, 2026-10-01: a lane sees the
     * screen plus its own guesses). A held write is held because showing it
     * would tear against the rest of its frame; a lane revealing a derivation
     * of it would show it anyway, beside inputs still committed elsewhere on
     * the page. The guess is the one value the user opted into predicting. So
     * a lane pass reading a transaction's held node — its parent's or any
     * other's — derives from the committed value and is re-derived at that
     * landing. The case read-through was built for — a corrected guess whose
     * downstream async must refetch with the truth at once, while another of
     * the parent's flights is still up — needs none of this: the correction
     * dissolves the lane, and the refetching pass is the parent's own, reading
     * the truth as a member (`joinPass`). */
    function frameRead(e, t) {
      if (!((
      // CONFIG_FRAME, spelled as at the effect's creation.
      !(e.l & EFFECT_RENDER << 23) || t.l & CONFIG_INPUTS_PUBLISHED))) {
        const E = txOf(t);
        if (!(E === flushTransaction && true || bornInto(e, E))) {
          staleReader(e, E);
          return true;
        }
      }
      joinPass(e, t);
      return false;
    }

    /** A node born into transaction `t`: held by it and never committed (A29,
     * ruling A) — uninitialized (born held), or a member of the frame one of its
     * held passes built (CONFIG_HELD_FRAME). Its branch exists only in `t`: it
     * has no screen to read, so it reads `t`'s values, whichever flush runs it,
     * and keeps staging (#4010). */
    function bornInto(e, t) {
      return (e.m & STATUS_UNINITIALIZED || e.l & CONFIG_HELD_FRAME) && e.l & CONFIG_HELD && txOf(e) === t;
    }

    /** The computed whose pass a creation under `owner` belongs to (a root's is
     * its nearest computed ancestor's), or null outside every pass. */
    function creatorPass(e) {
      return e !== null && e.Qe ? e.Ke : e;
    }

    /** L2 — park the previous pass's frame for this node's commit: the children
     * (already allocated — nothing new) and the `_disposal` list move to the
     * extension, keep reacting from the heap, and die when the commit publishes
     * the frame that replaces them (`commitPendingNode`) or when the owner does. */
    function parkChildren(e) {
      markDisposal(e);
      const t = ext(e);
      t.Le = e.ke;
      t.me = e.pe;
      e.ke = null;
      e.pe = null;
      e.be = 0;
    }

    /**
     * Build an Effect node with all effect-specific fields baked into a single object literal,
     * so V8 sees the full hidden class shape at construction time. Effects always run in lazy
     * mode (recompute is called explicitly by `effect()`), so we hardcode the lazy bits and skip
     * the auto-dispose CONFIG bit (effect() previously cleared it post-construction).
     */
    function createEffectNode(e, t, n, o, E) {
      const s = E?.transparent ?? false;
      // Prod and observe boilerplates — see computed() for why the observe tier
      // gets its `_name` as a literal slot rather than a write after the fact.
      // The default label is the node kind (tracked effects relabel their computed
      // in trackedEffect); the wrappers in signals.ts no longer spread a name into
      // the options to get it.
      const l = {
        id: inheritId(E, s, context),
        l:
        // CONFIG_FRAME for a render effect (EFFECT_RENDER = 1; a user
        // effect's 1 << 24 is unused).
        o << 23 | (s ? CONFIG_TRANSPARENT : 0) | (E?.ownedWrite ? CONFIG_OWNED_WRITE : 0) | (E?.sync ? CONFIG_SYNC : 0) | (E?.xe ?? 0) | (0),
        ye: false,
        ke: null,
        A: context?.A ?? defaultContext,
        be: 0,
        X: e,
        le: undefined,
        he: 0,
        ve: undefined,
        We: null,
        C: null,
        _: null,
        de: 0,
        o: null,
        Ze: null,
        _parent: context,
        Ge: null,
        Me: null,
        pe: null,
        R: REACTIVE_LAZY,
        m: STATUS_UNINITIALIZED,
        ie: clock,
        ue: NOT_PENDING,
        we: -1,
        Ie: false,
        Ae: false,
        ge: undefined,
        qe: t,
        Je: n,
        ze: undefined,
        i: o,
        T: null
      };
      // Effects dispatch status through the SHARED notifier (statusNotifierOf,
      // keyed off _type) — storing it per node forced a full NodeExtension
      // allocation on EVERY effect at creation (an alloc + 19 field stores,
      // +23% effect creation, caught by the creation benches). Only genuinely
      // per-node channels (boundaries) live on _x.
      if (E?.unobserved) ext(l).Ye = E.unobserved;
      setupComputedNode(l, lazyOptions);
      return l;
    }

    /**
     * The shared status notifier for effect nodes, installed once by effect.ts
     * at module evaluation (`this`-dispatched — one function serves every
     * effect, so nodes never store it). CARVE 4: the boundaries' per-node
     * channel (`_x._notifyStatus`) went with them; effects are the only
     * display consumers.
     */
    let effectStatusNotify = null;
    function setEffectStatusNotify(e) {
      effectStatusNotify = e;
    }

    /** Resolve a node's status notifier: effect nodes (`_type` — EFFECT_PURE is
     * 0, and only effect literals carry the field) get the shared notifier.
     * Presence doubles as the "display consumer" membership test in the status
     * walks, exactly as the per-node field did when every effect carried one. */
    function statusNotifierOf(e) {
      return e.i ? effectStatusNotify : null;
    }
    const lazyOptions = {
      lazy: true
    };
    function setupComputedNode(e, t) {
      e.We = e;
      const n = context?.Qe ? context.Ke : context;
      if (context) linkChild(context, e);
      if (n) e.he = n.he + 1;
      !t?.lazy && recompute(e, true);
    }
    function isEqual(e, t) {
      return e === t;
    }

    /**
     * Runs `fn` outside of any reactive tracking — reads inside `fn` will not
     * subscribe the current scope. Returns whatever `fn` returns.
     *
     * Use `untrack` inside a memo or effect when you need to read a signal once
     * without making the surrounding computation depend on its future changes.
     *
     * `untrack` stops dependency tracking, not async settlement. Reading an
     * uninitialized async source still suspends the owning computation; it runs
     * again when that source first resolves. Afterward, the untracked read is a
     * snapshot and does not subscribe the computation to later changes.
     *
     * If the first read must return immediately, give the async source a
     * `loadingValue` before reading it with `untrack`. `isPending` and `latest`
     * inspect updates to an existing value; neither supplies a missing initial
     * value.
     *
     * Pass a `strictReadLabel` string to enable a dev-mode warning: any reactive
     * read inside `fn` that isn't inside a nested tracking scope will log a
     * warning naming the label.
     *
     * @example
     * ```ts
     * createEffect(
     *   () => trigger(),                 // tracks `trigger` only
     *   () => {
     *     const snapshot = untrack(() => state); // read once, untracked
     *     log(snapshot);
     *   }
     * );
     *
     * const color = createMemo<string>(() => fetchColor(), { loadingValue: "gray" });
     * const initialColor = untrack(color); // "gray" while the fetch is unresolved
     * ```
     */
    function untrack(e, t) {
      const n = tracking;
      tracking = false;
      try {
        if (externalUntrackHook) ;
        return e();
      } finally {
        tracking = n;
      }
    }

    /** > 0 while `runRefCallback` is on the stack (prod and dev). A ref whose
     * creating pass was born into a held node's hold may read that node's staged
     * value (#4767, F-7); A19 exc. 1 would otherwise throw NotReadyError from the
     * ownerless commit half and leave the hold parked forever. */
    let refCallbackDepth = 0;

    /**
     * Runs a ref callback (`@solidjs/web`'s compiled `ref()`) the way a render
     * effect's callback runs on its first run at creation: untracked, in the
     * current context — its reads are the pass's that builds the element, not
     * the screen's (#4761) — and, in dev, a strict-read scope in which creating a
     * primitive is PRIMITIVE_IN_EFFECT_CALLBACK. Work a ref sets up belongs in
     * the factory that returns the callback (the component body).
     *
     * @internal
     */
    function runRefCallback(e) {
      refCallbackDepth++;
      try {
        if (false) ;else untrack(e);
      } finally {
        refCallbackDepth--;
      }
    }

    /**
     * Set while runtime bookkeeping reads a node inside another node's pass (a
     * loading boundary priming its tree at creation, from whatever pass is
     * mounting it). `context` is that node, but the read is nobody's: the value
     * is probed, never derived from, so nothing the read would normally record
     * on `context` may be recorded — not the untracked-pending re-run link
     * (`read`, `!tracking`; #3528: a boundary's `on` key read this way from
     * `notify` linked the key's source into an unrelated async memo, a cycle that
     * never converged), and not a transaction entry (`enterStagedRead`; #3540: a
     * born-held tree would otherwise pull the mounting pass into the hold).
     */
    let spectating = false;

    /**
     * Bring a computed to a readable state: lazy/disposed nodes are (re)computed;
     * `refresh` additionally pulls the node fully up to date so its status flags
     * reflect the current graph.
     */
    function prepareComputed(e, t) {
      if (e.R & REACTIVE_LAZY) {
        e.R &= ~REACTIVE_LAZY;
        recompute(e, true);
      } else if (e.R & REACTIVE_DISPOSED) {
        // Two disposal lifecycles share the flag (#3024). Observation-lifecycle
        // nodes (CONFIG_AUTO_DISPOSE) are dormant — torn down by unobserved()
        // when the last subscriber left — and reads reawaken them; that is the
        // pay-for-use contract. Owner-lifecycle nodes are dead: recomputing would
        // re-run user code in a torn-down tree (and discard manual writes on
        // derived-writable signals), so reads return the last committed value.
        if (e.l & CONFIG_AUTO_DISPOSE) {
          const t = e._parent;
          if (t !== null) {
            // A dormant node was off the chain when its owner died, so the strip
            // in disposeChildren missed it: freeze here instead (#3024).
            if (t.R & REACTIVE_DISPOSED) {
              e.l &= ~CONFIG_AUTO_DISPOSE;
              return;
            }
            // A zombie never left its chain (the parked frame is drained whole,
            // and its members skip the splice): relinking would put it on the
            // live chain too.
            if (!(e.R & REACTIVE_ZOMBIE)) linkChild(t, e);
          }
          recompute(e, true);
        }
      } else ;
    }

    // CARVE 3: until()'s authoritative-view wakeup (notifyAuthoritativeObservers /
    // installAuthoritativeRead), the stale-of-foreign clause (heldFromStale,
    // recordStaleReplay, ownsHold) and the transaction entry on a staged read
    // (enterStagedRead, stagedEntry / born held, underFreshLoadingBoundary) went
    // with the transactions.
    /**
     * Rule 1 (value selection): does this reader see a STAGED node's COMMITTED
     * value? One implementation of the rule the fast paths (read's fast block)
     * carry as their trivial ternary. In order:
     * - no reader at all (an untracked read) — the committed frame;
     * - nothing staged;
     * - a children-forbidden reader (createTrackedEffect / onSettled: the frame,
     *   never the graph — A32).
     * False means the reader derives from the staged value.
     */
    function readerSeesCommitted(e, t) {
      return !t || e.ue === NOT_PENDING || t.l & CONFIG_CHILDREN_FORBIDDEN;
    }

    /** A28 — set when a node is staged (queuePendingNode) OUTSIDE a flush;
     * cleared when the next flush begins. The read sites test this one module
     * boolean instead of `globalQueue._running`: inside a flush it is false and
     * the A28 arm costs nothing; outside, only a tick with unflushed writes pays
     * the staged-node check. */
    let unflushedStaged = false;
    function markUnflushedStaged() {
      unflushedStaged = true;
    }

    /** A28 — a write becomes visible at flush. Outside a flush, a node holding a
     * staged value was written since the last flush: staging commits at flush
     * end, so nothing else leaves a node in this state. Inside a flush the rule
     * does not apply (A28 (4): promoted within the round). The value an
     * unflushed node serves is its committed value, or NOT_PENDING when nothing
     * is unflushed. Exempt: promoted writes (A28 (4): a write issued inside a
     * recompute is promoted at that recompute's end — boundary and loading
     * machinery, signals declared for in-computation writes). */
    function unflushedValue(e) {
      if (globalQueue.Y || e.ue === NOT_PENDING || e.l & CONFIG_PROMOTED) return NOT_PENDING;
      // A held node (L2) carries a staged value between flushes too, but it was
      // flushed — and parked. Not an unflushed write — unless rewritten since:
      // then the flushed staging is what the world sees until the next flush.
      if (e.l & CONFIG_HELD) return e.T.Be === clock ? e.T.je : NOT_PENDING;
      return e.le;
    }

    /** A28: a held node rewritten outside a flush keeps the staging the last
     * flush left (`_flushed`) until the flush that carries the rewrite — the
     * stash is stamped with the clock, which that flush advances. */
    function stashFlushed(e) {
      const t = e.T;
      if (t.Be !== clock) {
        t.je = e.ue;
        t.Be = clock;
        unflushedStaged = true;
      }
    }

    /** Nodes written inside a creation-time recompute (CONFIG_PROMOTED). */
    const promotedWrites = [];

    /** A derivation served the committed value because of an unflushed write
     * (A28) must run again in the flush that carries it — the late-linker case
     * (#3337's reason to defer the walk): it linked after the write walked. */
    function markLateLinker(e) {
      // The pass's own tail re-enqueues on this latch (recompute's finally) —
      // a direct enqueue here would be wiped by the pass's flag reset.
      e.R |= REACTIVE_MISSED_WAKE;
      return true;
    }
    function resyncUnflushedCompanions() {
      unflushedStaged = false;
      // Length-guarded: the common flush has nothing here and allocates nothing.
      if (promotedWrites.length !== 0) {
        for (const e of promotedWrites) e.l &= ~CONFIG_PROMOTED;
        promotedWrites.length = 0;
      }
    }

    /** A tracked read's pull of a computed: bring it current when the flush has
     * reached its height (or the reader is a fresh-pull waiter), and sit the
     * reader above it. */
    function pullComputed(e, t) {
      if (e.he >= dirtyQueue.Fe || e.R & REACTIVE_CHECK) {
        markNode(t);
        markHeap(dirtyQueue);
        updateIfNecessary(e);
      }
      // Fresh-pull readers (awaitable refresh's waiter) recompute a dirty
      // source inline even when the height gate defers to the flush: the
      // waiter must park on the re-ask's window (or serve its sync answer),
      // never read the PRE-re-ask value as settled. Self-guarded: a clean
      // node no-ops and updateIfNecessary refuses disposed nodes (#2983) —
      // a dead target serves its last value, which is already quiescent.
      else if (t.l & CONFIG_FRESH_READ) updateIfNecessary(e);
      const n = e.he;
      // parent check is shallow, might need to be recursive
      if (e._parent === t) e.R |= REACTIVE_OWNER_READS;else if (n >= t.he) liftOwned(t, t.he = n + 1);
    }

    // (Implementation typed `any` so `el` needs no cast alias: an alias the minifier keeps.)
    function read(e) {
      let t = context;
      if (t?.Qe) t = t.Ke;
      if (typeof e.X === "function") prepareComputed(e);
      if (!e.X && e.T?.De === undefined && true && (!unflushedStaged || e.ue === NOT_PENDING) &&
      // A28, see readNodeFast
      !(e.l & CONFIG_OVERRIDE) &&
      // lanes: the slow path's one arm
      true) {
        if (t) {
          if (tracking) link(e, t);
          // L2: a pass that reads something already in the future joins it —
          // the one mechanism behind "a write that reaches the future joins
          // it". Tracked or not (`untrack` is about dependencies, not about
          // which world a pass derives from — posture-store-parity S4/S5): a
          // derivation of a held write published mainline would tear. Frame
          // readers (children-forbidden, A32) see committed below and stay
          // out; a render effect outside a parking flush sees committed and
          // stays out too (rule 3, `frameRead`). The pass remembers it read the
          // future (REACTIVE_JOINED): a first pass that did is born held (A29),
          // wherever it was created. Lane work sees the screen (`frameRead`).
          if (e.l & CONFIG_HELD && !(t.l & CONFIG_CHILDREN_FORBIDDEN)) {
            if (frameRead(t, e)) {
              return e.le;
            }
          }
        }
        // Committed visibility for untracked and children-forbidden readers.
        if (!t || e.ue === NOT_PENDING || t.l & CONFIG_CHILDREN_FORBIDDEN) {
          return e.le;
        }
        // A staging equal to the committed value is writes that netted (D-8): no
        // proposal, so not a read of the frame's future — nor, for a verdict
        // reader, a stale read of the tick's hold re-run at its landing (#4485).
        // (A plain signal is never uninitialized — the carve-out is `serve`'s.)
        // `===` alone identifies opposite signed zeros. Require SameValue too;
        // keep the strict check so an accepted NaN rewrite remains a proposal.
        const n = e.ue === e.le && Object.is(e.ue, e.le);
        // Lane work over a folded lane (D-34), once the frame has a transaction,
        // reads the screen too.
        if (n || (laneStageHook)) {
          return e.le;
        }
        stagedRead(t);
        return e.ue;
      }
      // Rule 3: this read serves the committed value to a render effect outside a
      // parking flush (decided after the pull below — a pull can join).
      let n = false;
      if (t) {
        if (tracking) {
          link(e, t);
          if (e.X) {
            pullComputed(e, t);
          }
        }
        // L2, as in the fast block above (tracked or not). A node born into the
        // future (uninitialized) has no committed value: every reader derives
        // from the future there, a render effect included (A29: a stale reader
        // of it cannot fall back to the committed frame and enters instead).
        if (e.l & CONFIG_HELD && !(e.l & CONFIG_OVERRIDE) && !(t.l & CONFIG_CHILDREN_FORBIDDEN)) {
          if (e.m & STATUS_UNINITIALIZED) joinPass(t, e);else n = frameRead(t, e);
        }
      }
      if (e.m & STATUS_PENDING && !n) {
        // A reader landing on a pending node throws; an untracked read of an
        // UNINITIALIZED node has no committed value to serve and throws too. A
        // children-forbidden reader (createTrackedEffect / onSettled) sees the
        // frame, not the graph (A32): the committed value, and the NotReady only
        // where there is none (uninitialized).
        if (t) {
          if (!(t.l & CONFIG_CHILDREN_FORBIDDEN) || e.m & STATUS_UNINITIALIZED) {
            // An untracked read of a pending node still re-runs its reader when
            // the node settles — unless nobody is reading (`spectating`, #3528)
            // or the reader is the node itself.
            if (!tracking && !spectating && e !== t) link(e, t);
            throw e.T?.U;
          }
        } else if (e.m & STATUS_UNINITIALIZED) {
          // (No reader pass: nothing to record against.)
          throw e.T?.U;
        }
      }
      // An errored derive throws for every late reader instead of silently
      // serving node values (memo parity, #2897 ruling).
      if (e.X && e.m & STATUS_ERROR) {
        // Only a genuine reactive re-read may retry an errored async source:
        // - tracking: owned/tracked scope only (never events / `untrack` / effect side-effect phase)
        // - owner._time < clock: only on a later cycle than the one the error was found
        // - not a zombie: its fate is the seam's (L2). A zombie's retry of a sync
        //   memo it reads threw a fresh error that re-derived the live frame's
        //   verdict readers of the same memo, whose retry next round re-derived
        //   the zombie: a livelock (#4405's one-hop shape, S-58)
        if (tracking && e.ie < clock && !(e.R & REACTIVE_ZOMBIE)) {
          recompute(e);
          return read(e);
        }
        // D-41: a staged error replacing the shown one is this flush's answer
        // (`stageError`): a reader served the staging (`serve`) throws it, as it
        // would read a staged value, and stages its own error with it; one
        // served the screen throws the shown error. Thrown the shown error, a
        // reader born this flush published it, and its readers' stale error
        // committed after the new one (#4404).
        if (!n && e.l & CONFIG_STAGED_ERROR) serve(e, t);
        throw e.T?.U;
      }
      // D-41: an untracked read reads the screen, and so does a frame reader
      // served the committed value — `serve` hands it that value as it does an
      // untracked read — a shown error included (`throwShown`).
      if (n || !t) throwShown(e);
      const o = serve(e, n ? null : t);
      if (!t && typeof e.X === "function" && e.l & CONFIG_AUTO_DISPOSE && !(e.m & STATUS_PENDING) && !e.o) {
        // Deferred, not inline (#3078): an inline unobserved() here made untracked
        // reads destructive — dispose on this read, full revival recompute on the
        // next — so consecutive reads could answer differently with no write in
        // between.
        // The sweep at flush finalization re-validates and reclaims; schedule()
        // guarantees that flush happens even if nothing else is queued.
        dormantNodes.add(e);
        schedule();
      }
      return o;
    }

    /** D-41: a reader served the screen — an untracked read, a frame reader
     * served the committed value, a verdict reader (`serve`) — reads a shown
     * error there until the answer that replaces it commits. */
    function throwShown(e) {
      if (e.T?.Te) {
        throw e.T.Te;
      }
    }

    /**
     * Rule 1, the one slow implementation (DESIGN-CONSOLIDATION move 3b, step
     * 6c): the value a reader `c` (null = untracked, no pass) is served from
     * `el`. Called by read()'s slow tail; the fast path (read's fast block) keeps
     * its trivial ternary by design (perf, see the doc). Arms, in order:
     * - a node born staged has nothing for an untracked reader (A19 exception 1);
     * - an unflushed write serves committed and re-runs the reader in the
     *   carrying flush (A28);
     * - readerSeesCommitted, else the staged value.
     */
    function serve(e, t) {
      // A node born staged (recompute) has a staged value and no committed one:
      // an untracked reader has nothing to serve and holds (A19 exception 1) — a
      // bookkeeping read (`spectate`) likewise, and a children-forbidden reader
      // (A32: the frame, which has nothing here).
      // Exception: a ref callback whose creating pass was born into this node's
      // hold (#4767, narrowed for F-7). Refs run in the attribute effect's commit
      // half with no owner, but `runRefCallback` keeps the creator's context
      // (#4768). Serving the staged value there is the hold's own work reading
      // plainly (D-25); a ref mounted outside that hold must not see it ahead of
      // the commit (F-7).
      if (e.ue !== NOT_PENDING && e.m & STATUS_UNINITIALIZED && (!t || spectating || t.l & CONFIG_CHILDREN_FORBIDDEN)) {
        if (refCallbackDepth > 0) {
          const t = creatorPass(context);
          if (t && e.l & CONFIG_HELD && bornInto(t, txOf(e))) {
            return e.ue;
          }
        }
        throw new NotReadyError(null);
      }
      const n = t && unflushedStaged ? unflushedValue(e) : NOT_PENDING;
      if (n !== NOT_PENDING) {
        markLateLinker(t);
        return n;
      }
      if (readerSeesCommitted(e, t) || observeFlightHook) {
        return e.le;
      }
      // D-8 (#4452), as `read`'s fast block: a signal's staging equal to its
      // committed value is writes that netted — no proposal, not a read of the
      // frame's future. Only the strict `untrack` read skips the fast block in
      // dev (its `strictRead` test); a hydration snapshot or a promoted write
      // reaches here in dev and prod alike, and keeps the mark.
      stagedRead(t, e);
      // D-41: the staged answer is an error (`stageError`).
      if (e.l & CONFIG_STAGED_ERROR) {
        throw e.ue;
      }
      return e.ue;
    }

    /** A pass read a staging of this flush: it derives from what the flush may
     * yet hold (REACTIVE_STAGED_READ — the seam decides). Lane work too (plan sec. 28, a
     * lane sees the screen plus its own guesses) — a folded lane's only before
     * the frame has a transaction (after, it reads the screen like a verdict
     * reader, `stagedScreen` — a list pass never pairs a held length with the
     * guess's rows, D-34): the staging is the screen if
     * the frame commits — one pass, the common case — and a held write if it
     * parks, which the seam repairs (`stagedReaders`): the pass re-derives on
     * the committed world and its lane's runs wait that round, so the held
     * write never shows through the lane. A verdict lane's work likewise: the
     * lane holds verdicts, not the frame's other stagings (#3851) — except a
     * verdict reader, which answered for itself (the lane seam, lanes.ts). Not
     * a read of a node born staged at all: it has no committed value to
     * re-derive on, and a re-run would read the same staging and re-queue every
     * round (#3969: nor does it make a later lane read a re-derive, `enterLane`). */
    function stagedRead(e, t) {
      if (!(t?.m & STATUS_UNINITIALIZED)) {
        e.R |= REACTIVE_STAGED_READ;
      }
    }

    /** A28 (4) — written inside a recompute that runs OUTSIDE a flush (a
     * creation-time compute): promoted at that pass's end, visible to the rest of
     * the block. Cold: only contextual writes reach here. */
    function notePromotedWrite(e) {
      if (globalQueue.Y || e.l & CONFIG_PROMOTED) return;
      e.l |= CONFIG_PROMOTED;
      promotedWrites.push(e);
    }

    /**
     * `el`'s comparator verdict (`_equals`), the one guarded call for recompute,
     * setSignal (user setters and async landings) and the seam's
     * staged-equals-committed check.
     * - A comparator that read an unresolved async source has not shown the
     *   values equal (#4111): falsy, a change, whose readers suspend in their own
     *   tracked context.
     * - Any other throw is an error of `el`'s computation (A3, #2837): routed
     *   through the status path so error boundaries contain it, instead of
     *   unwinding a flush or a setter; answered "same" so nothing commits.
     * @internal
     */
    function isSame(e, t, n) {
      if (e.ye === isEqual) return t === n;
      try {
        return e.ye && e.ye(t, n);
      } catch (t) {
        if (!(t instanceof NotReadyError)) return notifyStatus(e, STATUS_ERROR, t), true;
      }
    }
    function setSignal(e, t) {
      const n = e.ue === NOT_PENDING ? e.le : e.ue;
      if (typeof t === "function") t = t(n);
      // L2 (T4) / A34 (1): a write to a node whose staged state is held is a
      // second proposal for the slot — the same value again or another — and
      // the two cannot finish at different times: the writer's tick joins the
      // hold, before the equality gate.
      if (e.l & CONFIG_HELD) joinFuture(txOf(e));
      const E = !!(e.m & STATUS_UNINITIALIZED) || !!e.T?.Te || (!isSame(e, n, t));
      if (!E) return t;
      const s = e.ue !== NOT_PENDING;
      if (!s) queuePendingNode(e);
      // A28: a held node rewritten outside a flush keeps its flushed staging
      // for every reader until the flush that carries the rewrite.
      else if (e.l & CONFIG_HELD && !globalQueue.Y) stashFlushed(e);
      // D-8 (#4483): a staged rewrite the comparator calls equal to the
      // committed value nets to it; staging the committed value itself lets
      // every netted test (`_pendingValue === _value`) see writes that made no
      // proposal. (Unstaged, the gate above already compared it.)
      // The netted test reads it only with the verdict engine (`isPending`,
      // `latest`): a build without it stages `v` as written. Under the default
      // comparator only the committed object itself is equal, and `v` is already
      // it, so a rewrite loop pays one local test (`custom`, from the gate).
      // (`custom` is truthy only with the engine installed.)
      e.ue = t;
      if (context !== null) notePromotedWrite(e);
      // _time is a computed-only slot (§12e): writing it on a signal would fork
      // the lean shape. Every read site is computed-typed.
      if (e.X !== undefined) e.ie = clock;
      // Staged-rewrite fast path (§12d): a re-write to a node whose subscribers
      // were already walked — and where nothing has recomputed or linked since
      // (epoch) — re-stages the value and stops. The walk is idempotent (subs
      // marked, heap entries flag-guarded, effects queued once).
      if (s && e.we === notifyEpoch) return t;
      insertSubs(e);
      schedule();
      return t;
    }

    /**
     * Executes `fn` with the given `owner` set as the current owner. Any reactive
     * primitives (`createSignal`, `createMemo`, `createEffect`, `onCleanup`,
     * `cleanup`, etc.) created inside `fn` are attached to that owner, so they
     * are disposed when the owner is disposed.
     *
     * The classic pattern: capture the current owner with `getOwner()` inside a
     * component, then re-enter it from a callback (event handler, async resolve,
     * setTimeout) so disposables created in the callback get cleaned up with the
     * component.
     *
     * @example
     * ```ts
     * function delayed<T>(ms: number, fn: () => T) {
     *   const owner = getOwner();
     *   setTimeout(() => runWithOwner(owner, fn), ms);
     * }
     * ```
     */
    function runWithOwner(e, t) {
      const n = context;
      const o = tracking;
      context = e;
      tracking = false;
      try {
        return t();
      } finally {
        context = n;
        tracking = o;
      }
    }

    /**
     * Effects are the leaf nodes of our reactive graph. When their sources change, they are
     * automatically added to the queue of effects to re-execute, which will cause them to fetch their
     * sources and recompute
     */
    function effect$1(e, t, E, f) {
      const u = !!f?.user;
      const o = createEffectNode(e, t, E, u ? EFFECT_USER : EFFECT_RENDER, f);
      recompute(o, true);
      // A first pass that read a staged value was staged itself (recompute: born
      // staged); the flush's commit replays this effect. Its first run is not this
      // creation's (A29). A lane's node's run is the lane's: queued, not run
      // now — into its own pass's lane (its transaction: the creator's lane, or
      // the one a lane read moved the pass into, F-6/F-7) — and released at the
      // reveal (lanes.ts). Not a lane's node: the creator's (`enqueue`'s default
      // for no transaction; the frame for a transaction's).
      // `defer` skips the first run, whoever owes it. A node born staged
      // (#4543): its staged first value applies now, so the commit replays
      // nothing and the next pass gets it as `prev`, as on a plain mount (#4556;
      // D-13). A lane's node (#4557): it queues none.
      f?.defer ? applyStaged(o) : o.ue === NOT_PENDING && (o.T?.Re?.P || o.i === EFFECT_USER || f?.schedule ? globalQueue.enqueue(o.i, runEffect.bind(null, o), o.T?.Re) :
      // Type 0: the synchronous first render, not a queued run (D-19).
      runEffect(o));
    }
    function notifyEffectStatus() {
      const e = this.m;
      const t = this.T?.U;
      if (e & STATUS_ERROR) {
        globalQueue.notify(this, STATUS_PENDING, 0);
        if (this.i === EFFECT_USER) {
          // The error handler is the error arm of the effect phase (#2840 ruling):
          // queue it like the effect function. It runs in the same imperative,
          // writable scope and throws escalate the same way. No payload is queued — the node already carries `_statusFlags`/`_error`,
          // and the runner dispatches on them, so a recovery before the effect
          // phase takes the success arm instead. (Re-read: the boundary
          // notify above can run a redraw.)
          if (this.m & STATUS_ERROR) queueEffectRun(this);
          return;
        }
        // Dev locates the halt at the node that threw: the StatusError's
        // source, upstream of this effect when a computed failed. The rethrow is
        // the user's error, not the wrapper: the wrapper's `source` is a node, and
        // a reporter that serializes the throw walks the reactive graph.
        escalate(this, unwrapStatusError(t));
      } else if (
      // A user effect's run owed for a pass a new question has since made
      // pending is for a world that will not commit (F-1, F-2): void — the
      // effect re-runs when that question settles (`settlePendingSource`). A
      // quiet re-ask keeps it: the pass still answers the question asked (F-9).
      this.i === EFFECT_USER) {
        if (e & STATUS_PENDING && this.Ae && !t?.source?.T?.Ve) ext(this).fe = !(this.Ae = false);
      } else if (this.i === EFFECT_RENDER) {
        globalQueue.notify(this, STATUS_PENDING | STATUS_ERROR, e, t);
      }
    }

    /** An effect's error no boundary takes halts the system (boundary-or-halt):
     * halted with `cause` and rethrown; dev locates it at `subject` (default:
     * the effect). */
    function escalate(e, t, E) {
      if (!globalQueue.notify(e, STATUS_ERROR, STATUS_ERROR)) {
        haltReactivity(t);
        throw t;
      }
    }
    function runEffect(e, t) {
      if (!e.Ae || e.R & REACTIVE_DISPOSED) return;
      // Error arm (#2840), user effects only: a compute-phase error that is still
      // the node's settled state at effect time runs the bundle's error handler in
      // this same imperative, writable scope. Unwrap the StatusError used for
      // source tracking — user code gets the error it threw, as boundaries do. No
      // handler: log and keep the system alive (the run was skipped). A handler
      // (or logging) consumes the error; a handler throw falls to the shared
      // catch below and escalates boundary-or-halt like any effect-phase throw.
      // Render effects bypass: their errors route to boundaries synchronously in
      // notifyEffectStatus, and a runner queued by an earlier valueChanged in the
      // same flush must not be hijacked by a later-arriving error status.
      if (e.m & STATUS_ERROR && e.i === EFFECT_USER) {
        const t = unwrapStatusError(e.T?.U);
        e.ge = e.le;
        e.Ae = false;
        try {
          e.Je ? e.Je(t, () => {
            const t = e.ze;
            e.ze = undefined;
            t?.();
          }) : console.error(t);
        } catch (t) {
          escalate(e, t);
        }
        return;
      }
      // Captured before the callback: its own throw errors the node below, but
      // the compute pass that produced `_value` was clean, so its tail still goes.
      const E = e.T?.U == null;
      const f = e.ze;
      e.ze = undefined;
      try {
        f?.();
        const t = e.qe(e.le, e.ge);
        if (false && t !== undefined && typeof t !== "function") ;
        // The final cleanup is invoked by disposeChildren at true disposal.
        e.ze = t;
      } catch (t) {
        ext(e).U = new StatusError(e, t);
        e.m |= STATUS_ERROR;
        escalate(e, t);
      } finally {
        e.ge = e.le;
        e.Ae = false;
        // The run applied: this is the frame now, so the dependency tail the
        // compute pass left linked goes (A30, #3438 — `recompute` defers an
        // effect's trim while a run is owed; the twin of `commitPendingNode`'s
        // trim for a staged pass). An errored compute kept its full list with
        // `_depsTail` marking where it stopped; leave it, as the commit does.
        if (E) trimStaleDeps(e);
      }
    }
    GlobalQueue.q = runEffect;

    // Install the shared effect status notifier (statusNotifierOf serves it to
    // every effect node) — module-scope: any bundle that creates effects
    // evaluates this module.
    setEffectStatusNotify(notifyEffectStatus);

    /** Brand keys the proxy answers directly (never user data). */
    const $TARGET = Symbol(0),
      $PROXY = Symbol(0),
      $RECORD = Symbol(0);
    function ownEnumerableKeys(e) {
      return Reflect.ownKeys(e).filter(r => Object.prototype.propertyIsEnumerable.call(e, r));
    }

    function accessor(e) {
      const t = read.bind(null, e);
      t[$REFRESH] = e;
      return t;
    }
    function createMemo$1(e, t) {
      return accessor(computed(e, t));
    }

    /**
     * Creates a reactive computation that runs during the render phase as DOM elements
     * are created and updated but not necessarily connected.
     *
     * Same compute / effect split as `createEffect`, but scheduled inside the render
     * queue rather than after it. Reach for this only when authoring renderer
     * plumbing (custom DOM bindings, JSX-generated `insert()` / `spread()` calls).
     * App code should use `createEffect`.
     *
     * ```typescript
     * createRenderEffect<T>(compute, effectFn, options?: EffectOptions);
     * ```
     * @param compute a function that receives its previous value and returns a new value used to react on a computation
     * @param effectFn a function that receives the new value and is used to perform side effects
     * @param options `EffectOptions` -- name, defer, schedule, transparent
     *
     * @example
     * ```ts
     * // Custom directive: bind an element's textContent to a reactive source.
     * function bindText(el: HTMLElement, source: () => string) {
     *   createRenderEffect(
     *     () => source(),
     *     value => { el.textContent = value; }
     *   );
     * }
     * ```
     *
     * @description https://docs.solidjs.com/reference/solid-js/advanced/specialized-reactivity/create-render-effect
     */
    function createRenderEffect$1(e, t, r) {
      effect$1(e, t, undefined, r);
    }

    // CARVE 4: `flatten` lived in boundaries.ts but is the general children
    // resolver the renderers (`web`, `universal`, `solid`'s `children()`) walk
    // through — not a boundary feature. Moved verbatim so the boundary carve
    // measures boundaries alone.
    /**
     * Resolves nested accessors and arrays in a children tree to their rendered
     * values. See the `children()` helper in solid-js for the memoized form.
     */
    function flatten(r, t) {
      if (typeof r === "function" && !r.length) {
        if (t?.doNotUnwrap) return r;
        do {
          r = r();
        } while (typeof r === "function" && !r.length);
      }
      if (t?.skipNonRendered && (r == null || r === true || r === false || r === "")) return;
      if (Array.isArray(r)) {
        let e = [];
        if (flattenArray(r, e, t)) {
          return () => {
            let r = [];
            flattenArray(e, r, {
              ...t,
              doNotUnwrap: false
            });
            return r;
          };
        }
        return e;
      }
      return r;
    }
    function flattenArray(r, t = [], e) {
      let o = null;
      let f = false;
      for (let n = 0; n < r.length; n++) {
        try {
          let o = r[n];
          if (typeof o === "function" && !o.length) {
            if (e?.doNotUnwrap) {
              t.push(o);
              f = true;
              continue;
            }
            do {
              o = o();
            } while (typeof o === "function" && !o.length);
          }
          if (Array.isArray(o)) {
            // OR, don't overwrite: an accessor already pushed under doNotUnwrap
            // still needs the resolving wrapper even when a later sibling
            // fragment contains no functions (#3133).
            f = flattenArray(o, t, e) || f;
          } else if (e?.skipNonRendered && (o == null || o === true || o === false || o === "")) {
            // skip
          } else t.push(o);
        } catch (r) {
          if (!(r instanceof NotReadyError)) throw r;
          o = r;
        }
      }
      if (o) throw o;
      return f;
    }

    function trueFn() {
      return true;
    }

    /** @internal What a source ENTRY is, decided once when the view is built
     * (`merge()` learns it while flattening; `omit()` from its argument) and
     * carried beside the entry — `MergeView.kinds[i]`, `OmitView.kind` — so no
     * read has to ask. Asking is the cost: any brand check on a Proxy is a trap
     * (`instanceof` is a `getPrototypeOf` trap, ~20 ns on a store — as much as
     * the read itself), and a merge over a store did two per read. */
    const SOURCE_PLAIN = 0;

    // a plain object: own keys fixed, data is data
    const SOURCE_OMIT = 1;

    // an `OmitView` record (only as a merge entry)
    const SOURCE_PROXY = 2;

    // a store or foreign proxy: everything is a trap
    const SOURCE_MEMO = 3;

    // a function source (merge's memo): swaps objects
    const SOURCE_MERGE = 4;

    // a `MergeView` record (only as an omit's source)
    const EMPTY = Object.freeze({});

    // The object behind a LEAF entry (any kind but OMIT): a memo is read
    // (tracked, as merge's own reads are) and a nullish result has no keys.
    function leafOf(e, n) {
      return n === SOURCE_MEMO ? (e = e()) || EMPTY : e;
    }

    /** @internal The record behind an `omit()` proxy: `source` with `hidden`
     * keys removed. It is the proxy's TARGET, so the shared handler reads it as
     * plain fields — no per-instance closures — and it is what props consumers
     * walk directly (`merge`, `spread`, `ssrElement`): a view never materializes
     * a copy, and a consumer that knows the record never goes through its traps
     * (a `getOwnPropertyDescriptor` trap per key allocates a descriptor and a
     * getter, so enumerating a proxy costs more than the copy it was avoiding).
     * `hidden` is a key list or a predicate (`omit(props, k => k[0] === "$")`).
     *
     * An omit over a `merge()` holds the merge's RECORD (`MergeView`, kind
     * `SOURCE_MERGE`) — never its proxy, so no read hops through a trap — and is
     * one record however many leaves the merge has. A consumer walks it as ONE
     * filtered entry (`sourceKeys` / `sourceGet` recurse into the merge's
     * sources by function call), and a later `merge()` over it carries the
     * record as one entry instead of copying its leaves: on a component chain of
     * defaults + omit + spread (`merge(omit(merge(omit(props))))`) the layers
     * nest as records, each a few fields, where a flatten to leaf views built a
     * view and a combined key list per leaf per layer — the largest allocation
     * of a Kobalte-shaped render. A merge leaf may be merge's memo for a
     * function source; it is resolved on access. */
    class OmitView {
      source;
      kind;
      hidden;
      /** see `MergeView.table` */
      table = 0;
      /** see `tableOwnKeys` / `tableDescriptor` */
      keys = undefined;
      descs = undefined;
      constructor(e,
      /** of `source` — PLAIN, PROXY (a store or a foreign proxy), MEMO, or
       * MERGE (a `MergeView` record); never OMIT, a view over a view folds
       * into one. */
      n, t) {
        this.source = e;
        this.kind = n;
        this.hidden = t;
      }
    }
    function isHidden(e, n) {
      const t = e.hidden;
      return typeof t === "function" ? t(n) : t.includes(n);
    }

    // The object a view filters (see `leafOf`).
    function viewSource(e) {
      return leafOf(e.source, e.kind);
    }

    // The record behind a `$PROXY`-marked object that is one of OUR views, else
    // undefined for a store or a foreign proxy. ONE read: the view traps answer
    // `$RECORD` first thing and a store's `get` trap answers it `undefined` on
    // its symbol fast path, so the question never reaches a store's generic
    // read path (firewall gate, tracked key read), which is what an unknown
    // symbol would take — and a foreign proxy forwards it to a target that has
    // no such key. Asking `$TARGET` first and then each view kind was two to
    // four trap hops per source at every `merge()`, `omit()` and `ssrElement`.
    // Call only after `$PROXY in o` is known true.
    function recordOf(e) {
      return e[$RECORD];
    }

    // A props SOURCE ENTRY is a plain object, a proxy (store, merge, omit — the
    // last two are normally unwrapped first: `mergeView` / `omitView`), a memo,
    // or an `OmitView` record, and travels with its kind. These three answer for
    // an entry what `Object.keys` / `in` / `[]` answer for an object, so every
    // consumer walks entries with one code path, an `OmitView` is filtered
    // rather than materialized, and nothing is asked of a proxy but the read.
    // Own keys of a leaf: a proxy answers through ONE `ownKeys` trap (a store's
    // keeps the key set tracked; `Object.keys` on a proxy would add a descriptor
    // trap per key); a plain object its enumerable string keys. What a memo
    // holds is only known once read.
    function leafKeys(e, n) {
      if (n === SOURCE_PLAIN) return Object.keys(e);
      if (n === SOURCE_PROXY || e[$PROXY] === e) {
        // A store's handler answers directly: the Proxy `ownKeys` invariant checks cost twice the trap.
        const n = e[$TARGET];
        return (n?.px === e ? n : Reflect).ownKeys(e);
      }
      return Object.keys(e);
    }

    /** @internal Own string keys of a source entry — every consumer skips
     * symbols itself. */
    function sourceKeys(e, n) {
      if (n === SOURCE_OMIT) {
        if (e.kind === SOURCE_MERGE) return mergeKeysOf(e.source, false, e);
        const n = leafKeys(viewSource(e), e.kind);
        const t = [];
        for (let r = 0; r < n.length; r++) if (!isHidden(e, n[r])) t.push(n[r]);
        return t;
      }
      return leafKeys(leafOf(e, n), n);
    }

    /** @internal `key in entry`. */
    function sourceHas(e, n, t) {
      if (n === SOURCE_OMIT) {
        if (isHidden(e, t)) return false;
        return e.kind === SOURCE_MERGE ? mergeHas(e.source, t) : t in viewSource(e);
      }
      return t in leafOf(e, n);
    }

    /** @internal `entry[key]` — the source's getter runs once, here. */
    function sourceGet(e, n, t) {
      if (n === SOURCE_OMIT) {
        if (isHidden(e, t)) return undefined;
        return e.kind === SOURCE_MERGE ? mergeGet(e.source, t) : viewSource(e)[t];
      }
      return leafOf(e, n)[t];
    }

    // An entry whose own key set is fixed: a plain object, or a view over one —
    // an omit of a plain object, or of a merge whose entries all are. Not a
    // store (its key set is a tracked signal), not a merge memo source (it
    // swaps whole objects), and not any proxy that declares itself with
    // `$PROXY in s` — a frames slot proxy answers `has` for every key and lists
    // none, so only the `in` walk is right for it.
    function entryHasStaticKeys(e, n) {
      if (n === SOURCE_PLAIN) return true;
      if (n !== SOURCE_OMIT) return false;
      if (e.kind === SOURCE_PLAIN) return true;
      return e.kind === SOURCE_MERGE && mergeHasStaticKeys(e.source);
    }
    function mergeHasStaticKeys(e) {
      const n = e.sources,
        t = e.kinds;
      for (let e = 0; e < n.length; e++) if (!entryHasStaticKeys(n[e], t[e])) return false;
      return true;
    }

    /** @internal Whether the own key set of a props object cannot change
     * reactively: a plain object, or a merge/omit view over plain objects only.
     * A consumer may then decide from `Object.getOwnPropertyDescriptor` once —
     * "no `children` key" or "a data `children`" holds for the object's lifetime,
     * so no tracking scope is needed for it (#3388). For a store, or a view with
     * a store or memo leaf, keys can appear later and the reactive path is the
     * only correct one. */
    function hasStaticKeys(e) {
      if (!($PROXY in e)) return true;
      const n = recordOf(e);
      if (n instanceof MergeView) return mergeHasStaticKeys(n);
      return n !== undefined && entryHasStaticKeys(n, SOURCE_OMIT);
    }
    function accessorDescriptor(e, n = true) {
      return {
        configurable: true,
        enumerable: n,
        get: e,
        set: trueFn
      };
    }

    /** The descriptor a consumer should see for `key` on an entry —
     * the view proxies answer `getOwnPropertyDescriptor` with it, so it tells the
     * truth through any depth of merge/omit layers.
     *
     * A DATA descriptor means "nothing reactive can hide behind this value": the
     * key is a data property of a plain-object leaf — the compiler's own
     * encoding of a static attribute. Everything else is an accessor: a getter
     * on a leaf, a key on a store proxy (its "data" is a signal), or a key on a
     * merge memo source (the whole object is reactive). That is what lets a
     * consumer skip a reactive node for a static prop at the bottom of a
     * component chain, and it is why the store case must NOT forward the store's
     * own descriptor, which reports a value.
     *
     * `configurable: true` always — the target has no such property, and the
     * Proxy invariants forbid reporting a non-configurable one. */
    // `present` says the caller has already established `key in s` (a trap's
    // shadowing walk did), so a store is not asked a second time.
    function sourceDescriptor(e, n, t, r = false) {
      if (n === SOURCE_OMIT) {
        if (isHidden(e, t)) return undefined;
        return sourceDescriptor(e.source, e.kind, t, r);
      }
      // An omit's merge record: the descriptor of the last entry that has the
      // key, as the merge proxy's own trap answers (see `mergeDescriptor`).
      if (n === SOURCE_MERGE) return mergeDescriptor(e, t);
      // A memo source (`merge(() => …)`) is reactive wholesale: whatever shape
      // the memo's current object has, the key is an accessor here.
      if (n === SOURCE_MEMO) {
        return r || t in leafOf(e, n) ? accessorDescriptor(() => leafOf(e, n)[t]) : undefined;
      }
      if (n === SOURCE_PROXY) {
        // Another view (an omit's source may be a merge proxy) already answers
        // truthfully. A store's reported "data" is a signal, and a foreign proxy
        // (frames slot props) has no own descriptors: for both, existence is
        // `in` and the kind is accessor — one trap, and never the store's
        // descriptor path.
        if (recordOf(e) !== undefined) return Reflect.getOwnPropertyDescriptor(e, t);
        return r || t in e ? accessorDescriptor(() => e[t]) : undefined;
      }
      const i = Reflect.getOwnPropertyDescriptor(e, t);
      if (i === undefined) return undefined;
      if (i.get !== undefined || i.set !== undefined) return accessorDescriptor(() => e[t], i.enumerable);
      // The proxy target has no such key, so the descriptor must be configurable;
      // Reflect's is a fresh object, so a configurable one is handed out as is.
      if (i.configurable) return i;
      return {
        configurable: true,
        enumerable: i.enumerable,
        writable: true,
        value: i.value
      };
    }

    // The target of a merge() proxy: the flattened sources, read by one shared
    // handler — like OmitView, no per-instance closures. `sources` is what
    // `mergeSources` answers.
    /** @internal */
    class MergeView {
      sources;
      kinds;
      /** key → the plain leaf that owns it (later sources win), built by an
       * enumeration or once the reads have paid for it (see `resolvedTable`)
       * when every leaf has static keys; `null` when one doesn't. Until then
       * the slot counts the per-key trap reads so far. One slot rather than a
       * counter field of its own: a view is built per source per component
       * layer, and each field initializer is a measurable share of a
       * constructor that small in the lower JIT tiers. */
      table = 0;
      /** see `tableOwnKeys` / `tableDescriptor` */
      keys = undefined;
      descs = undefined;
      constructor(e, /** `kinds[i]` is what `sources[i]` is (see `SourceKind`). */
      n) {
        this.sources = e;
        this.kinds = n;
      }
    }

    /** @internal The record behind a merge() or omit() proxy — a `MergeView`
     * (flattened `sources` with their `kinds`) or an `OmitView` — or undefined
     * for anything else (a plain object, a store, a foreign proxy). Two fast
     * traps on a proxy (`has`, then `$RECORD`), none on a plain object. */
    function viewOf(e) {
      return e && $PROXY in e ? e[$RECORD] : undefined;
    }

    /** @internal The resolved key table of a merge/omit view — every own key of
     * the view mapped to the plain object that owns it, in merged order (a key
     * at the position of the last source that carries it, see `tableSet`) — or
     * undefined when it has none: a leaf is a store or a memo source, whose
     * keys can change, or the object is not a view at all.
     *
     * This is the flat object the eager copy used to build, made lazily and
     * without copying: one pass over the leaves' own keys, then every
     * `get`/`has`/descriptor is one lookup plus one read of the owning leaf, and
     * a consumer (`spread` rerunning its effect) walks the table instead of
     * re-deriving shadowing from the leaves each time. Own keys only, as the
     * copy's were: a plain source's key set is fixed once merged (keys added to
     * it later are not seen — the copy didn't see them either).
     *
     * It is built by an ENUMERATION — the `ownKeys` trap, or a consumer asking
     * for it here — or once per-key reads have paid for it (`READS_FOR_TABLE`),
     * not on the first read. A per-key read has a direct answer (a walk of the
     * sources, last to first, one `in` each) whose cost is the source count,
     * while the table's is every key of every leaf, so the walk wins until a
     * view has been read about as many times as it has keys. On the server it
     * never is: a component reads its props a few times, the element enumerates
     * them once through its own source walk, and the view is gone — building on
     * first read there cost a component chain a table per layer (profiled on
     * the Kobalte-shaped chain: a third of SSR time in the table code and its
     * garbage). On the
     * client a view read on every reactive rerun crosses the threshold in its
     * first few updates and is one lookup per read from then on, as before.
     * Once built — by a `spread`, `Object.keys`, `{...props}`, or the count —
     * every trap uses it. */
    function resolvedTable(e) {
      if (!e || !($PROXY in e)) return undefined;
      const n = recordOf(e);
      if (n instanceof OmitView) return omitTable(n);
      return n === undefined ? undefined : mergeTable(n);
    }
    function mergeTable(e) {
      let n = e.table;
      if (typeof n !== "object") {
        // a read count: not decided yet
        const t = e.sources,
          r = e.kinds;
        for (let n = 0; n < t.length; n++) {
          if (!entryHasStaticKeys(t[n], r[n])) {
            e.table = null;
            return undefined;
          }
        }
        n = new Map();
        collectTable(n, e, undefined);
        e.table = n;
      }
      return n === null ? undefined : n;
    }

    // One pass over a merge record's leaves into `table`, through the nested
    // omit-over-merge entries — the filters enclosing the current leaf are the
    // `filters` stack — so a component chain builds ONE table at the view that
    // asked, not one per layer. A key an entry hides that an EARLIER entry owned
    // must stay: a filter applies to its own entry's contribution, not to the
    // merge, which is exactly what the stack expresses. Every entry has static
    // keys (the caller checked), so a leaf's own keys are the truth.
    function collectTable(e, n, t) {
      const r = n.sources,
        i = n.kinds;
      for (let n = 0; n < r.length; n++) {
        const f = r[n];
        if (i[n] === SOURCE_OMIT) {
          if (f.kind === SOURCE_MERGE) {
            if (t === undefined) t = [f];else t.push(f);
            collectTable(e, f.source, t);
            t.pop();
            continue;
          }
          const n = f.source;
          const r = Reflect.ownKeys(n);
          for (let i = 0; i < r.length; i++) {
            const u = r[i];
            if (!isHidden(f, u) && !hiddenByAny(t, u)) tableSet(e, u, n);
          }
        } else {
          const n = Reflect.ownKeys(f);
          for (let r = 0; r < n.length; r++) {
            const i = n[r];
            if (!hiddenByAny(t, i)) tableSet(e, i, f);
          }
        }
      }
    }
    function hiddenByAny(e, n) {
      if (e !== undefined) for (let t = e.length - 1; t >= 0; t--) if (isHidden(e[t], n)) return true;
      return false;
    }

    // Key order is the merged one — every key at the position of the LAST source
    // that carries it — the order `ssrElement`'s array form serializes in and the
    // eager copy enumerated in, so a spread through a view and a spread over the
    // sources emit the same attribute order.
    function tableSet(e, n, t) {
      if (e.has(n)) e.delete(n);
      e.set(n, t);
    }

    // An omit view's table: its source's (a merge's table, or a plain object's
    // own keys) minus the hidden keys. Cached on the record.
    function omitTable(e) {
      let n = e.table;
      if (typeof n !== "object") {
        const t = e.source;
        if (e.kind === SOURCE_MERGE) {
          // One pass over the merge's leaves with this filter on the stack —
          // the merge record builds no table of its own for it.
          if (!mergeHasStaticKeys(t)) {
            e.table = null;
            return undefined;
          }
          n = new Map();
          collectTable(n, t, [e]);
        } else if (e.kind === SOURCE_PLAIN) {
          n = new Map();
          const r = Reflect.ownKeys(t);
          for (let i = 0; i < r.length; i++) {
            const f = r[i];
            if (!isHidden(e, f)) n.set(f, t);
          }
        } else {
          // a store or a memo: keys can change, no table
          e.table = null;
          return undefined;
        }
        e.table = n;
      }
      return n === null ? undefined : n;
    }

    // The user-facing key set of a resolved table: its keys that are enumerable
    // on the leaf that owns them (`Object.keys(merged)`, #2769). Fixed, like the
    // table, so it is built once per view: an `ownKeys` trap may hand back the
    // same array every time (the engine copies it).
    const propertyIsEnumerable = Object.prototype.propertyIsEnumerable;
    function tableOwnKeys(e, n) {
      let t = e.keys;
      if (t === undefined) {
        t = e.keys = [];
        for (const [e, r] of n) if (propertyIsEnumerable.call(r, e)) t.push(e);
      }
      return t;
    }

    // The descriptor for a table key — its owning leaf's, truthful (see
    // `sourceDescriptor`) — with the shape cached per key so an enumeration
    // (`for…in`, `Object.keys`, `{...props}`: a descriptor trap per key, on
    // every pass) does not re-read the leaf's descriptor and re-allocate a
    // getter each time. An accessor reads live, so its descriptor is reused as
    // is; a data descriptor is rebuilt with the current value.
    function tableDescriptor(e, n, t) {
      const r = n.get(t);
      if (r === undefined) return undefined;
      let i = e.descs;
      if (i === undefined) i = e.descs = new Map();
      let f = i.get(t);
      if (f === undefined) {
        f = sourceDescriptor(r, SOURCE_PLAIN, t);
        if (f === undefined) return undefined;
        i.set(t, f);
        return f;
      }
      if (f.get !== undefined) return f;
      return {
        configurable: true,
        enumerable: f.enumerable,
        writable: f.writable,
        value: r[t]
      };
    }

    // Per-key trap reads a view takes before building its table, from the
    // break-even: a build is ~60 ns per key (an `ownKeys` share, a `has`, a
    // `set`), a walk ~20 ns per source (an `in`, a hidden-list check), and a
    // leaf carries about five keys — so the table has paid for itself after
    // ~15 reads. Measured on the Kobalte-shaped chain: a walk is 2× a lookup at
    // depth 1 and up to 10× for a first-source key at depth 7 (a walk through
    // seven nested layers, a hidden-list check at each), so a view read on
    // every update wants the table; a view read a handful of times (every
    // server-side view) never wants it.
    const READS_FOR_TABLE = 16;

    // The table for a per-key trap: the one a view HAS (built by an enumeration
    // or an earlier read, see `resolvedTable`), or the one this read pays for,
    // or none — a walk answers. One per view type, so a trap pays no type check.
    // A settled slot is an object (the Map, or `null`); a number is the count.
    function mergeReadTable(e) {
      const n = e.table;
      if (typeof n === "object") return n === null ? undefined : n;
      if (n + 1 < READS_FOR_TABLE) {
        e.table = n + 1;
        return undefined;
      }
      return mergeTable(e);
    }

    // The table a record HAS — built already by an enumeration or a trap's read
    // count — or undefined. What a nested walk asks: a record reached through an
    // outer view's entry counts no reads of its own (the outer view decides for
    // the whole tree, and its table build then builds the inner ones), so the
    // inner merges of a component chain build nothing on the server where the
    // leaves are read a few times each.
    function tableOf(e) {
      const n = e.table;
      return typeof n === "object" && n !== null ? n : undefined;
    }

    // "no entry has the key" — distinct from an entry that holds `undefined`.
    const MISSING = Symbol();

    // The read: the value of the last entry that has the key, or MISSING. ONE
    // walk — a nested omit-over-merge entry answers presence and value together,
    // so a chain of layers is walked once per read, not once per layer per
    // level.
    function mergeLookup(e, n) {
      const t = tableOf(e);
      if (t !== undefined) {
        const e = t.get(n);
        return e === undefined ? MISSING : e[n];
      }
      const r = e.sources,
        i = e.kinds;
      for (let e = r.length - 1; e >= 0; e--) {
        const t = i[e];
        // The common leaf first, read in place: a component's props view is a
        // few plain objects, read once per key on the server.
        if (t === SOURCE_PLAIN) {
          const t = r[e];
          if (n in t) return t[n];
          continue;
        }
        if (t === SOURCE_OMIT) {
          const t = r[e];
          if (isHidden(t, n)) continue;
          if (t.kind === SOURCE_MERGE) {
            const e = mergeLookup(t.source, n);
            if (e !== MISSING) return e;
            continue;
          }
          const i = viewSource(t);
          if (n in i) return i[n];
        } else {
          const i = leafOf(r[e], t);
          if (n in i) return i[n];
        }
      }
      return MISSING;
    }
    function mergeGet(e, n) {
      const t = mergeLookup(e, n);
      return t === MISSING ? undefined : t;
    }

    // `key in merge`, on the record.
    function mergeHas(e, n) {
      const t = tableOf(e);
      if (t !== undefined) return t.has(n);
      const r = e.sources,
        i = e.kinds;
      for (let e = r.length - 1; e >= 0; e--) if (sourceHas(r[e], i[e], n)) return true;
      return false;
    }

    // The proxy's `getOwnPropertyDescriptor`, on the record.
    function mergeDescriptor(e, n) {
      const t = tableOf(e);
      if (t !== undefined) return tableDescriptor(e, t, n);
      const r = e.sources,
        i = e.kinds;
      for (let t = r.length - 1; t >= 0; t--) {
        if (!sourceHas(r[t], i[t], n)) continue;
        // `in` also answers for inherited keys, which have no own descriptor.
        return sourceDescriptor(r[t], i[t], n, true) ?? accessorDescriptor(() => mergeGet(e, n));
      }
      return undefined;
    }

    // Own keys of a merge record in merged order — every key at the position
    // of the LAST entry that carries it, the order the table keeps and
    // `ssrElement` serializes in. `enumerable` selects the user-facing set
    // (`Object.keys`, #2769) over every own string key (a consumer's walk);
    // `filter` is the omit this record is read through, applied as the keys
    // are gathered so an omit over a merge builds ONE list per layer. A list
    // with `indexOf` rather than a Set: a props object has a dozen keys, and a
    // Set's hash store was 2 KB per row on the Kobalte-shaped chain.
    function mergeKeysOf(e, n, t) {
      const r = [];
      collectKeys(e, t === undefined ? undefined : [t], n, r, null);
      return r;
    }

    // One pass over a merge record's leaves — through its nested omit-over-merge
    // entries, `filters` the omits enclosing the current leaf (see
    // `collectTable`) — appending each leaf's keys to `keys` in merged order
    // (a key already listed moves to the end: later wins) and, when `owners` is
    // given, the object that owns the key at the same index. A consumer that
    // reads every key once (`ssrElement`) then reads `owners[i][keys[i]]`: no
    // `in` walk per key, no table. A memo leaf is resolved once here.
    function collectKeys(e, n, t, r, i) {
      const f = e.sources,
        u = e.kinds;
      for (let e = 0; e < f.length; e++) {
        let o = f[e],
          c = u[e];
        let s;
        if (c === SOURCE_OMIT) {
          if (o.kind === SOURCE_MERGE) {
            if (n === undefined) n = [o];else n.push(o);
            collectKeys(o.source, n, t, r, i);
            n.pop();
            continue;
          }
          s = o;
          c = o.kind;
          o = o.source;
        }
        o = leafOf(o, c);
        const d = t ? ownEnumerableKeys(o) : leafKeys(o, c);
        for (let e = 0; e < d.length; e++) {
          const t = d[e];
          if (s !== undefined && isHidden(s, t)) continue;
          if (hiddenByAny(n, t)) continue;
          addKey(r, i, t);
        }
      }
    }

    // Append `key` owned by `owner`, moving an earlier listing to the end: later
    // wins, and the position is the last owner's (the merged order).
    function addKey(e, n, t, r) {
      const i = e.indexOf(t);
      if (i !== -1) {
        e.splice(i, 1);
      }
      e.push(t);
    }

    // The user-facing key set of a merge record, read through `filter` if given.
    function mergeEnumerableKeys(e, n) {
      const t = mergeTable(e);
      if (t === undefined) return mergeKeysOf(e, true, n);
      const r = tableOwnKeys(e, t);
      return r;
    }
    const mergeTraps = {
      get(e, n, t) {
        // The private keys are symbols; a string read (every prop) skips the
        // compares. `$TARGET` is answered so a store check never walks the
        // sources (a leaf that is a store would answer it).
        if (typeof n === "symbol") {
          if (n === $PROXY) return t;
          if (n === $RECORD) return e;
          if (n === $TARGET) return undefined;
        }
        // A trap read counts toward the table (see `mergeReadTable`); the walk
        // itself is the record's. `mergeReadTable` and the plain walk of
        // `mergeLookup` are inlined here: a trap is entered from the runtime, so
        // nothing below it is inlined for it, and a component's props view is a
        // few plain objects read once per key on the server — the walk is the
        // whole read. A leaf that is not plain hands the walk to `mergeGet`,
        // which starts over (a plain leaf walked twice is two `in` checks).
        const r = e.table;
        let i;
        if (typeof r !== "object") {
          if (r + 1 < READS_FOR_TABLE) {
            e.table = r + 1;
            const t = e.sources,
              i = e.kinds;
            for (let r = t.length - 1; r >= 0; r--) {
              if (i[r] !== SOURCE_PLAIN) return mergeGet(e, n);
              // Read first, `in` only to tell a missing key from one holding
              // undefined: the last source is the one that usually has the key.
              const f = t[r][n];
              if (f !== undefined || n in t[r]) return f;
            }
            return undefined;
          }
          i = mergeTable(e);
          if (i === undefined) return mergeGet(e, n);
        } else if (r === null) return mergeGet(e, n);else i = r;
        const f = i.get(n);
        return f === undefined ? undefined : f[n];
      },
      has(e, n) {
        if (n === $PROXY) return true;
        if (n === $TARGET || n === $RECORD) return false;
        const t = mergeReadTable(e);
        if (t !== undefined) return t.has(n);
        return mergeHas(e, n);
      },
      set: trueFn,
      deleteProperty: trueFn,
      getOwnPropertyDescriptor(e, n) {
        if (n === $PROXY || n === $TARGET || n === $RECORD) return undefined;
        const t = mergeReadTable(e);
        if (t !== undefined) return tableDescriptor(e, t, n);
        return mergeDescriptor(e, n);
      },
      ownKeys(e) {
        return mergeEnumerableKeys(e);
      }
    };

    /**
     * Merges multiple props-like objects into a single proxy that *preserves
     * reactivity*. Reads are forwarded to the right-most source that defines the
     * property, so later sources override earlier ones (like `Object.assign`).
     *
     * Function arguments are treated as memo-backed sources — useful for passing
     * derived defaults whose computation should track reactively.
     *
     * The result is a live VIEW of its sources, never a copy: creating it costs
     * nothing per key, every read goes to the source that owns the key (a getter
     * runs there, a data property is read live), and writing to it is a no-op.
     * A single non-function source is returned as is. To own a mutable object,
     * copy it: `{ ...merged }` snapshots the current values.
     *
     * Use this in component bodies to merge defaults / overrides without losing
     * Solid's per-property tracking.
     *
     * Reading props, here and anywhere: a prop's getter is defined only for a
     * read through its own object (`props.x`, `{ ...props }`, `Reflect.get`,
     * these views). Forwarding its descriptor onto another object and reading it
     * there is not supported — the compiler's server-side props keep their state
     * on the instance, so the getter needs its object as receiver. A copy that
     * must stay live defines its own getter that reads through the source, as
     * the no-Proxy paths of merge() and omit() do.
     *
     * @example
     * ```tsx
     * function Button(_props: { label: string; type?: string; disabled?: boolean }) {
     *   const props = merge({ type: "button", disabled: false }, _props);
     *
     *   return <button type={props.type} disabled={props.disabled}>{props.label}</button>;
     * }
     * ```
     */
    function merge(...e) {
      if (e.length === 1 && typeof e[0] !== "function") return e[0];
      // Sized to the argument count up front: a view is built per source per
      // component layer, and growing two empty arrays by `push` was a third of
      // its construction. A nested view's sources may run past the count (the
      // array grows), a falsy source leaves it short (trimmed below).
      const n = new Array(e.length);
      const t = new Array(e.length);
      let r = 0;
      // The one non-falsy source, if there is exactly one: it IS the merge.
      let i = undefined;
      let f = 0;
      for (let u = 0; u < e.length; u++) {
        const o = e[u];
        if (!o) continue;
        f++;
        i = o;
        if (typeof o === "function") {
          // Observe tiers name it and exempt it from UNSTABLE_MEMO_OUTPUT (see
          // CONFIG_KEY_BAG); prod passes no options.
          n[r] = createMemo$1(o);
          t[r++] = SOURCE_MEMO;
          continue;
        }
        if ($PROXY in o) {
          // A store (or a foreign proxy) is a leaf as it is. A merge() proxy is
          // flattened through: its writes are no-ops, so its sources are exactly
          // what it reads. An omit() proxy joins as its view record — ONE entry,
          // its filter travelling with it, whether it is over a plain object or
          // a whole merge (never the merge's own sources, which would leak the
          // omitted keys, #3014). A consumer's walk recurses into the record.
          const e = recordOf(o);
          if (e instanceof MergeView) {
            for (let i = 0; i < e.sources.length; i++) {
              n[r] = e.sources[i];
              t[r++] = e.kinds[i];
            }
          } else if (e !== undefined) {
            n[r] = e;
            t[r++] = SOURCE_OMIT;
          } else {
            n[r] = o;
            t[r++] = SOURCE_PROXY;
          }
          continue;
        }
        n[r] = o;
        t[r++] = SOURCE_PLAIN;
      }
      if (r !== n.length) {
        n.length = r;
        t.length = r;
      }
      if (SUPPORTS_PROXY) {
        if (f === 1 && typeof i !== "function") return i;
        // Always a view, never a copy. Building a plain object here costs a
        // descriptor read, a bound getter and a defineProperty per key per
        // layer, and component libraries stack several layers per element
        // (defaults → omit → call-site statics → …), so the copies dominated
        // their render cost while every consumer that matters — `spread`,
        // `ssrElement`, a nested merge — reads the flattened sources directly
        // anyway (#3448). The view is O(1) to create and reads through to the
        // sources, so a data property on a source is read live, like a getter.
        // Writes to the result are no-ops (a consumer that needs its own object
        // copies: `{...merged}`, which the traps answer truthfully). Copies of
        // the result never carry $RECORD (#3384): `ownKeys` answers only the
        // sources' keys.
        return new Proxy(new MergeView(n, t), mergeTraps);
      }
      // No Proxy: an eager descriptor copy, semantics as close to the view as a
      // plain object allows (getters stay live; data properties are snapshots).
      const u = Object.create(null);
      let o = false;
      let c = n.length - 1;
      for (let e = c; e >= 0; e--) {
        const t = n[e];
        if (!t) {
          e === c && c--;
          continue;
        }
        const r = Object.getOwnPropertyNames(t);
        for (let n = r.length - 1; n >= 0; n--) {
          const i = r[n];
          if (i === "__proto__" || i === "constructor") continue;
          if (!u[i]) {
            o = o || e !== c;
            const n = Object.getOwnPropertyDescriptor(t, i);
            u[i] = n.get ? {
              enumerable: true,
              configurable: true,
              get: n.get.bind(t)
            } : n;
          }
        }
      }
      if (!o) return n[c];
      const s = {};
      const d = Object.keys(u);
      for (let e = d.length - 1; e >= 0; e--) {
        const n = d[e],
          t = u[n];
        if (t.get) Object.defineProperty(s, n, t);else s[n] = t.value;
      }
      return s;
    }

    const createMemo = (...args) => {
      return (createMemo$1)(...args);
    };
    let createRoot = createRoot$1;
    let createRenderEffect = createRenderEffect$1;
    function createComponent$1(Comp, props, name, loc) {
      return untrack(() => Comp(props || {}));
    }

    const transparentOptions = {
      transparent: true,
      sync: true
    };
    const syncOptions = {
      sync: true
    };
    const effect = (fn, effectFn, options) => createRenderEffect(fn, effectFn, options ? {
      sync: true,
      ...options,
      transparent: !options.scope
    } : transparentOptions);
    const memo = fn => createMemo(() => fn(), syncOptions);
    const named = (options, fallback) => options;
    const INNER_OWNED = {};
    function createRenderer({
      createElement,
      createTextNode,
      createSentinel = () => createTextNode(""),
      isTextNode,
      replaceText,
      insertNode,
      removeNode,
      cleanupNodes,
      setProperty,
      getParentNode,
      getFirstChild,
      getNextSibling
    }) {
      function insert(parent, accessor, marker, initial, options) {
        const onUpdate = options && options.onUpdate;
        let effectOptions = options;
        if (onUpdate) {
          const {
            onUpdate,
            ...rest
          } = options;
          effectOptions = rest;
        }
        effectOptions = named(effectOptions);
        const multi = marker !== undefined;
        if (multi && !initial) initial = [];
        if (typeof accessor !== "function") {
          accessor = normalize(accessor, multi, true);
          if (typeof accessor !== "function") {
            insertExpression(parent, accessor, initial, marker);
            onUpdate && onUpdate(accessor);
            return;
          }
        }
        if (multi && initial.length === 0) {
          const sentinel = createSentinel();
          insertNode(parent, sentinel, marker);
          initial = [sentinel];
        }
        let current = initial;
        effect(prev => {
          const value = normalize(accessor(), multi, true);
          if (typeof value !== "function") return value;
          effect(() => normalize(value, multi), inner => {
            insertExpression(parent, inner, current, marker);
            current = inner;
            onUpdate && onUpdate(current);
          }, prev !== undefined && !(options && options.schedule) ? {
            ...effectOptions,
            schedule: true
          } : effectOptions);
          return INNER_OWNED;
        }, value => {
          if (value === INNER_OWNED) return;
          insertExpression(parent, value, current, marker);
          current = value;
          onUpdate && onUpdate(current);
        }, effectOptions);
      }
      function insertExpression(parent, value, current, marker) {
        if (value === current) return;
        const t = typeof value,
          multi = marker !== undefined;
        if (t === "string" || t === "number") {
          const tc = typeof current;
          if (tc === "string" || tc === "number") {
            replaceText(getFirstChild(parent), value);
          } else {
            cleanChildren(parent, current, marker, createTextNode(value));
          }
        } else if (value == null) {
          cleanChildren(parent, current, marker);
        } else if (Array.isArray(value)) {
          if (value.length === 0) {
            cleanChildren(parent, current, marker);
          } else {
            if (Array.isArray(current)) {
              if (current.length === 0) {
                appendNodes(parent, value, marker);
              } else reconcileArrays(parent, current, value);
            } else if (current == null) {
              appendNodes(parent, value);
            } else {
              reconcileArrays(parent, multi && current || [getFirstChild(parent)], value);
            }
          }
        } else {
          if (Array.isArray(current)) {
            cleanChildren(parent, current, multi ? marker : null, value);
          } else if (current == null || !getFirstChild(parent)) {
            insertNode(parent, value);
          } else replaceNode(parent, value, getFirstChild(parent));
        }
      }
      function normalize(value, multi, doNotUnwrap) {
        value = flatten(value, {
          skipNonRendered: true,
          doNotUnwrap
        });
        if (doNotUnwrap && typeof value === "function") return value;
        if (multi && !Array.isArray(value)) value = [value != null ? value : ""];else if (multi && !value.length) value = [createSentinel()];
        if (Array.isArray(value)) {
          for (let i = 0, len = value.length; i < len; i++) {
            const item = value[i],
              t = typeof item;
            if (t === "string" || t === "number") value[i] = createTextNode(item);
          }
        }
        return value;
      }
      function reconcileArrays(parentNode, a, b) {
        let bLength = b.length,
          aEnd = a.length,
          bEnd = bLength,
          aStart = 0,
          bStart = 0,
          after = getNextSibling(a[aEnd - 1]),
          map = null;
        const isLive = n => n && getParentNode(n) === parentNode;
        while (aStart < aEnd || bStart < bEnd) {
          if (a[aStart] === b[bStart] && isLive(a[aStart])) {
            aStart++;
            bStart++;
            continue;
          }
          while (a[aEnd - 1] === b[bEnd - 1] && isLive(a[aEnd - 1])) {
            aEnd--;
            bEnd--;
          }
          if (aEnd === aStart) {
            const node = bEnd < bLength ? bStart ? getNextSibling(b[bStart - 1]) : b[bEnd - bStart] : after;
            while (bStart < bEnd) insertNode(parentNode, b[bStart++], node);
          } else if (bEnd === bStart) {
            while (aStart < aEnd) {
              if (!map || !map.has(a[aStart])) removeNode(parentNode, a[aStart]);
              aStart++;
            }
          } else if (a[aStart] === b[bEnd - 1] && b[bStart] === a[aEnd - 1]) {
            const anchor = a[aStart];
            do {
              insertNode(parentNode, a[--aEnd], anchor);
              bStart++;
              if (aStart >= aEnd - 1 || bStart >= bEnd) break;
            } while (a[aStart] === b[bEnd - 1] && b[bStart] === a[aEnd - 1]);
          } else {
            if (!map) {
              map = new Map();
              let i = bStart;
              while (i < bEnd) map.set(b[i], i++);
            }
            const index = map.get(a[aStart]);
            if (index != null) {
              if (bStart < index && index < bEnd) {
                let i = aStart,
                  sequence = 1,
                  t;
                while (++i < aEnd && i < bEnd) {
                  if ((t = map.get(a[i])) == null || t !== index + sequence) break;
                  sequence++;
                }
                if (sequence > index - bStart) {
                  const node = a[aStart];
                  while (bStart < index) insertNode(parentNode, b[bStart++], node);
                } else replaceNode(parentNode, b[bStart++], a[aStart++]);
              } else aStart++;
            } else removeNode(parentNode, a[aStart++]);
          }
        }
      }
      function cleanChildren(parent, current, marker, replacement) {
        if (marker === undefined) {
          let removed;
          while (removed = getFirstChild(parent)) removeNode(parent, removed);
          replacement && insertNode(parent, replacement);
          return "";
        }
        if (current.length) {
          let inserted = false;
          for (let i = current.length - 1; i >= 0; i--) {
            const el = current[i];
            if (replacement !== el) {
              const isParent = getParentNode(el) === parent;
              if (replacement && !inserted && !i) isParent ? replaceNode(parent, replacement, el) : insertNode(parent, replacement, marker);else isParent && removeNode(parent, el);
            } else inserted = true;
          }
        } else if (replacement) insertNode(parent, replacement, marker);
      }
      function appendNodes(parent, array, marker) {
        for (let i = 0, len = array.length; i < len; i++) insertNode(parent, array[i], marker);
      }
      function replaceNode(parent, newNode, oldNode) {
        insertNode(parent, newNode, oldNode);
        removeNode(parent, oldNode);
      }
      function collectNodes(value, nodes) {
        if (Array.isArray(value)) {
          for (let i = 0, len = value.length; i < len; i++) collectNodes(value[i], nodes);
        } else if (value != null && typeof value !== "string" && typeof value !== "number") {
          nodes.push(value);
        }
        return nodes;
      }
      function collectMounted(parent, value) {
        const nodes = collectNodes(value, []);
        if (!nodes.length && (typeof value === "string" || typeof value === "number")) {
          const node = getFirstChild(parent);
          if (node) nodes.push(node);
        }
        return nodes;
      }
      function defaultCleanupNodes(parent, nodes) {
        for (let i = 0, len = nodes.length; i < len; i++) {
          const node = nodes[i];
          if (getParentNode(node) === parent) removeNode(parent, node);
        }
      }
      function spread(node, props, skipChildren, options) {
        const prevProps = {};
        const apply = newProps => {
          for (const prop in prevProps) {
            if (prop in newProps) continue;
            if (prop !== "ref") setProperty(node, prop, undefined, prevProps[prop]);
            delete prevProps[prop];
          }
          for (const prop in newProps) {
            const value = newProps[prop];
            if (value === prevProps[prop]) continue;
            if (prop === "ref") {
              (typeof value === "function" || Array.isArray(value)) && ref(() => value, node);
            } else setProperty(node, prop, value, prevProps[prop]);
            prevProps[prop] = value;
          }
        };
        const childrenOptions = () => named(options);
        if (Array.isArray(props)) {
          if (!skipChildren) insert(node, () => {
            for (let i = props.length - 1; i >= 0; i--) {
              const s = resolveSource(props[i]);
              if (s != null && entryHas(s, "children")) return entryGet(s, "children");
            }
          }, undefined, undefined, childrenOptions());
          effect(() => collectSources({}, props, undefined), apply, named(options));
          return prevProps;
        }
        if (!skipChildren) {
          if (typeof props !== "function" && props != null && hasStaticKeys(props)) {
            const desc = Object.getOwnPropertyDescriptor(props, "children");
            if (desc !== undefined) {
              if (desc.get === undefined) insert(node, desc.value, undefined, undefined, childrenOptions());else insert(node, () => props.children, undefined, undefined, childrenOptions());
            }
          } else insert(node, () => {
            const s = resolveSource(props);
            return s != null ? entryGet(s, "children") : undefined;
          }, undefined, undefined, childrenOptions());
        }
        effect(() => {
          const s = resolveSource(props);
          const newProps = {};
          const table = resolvedTable(s);
          if (table !== undefined) {
            for (const [prop, leaf] of table) {
              if (typeof prop !== "string" || prop === "children") continue;
              newProps[prop] = leaf[prop];
            }
            return newProps;
          }
          if (s != null) {
            const view = viewOf(s);
            if (view instanceof OmitView) collectProps(newProps, view, SOURCE_OMIT);else if (view !== undefined) collectSources(newProps, view.sources, view.kinds);else collectProps(newProps, s, $PROXY in s ? SOURCE_PROXY : SOURCE_PLAIN);
          }
          return newProps;
        }, apply, named(options));
        return prevProps;
      }
      function resolveSource(s) {
        return typeof s === "function" ? s() : s;
      }
      function entryHas(s, key) {
        const view = viewOf(s);
        return view instanceof OmitView ? sourceHas(view, SOURCE_OMIT, key) : key in s;
      }
      function entryGet(s, key) {
        const view = viewOf(s);
        return view instanceof OmitView ? sourceGet(view, SOURCE_OMIT, key) : s[key];
      }
      function collectSources(out, sources, kinds) {
        const resolved = [];
        const resolvedKinds = [];
        for (let i = 0; i < sources.length; i++) pushEntry(resolved, resolvedKinds, sources[i], kinds !== undefined ? kinds[i] : SOURCE_MEMO);
        for (let i = 0; i < resolved.length; i++) collectProps(out, resolved[i], resolvedKinds[i], resolved, resolvedKinds, i + 1);
        return out;
      }
      function pushEntry(resolved, kinds, s, kind) {
        if (kind !== SOURCE_MEMO) {
          resolved.push(s);
          kinds.push(kind);
          return;
        }
        s = resolveSource(s);
        if (s == null) return;
        const view = viewOf(s);
        if (view instanceof OmitView) {
          resolved.push(view);
          kinds.push(SOURCE_OMIT);
        } else if (view !== undefined) {
          const f = view.sources,
            k = view.kinds;
          for (let j = 0; j < f.length; j++) pushEntry(resolved, kinds, f[j], k[j]);
        } else {
          resolved.push(s);
          kinds.push($PROXY in s ? SOURCE_PROXY : SOURCE_PLAIN);
        }
      }
      function collectProps(out, s, kind, later, laterKinds, from) {
        const keys = sourceKeys(s, kind);
        outer: for (let i = 0; i < keys.length; i++) {
          const prop = keys[i];
          if (typeof prop !== "string" || prop === "children") continue;
          if (later !== undefined) for (let j = from; j < later.length; j++) if (sourceHas(later[j], laterKinds[j], prop)) continue outer;
          out[prop] = sourceGet(s, kind, prop);
        }
        return out;
      }
      function applyRef(r, element) {
        Array.isArray(r) ? r.flat(Infinity).forEach(f => f && f(element)) : r(element);
      }
      function ref(fn, element) {
        const resolved = untrack(fn);
        runRefCallback(() => applyRef(resolved, element));
      }
      return {
        render(code, element) {
          let disposer,
            disposed = false,
            mounted = [];
          const cleanup = cleanupNodes || defaultCleanupNodes;
          try {
            createRoot(dispose => {
              disposer = dispose;
              const tree = code();
              const renderOptions = {
                schedule: true,
                onUpdate(value) {
                  mounted = collectMounted(element, value);
                }
              };
              if (false) ;
              insert(element, () => tree, undefined, undefined, renderOptions);
            });
            flush();
          } catch (err) {
            if (disposer) disposer();
            cleanup(element, mounted);
            throw err;
          }
          return () => {
            if (disposed) return;
            disposed = true;
            disposer();
            cleanup(element, mounted);
            mounted = [];
          };
        },
        insert,
        spread,
        createElement,
        createTextNode,
        insertNode,
        setProp(node, name, value, prev) {
          setProperty(node, name, value, prev);
          return value;
        },
        mergeProps: merge,
        effect,
        memo,
        createComponent: createComponent$1,
        applyRef,
        ref
      };
    }

    // Solid 2 universal renderer (@solidjs/universal) that drives a native host
    // through `globalThis.__host` (README: Host interface). The host owns the real
    // nodes (props, Yoga layout, views) and knows them only by integer tag. This
    // side keeps the tree bookkeeping Solid needs (parent / first child / next
    // sibling) in small JS objects, and the JS event handlers by tag.
    //
    // When mutations reach the host (README: Batching and commits): Solid 2
    // batches every write and applies it when its queue is flushed. Each call
    // into the app (mount, onState, dispatch, timer) runs inside flush(fn), so
    // everything that call causes (render effects, then user effects, and
    // whatever they write in turn) is applied before it returns, and then the
    // renderer commits once. Work Solid finishes later, in a microtask (async
    // computations, actions), mutates the host outside any call; the renderer
    // then commits it itself, in a microtask of its own after Solid's.
    const host = () => globalThis.__host;

    // JS event handlers live on their Node (node.handlers: { eventName: fn });
    // dispatch finds the node by tag through a weak reference, so a handler
    // that closes over its own node (a ref) does not keep it alive: the node and
    // its handlers are collected together. tag -> WeakRef(node).
    const byTag = new Map();
    const weak = typeof WeakRef === "function" ? n => new WeakRef(n) : n => ({
      deref: () => n
    });

    // Host nodes live as long as their JS Node object: once the engine collects
    // it (nothing in JS can reach it, so Solid can never re-insert it), the host
    // is told to free the tag. Callbacks run as engine jobs after a GC, outside
    // any batch; they are not part of the golden logs (timing is the engine's).
    const released = typeof FinalizationRegistry === "function" ? new FinalizationRegistry(tag => {
      byTag.delete(tag);
      const h = host();
      if (h && h.release) h.release(tag);
    }) : null;
    const track = node => {
      if (released) released.register(node, node.tag);
      return node;
    };

    // ---- commits ----------------------------------------------------------------
    // `calls`: how deep we are in calls into the app (a handler may call into
    // another entry point, e.g. a test calling __app.onState from a handler).
    // `dirty`: the host's tree changed since the last commit.
    let calls = 0;
    let dirty = false;
    let lateQueued = false;
    // An error that escaped every boundary while Solid flushed: Solid halts its
    // reactivity and hands the error to globalThis.reportError (when there is
    // one) rather than throw it, e.g. when an async value lands in a promise
    // reaction and its render throws. Here it fails the call it happened in or,
    // outside any call, a job of its own (the host's job queue then fails, as
    // for any job that throws), so the host learns of it either way.
    let reported = null;
    // Set by the first report: a late commit due after it would show the
    // half-applied update the error interrupted, so there is none.
    let failed = false;
    globalThis.reportError = function reportError(e) {
      failed = true;
      if (calls > 0) {
        if (reported === null) reported = {
          e
        };
      } else {
        queueMicrotask(() => {
          throw e;
        });
      }
    };
    function commit() {
      dirty = false;
      host().commit();
    }
    // A tree change outside any call (Solid flushing in a microtask) is committed
    // by a microtask queued behind the one making it: by then that flush is done.
    function changed() {
      dirty = true;
      if (calls === 0 && !lateQueued) {
        lateQueued = true;
        queueMicrotask(() => {
          lateQueued = false;
          if (dirty && calls === 0 && !failed) commit();
        });
      }
    }
    /**
     * Runs `fn` as one call into the app: inside flush(fn) (so its writes and
     * everything they cause are applied before it returns), then one commit. A
     * call made from inside another (a handler calling __app.onState) does not
     * commit: the outermost call does, once. If `fn` throws (or Solid reported an
     * error while flushing), nothing is committed and the error goes to the
     * host; what the call had already applied is in the next commit.
     */
    function call(fn) {
      calls++;
      let out;
      try {
        out = flush(fn);
      } catch (e) {
        // Solid's report is the cause when there is one (the error thrown may
        // be the same, or one that followed from it)
        if (calls === 1 && reported !== null) {
          const r = reported.e;
          reported = null;
          throw r;
        }
        throw e;
      } finally {
        calls--;
      }
      if (calls > 0) return out;
      if (reported !== null) {
        const {
          e
        } = reported;
        reported = null;
        throw e;
      }
      commit();
      return out;
    }
    class Node {
      constructor(tag, type, text) {
        this.tag = tag;
        this.type = type; // "#text" for raw text
        this.text = text; // raw text only
        this.parent = null;
        this.first = null;
        this.last = null;
        this.prev = null;
        this.next = null;
        this.handlers = null; // { eventName: fn } once one is set
      }
    }

    /** Wrap a node the host created (the root it passes to mount). */
    function wrapHostNode(tag, type = "#root") {
      return new Node(tag, type);
    }
    function unlink(parent, node) {
      if (node.prev) node.prev.next = node.next;else parent.first = node.next;
      if (node.next) node.next.prev = node.prev;else parent.last = node.prev;
      node.parent = node.prev = node.next = null;
    }

    // Raw strings are only valid inside <text>. Solid itself inserts empty text
    // nodes as placeholders (sentinels, e.g. where a <Show> renders nothing); the
    // host ignores raw text outside <text>, so only a non-empty one is an error.
    function checkText(parent, node) {
      if (parent && node.type === "#text" && parent.type !== "text" && node.text !== "") {
        throw new Error(`raw text ${JSON.stringify(node.text)} must be inside <text>, not <${parent.type.replace("#", "")}>`);
      }
    }

    /** "onPress" -> "press" */
    const eventName = prop => prop.charAt(2).toLowerCase() + prop.slice(3);
    function setProperty(node, name, value) {
      if (value === undefined) value = null;
      if (/^on[A-Z]/.test(name)) {
        // Event prop: the handler stays here; the host only learns that one is set.
        let h = node.handlers;
        const ev = eventName(name);
        if (typeof value === "function") {
          if (!h) {
            h = node.handlers = {};
            byTag.set(node.tag, weak(node));
          }
          const had = !!h[ev];
          h[ev] = value;
          if (!had) {
            host().setProp(node.tag, name, true);
            changed();
          }
        } else if (h && h[ev]) {
          delete h[ev];
          host().setProp(node.tag, name, null);
          changed();
        }
        return;
      }
      host().setProp(node.tag, name, value);
      changed();
    }
    const {
      render,
      createComponent,
      createElement,
      createTextNode,
      insertNode} = createRenderer({
      // The compiler hands an element's literal props over with it (staticProps):
      // they are set right after the node is created, as any other prop.
      createElement(type, staticProps) {
        const node = track(new Node(host().createNode(type), type));
        if (staticProps) for (const name in staticProps) setProperty(node, name, staticProps[name]);
        return node;
      },
      createTextNode(value) {
        const s = String(value);
        return track(new Node(host().createText(s), "#text", s));
      },
      replaceText(node, value) {
        node.text = String(value);
        checkText(node.parent, node);
        host().setProp(node.tag, "text", node.text);
        changed();
      },
      isTextNode(node) {
        return node.type === "#text";
      },
      setProperty,
      insertNode(parent, node, anchor) {
        // Inserting an attached node moves it (the host does the same).
        if (node.parent) unlink(node.parent, node);
        checkText(parent, node);
        node.parent = parent;
        if (anchor) {
          node.prev = anchor.prev;
          node.next = anchor;
          if (anchor.prev) anchor.prev.next = node;else parent.first = node;
          anchor.prev = node;
        } else {
          node.prev = parent.last;
          if (parent.last) parent.last.next = node;else parent.first = node;
          parent.last = node;
        }
        host().insert(parent.tag, node.tag, anchor ? anchor.tag : 0);
        changed();
      },
      removeNode(parent, node) {
        unlink(parent, node);
        host().remove(parent.tag, node.tag);
        changed();
      },
      getParentNode(node) {
        return node.parent;
      },
      getFirstChild(node) {
        return node.first;
      },
      getNextSibling(node) {
        return node.next;
      }
    });

    // ---- timers (README: Timers) ------------------------------------------------
    // setTimeout / setInterval for the bundle, on the host's timers: the host
    // arms one native timer per id and calls __app.timer(id) when it is due,
    // which runs the callback as a call into the app (flushed, then one commit).
    // Installed as globals, so app code and libraries use the standard names.
    // The clock (Date) is the host's own and is left alone.
    const timers = new Map(); // id -> { fn, args, every }
    let nextTimer = 1;
    const delayOf = ms => {
      const d = Number(ms);
      return d > 0 ? d : 0;
    };
    function arm(fn, ms, args, repeat) {
      if (typeof fn !== "function") throw new TypeError("setTimeout/setInterval: a function is required");
      const id = nextTimer++;
      const d = delayOf(ms);
      timers.set(id, {
        fn,
        args,
        every: repeat ? d : null
      });
      host().setTimer(id, d);
      return id;
    }
    function setTimeout(fn, ms, ...args) {
      return arm(fn, ms, args, false);
    }
    function setInterval(fn, ms, ...args) {
      return arm(fn, ms, args, true);
    }
    function clearTimeout(id) {
      if (timers.delete(id)) host().clearTimer(id);
    }
    const clearInterval = clearTimeout;
    globalThis.setTimeout = setTimeout;
    globalThis.setInterval = setInterval;
    globalThis.clearTimeout = clearTimeout;
    globalThis.clearInterval = clearInterval;

    /**
     * Define the bundle's entry point: sets and returns `globalThis.__app`.
     *
     *   createApp(Root, { onState(state) { ...set signals... } })
     *
     * Each entry point is one call into the app: it runs inside Solid's
     * flush(fn), so all it causes is applied before the call returns, then one
     * commit (README: Batching and commits).
     *
     * - mount(rootTag, ctx): renders <Root {...ctx} /> into the host's root, then
     *   one commit. ctx = { width, height } in points. Mounting again disposes
     *   the previous tree first (its nodes are removed from the root).
     * - onState(state): runs `onState(state)`, then one commit. `state` is
     *   whatever the app delivers (bytes, an object); the package doesn't look.
     * - dispatch(tag, name, payload): runs the JS handler for event `name` on
     *   `tag` (e.g. "press" for onPress), then one commit. Returns false (and
     *   doesn't commit) if there is no handler.
     * - timer(id): a timer the bundle set is due: runs its callback, then one
     *   commit (an interval is re-armed first). Returns false (and doesn't
     *   commit) for a timer that was cleared.
     */
    function createApp(Root, {
      onState
    } = {}) {
      let dispose = null;
      const app = {
        mount(rootTag, ctx = {}) {
          call(() => {
            if (dispose) {
              const d = dispose;
              dispose = null;
              d();
            }
            dispose = render(() => createComponent(Root, ctx), wrapHostNode(rootTag));
          });
        },
        onState(state) {
          call(() => {
            if (onState) onState(state);
          });
        },
        dispatch(tag, name, payload) {
          const ref = byTag.get(tag);
          const node = ref && ref.deref();
          const h = node && node.handlers;
          const fn = h && h[name];
          if (!fn) return false;
          call(() => {
            fn(payload);
          });
          return true;
        },
        timer(id) {
          const t = timers.get(id);
          if (!t) return false;
          if (t.every === null) timers.delete(id);else host().setTimer(id, t.every);
          call(() => {
            t.fn(...t.args);
          });
          return true;
        }
      };
      globalThis.__app = app;
      return app;
    }

    createApp(() => (() => {
      var _el$ = createElement("view");
      insertNode(_el$, createTextNode(`hello`));
      return _el$;
    })());

})();
