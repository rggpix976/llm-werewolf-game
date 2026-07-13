import { sanitizeTerminalText } from "./playerStructuredConsumer.mjs";

export async function deliverPlayerPublication({ game, publicationId, consumerId, sinkType, deliveryMode = "structured", modeTransitionId = null, write, cleanup = async () => {}, onSinkSucceeded = () => {} }) {
  const attempt = game.preparePlayerPublicationDelivery({ publicationId, consumerId, sinkType, deliveryMode, modeTransitionId });
  const capability = game.beginPlayerPublicationSink({ deliveryAttemptId: attempt.deliveryAttemptId });
  let sinkValue;
  try { sinkValue = await write(attempt.entry, attempt); }
  catch (error) { game.failPlayerPublicationSink(capability); throw error; }
  let receipt;
  try { receipt = game.completePlayerPublicationSink(capability); }
  catch (error) { await cleanup(sinkValue, attempt); try { game.failPlayerPublicationSink(capability); } catch {} throw error; }
  const deliveryIdentity = sinkReceiptIdentity(receipt);
  try { onSinkSucceeded(deliveryIdentity, attempt.entry); }
  catch (error) { error.deliveryIdentity = deliveryIdentity; if (deliveryMode === "legacy_pre_cutover") error.evidenceOnlyRetry = true; else error.acknowledgementOnlyRetry = true; throw error; }
  try { return deliveryMode === "legacy_pre_cutover" ? game.recordPreCutoverPlayerPublicationEvidence(receipt) : game.acknowledgePlayerPublication(receipt); }
  catch (error) { error.deliveryIdentity = deliveryIdentity; if (deliveryMode === "legacy_pre_cutover") error.evidenceOnlyRetry = true; else error.acknowledgementOnlyRetry = true; throw error; }
}

export function retryPlayerPublicationAcknowledgement({ game, deliveryIdentity }) { return game.acknowledgePlayerPublication(game.getPlayerPublicationSinkReceipt(deliveryIdentity)); }
export function retryPreCutoverPlayerPublicationEvidence({ game, deliveryIdentity }) { return game.recordPreCutoverPlayerPublicationEvidence(game.getPlayerPublicationSinkReceipt(deliveryIdentity)); }

export async function deliverLivePlayerEntries({ game, entries, consumerId, sinkType, writeStructured, writeLegacy, cleanup, onSinkSucceeded, acknowledgeOnly }) {
  for (const envelope of entries) {
    if (envelope.kind === "player_publication_delivery" && envelope.acknowledgementOnly) await acknowledgeOnly(envelope.deliveryIdentity);
    else if (envelope.kind === "player_publication_delivery" && envelope.evidenceOnly) await acknowledgeOnly(envelope.deliveryIdentity, true);
    else if (envelope.kind === "player_publication_delivery") await deliverPlayerPublication({ game, publicationId: envelope.publicationId, consumerId, sinkType, deliveryMode: envelope.deliveryMode, modeTransitionId: envelope.modeTransitionId, write: envelope.deliveryMode === "structured" ? writeStructured : writeLegacy, cleanup, onSinkSucceeded });
    else if (envelope.kind === "legacy_display") await writeLegacy(envelope.entry);
    else throw new TypeError("invalid_live_display_envelope");
  }
}

export function sinkReceiptIdentity(receipt) { return Object.freeze({ gameSessionId: receipt.gameSessionId, publicationId: receipt.publicationId, consumerId: receipt.consumerId, consumerGeneration: receipt.consumerGeneration, deliveryAttemptId: receipt.deliveryAttemptId, sinkType: receipt.sinkType, deliveryMode: receipt.deliveryMode, modeTransitionId: receipt.modeTransitionId ?? null, receiptId: receipt.receiptId }); }
export function deliveryBookkeepingKey(identity) { return [identity.gameSessionId, identity.publicationId, identity.consumerId, identity.consumerGeneration, identity.deliveryAttemptId, identity.sinkType, identity.deliveryMode, identity.modeTransitionId ?? "none"].join("|"); }

