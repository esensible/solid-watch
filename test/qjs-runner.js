// Runs a bundle under the quickjs-ng CLI with the recording host and prints
// the golden mutation log (JSON lines) to stdout.
//
//   qjs test/qjs-runner.js <driver.js> <bundle.js> <script.json> [--gc]
//
// --gc: afterwards drop the bundle's references, run the GC, let the
// FinalizationRegistry jobs run, and print one more line
// ["#released", [tags...]] (sorted): the tags the renderer released.
//
// After each call into the bundle the driver yields, and the runner goes on
// from a timer: qjs's event loop (js_std_loop) runs every pending job before
// it fires a timer, so the job queue is drained in between, as a real host
// drains it after each call. No top-level await: while a module awaits, qjs
// runs one job at a time and polls timers in between (js_std_await), so a
// timer could fire with jobs still queued.
import * as std from "qjs:std";
import * as os from "qjs:os";

const [driverPath, bundlePath, scriptPath, flag] = scriptArgs.slice(1);
if (!driverPath || !bundlePath || !scriptPath) {
  std.err.puts("usage: qjs qjs-runner.js <driver.js> <bundle.js> <script.json> [--gc]\n");
  std.exit(2);
}
// console as the Swift host has it (log, info, warn, error), to stderr: stdout
// is the log
const toStderr = (...a) => std.err.puts(a.map(String).join(" ") + "\n");
globalThis.console = { log: toStderr, info: toStderr, warn: toStderr, error: toStderr };
std.evalScript(std.loadFile(driverPath));
const src = std.loadFile(bundlePath);
const script = JSON.parse(std.loadFile(scriptPath));
const it = globalThis.__swDriver(() => std.evalScript(src), script);

function step() {
  const r = it.next();
  if (!r.done) {
    os.setTimeout(step, 0);
    return;
  }
  for (const l of r.value) std.out.puts(l + "\n");
  if (flag === "--gc") {
    std.gc();
    // the FinalizationRegistry callbacks are jobs: drained before this timer
    os.setTimeout(() => {
      std.out.puts(JSON.stringify(["#released", globalThis.__swReleased.slice().sort((a, b) => a - b)]) + "\n");
    }, 0);
  }
}
step();
