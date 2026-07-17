import { exactDataObject, failureEvidence, frozenCopy, identityFromExecution, identityKey, sanitizeNpcTerminalText, validateController, validateExecution, validateLookup } from "./npcPublicationSinkShared.mjs";

const FACTORY_FIELDS = ["write", "failureGuarantee"];
const GUARANTEES = new Set(["unknown_on_failure", "no_output_on_rejection"]);
const ERROR_CODES = Object.freeze(["invalid_npc_cli_sink_configuration", "invalid_npc_cli_sink_execution", "npc_cli_sink_reset"]);
export const NPC_CLI_PUBLICATION_SINK_ERROR_CODES = ERROR_CODES;

export class NpcCliPublicationSinkError extends Error {
  constructor(code) { super("NPC CLI publication sink failed"); Object.defineProperty(this, "name", { value: "NpcCliPublicationSinkError" }); Object.defineProperty(this, "code", { value: code }); }
}
function sinkError(code) { return new NpcCliPublicationSinkError(code); }

function createSink(options, testing) {
  if (!exactDataObject(options, FACTORY_FIELDS) || typeof options.write !== "function" || !GUARANTEES.has(options.failureGuarantee)) throw sinkError("invalid_npc_cli_sink_configuration");
  let reset = false;
  const records = new Map();
  const states = new Map();
  const seams = testing?.seams ?? {};

  async function deliver(execution, controller) {
    if (reset) throw sinkError("npc_cli_sink_reset");
    if (!validateController(controller) || !validateExecution(execution, "cli")) throw sinkError("invalid_npc_cli_sink_execution");
    const identity = identityFromExecution(execution);
    const key = identityKey(identity);
    if (states.has(identity.deliveryAttemptId)) throw sinkError("invalid_npc_cli_sink_execution");
    states.set(identity.deliveryAttemptId, "active");
    if (execution.signal.aborted) { states.set(identity.deliveryAttemptId, "completion_uncertain"); throw sinkError("invalid_npc_cli_sink_execution"); }
    const writerInput = Object.freeze({ schemaVersion: 1, outputType: "npc_canonical_utterance", publicationId: identity.publicationId, deliveryAttemptId: identity.deliveryAttemptId, text: sanitizeNpcTerminalText(execution.request.payload.displayText), signal: execution.signal });
    try { await options.write(writerInput); }
    catch {
      states.set(identity.deliveryAttemptId, "settled_or_failed");
      const proved = options.failureGuarantee === "no_output_on_rejection";
      return controller.recordNpcPublicationSinkFailure(execution.settlementCapability, failureEvidence("cli", "cli_sink_write_failed", proved ? "none" : "unknown", proved ? "complete" : "unproved"));
    }
    if (reset) { states.set(identity.deliveryAttemptId, "completion_uncertain"); throw sinkError("npc_cli_sink_reset"); }
    try {
      if (seams.bookkeepingRegistrationFault) seams.bookkeepingRegistrationFault();
      if (records.has(key)) throw new Error("bookkeeping");
      records.set(key, identity);
      if (records.get(key) !== identity) throw new Error("bookkeeping");
    } catch {
      states.set(identity.deliveryAttemptId, "settled_or_failed");
      return controller.recordNpcPublicationSinkFailure(execution.settlementCapability, failureEvidence("cli", "cli_sink_write_failed", "unknown", "unproved"));
    }
    try {
      const result = controller.completeNpcPublicationSink(execution.settlementCapability);
      states.set(identity.deliveryAttemptId, "settled_or_failed");
      return result;
    } catch (error) {
      states.set(identity.deliveryAttemptId, "completion_uncertain");
      throw error;
    }
  }

  function getCompletedOutputEvidence(input) {
    if (reset || !validateLookup(input, "cli")) return null;
    const identity = records.get(identityKey(input));
    if (!identity) return null;
    return frozenCopy({ ...identity, evidenceType: "npc_cli_completed_output", completed: true });
  }

  function resetSink() { if (reset) return undefined; reset = true; records.clear(); states.clear(); return undefined; }
  const sink = Object.freeze({ deliver, getCompletedOutputEvidence, reset: resetSink });
  if (!testing) return sink;
  return Object.freeze({ sink, inspect: () => Object.freeze({ reset, recordCount: records.size, activeCount: [...states.values()].filter((value) => value === "active").length, uncertainCount: [...states.values()].filter((value) => value === "completion_uncertain").length }) });
}

export function createNpcCliPublicationSink(options) { return createSink(options, null); }
export function createNpcCliPublicationSinkForTesting(options, seams = {}) { return createSink(options, { seams }); }