export async function consumeLiveActionDisplay({ game, action, consumerId, sinkType, bookkeeping, writeStructured, writeLegacy }) {
  let pendingIdentity;
  try {
    await deliverLivePlayerEntries({ game, entries: action.livePlayerDisplayEntries, consumerId, sinkType, writeStructured: async (entry, attempt) => { const key = deliveryBookkeepingKey(attempt); if (bookkeeping.has(key)) throw new Error(`duplicate_${sinkType}_publication`); const value = await writeStructured(entry, attempt); bookkeeping.set(key, { value, identity: null }); return value; }, writeLegacy: async (entry, attempt) => { if (!attempt) return writeLegacy(entry); const key = deliveryBookkeepingKey(attempt); if (bookkeeping.has(key)) throw new Error(`duplicate_${sinkType}_publication`); const value = await writeLegacy(entry, attempt); bookkeeping.set(key, { value, identity: null }); return value; }, cleanup: async (value, attempt) => { const key = deliveryBookkeepingKey(attempt); value?.rollbackDeliveryModel?.(); if (value?.remove) value.remove(); bookkeeping.delete(key); }, onSinkSucceeded: (identity) => { pendingIdentity = identity; const stored = bookkeeping.get(deliveryBookkeepingKey(identity)); if (!stored) throw new Error("missing_exact_sink_bookkeeping"); stored.identity = identity; if (stored.value?.dataset) stored.value.dataset.receiptId = identity.receiptId; }, acknowledgeOnly: (identity, evidenceOnly = false) => { const stored = bookkeeping.get(deliveryBookkeepingKey(identity)); if (!stored?.identity || stored.identity.receiptId !== identity.receiptId) throw new Error("missing_exact_sink_bookkeeping"); return evidenceOnly ? retryPreCutoverPlayerPublicationEvidence({ game, deliveryIdentity: stored.identity }) : retryPlayerPublicationAcknowledgement({ game, deliveryIdentity: stored.identity }); } });
  } catch (error) {
    const identity = error.deliveryIdentity ?? pendingIdentity, stored = identity && bookkeeping.get(deliveryBookkeepingKey(identity));
    if (error.acknowledgementOnlyRetry && stored?.identity === identity) return retryPlayerPublicationAcknowledgement({ game, deliveryIdentity: identity });
    if (error.evidenceOnlyRetry && stored?.identity === identity) return retryPreCutoverPlayerPublicationEvidence({ game, deliveryIdentity: identity });
    throw error;
  }
}

export async function ensurePlayerPublicationConsumerMode({ game, requestedMode, consumerId, sinkType, bookkeeping, writeStructured, writeLegacy }) {
  let result = game.requestPlayerPublicationConsumerMode({ consumerId, sinkType, requestedMode });
  if (result.status !== "draining_pre_cutover") return result;
  while (result.pendingCount > 0) {
    const candidates = game.getPendingPreCutoverPlayerPublications({ modeTransitionId: result.modeTransitionId, gameSessionId: result.gameSessionId, consumerId, sinkType, limit: 32 });
    if (candidates.length === 0) throw deliveryProtocolError("pre_cutover_delivery_terminal");
    await consumeLiveActionDisplay({ game, action: { livePlayerDisplayEntries: candidates.map((candidate) => Object.freeze({ kind: "player_publication_delivery", ...candidate })) }, consumerId, sinkType, bookkeeping, writeStructured, writeLegacy });
    result = game.getPlayerPublicationConsumerModeState();
  }
  return game.completePlayerPublicationConsumerModeTransition({ modeTransitionId: result.modeTransitionId, gameSessionId: result.gameSessionId, consumerId, sinkType, proposedCutoverPublicationSlotOrder: result.proposedCutoverPublicationSlotOrder });
}

export async function dispatchPlayerActionWithConsumerMode({ game, action, requestedMode, consumerId, sinkType, bookkeeping, writeStructured, writeLegacy }) {
  await ensurePlayerPublicationConsumerMode({ game, requestedMode, consumerId, sinkType, bookkeeping, writeStructured, writeLegacy });
  return game.dispatchPlayerAction(action);
}

export function appendBrowserPublicationNode({ document, container, entry, formatPhase = (value) => String(value) }) { if (!container || typeof container.append !== "function") throw deliveryProtocolError("browser_sink_container_missing"); const row = createBrowserPublicationNode({ document, entry, formatPhase }); container.append(row); if (row.parentNode !== container) { row.remove?.(); throw deliveryProtocolError("browser_sink_attachment_failed"); } return row; }
export function reconcileBrowserPublicationNodes({ document, container, entries, formatPhase = (value) => String(value) }) { const existing = new Map([...container.querySelectorAll("[data-publication-id]")].map((node) => [node.dataset.publicationId, node])); const nodes = entries.map((entry) => { const row = entry.publicationId ? existing.get(entry.publicationId) : null; if (!row) return createBrowserPublicationNode({ document, entry, formatPhase }); row.children[0].textContent = `Day ${entry.day} / ${formatPhase(entry.phase)}`; row.children[1].textContent = entry.message; return row; }); container.replaceChildren(...nodes); return Object.freeze(nodes); }
export async function writeCliPublication({ write, entry }) { const text = `[Day ${entry.day} / ${entry.phase}] ${sanitizeTerminalText(entry.message)}`; await write(text); return text; }

function createBrowserPublicationNode({ document, entry, formatPhase }) { const row = document.createElement("div"); row.className = "log-entry"; if (entry.publicationId) row.dataset.publicationId = entry.publicationId; const meta = document.createElement("div"); meta.className = "log-meta"; meta.textContent = `Day ${entry.day} / ${formatPhase(entry.phase)}`; const message = document.createElement("div"); message.className = "log-message"; message.textContent = entry.message; row.append(meta, message); return row; }
function deliveryProtocolError(code) { const error = new Error(code); error.code = code; return error; }
