/* eslint-disable @typescript-eslint/no-explicit-any -- JSON schema objects are schemaless in these assertions */
import { describe, expect, it } from "vitest";
import { askUserDeclaration, parseAskUser } from "../../../tools/ask-user.ts";

describe("ask_user declaration", () => {
  it("is a frontend tool declaration with a strict JSON schema", () => {
    expect(askUserDeclaration.name).toBe("ask_user");
    const schema = askUserDeclaration.input_schema as any;
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["question"]);
    expect(schema.properties.question).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 2000,
    });
    expect(schema.properties.choices).toMatchObject({ type: "array", maxItems: 6 });
  });

  it("describes when to use it", () => {
    expect(askUserDeclaration.description.length).toBeGreaterThan(30);
  });
});

describe("parseAskUser", () => {
  it("accepts a question with and without choices", () => {
    expect(parseAskUser({ question: "Which one?" })).toEqual({ question: "Which one?" });
    expect(parseAskUser({ question: "Which one?", choices: ["a", "b"] })).toEqual({
      question: "Which one?",
      choices: ["a", "b"],
    });
  });

  it.each([
    ["an empty question", { question: "" }],
    ["a question over 2000 characters", { question: "q".repeat(2001) }],
    ["more than 6 choices", { question: "q", choices: ["1", "2", "3", "4", "5", "6", "7"] }],
    ["an extra property", { question: "q", extra: true }],
    ["a non-string choice", { question: "q", choices: [1] }],
    ["an empty choice", { question: "q", choices: [""] }],
    ["no question", {}],
    ["null", null],
  ])("rejects %s", (_n, input) => {
    expect(() => parseAskUser(input)).toThrow();
  });

  it("accepts exactly the limits", () => {
    expect(
      parseAskUser({ question: "q".repeat(2000), choices: ["1", "2", "3", "4", "5", "6"] }).choices,
    ).toHaveLength(6);
  });
});
