#!/usr/bin/env bun
export {}; // mark as module so top-level declarations are module-scoped

// A behavior-configurable mock that speaks the `codex exec --json` protocol.
// Used for CodexRunner lifecycle tests. Modes are chosen via the first CLI arg:
//
//   normal           — emit thread.started + turn.started, echo the stdin prompt
//                       in an item.completed agent_message, then turn.completed.
//   crash-on-spawn   — exit 1 immediately, no stdout.
//   auth-fail        — write "Error: not logged in" to stderr, exit 1.
//   no-completion    — emit thread.started + turn.started but exit before
//                       turn.completed (used to verify error synthesis).
//   replay-resume    — emit an init line tagged with argv so tests can verify
//                       the `exec resume <id>` invocation shape.
//   slow             — sleep 200ms before emitting any events (used for stop()
//                       graceful exit timing).
//   slow-echo        — emit thread.started immediately, then sleep 500ms before
//                       echoing the prompt + turn.completed. Lets concurrency
//                       tests reliably catch a session in busy state.
//   stubborn         — ignore SIGTERM (must be SIGKILLed).
//   turn-failed      — emit thread.started + turn.failed instead of completed.
//   thread-late      — invert the realistic-but-rare ordering: emit
//                       turn.completed BEFORE thread.started, validating that
//                       the runner captures threadId via parser.flush() rather
//                       than relying on order.
//
// Note: the runner injects `--` and `-` style args + approval/sandbox flags +
// the prompt sentinel `-`, so the mock reads the prompt from stdin. The first
// non-flag arg the runner passes through is mode (set by the test via
// `args: [mode]`); we look for it.

const args = process.argv.slice(2);

// Mode is the test's user-supplied arg (set via CodexRunnerConfig.args). The
// runner additionally injects: exec [resume <thread_id>] --full-auto --sandbox X
// --image <path>... and a final `-` sentinel. Skip those structural args to
// find the test mode.
const RUNNER_KEYWORDS = new Set(["exec", "resume", "-"]);
const isResume = args.includes("resume");
let mode = "normal";
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("-")) {
    // Skip the value of flags that take a value: --sandbox, --ask-for-approval,
    // --model, --image. (--full-auto and --dangerously-bypass-... are bare.)
    if (
      a === "--sandbox" ||
      a === "--ask-for-approval" ||
      a === "--model" ||
      a === "--image" ||
      a === "-c" ||
      a === "--config" ||
      a === "-i" ||
      a === "-m" ||
      a === "-s" ||
      a === "-a"
    ) {
      i++;
    }
    continue;
  }
  if (RUNNER_KEYWORDS.has(a)) continue;
  // The previous arg's slot for `resume <id>`: skip the thread id.
  if (i > 0 && args[i - 1] === "resume") continue;
  mode = a;
  break;
}

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function readStdin(): Promise<string> {
  let buf = "";
  const decoder = new TextDecoder();
  for await (const chunk of process.stdin as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
  }
  return buf;
}

async function main(): Promise<void> {
  if (mode === "crash-on-spawn") {
    process.exit(1);
  }
  if (mode === "auth-fail") {
    process.stderr.write("Error: not logged in. Run `codex login` first.\n");
    process.exit(1);
  }
  if (mode === "stubborn") {
    process.on("SIGTERM", () => {
      /* ignore */
    });
    process.on("SIGINT", () => {
      /* ignore */
    });
  }
  if (mode === "slow") {
    await new Promise((r) => setTimeout(r, 200));
  }

  if (mode === "replay-resume") {
    // Tag the thread.started event with argv so tests can verify shape.
    emit({
      type: "thread.started",
      thread_id: "tid-replay",
      __argv: args,
      __resuming: isResume,
    });
    const prompt = await readStdin();
    emit({ type: "turn.started" });
    emit({
      type: "item.completed",
      item: {
        id: "i1",
        type: "agent_message",
        text: `replay: ${prompt.trim()}`,
      },
    });
    emit({
      type: "turn.completed",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    return;
  }

  // thread-late inverts the order so we can assert the runner captures
  // threadId via parser.flush() at exit, not by relying on event ordering.
  if (mode === "thread-late") {
    const prompt = await readStdin();
    emit({ type: "turn.started" });
    emit({
      type: "item.completed",
      item: {
        id: "msg1",
        type: "agent_message",
        text: `late: ${prompt.trim()}`,
      },
    });
    emit({
      type: "turn.completed",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    // Now — AFTER turn.completed — emit thread.started.
    emit({ type: "thread.started", thread_id: "tid-late" });
    return;
  }

  emit({ type: "thread.started", thread_id: `tid-${process.pid}` });

  if (mode === "slow-echo") {
    const prompt = await readStdin();
    await new Promise((r) => setTimeout(r, 500));
    emit({ type: "turn.started" });
    emit({
      type: "item.completed",
      item: {
        id: "msg1",
        type: "agent_message",
        text: `echo: ${prompt.trim()}`,
      },
    });
    emit({
      type: "turn.completed",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    return;
  }

  const prompt = await readStdin();

  if (mode === "no-completion") {
    emit({ type: "turn.started" });
    // Exit without emitting turn.completed.
    return;
  }

  if (mode === "turn-failed") {
    emit({ type: "turn.started" });
    emit({ type: "turn.failed", error: { message: "model refused" } });
    return;
  }

  emit({ type: "turn.started" });
  emit({
    type: "item.started",
    item: { id: "cmd1", type: "command_execution", status: "in_progress" },
  });
  emit({
    type: "item.completed",
    item: { id: "msg1", type: "agent_message", text: `echo: ${prompt.trim()}` },
  });
  emit({
    type: "turn.completed",
    usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 3 },
  });

  if (mode === "stubborn") {
    // Stay alive after the turn so the test exercising stop() can SIGKILL it.
    await new Promise(() => {
      /* never resolves */
    });
  }
}

void main();
