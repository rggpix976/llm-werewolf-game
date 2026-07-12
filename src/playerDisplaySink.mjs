import { sanitizeTerminalText } from "./playerStructuredConsumer.mjs";

export async function deliverPlayerPublication({ game, publicationId, consumerId, sinkType, write, onSinkSucceeded = () => {} }) {
  const attempt = game.preparePlayerPublicationDelivery({ publicationId, consumerId, sinkType }); const capability = game.beginPlayerPublicationSink({ deliveryAttemptId: attempt.deliveryAttemptId });
  try { await write(attempt.entry, attempt); }
  catch (error) { game.failPlayerPublicationSink(capability); throw error; }
  const receipt = game.completePlayerPublicationSink(capability), deliveryIdentity = sinkReceiptIdentity(receipt); onSinkSucceeded(deliveryIdentity, attempt.entry); try { return game.acknowledgePlayerPublication(receipt); } catch (error) { error.acknowledgementOnlyRetry = true; error.deliveryIdentity = deliveryIdentity; throw error; }
}

export function retryPlayerPublicationAcknowledgement({ game, deliveryIdentity }) { return game.acknowledgePlayerPublication(game.getPlayerPublicationSinkReceipt(deliveryIdentity)); }

export async function deliverLivePlayerEntries({ game, entries, consumerId, sinkType, writeStructured, writeLegacy, onSinkSucceeded }) {
  for (const envelope of entries) {
    if (envelope.kind === "player_publication_delivery") await deliverPlayerPublication({ game, publicationId: envelope.publicationId, consumerId, sinkType, write: writeStructured, onSinkSucceeded });
    else if (envelope.kind === "legacy_display") await writeLegacy(envelope.entry);
    else throw new TypeError("invalid_live_display_envelope");
  }
}

export function sinkReceiptIdentity(receipt) { return Object.freeze({ gameSessionId: receipt.gameSessionId, publicationId: receipt.publicationId, consumerId: receipt.consumerId, consumerGeneration: receipt.consumerGeneration, deliveryAttemptId: receipt.deliveryAttemptId, sinkType: receipt.sinkType, receiptId: receipt.receiptId }); }
export function deliveryBookkeepingKey(identity) { return [identity.gameSessionId, identity.publicationId, identity.consumerId, identity.consumerGeneration, identity.deliveryAttemptId, identity.sinkType].join("|"); }

export async function consumeLiveActionDisplay({ game, action, consumerId, sinkType, bookkeeping, writeStructured, writeLegacy }) {
  let pendingIdentity;
  try {
    await deliverLivePlayerEntries({ game, entries: action.livePlayerDisplayEntries, consumerId, sinkType, writeStructured: async (entry, attempt) => { const key = deliveryBookkeepingKey(attempt); if (bookkeeping.has(key)) throw new Error(`duplicate_${sinkType}_publication`); const value = await writeStructured(entry, attempt); bookkeeping.set(key, { value, identity: null }); return value; }, writeLegacy, onSinkSucceeded: (identity) => { pendingIdentity = identity; const stored = bookkeeping.get(deliveryBookkeepingKey(identity)); if (stored) { stored.identity = identity; if (stored.value?.dataset) stored.value.dataset.receiptId = identity.receiptId; } } });
  } catch (error) {
    const identity = error.deliveryIdentity ?? pendingIdentity, stored = identity && bookkeeping.get(deliveryBookkeepingKey(identity));
    if (error.acknowledgementOnlyRetry && stored?.identity === identity) return retryPlayerPublicationAcknowledgement({ game, deliveryIdentity: identity });
    throw error;
  }
}

export function appendBrowserPublicationNode({ document, container, entry, formatPhase = (value) => String(value) }) { const row = document.createElement("div"); row.className = "log-entry"; row.dataset.publicationId = entry.publicationId; const meta = document.createElement("div"); meta.className = "log-meta"; meta.textContent = `Day ${entry.day} / ${formatPhase(entry.phase)}`; const message = document.createElement("div"); message.className = "log-message"; message.textContent = entry.message; row.append(meta, message); container.append(row); return row; }
export async function writeCliPublication({ write, entry }) { const text = `[Day ${entry.day} / ${entry.phase}] ${sanitizeTerminalText(entry.message)}`; await write(text); return text; }
