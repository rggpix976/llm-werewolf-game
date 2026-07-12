import { sanitizeTerminalText } from "./playerStructuredConsumer.mjs";

export async function deliverPlayerPublication({ game, publicationId, consumerId, sinkType, write, displayEntry }) {
  const attempt = game.preparePlayerPublicationDelivery({ publicationId, consumerId, sinkType }); const capability = game.beginPlayerPublicationSink({ deliveryAttemptId: attempt.deliveryAttemptId });
  try { await write(displayEntry ?? attempt.entry, attempt); }
  catch (error) { game.failPlayerPublicationSink(capability); throw error; }
  const receipt = game.completePlayerPublicationSink(capability); try { return game.acknowledgePlayerPublication(receipt); } catch (error) { error.acknowledgementOnlyRetry = true; error.publicationId = publicationId; throw error; }
}

export function retryPlayerPublicationAcknowledgement({ game, publicationId }) { return game.acknowledgePlayerPublication(game.getPlayerPublicationSinkReceipt({ publicationId })); }

export async function deliverProjectedEntries({ game, entries, consumerId, sinkType, writeStructured, writeLegacy }) {
  for (const entry of entries) { if (entry.structured) await deliverPlayerPublication({ game, publicationId: entry.publicationId, consumerId, sinkType, write: writeStructured, displayEntry: entry }); else await writeLegacy(entry); }
}

export function appendBrowserPublicationNode({ document, container, entry, formatPhase = (value) => String(value) }) { const row = document.createElement("div"); row.className = "log-entry"; row.dataset.publicationId = entry.publicationId; const meta = document.createElement("div"); meta.className = "log-meta"; meta.textContent = `Day ${entry.day} / ${formatPhase(entry.phase)}`; const message = document.createElement("div"); message.className = "log-message"; message.textContent = entry.message; row.append(meta, message); container.append(row); return row; }
export async function writeCliPublication({ write, entry }) { const text = `[Day ${entry.day} / ${entry.phase}] ${sanitizeTerminalText(entry.message)}`; await write(text); return text; }
