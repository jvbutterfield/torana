import { describe, expect, test } from "bun:test";
import { createClaudeNdjsonParser } from "../../src/runner/protocols/claude-ndjson.js";
import { createCodexJsonlParser } from "../../src/runner/protocols/codex-jsonl.js";
import {
  createJsonlTextParser,
  encodeTurn,
} from "../../src/runner/protocols/jsonl-text.js";
import type { RunnerEvent } from "../../src/runner/types.js";

function collect(
  parser: { feed: (c: string, cb: (e: RunnerEvent) => void) => void },
  input: string,
): RunnerEvent[] {
  const events: RunnerEvent[] = [];
  parser.feed(input, (ev) => events.push(ev));
  return events;
}

describe("claude-ndjson parser", () => {
  test("system init emits ready", () => {
    const parser = createClaudeNdjsonParser({ currentTurnId: () => null });
    const events = collect(
      parser,
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }) +
        "\n",
    );
    expect(events).toEqual([{ kind: "ready" }]);
  });

  test("text_delta emits text_delta with current turnId", () => {
    const parser = createClaudeNdjsonParser({ currentTurnId: () => "42" });
    const event = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hello" },
      },
    };
    const events = collect(parser, JSON.stringify(event) + "\n");
    expect(events).toEqual([
      { kind: "text_delta", turnId: "42", text: "hello" },
    ]);
  });

  test("thinking_delta is dropped", () => {
    const parser = createClaudeNdjsonParser({ currentTurnId: () => "42" });
    const event = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "..." },
      },
    };
    const events = collect(parser, JSON.stringify(event) + "\n");
    expect(events).toHaveLength(0);
  });

  test("tool_use start emits status", () => {
    const parser = createClaudeNdjsonParser({ currentTurnId: () => "42" });
    const event = {
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use" },
      },
    };
    const events = collect(parser, JSON.stringify(event) + "\n");
    expect(events).toEqual([
      { kind: "status", turnId: "42", phase: "tool_use" },
    ]);
  });

  test("result success emits done", () => {
    const parser = createClaudeNdjsonParser({ currentTurnId: () => "42" });
    const event = {
      type: "result",
      is_error: false,
      result: "final text",
      duration_ms: 1234,
      stop_reason: "end_turn",
    };
    const events = collect(parser, JSON.stringify(event) + "\n");
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe("done");
    if (e.kind === "done") {
      expect(e.turnId).toBe("42");
      expect(e.stopReason).toBe("end_turn");
      expect(e.finalText).toBe("final text");
    }
  });

  test("result error emits error terminal", () => {
    const parser = createClaudeNdjsonParser({ currentTurnId: () => "7" });
    const event = { type: "result", is_error: true, result: "oops" };
    const events = collect(parser, JSON.stringify(event) + "\n");
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("error");
  });

  test("rate_limit_event with non-allowed status emits rate_limit", () => {
    const parser = createClaudeNdjsonParser({ currentTurnId: () => null });
    const event = {
      type: "rate_limit_event",
      rate_limit_info: { status: "limited" },
    };
    const events = collect(parser, JSON.stringify(event) + "\n");
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("rate_limit");
  });

  test("unknown event types are dropped", () => {
    const parser = createClaudeNdjsonParser({ currentTurnId: () => null });
    const events = collect(
      parser,
      JSON.stringify({ type: "future_event" }) + "\n",
    );
    expect(events).toHaveLength(0);
  });

  test("handles chunked input across feeds", () => {
    const parser = createClaudeNdjsonParser({ currentTurnId: () => "42" });
    const event = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "abc" },
      },
    };
    const raw = JSON.stringify(event) + "\n";
    const events: RunnerEvent[] = [];
    parser.feed(raw.slice(0, 20), (e) => events.push(e));
    parser.feed(raw.slice(20), (e) => events.push(e));
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("text_delta");
  });
});

describe("jsonl-text parser", () => {
  test("ready event", () => {
    const parser = createJsonlTextParser();
    const events = collect(parser, JSON.stringify({ type: "ready" }) + "\n");
    expect(events).toEqual([{ kind: "ready" }]);
  });

  test("text emits text_delta", () => {
    const parser = createJsonlTextParser();
    const events = collect(
      parser,
      JSON.stringify({ type: "text", turn_id: "7", text: "hello" }) + "\n",
    );
    expect(events).toEqual([
      { kind: "text_delta", turnId: "7", text: "hello" },
    ]);
  });

  test("done terminates turn", () => {
    const parser = createJsonlTextParser();
    const events = collect(
      parser,
      JSON.stringify({ type: "done", turn_id: "7" }) + "\n",
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("done");
  });

  test("error with retriable", () => {
    const parser = createJsonlTextParser();
    const events = collect(
      parser,
      JSON.stringify({
        type: "error",
        turn_id: "7",
        message: "x",
        retriable: true,
      }) + "\n",
    );
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe("error");
    if (e.kind === "error") expect(e.retriable).toBe(true);
  });

  test("encodeTurn produces the documented envelope", () => {
    const line = encodeTurn("T1", "hi", []);
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      type: "turn",
      turn_id: "T1",
      text: "hi",
      attachments: [],
    });
  });

  test("malformed JSON line is dropped", () => {
    const parser = createJsonlTextParser();
    const events = collect(parser, "not json\n");
    expect(events).toHaveLength(0);
  });
});

