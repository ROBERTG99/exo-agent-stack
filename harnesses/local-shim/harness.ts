// Fallback harness for the `local-harness` agent when @agent-harness/exo-adapter cannot be resolved
// (BUILD.md §1.4, docs/DECISIONS.md). The turn loop and the chat-completions model client are
// implemented and tested (../scripted/turn.ts, ./chat-model.ts). The module Exo loads
// (`defineHarness({ runTurn, resumeTurn })`) is not written yet: it needs how Exo's TurnContext
// exposes the durable conversation (verification item V-12, docs/KNOWN_LIMITATIONS.md). Until
// then this file deliberately has no default export, so Exo refuses to load it instead of running
// something that looks like a harness but is not one.
export { chatCallModel, LocalModelError } from "./chat-model.ts";
export { runScriptedTurn } from "../scripted/turn.ts";
