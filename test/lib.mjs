// Test helpers: run a bundle in node (vm) or qjs with the recording host, and
// replay a mutation log through the shadow tree with the stub measurer.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import Yoga from "yoga-layout";
import { ShadowTree } from "../browser/shadow.js";
import { stubMeasurer } from "../browser/text-layout.js";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DRIVER = ROOT + "test/driver.js";
export const QJS_RUNNER = ROOT + "test/qjs-runner.js";
export const schema = JSON.parse(readFileSync(ROOT + "schema/nodes.json", "utf8"));

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Run a bundle in a fresh node vm context; returns the log lines. */
export function runNode(bundleSrc, script) {
  return runNodeCtx(bundleSrc, script).lines;
}
/**
 * As runNode, also returning the vm context (its __swReleased fills after a
 * GC). The context has its own job queue ("afterEvaluate"), which the driver
 * has drained after every call into the bundle, as a real host does: an empty
 * evaluation in the context runs its jobs until none are left.
 */
export function runNodeCtx(bundleSrc, script) {
  const ctx = vm.createContext({}, { microtaskMode: "afterEvaluate" });
  vm.runInContext(readFileSync(DRIVER, "utf8"), ctx, { filename: "driver.js" });
  const drainJobs = () => vm.runInContext("", ctx);
  const it = ctx.__swDriver(() => vm.runInContext(bundleSrc, ctx, { filename: "bundle.js" }), script);
  let r;
  while (!(r = it.next()).done) drainJobs();
  // copy out of the vm realm (its arrays have their own prototype)
  return { lines: Array.from(r.value, String), ctx };
}

/** Run a bundle under qjs; returns the log lines. */
export function runQjs(qjs, bundlePath, scriptPath, extra = []) {
  const r = spawnSync(qjs, [QJS_RUNNER, DRIVER, bundlePath, scriptPath, ...extra], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`qjs exited ${r.status}: ${r.stderr}`);
  return r.stdout.split("\n").filter((l) => l !== "");
}

/**
 * Replay log lines through a ShadowTree (stub measurer, pointScaleFactor 2).
 * Returns one result per commit: { commit, frames, text, content, haptics }.
 */
export function replay(lines, { fragments = [] } = {}) {
  const tree = new ShadowTree(Yoga, { schema, fragments, measurer: stubMeasurer, pointScaleFactor: 2 });
  const out = [];
  for (const line of lines) {
    const [op, ...a] = JSON.parse(line);
    switch (op) {
      case "#mount": tree.createRoot(a[0], a[1]); break;
      case "createNode": { const t = tree.createNode(a[1]); if (t !== a[0]) throw new Error(`tag mismatch ${t} != ${a[0]}`); break; }
      case "createText": { const t = tree.createText(a[1]); if (t !== a[0]) throw new Error(`tag mismatch ${t} != ${a[0]}`); break; }
      case "setProp": tree.setProp(a[0], a[1], a[2]); break;
      case "insert": tree.insert(a[0], a[1], a[2]); break;
      case "remove": tree.remove(a[0], a[1]); break;
      case "commit": {
        const r = tree.commit();
        // the <crown> that has the Digital Crown, only while there is one
        out.push({ commit: out.length, ...r, haptics: tree.hapticsFired, ...(tree.crown ? { crown: tree.crown.tag } : {}) });
        break;
      }
      default: break; // driver markers
    }
  }
  return out;
}
