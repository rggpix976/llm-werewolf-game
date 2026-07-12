export class PlayerPublicationDeliveryController {
  constructor({ gameSessionId, createId, observer = () => {}, resolvePublication, listPublications, enabled = false, initialWatermark = 0 }) {
    this.gameSessionId = gameSessionId; this.createId = createId; this.observer = observer; this.resolvePublication = resolvePublication; this.listPublications = listPublications;
    this.enabled = enabled; this.consumerGeneration = 0; this.cutoverPublicationSlotOrder = enabled ? initialWatermark : null; this.invalidated = false;
    this.attempts = new Map(); this.activeByPublication = new Map(); this.acknowledgements = new Map(); this.capabilities = new WeakMap(); this.receipts = new WeakMap();
  }

  setEnabled(enabled, nextPublicationSlotOrder) {
    if (this.invalidated) throw deliveryError("stale_publication_session"); if (enabled === this.enabled) return;
    if ([...this.attempts.values()].some((attempt) => ["in_flight", "sink_succeeded"].includes(attempt.state))) throw deliveryError("consumer_mode_switch_in_flight");
    this.consumerGeneration += 1; this.enabled = enabled; if (enabled) this.cutoverPublicationSlotOrder = nextPublicationSlotOrder;
    for (const attempt of this.attempts.values()) if (!["acknowledged", "failed_terminal"].includes(attempt.state)) attempt.state = "stale_session";
    this.activeByPublication.clear();
  }

  discover() {
    this._live(); if (!this.enabled) return [];
    return this.listPublications().filter((publication) => publication.publicationSlotOrder >= this.cutoverPublicationSlotOrder && !this.acknowledgements.has(publication.publicationId)).map((publication) => publication.publicationId);
  }
  historyPublicationIds() { this._live(); return this.cutoverPublicationSlotOrder === null ? [] : this.listPublications().map((publication) => publication.publicationId); }
  liveScopePublicationIds() { this._live(); if (this.cutoverPublicationSlotOrder === null) return new Set(); return new Set(this.listPublications().filter((publication) => publication.publicationSlotOrder >= this.cutoverPublicationSlotOrder).map((publication) => publication.publicationId)); }

  prepare({ publicationId, consumerId, sinkType }) {
    this._live(); if (!this.enabled) throw deliveryError("publication_not_found"); validateSinkIdentity(consumerId, sinkType);
    if (this.acknowledgements.has(publicationId)) throw deliveryError("publication_already_acknowledged");
    const publication = this.listPublications().find((entry) => entry.publicationId === publicationId); if (!publication || publication.publicationSlotOrder < this.cutoverPublicationSlotOrder) throw deliveryError("publication_not_found");
    const active = this.activeByPublication.get(publicationId); if (active?.state === "failed_terminal") throw deliveryError(active.failureCode ?? "history_projection_failure"); if (active && !["failed_retryable", "stale_session"].includes(active.state)) throw deliveryError(active.state === "sink_succeeded" ? "publication_not_delivered" : "publication_not_prepared");
    const attempt = { gameSessionId: this.gameSessionId, publicationId, deliveryAttemptId: `delivery-${this.createId()}`, consumerId, consumerGeneration: this.consumerGeneration, sinkType, state: "unseen", rendered: null, capability: null, receipt: null }; this.attempts.set(attempt.deliveryAttemptId, attempt); this.activeByPublication.set(publicationId, attempt);
    try { attempt.rendered = this.resolvePublication(publicationId); }
    catch (error) { attempt.state = "failed_terminal"; attempt.failureCode = error?.code ?? "history_projection_failure"; this._observe("render_failed", attempt); throw error; }
    attempt.state = "prepared"; this._observe("render_prepared", attempt); return publicAttempt(attempt);
  }

  begin({ deliveryAttemptId }) {
    const attempt = this._attempt(deliveryAttemptId); if (attempt.state !== "prepared") throw deliveryError("publication_not_prepared");
    attempt.state = "in_flight"; const capability = Object.freeze({ capabilityId: `sink-capability-${this.createId()}` }); attempt.capability = capability; this.capabilities.set(capability, attempt); this._observe("sink_started", attempt); return capability;
  }

  complete(capability) {
    const attempt = this.capabilities.get(capability); if (!attempt || attempt.capability !== capability || attempt.state !== "in_flight") throw deliveryError("publication_not_delivered"); this._current(attempt);
    attempt.state = "sink_succeeded"; const receipt = Object.freeze({ receiptId: `sink-receipt-${this.createId()}`, gameSessionId: attempt.gameSessionId, publicationId: attempt.publicationId, consumerId: attempt.consumerId, deliveryAttemptId: attempt.deliveryAttemptId, consumerGeneration: attempt.consumerGeneration, sinkType: attempt.sinkType }); attempt.receipt = receipt; this.receipts.set(receipt, attempt); this._observe("sink_succeeded", attempt); return receipt;
  }

  fail(capability) {
    const attempt = this.capabilities.get(capability); if (!attempt || attempt.capability !== capability || attempt.state !== "in_flight") throw deliveryError("publication_not_delivered"); this._current(attempt); attempt.state = "failed_retryable"; attempt.capability = null; this._observe("sink_failed", attempt); return publicAttempt(attempt);
  }

  acknowledge(receipt) {
    const attempt = this.receipts.get(receipt); if (!attempt || attempt.receipt !== receipt) throw deliveryError("invalid_sink_success_receipt"); this._current(attempt);
    const stored = this.acknowledgements.get(attempt.publicationId);
    if (stored) { if (stored.receipt !== receipt) throw deliveryError("publication_ack_conflict"); this._observe("duplicate_ack_suppressed", attempt); return stored.result; }
    if (attempt.state !== "sink_succeeded") throw deliveryError("publication_not_delivered");
    attempt.state = "acknowledged"; const result = Object.freeze({ status: "acknowledged", gameSessionId: attempt.gameSessionId, publicationId: attempt.publicationId, consumerId: attempt.consumerId, deliveryAttemptId: attempt.deliveryAttemptId, consumerGeneration: attempt.consumerGeneration, sinkType: attempt.sinkType, receiptId: receipt.receiptId }); this.acknowledgements.set(attempt.publicationId, { receipt, result }); this.activeByPublication.delete(attempt.publicationId); this._observe("publication_acknowledged", attempt); return result;
  }

  receiptFor(identity = {}) {
    this._live(); const { gameSessionId, publicationId, consumerId, consumerGeneration, deliveryAttemptId, sinkType, receiptId } = identity;
    if (![gameSessionId, publicationId, consumerId, deliveryAttemptId, sinkType, receiptId].every((value) => typeof value === "string" && value) || !Number.isSafeInteger(consumerGeneration)) throw deliveryError("invalid_sink_success_receipt");
    if (gameSessionId !== this.gameSessionId) throw deliveryError("stale_publication_session");
    if (consumerGeneration !== this.consumerGeneration) { const stale = this.attempts.get(deliveryAttemptId); if (stale) this._observe("stale_consumer_generation", stale); throw deliveryError("stale_consumer_generation"); }
    const attempt = this.attempts.get(deliveryAttemptId); if (!attempt || attempt.publicationId !== publicationId || attempt.consumerId !== consumerId || attempt.sinkType !== sinkType || attempt.receipt?.receiptId !== receiptId) throw deliveryError("publication_not_delivered");
    this._current(attempt); if (!attempt.receipt || !["sink_succeeded", "acknowledged"].includes(attempt.state)) throw deliveryError("publication_not_delivered"); return attempt.receipt;
  }

  stateFor(publicationId) { return this.acknowledgements.has(publicationId) ? "acknowledged" : this.activeByPublication.get(publicationId)?.state ?? "unseen"; }
  acknowledgedPublicationIds() { return new Set(this.acknowledgements.keys()); }
  invalidate() { this.invalidated = true; for (const attempt of this.attempts.values()) if (attempt.state !== "acknowledged") attempt.state = "stale_session"; this.activeByPublication.clear(); }

  _attempt(id) { this._live(); const attempt = this.attempts.get(id); if (!attempt) throw deliveryError("publication_not_prepared"); this._current(attempt); return attempt; }
  _current(attempt) { if (this.invalidated || attempt.gameSessionId !== this.gameSessionId) throw deliveryError("stale_publication_session"); if (attempt.consumerGeneration !== this.consumerGeneration) { this._observe("stale_consumer_generation", attempt); throw deliveryError("stale_consumer_generation"); } }
  _live() { if (this.invalidated) throw deliveryError("stale_publication_session"); }
  _observe(outcomeCategory, attempt) { try { this.observer(Object.freeze({ gameSessionId: attempt.gameSessionId, publicationId: attempt.publicationId, deliveryAttemptId: attempt.deliveryAttemptId, consumerGeneration: attempt.consumerGeneration, sinkType: attempt.sinkType, outcomeCategory })); } catch {} }
}

function publicAttempt(attempt) { return Object.freeze({ gameSessionId: attempt.gameSessionId, publicationId: attempt.publicationId, consumerId: attempt.consumerId, deliveryAttemptId: attempt.deliveryAttemptId, consumerGeneration: attempt.consumerGeneration, sinkType: attempt.sinkType, state: attempt.state, entry: attempt.rendered }); }
function validateSinkIdentity(consumerId, sinkType) { if (typeof consumerId !== "string" || !consumerId || !["browser", "cli"].includes(sinkType)) throw deliveryError("invalid_sink_success_receipt"); }
export function deliveryError(code) { const error = new Error(code); error.name = "PlayerPublicationDeliveryError"; error.code = code; return error; }
