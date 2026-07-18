import { createDeliveryHarness, discoveryInput, prepareInput } from "./npcPublicationDeliveryFixtures.mjs";
import { sha256CanonicalJson } from "../../src/conversation/ids.mjs";
import { resolveNpcCanonicalDeliveryPayload } from "../../src/npcCanonicalRenderer.mjs";

export function preparedExecution(sinkType = "browser", options = {}) {
  const harness = createDeliveryHarness({ sinkType, ...options });
  harness.controller.discoverPendingNpcPublications(discoveryInput({ sinkType }));
  const request = harness.controller.prepareNpcPublicationDelivery(prepareInput("npc-publication-1", { sinkType }));
  const execution = harness.controller.beginNpcPublicationSink(request);
  return { harness, request, execution };
}

export function controllerSpy(controller, overrides = {}) {
  const counts = { complete: 0, failure: 0, acknowledge: 0, retry: 0 };
  const spy = {};
  for (const key of Object.keys(controller)) spy[key] = (...args) => controller[key](...args);
  spy.completeNpcPublicationSink = (...args) => { counts.complete += 1; return overrides.complete ? overrides.complete(...args) : controller.completeNpcPublicationSink(...args); };
  spy.recordNpcPublicationSinkFailure = (...args) => { counts.failure += 1; return overrides.failure ? overrides.failure(...args) : controller.recordNpcPublicationSinkFailure(...args); };
  spy.acknowledgeNpcPublication = (...args) => { counts.acknowledge += 1; return controller.acknowledgeNpcPublication(...args); };
  spy.retryNpcPublicationDelivery = (...args) => { counts.retry += 1; return controller.retryNpcPublicationDelivery(...args); };
  return { controller: Object.freeze(spy), counts };
}

export function fakeDom({ containerMissing = false, appendThrows = false, attach = true, wrongParent = false, removalThrows = false } = {}) {
  const nodes = [];
  const otherParent = {
    children: [],
    removeChild(node) { if (removalThrows) throw new Error("remove"); this.children = this.children.filter((value) => value !== node); node.parentNode = null; }
  };
  const container = containerMissing ? null : {
    children: [],
    appendChild(node) {
      if (appendThrows) throw new Error("append");
      if (!attach) return node;
      const parent = wrongParent ? otherParent : this;
      parent.children.push(node);
      node.parentNode = parent;
      return node;
    },
    contains(node) { return this.children.includes(node); },
    removeChild(node) { if (removalThrows) throw new Error("remove"); this.children = this.children.filter((value) => value !== node); node.parentNode = null; }
  };
  const createTextNode = (text) => ({ nodeType: 3, textContent: text, parentNode: null });
  const createMessageNode = ({ textNode, publicationId, deliveryAttemptId }) => {
    const node = { nodeType: 1, childNodes: [textNode], firstChild: textNode, lastChild: textNode, parentNode: null, publicationId, deliveryAttemptId, remove() { if (this.parentNode?.removeChild) this.parentNode.removeChild(this); } };
    textNode.parentNode = node;
    nodes.push(node);
    return node;
  };
  return { container, otherParent, nodes, createTextNode, createMessageNode, getConversationContainer: () => container };
}

export function lookupFor(execution) {
  const { request } = execution;
  return { schemaVersion: 1, gameSessionId: request.gameSessionId, publicationId: request.payload.publicationId, consumerId: request.consumerId, consumerGeneration: request.consumerGeneration, sinkType: request.sinkType, deliveryAttemptId: request.deliveryAttemptId, deliveryAttemptOrder: request.deliveryAttemptOrder, attemptNumber: request.attemptNumber };
}

export function rendererWithText(displayText) {
  return (input) => {
    const resolved = resolveNpcCanonicalDeliveryPayload(input);
    const unsigned = { ...resolved, displayText };
    delete unsigned.payloadFingerprint;
    return Object.freeze({ ...unsigned, payloadFingerprint: sha256CanonicalJson(unsigned) });
  };
}