describe("codex-jsonl parser", () => {
  test("thread.started captures thread_id via callback (no event emitted)", () => {
    const captured: string[] = [];
    const parser = createCodexJsonlParser({
      currentTurnId: () => "T1",
      onThreadStarted: (id) => captured.push(id),
    });
    const events = collect(
      parser,
      JSON.stringify({ type: "thread.started", thread_id: "tid-abc" }) + "\n",
    );
    expect(captured).toEqual(["tid-abc"]);
    expect(events).toHaveLength(0);
  });

  test("synthetic ready promotes status (for command-runner wrappers)", () => {
    const parser = createCodexJsonlParser({ currentTurnId: () => null });
    const events = collect(parser, JSON.stringify({ type: "ready" }) + "\n");
    expect(events).toEqual([{ kind: "ready" }]);
  });

  test("turn.started is silent", () => {
    const parser = createCodexJsonlParser({ currentTurnId: () => "T1" });
    const events = collect(
      parser,
      JSON.stringify({ type: "turn.started" }) + "\n",
    );
    expect(events).toHaveLength(0);
  });

  test("item.started for command_execution emits status tool_use", () => {
    const parser = createCodexJsonlParser({ currentTurnId: () => "T1" });
    const events = collect(
      parser,
      JSON.stringify({
        type: "item.started",
        item: { id: "i1", type: "command_execution", status: "in_progress" },
      }) + "\n",
    );
    expect(events).toEqual([
      { kind: "status", turnId: "T1", phase: "tool_use" },
    ]);
  });

  test("item.started for reasoning is silent (not surfaced)", () => {
    const parser = createCodexJsonlParser({ currentTurnId: () => "T1" });
    const events = collect(
      parser,
      JSON.stringify({
        type: "item.started",
        item: { id: "i1", type: "reasoning" },
      }) + "\n",
    );
    expect(events).toHaveLength(0);
  });

  test("item.completed for agent_message emits one text_delta", () => {
    const parser = createCodexJsonlParser({ currentTurnId: () => "T1" });
    const events = collect(
      parser,
      JSON.stringify({
        type: "item.completed",
        item: { id: "i3", type: "agent_message", text: "the answer is 42" },
      }) + "\n",
    );
    expect(events).toEqual([
      { kind: "text_delta", turnId: "T1", text: "the answer is 42" },
    ]);
  });

  test("item.completed for non-agent_message types is dropped", () => {
    const parser = createCodexJsonlParser({ currentTurnId: () => "T1" });
    const events = collect(
      parser,
      JSON.stringify({
        type: "item.completed",
        item: { id: "i4", type: "command_execution", exit_code: 0 },
      }) + "\n",
    );
    expect(events).toHaveLength(0);
  });

  test("turn.completed emits done with usage", () => {
    const parser = createCodexJsonlParser({ currentTurnId: () => "T1" });
    const events = collect(
      parser,
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 50,
          output_tokens: 25,
        },
      }) + "\n",
    );
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe("done");
    if (e.kind === "done") {
      expect(e.turnId).toBe("T1");
      expect(e.stopReason).toBe("end_turn");
      expect(e.usage).toEqual({ input_tokens: 100, output_tokens: 25 });
    }
  });

  test("turn.failed with error.message emits error", () => {
    const parser = createCodexJsonlParser({ currentTurnId: () => "T1" });
    const events = collect(
      parser,
      JSON.stringify({
        type: "turn.failed",
        error: { message: "model refused" },
      }) + "\n",
    );
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe("error");
    if (e.kind === "error") {
      expect(e.turnId).toBe("T1");
      expect(e.message).toBe("model refused");
      expect(e.retriable).toBe(false);
    }
  });

  test("error event with no in-flight turn is dropped", () => {
    const parser = createCodexJsonlParser({ currentTurnId: () => null });
    const events = collect(
      parser,
      JSON.stringify({ type: "error", message: "stray" }) + "\n",
    );
    expect(events).toHaveLength(0);
  });

  test("unknown event types are dropped (forward compat)", () => {
    const parser = createCodexJsonlParser({ currentTurnId: () => "T1" });
    const events = collect(
      parser,
      JSON.stringify({ type: "future.event", payload: 1 }) + "\n",
    );
    expect(events).toHaveLength(0);
  });

  test("handles chunked input across feeds", () => {
    const parser = createCodexJsonlParser({ currentTurnId: () => "T1" });
    const ev = {
      type: "item.completed",
      item: { id: "i3", type: "agent_message", text: "split across feeds" },
    };
    const raw = JSON.stringify(ev) + "\n";
    const events: RunnerEvent[] = [];
    parser.feed(raw.slice(0, 25), (e) => events.push(e));
    parser.feed(raw.slice(25), (e) => events.push(e));
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("text_delta");
  });
});
