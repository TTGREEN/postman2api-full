import { describe, expect, test } from "bun:test";
import {
  buildSeedingContext,
  splitContextForPriming,
  type ContextPart,
} from "../src/provider/postman";

const MAX_CONTEXT_LEN = 9_500;
const PRIMING_SEGMENT_LEN = 8_500;

function part(kind: ContextPart["kind"], text: string): ContextPart {
  return { kind, text };
}

describe("buildSeedingContext", () => {
  test("passes short context through untouched", () => {
    const parts = [part("system", "[System]\nbe terse"), part("history", "[User]\nhi")];
    const { content, dropped } = buildSeedingContext(parts);
    expect(dropped).toBe(0);
    expect(content).toBe("[System]\nbe terse\n\n[User]\nhi");
  });

  test("keeps the head of an oversized system prompt instead of its middle", () => {
    const head = "RULE-ONE always call the tool first. ";
    const system = "[System]\n" + head + "x".repeat(40_000);
    const { content, dropped } = buildSeedingContext([
      part("system", system),
      part("history", "[User]\n" + "h".repeat(5_000)),
    ]);
    expect(content.length).toBeLessThanOrEqual(MAX_CONTEXT_LEN);
    expect(dropped).toBeGreaterThan(0);
    expect(content).toContain("RULE-ONE always call the tool first.");
  });

  test("reserves budget for history so a huge system prompt cannot starve it", () => {
    const newest = "[User]\nNEEDLE-LAST";
    const { content } = buildSeedingContext([
      part("system", "[System]\n" + "s".repeat(60_000)),
      part("history", "[User]\n" + "old".repeat(500)),
      part("history", newest),
    ]);
    expect(content).toContain("NEEDLE-LAST");
    expect(content.length).toBeLessThanOrEqual(MAX_CONTEXT_LEN);
  });

  test("drops oldest history first and marks the omission", () => {
    const parts = [
      part("history", "[User]\nOLDEST " + "a".repeat(6_000)),
      part("history", "[User]\nNEWEST " + "b".repeat(6_000)),
    ];
    const { content, dropped } = buildSeedingContext(parts);
    expect(dropped).toBeGreaterThan(0);
    expect(content).toContain("NEWEST");
    expect(content).not.toContain("OLDEST");
    expect(content).toContain("omitted");
  });

  test("salvages the tail of an oversized newest message instead of wasting budget", () => {
    const parts = [
      part("system", "[System]\n" + "s".repeat(60_000)),
      part("history", "[User]\n" + "h".repeat(40_000) + "NEEDLE-TAIL"),
    ];
    const { content } = buildSeedingContext(parts);
    expect(content).toContain("NEEDLE-TAIL");
    expect(content).toContain("start of this message omitted");
    // Budget must be nearly filled, not abandoned when one block cannot fit whole.
    expect(content.length).toBeGreaterThan(MAX_CONTEXT_LEN - 200);
    expect(content.length).toBeLessThanOrEqual(MAX_CONTEXT_LEN);
  });

  test("never exceeds the upstream seeding limit", () => {
    const parts = Array.from({ length: 30 }, (_, i) =>
      part(i === 0 ? "system" : "history", `[Block ${i}]\n` + "z".repeat(3_000)));
    const { content } = buildSeedingContext(parts);
    expect(content.length).toBeLessThanOrEqual(MAX_CONTEXT_LEN);
  });
});

describe("splitContextForPriming", () => {
  test("keeps every segment inside the query limit", () => {
    const parts = Array.from({ length: 20 }, (_, i) =>
      part("history", `[User ${i}]\n` + "q".repeat(4_000)));
    const segments = splitContextForPriming(parts);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(PRIMING_SEGMENT_LEN);
    }
  });

  test("loses no characters across the split", () => {
    const parts = [
      part("system", "[System]\n" + "s".repeat(20_000)),
      part("history", "[User]\nTAIL-MARKER"),
    ];
    const segments = splitContextForPriming(parts);
    const rejoined = segments.join("");
    expect(rejoined).toContain("TAIL-MARKER");
    expect(rejoined.replace(/\n/g, "").length).toBeGreaterThanOrEqual(20_000);
  });

  test("hard-splits a single part larger than one segment", () => {
    const segments = splitContextForPriming([part("system", "s".repeat(30_000))]);
    expect(segments.length).toBe(Math.ceil(30_000 / PRIMING_SEGMENT_LEN));
    expect(segments.every((s) => s.length <= PRIMING_SEGMENT_LEN)).toBe(true);
  });

  test("returns a single segment when everything fits", () => {
    expect(splitContextForPriming([part("history", "short")])).toEqual(["short"]);
  });
});
