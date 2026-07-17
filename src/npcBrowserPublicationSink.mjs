import { exactDataObject, failureEvidence, frozenCopy, identityFromExecution, identityKey, validateController, validateExecution, validateLookup } from "./npcPublicationSinkShared.mjs";

const FACTORY_FIELDS = ["getConversationContainer", "createTextNode", "createMessageNode"];
const ERROR_CODES = Object.freeze(["invalid_npc_browser_sink_configuration", "invalid_npc_browser_sink_execution", "npc_browser_sink_reset"]);
export const NPC_BROWSER_PUBLICATION_SINK_ERROR_CODES = ERROR_CODES;

export class NpcBrowserPublicationSinkError extends Error {
  constructor(code) { super("NPC browser publication sink failed"); Object.defineProperty(this, "name", { value: "NpcBrowserPublicationSinkError" }); Object.defineProperty(this, "code", { value: code }); }
}

function sinkError(code) { return new NpcBrowserPublicationSinkError(code); }
function validNode(node) { return node && typeof node === "object" && "parentNode" in node; }
function validTextNode(node, text) { return validNode(node) && node.nodeType === 3 && node.textContent === text && node.parentNode === null; }
function ownsTextNode(node, textNode) { return validNode(node) && node.nodeType === 1 && node.parentNode === null && ((Array.isArray(node.childNodes) && node.childNodes.length === 1 && node.childNodes[0] === textNode) || node.firstChild === textNode && node.lastChild === textNode); }
function validContainer(container) { return container && typeof container === "object" && (typeof container.appendChild === "function" || typeof container.append === "function"); }
function contains(container, node) { try { return node.parentNode === container && (typeof container.contains !== "function" || container.contains(node)); } catch { return false; } }

function createSink(options, testing) {
  if (!exactDataObject(options, FACTORY_FIELDS) || FACTORY_FIELDS.some((field) => typeof options[field] !== "function")) throw sinkError("invalid_npc_browser_sink_configuration");
  let reset = false;
  const records = new Map();
  const nodeOwners = new Map();
  const states = new Map();
  const seams = testing?.seams ?? {};

  function removeAndProve(container, node, key) {
    let removed = false;
    try {
      if (seams.nodeRemovalFault) seams.nodeRemovalFault();
      if (node.parentNode && typeof node.parentNode.removeChild === "function") node.parentNode.removeChild(node);
      else if (typeof node.remove === "function") node.remove();
      removed = node.parentNode === null && (!container || typeof container.contains !== "function" || !container.contains(node));
    } catch { removed = false; }
    records.delete(key);
    if (nodeOwners.get(node) === key) nodeOwners.delete(node);
    return removed && !records.has(key) && !nodeOwners.has(node);
  }

  function fail(controller, execution, code, proved) {
    states.set(execution.request.deliveryAttemptId, "settled_or_failed");
    return controller.recordNpcPublicationSinkFailure(execution.settlementCapability, failureEvidence("browser", code, proved ? "none" : "unknown", proved ? "complete" : "unproved"));
  }

  function deliver(execution, controller) {
    if (reset) throw sinkError("npc_browser_sink_reset");
    if (!validateController(controller) || !validateExecution(execution, "browser")) throw sinkError("invalid_npc_browser_sink_execution");
    const identity = identityFromExecution(execution);
    const key = identityKey(identity);
    if (states.has(identity.deliveryAttemptId)) throw sinkError("invalid_npc_browser_sink_execution");
    states.set(identity.deliveryAttemptId, "active");
    if (execution.signal.aborted) { states.set(identity.deliveryAttemptId, "completion_uncertain"); throw sinkError("invalid_npc_browser_sink_execution"); }
    let container;
    try { container = options.getConversationContainer(); } catch { container = null; }
    if (!validContainer(container)) return fail(controller, execution, "browser_sink_container_missing", true);
    let textNode;
    try { textNode = options.createTextNode(execution.request.payload.displayText); }
    catch { return fail(controller, execution, "browser_sink_attachment_failed", true); }
    if (!validTextNode(textNode, execution.request.payload.displayText)) return fail(controller, execution, "browser_sink_attachment_failed", true);
    let messageNode;
    try { messageNode = options.createMessageNode(Object.freeze({ textNode, publicationId: identity.publicationId, deliveryAttemptId: identity.deliveryAttemptId })); }
    catch { return fail(controller, execution, "browser_sink_attachment_failed", false); }
    if (!ownsTextNode(messageNode, textNode) || nodeOwners.has(messageNode)) return fail(controller, execution, "browser_sink_attachment_failed", messageNode ? removeAndProve(container, messageNode, key) : false);
    if (execution.signal.aborted) { states.set(identity.deliveryAttemptId, "completion_uncertain"); throw sinkError("invalid_npc_browser_sink_execution"); }
    try { if (typeof container.appendChild === "function") container.appendChild(messageNode); else container.append(messageNode); }
    catch { return fail(controller, execution, "browser_sink_attachment_failed", removeAndProve(container, messageNode, key)); }
    if (!contains(container, messageNode)) return fail(controller, execution, "browser_sink_attachment_failed", removeAndProve(container, messageNode, key));
    try {
      if (seams.bookkeepingRegistrationFault) seams.bookkeepingRegistrationFault();
      if (records.has(key) || nodeOwners.has(messageNode)) throw new Error("bookkeeping");
      records.set(key, { identity, messageNode, textNode });
      nodeOwners.set(messageNode, key);
      if (seams.bookkeepingLookupFault) seams.bookkeepingLookupFault();
      if (records.get(key)?.messageNode !== messageNode || nodeOwners.get(messageNode) !== key) throw new Error("bookkeeping");
    } catch {
      return fail(controller, execution, "browser_sink_bookkeeping_failed", removeAndProve(container, messageNode, key));
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

  function getAttachedDeliveryEvidence(input) {
    if (reset || !validateLookup(input, "browser")) return null;
    const record = records.get(identityKey(input));
    if (!record) return null;
    return frozenCopy({ ...record.identity, evidenceType: "npc_browser_attached_delivery", attached: true });
  }

  function resetSink() { if (reset) return undefined; reset = true; records.clear(); nodeOwners.clear(); states.clear(); return undefined; }
  const sink = Object.freeze({ deliver, getAttachedDeliveryEvidence, reset: resetSink });
  if (!testing) return sink;
  return Object.freeze({ sink, inspect: () => Object.freeze({ reset, recordCount: records.size, nodeOwnerCount: nodeOwners.size, activeCount: [...states.values()].filter((value) => value === "active").length, uncertainCount: [...states.values()].filter((value) => value === "completion_uncertain").length }) });
}

export function createNpcBrowserPublicationSink(options) { return createSink(options, null); }
export function createNpcBrowserPublicationSinkForTesting(options, seams = {}) { return createSink(options, { seams }); }
