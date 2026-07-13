export class PlayerPublicationDeliveryController {
  constructor({ gameSessionId, createId, observer = () => {}, resolvePublication, resolvePreCutoverIdentity, listPublications, isQuiescent = () => true, enabled = false, initialWatermark = 0 }) {
    this.gameSessionId = gameSessionId;
    this.createId = createId;
    this.observer = observer;
    this.resolvePublication = resolvePublication;
    this.resolvePreCutoverIdentity = resolvePreCutoverIdentity ?? ((publicationId) => ({ publicationId }));
    this.listPublications = listPublications;
    this.isQuiescent = isQuiescent;
    this.requestedMode = enabled ? "structured" : "legacy";
    this.effectiveMode = this.requestedMode;
    this.consumerGeneration = 0;
    this.committedCutoverPublicationSlotOrder = enabled ? initialWatermark : null;
    this.invalidated = false;
    this.attempts = new Map();
    this.activeByPublication = new Map();
    this.terminalFailures = new Map();
    this.acknowledgements = new Map();
    this.preCutoverEvidence = new Map();
    this.capabilities = new WeakMap();
    this.receipts = new WeakMap();
    this.transitions = new Map();
    this.activeTransition = null;
    this.transitionRuntimeOrder = 0;
    this.evidenceRuntimeOrder = 0;
  }

  get enabled() { return this.effectiveMode === "structured"; }
  get cutoverPublicationSlotOrder() { return this.committedCutoverPublicationSlotOrder; }

  modeState() {
    this._live();
    const transition = this.activeTransition;
    return Object.freeze({
      gameSessionId: this.gameSessionId,
      requestedMode: this.requestedMode,
      effectiveMode: this.effectiveMode,
      transitionStatus: transition?.status ?? "stable",
      modeTransitionId: transition?.modeTransitionId ?? null,
      consumerId: transition?.consumerId ?? null,
      sinkType: transition?.sinkType ?? null,
      proposedCutoverPublicationSlotOrder: transition?.proposedCutoverPublicationSlotOrder ?? null,
      committedCutoverPublicationSlotOrder: this.committedCutoverPublicationSlotOrder,
      consumerGeneration: this.consumerGeneration,
      pendingCount: transition ? this._missingRequired(transition).length : 0
    });
  }

  requestMode({ gameSessionId, consumerId, sinkType, requestedMode, nextPublicationSlotOrder }) {
    this._live();
    this._session(gameSessionId);
    validateSinkIdentity(consumerId, sinkType);
    if (!MODES.has(requestedMode)) throw deliveryError("consumer_mode_transition_conflict");
    if (!Number.isSafeInteger(nextPublicationSlotOrder) || nextPublicationSlotOrder < 0) throw deliveryError("consumer_mode_transition_conflict");
    if (!this.isQuiescent()) return this._rejectTransition("consumer_mode_switch_in_flight", { consumerId, sinkType, requestedMode });
    if (this._hasUnsettledSink()) return this._rejectTransition("consumer_mode_switch_in_flight", { consumerId, sinkType, requestedMode });
    if (this.activeTransition) {
      const active = this.activeTransition;
      if (active.consumerId === consumerId && active.sinkType === sinkType && active.requestedMode === requestedMode) return this._transitionResult(active);
      return this._rejectTransition("consumer_mode_transition_conflict", { consumerId, sinkType, requestedMode });
    }
    if (requestedMode === this.effectiveMode) {
      this.requestedMode = requestedMode;
      return this.modeState();
    }
    if (requestedMode === "legacy") {
      this.requestedMode = "legacy";
      this.effectiveMode = "legacy";
      this.consumerGeneration += 1;
      this._staleGenerationAttempts();
      return this.modeState();
    }
    if (this.committedCutoverPublicationSlotOrder !== null) {
      this.requestedMode = "structured";
      this.effectiveMode = "structured";
      this.consumerGeneration += 1;
      this._staleGenerationAttempts();
      return this.modeState();
    }

    const required = Object.freeze(this.listPublications()
      .filter((publication) => publication.publicationSlotOrder < nextPublicationSlotOrder)
      .map((publication) => Object.freeze({
        gameSessionId: this.gameSessionId,
        publicationId: publication.publicationId,
        publicationSlotOrder: publication.publicationSlotOrder,
        ...this.resolvePreCutoverIdentity(publication.publicationId)
      })));
    const transition = {
      modeTransitionId: `consumer-transition-${this.createId()}`,
      gameSessionId: this.gameSessionId,
      consumerId,
      sinkType,
      fromMode: this.effectiveMode,
      requestedMode: "structured",
      effectiveMode: this.effectiveMode,
      status: "draining_pre_cutover",
      proposedCutoverPublicationSlotOrder: nextPublicationSlotOrder,
      consumerGenerationBefore: this.consumerGeneration,
      required,
      createdRuntimeOrder: this.transitionRuntimeOrder++,
      result: null
    };
    this.requestedMode = "structured";
    this.activeTransition = transition;
    this.transitions.set(transition.modeTransitionId, transition);
    this._observeTransition("consumer_mode_transition_requested", transition);
    if (this._missingRequired(transition).length === 0) return this.completeTransition(this._transitionIdentity(transition));
    this._observeTransition("pre_cutover_delivery_pending", transition, "pre_cutover_delivery_pending");
    return this._transitionResult(transition, "pre_cutover_delivery_pending");
  }

  pendingPreCutover({ modeTransitionId, gameSessionId, consumerId, sinkType, limit = 32 }) {
    this._live();
    const transition = this._activeTransition({ modeTransitionId, gameSessionId, consumerId, sinkType });
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw deliveryError("consumer_mode_transition_conflict");
    return Object.freeze(this._missingRequired(transition)
      .filter((identity) => !this.terminalFailures.has(identity.publicationId))
      .slice(0, limit)
      .map((identity) => Object.freeze({ ...identity, deliveryMode: "legacy_pre_cutover", modeTransitionId })));
  }

  completeTransition(identity) {
    this._live();
    const stored = this.transitions.get(identity?.modeTransitionId);
    if (stored?.status === "completed") { this._assertTransitionIdentity(stored, identity); return stored.result; }
    const transition = this._activeTransition(identity);
    if (this._hasUnsettledSink()) throw deliveryError("consumer_mode_switch_in_flight");
    if (transition.required.some((entry) => this.terminalFailures.has(entry.publicationId))) throw deliveryError("pre_cutover_delivery_terminal");
    if (this._missingRequired(transition).length !== 0) return this._transitionResult(transition, "pre_cutover_delivery_pending");
    transition.status = "applying";
    this.effectiveMode = "structured";
    this.requestedMode = "structured";
    this.consumerGeneration += 1;
    this.committedCutoverPublicationSlotOrder = transition.proposedCutoverPublicationSlotOrder;
    transition.effectiveMode = "structured";
    transition.status = "completed";
    this.activeTransition = null;
    transition.result = this._transitionResult(transition);
    this._observeTransition("consumer_mode_transition_completed", transition);
    return transition.result;
  }

  cancelTransition(identity) {
    this._live();
    const stored = this.transitions.get(identity?.modeTransitionId);
    if (stored?.status === "cancelled") { this._assertTransitionIdentity(stored, identity); return stored.result; }
    const transition = this._activeTransition(identity);
    if (this._hasUnsettledSink()) throw deliveryError("consumer_mode_switch_in_flight");
    transition.status = "cancelled";
    transition.requestedMode = "legacy";
    transition.effectiveMode = "legacy";
    this.requestedMode = "legacy";
    this.effectiveMode = "legacy";
    this.activeTransition = null;
    transition.result = this._transitionResult(transition);
    this._observeTransition("consumer_mode_transition_cancelled", transition);
    return transition.result;
  }

  discover() { return this.discoverCandidates().map((candidate) => candidate.publicationId); }

  discoverCandidates(deliveryMode) {
    this._live();
    const mode = deliveryMode ?? (this.effectiveMode === "structured" ? "structured" : this.committedCutoverPublicationSlotOrder === null ? "legacy_pre_cutover" : "legacy");
    this._validateDeliveryMode(mode);
    let publications = this.listPublications();
    if (mode === "structured" || mode === "legacy") publications = publications.filter((publication) => publication.publicationSlotOrder >= this.committedCutoverPublicationSlotOrder);
    if (mode === "legacy_pre_cutover" && this.activeTransition) {
      const required = new Set(this.activeTransition.required.map((entry) => entry.publicationId));
      publications = publications.filter((publication) => required.has(publication.publicationId));
    }
    return publications
      .filter((publication) => !this.terminalFailures.has(publication.publicationId))
      .filter((publication) => mode === "legacy_pre_cutover" ? !this.preCutoverEvidence.has(publication.publicationId) : !this.acknowledgements.has(publication.publicationId))
      .map((publication) => {
        const attempt = this.activeByPublication.get(publication.publicationId);
        return Object.freeze({ publicationId: publication.publicationId, deliveryMode: mode, modeTransitionId: mode === "legacy_pre_cutover" ? this.activeTransition?.modeTransitionId ?? null : null, acknowledgementOnly: mode !== "legacy_pre_cutover" && attempt?.state === "sink_succeeded", evidenceOnly: mode === "legacy_pre_cutover" && attempt?.state === "sink_succeeded", deliveryIdentity: attempt?.state === "sink_succeeded" ? receiptIdentity(attempt.receipt) : null });
      });
  }

  historyPublicationIds() { this._live(); return this.listPublications().map((publication) => publication.publicationId); }
  liveScopePublicationIds() { this._live(); if (this.committedCutoverPublicationSlotOrder === null) return new Set(); return new Set(this.listPublications().filter((publication) => publication.publicationSlotOrder >= this.committedCutoverPublicationSlotOrder).map((publication) => publication.publicationId)); }
  preCutoverLegacyDeliveredPublicationIds() { this._live(); return new Set(this.preCutoverEvidence.keys()); }
  pendingPreCutoverLegacyPublicationIds() { this._live(); if (this.committedCutoverPublicationSlotOrder !== null) return []; return this.discoverCandidates("legacy_pre_cutover").map((candidate) => candidate.publicationId); }

  prepare({ publicationId, consumerId, sinkType, deliveryMode = "structured", modeTransitionId = null }) {
    this._live();
    this._validateDeliveryMode(deliveryMode);
    validateSinkIdentity(consumerId, sinkType);
    if (this.terminalFailures.has(publicationId)) throw deliveryError(this.terminalFailures.get(publicationId));
    if (deliveryMode === "legacy_pre_cutover" ? this.preCutoverEvidence.has(publicationId) : this.acknowledgements.has(publicationId)) throw deliveryError("publication_already_acknowledged");
    const publication = this.listPublications().find((entry) => entry.publicationId === publicationId);
    if (!publication || ((deliveryMode === "structured" || deliveryMode === "legacy") && publication.publicationSlotOrder < this.committedCutoverPublicationSlotOrder)) throw deliveryError("publication_not_found");
    if (deliveryMode === "legacy_pre_cutover" && this.activeTransition) {
      if (modeTransitionId !== this.activeTransition.modeTransitionId || !this.activeTransition.required.some((entry) => entry.publicationId === publicationId)) throw deliveryError("consumer_mode_transition_conflict");
      if (consumerId !== this.activeTransition.consumerId || sinkType !== this.activeTransition.sinkType) throw deliveryError("consumer_mode_transition_conflict");
    }
    const active = this.activeByPublication.get(publicationId);
    if (active && !["failed_retryable", "stale_session"].includes(active.state)) throw deliveryError(active.state === "sink_succeeded" ? "publication_not_delivered" : "publication_not_prepared");
    const attempt = { gameSessionId: this.gameSessionId, publicationId, deliveryAttemptId: `delivery-${this.createId()}`, consumerId, consumerGeneration: this.consumerGeneration, sinkType, deliveryMode, modeTransitionId, state: "unseen", rendered: null, capability: null, receipt: null };
    this.attempts.set(attempt.deliveryAttemptId, attempt);
    this.activeByPublication.set(publicationId, attempt);
    try { attempt.rendered = this.resolvePublication(publicationId, deliveryMode); }
    catch (error) { attempt.state = "failed_terminal"; attempt.failureCode = error?.code ?? "history_projection_failure"; this.terminalFailures.set(publicationId, attempt.failureCode); this._observe("render_failed", attempt, attempt.failureCode); throw error; }
    attempt.state = "prepared";
    this._observe("render_prepared", attempt);
    return publicAttempt(attempt);
  }

  begin({ deliveryAttemptId }) {
    const attempt = this._attempt(deliveryAttemptId);
    if (attempt.state !== "prepared") throw deliveryError("publication_not_prepared");
    attempt.state = "in_flight";
    const capability = Object.freeze({ capabilityId: `sink-capability-${this.createId()}` });
    attempt.capability = capability;
    this.capabilities.set(capability, attempt);
    this._observe("sink_started", attempt);
    return capability;
  }

  complete(capability) {
    const attempt = this.capabilities.get(capability);
    if (!attempt || attempt.capability !== capability || attempt.state !== "in_flight") throw deliveryError("publication_not_delivered");
    this._current(attempt);
    attempt.state = "sink_succeeded";
    const receipt = Object.freeze({ receiptId: `sink-receipt-${this.createId()}`, gameSessionId: attempt.gameSessionId, publicationId: attempt.publicationId, consumerId: attempt.consumerId, deliveryAttemptId: attempt.deliveryAttemptId, consumerGeneration: attempt.consumerGeneration, sinkType: attempt.sinkType, deliveryMode: attempt.deliveryMode, modeTransitionId: attempt.modeTransitionId });
    attempt.receipt = receipt;
    this.receipts.set(receipt, attempt);
    this._observe(attempt.deliveryMode === "legacy_pre_cutover" ? "pre_cutover_legacy_sink_succeeded" : "sink_succeeded", attempt);
    return receipt;
  }

  fail(capability) {
    const attempt = this.capabilities.get(capability);
    if (!attempt || attempt.capability !== capability || attempt.state !== "in_flight") throw deliveryError("publication_not_delivered");
    this._current(attempt);
    attempt.state = "failed_retryable";
    attempt.capability = null;
    this._observe("sink_failed", attempt);
    return publicAttempt(attempt);
  }

  recordPreCutoverEvidence(receipt) {
    const attempt = this.receipts.get(receipt);
    if (!attempt || attempt.receipt !== receipt) {
      if (validReceiptShape(receipt) && receipt.gameSessionId !== this.gameSessionId) throw deliveryError("stale_publication_session");
      throw deliveryError("invalid_sink_success_receipt");
    }
    this._current(attempt);
    const existing = this.preCutoverEvidence.get(attempt.publicationId);
    if (existing) {
      if (existing.receipt !== receipt) throw deliveryError("consumer_mode_transition_conflict");
      return existing.result;
    }
    if (attempt.deliveryMode !== "legacy_pre_cutover" || attempt.state !== "sink_succeeded") throw deliveryError("publication_not_delivered");
    const mapping = this.resolvePreCutoverIdentity(attempt.publicationId);
    const result = Object.freeze({ status: "evidence_recorded", gameSessionId: attempt.gameSessionId, publicationId: attempt.publicationId, consumerId: attempt.consumerId, consumerGeneration: attempt.consumerGeneration, deliveryAttemptId: attempt.deliveryAttemptId, sinkType: attempt.sinkType, deliveryMode: attempt.deliveryMode, modeTransitionId: attempt.modeTransitionId, receiptId: receipt.receiptId, ...mapping, evidenceRuntimeOrder: this.evidenceRuntimeOrder++ });
    attempt.state = "evidence_recorded";
    this.preCutoverEvidence.set(attempt.publicationId, { receipt, result });
    this.activeByPublication.delete(attempt.publicationId);
    this._observe("pre_cutover_delivery_evidence_recorded", attempt);
    return result;
  }

  acknowledge(receipt) {
    const attempt = this.receipts.get(receipt);
    if (!attempt || attempt.receipt !== receipt) { if (validReceiptShape(receipt) && receipt.gameSessionId !== this.gameSessionId) { this._rejectStaleAck("stale_publication_session", receipt); throw deliveryError("stale_publication_session"); } throw deliveryError("invalid_sink_success_receipt"); }
    this._currentAck(attempt);
    if (attempt.deliveryMode === "legacy_pre_cutover") throw deliveryError("publication_not_delivered");
    const stored = this.acknowledgements.get(attempt.publicationId);
    if (stored) { if (stored.receipt !== receipt) throw deliveryError("publication_ack_conflict"); this._observe("duplicate_ack_suppressed", attempt); return stored.result; }
    if (attempt.state !== "sink_succeeded") throw deliveryError("publication_not_delivered");
    attempt.state = "acknowledged";
    const result = Object.freeze({ status: "acknowledged", ...receiptIdentity(receipt) });
    this.acknowledgements.set(attempt.publicationId, { receipt, result });
    this.activeByPublication.delete(attempt.publicationId);
    this._observe("publication_acknowledged", attempt);
    return result;
  }

  receiptFor(identity = {}) {
    const { gameSessionId, publicationId, consumerId, consumerGeneration, deliveryAttemptId, sinkType, deliveryMode, receiptId, modeTransitionId = null } = identity;
    if (![gameSessionId, publicationId, consumerId, deliveryAttemptId, sinkType, deliveryMode, receiptId].every(nonemptyString) || !Number.isSafeInteger(consumerGeneration) || !(modeTransitionId === null || nonemptyString(modeTransitionId))) throw deliveryError("invalid_sink_success_receipt");
    const attempt = this.attempts.get(deliveryAttemptId);
    if (gameSessionId !== this.gameSessionId || this.invalidated) { this._rejectStaleAck("stale_publication_session", attempt ?? identity); throw deliveryError("stale_publication_session"); }
    if (consumerGeneration !== this.consumerGeneration) { if (attempt) this._rejectStaleAck("stale_consumer_generation", attempt); throw deliveryError("stale_consumer_generation"); }
    if (!attempt || attempt.publicationId !== publicationId || attempt.consumerId !== consumerId || attempt.sinkType !== sinkType || attempt.deliveryMode !== deliveryMode || attempt.modeTransitionId !== modeTransitionId || attempt.receipt?.receiptId !== receiptId) throw deliveryError("publication_not_delivered");
    if (!attempt.receipt || !["sink_succeeded", "acknowledged", "evidence_recorded"].includes(attempt.state)) throw deliveryError("publication_not_delivered");
    return attempt.receipt;
  }

  stateFor(publicationId) { return this.acknowledgements.has(publicationId) ? "acknowledged" : this.preCutoverEvidence.has(publicationId) ? "evidence_recorded" : this.terminalFailures.has(publicationId) ? "failed_terminal" : this.activeByPublication.get(publicationId)?.state ?? "unseen"; }
  acknowledgedPublicationIds() { return new Set(this.acknowledgements.keys()); }

  invalidate() {
    this.invalidated = true;
    for (const attempt of this.attempts.values()) if (!["acknowledged", "evidence_recorded"].includes(attempt.state)) attempt.state = "stale_session";
    if (this.activeTransition) { this.activeTransition.status = "stale_session"; this._observeTransition("consumer_mode_transition_stale", this.activeTransition, "stale_publication_session"); }
    this.activeTransition = null;
    this.activeByPublication.clear();
    this.preCutoverEvidence.clear();
  }

  _validateDeliveryMode(deliveryMode) {
    if (!DELIVERY_MODES.has(deliveryMode)) throw deliveryError("publication_not_found");
    if (deliveryMode === "structured" && this.effectiveMode !== "structured") throw deliveryError("publication_not_found");
    if (deliveryMode === "legacy" && (this.effectiveMode !== "legacy" || this.committedCutoverPublicationSlotOrder === null)) throw deliveryError("publication_not_found");
    if (deliveryMode === "legacy_pre_cutover" && (this.effectiveMode !== "legacy" || this.committedCutoverPublicationSlotOrder !== null)) throw deliveryError("publication_not_found");
  }
  _hasUnsettledSink() { return [...this.attempts.values()].some((attempt) => ["in_flight", "sink_succeeded"].includes(attempt.state)); }
  _missingRequired(transition) { return transition.required.filter((identity) => !this._hasMatchingEvidence(identity)); }
  _hasMatchingEvidence(identity) { const stored = this.preCutoverEvidence.get(identity.publicationId)?.result; return Boolean(stored && ["compatibilityMappingId", "legacyEntryId", "legacyLogAppendOrder", "legacyEntryFingerprint"].every((key) => identity[key] === undefined || stored[key] === identity[key])); }
  _activeTransition(identity) { const transition = this.activeTransition; if (!transition) throw deliveryError("consumer_mode_transition_not_found"); this._assertTransitionIdentity(transition, identity); if (transition.status !== "draining_pre_cutover") throw deliveryError("consumer_mode_transition_conflict"); return transition; }
  _assertTransitionIdentity(transition, identity = {}) { if (transition.modeTransitionId !== identity.modeTransitionId || transition.gameSessionId !== identity.gameSessionId || transition.consumerId !== identity.consumerId || transition.sinkType !== identity.sinkType || (identity.proposedCutoverPublicationSlotOrder !== undefined && transition.proposedCutoverPublicationSlotOrder !== identity.proposedCutoverPublicationSlotOrder)) throw deliveryError(identity.gameSessionId !== this.gameSessionId ? "stale_publication_session" : "consumer_mode_transition_conflict"); }
  _transitionIdentity(transition) { return { modeTransitionId: transition.modeTransitionId, gameSessionId: transition.gameSessionId, consumerId: transition.consumerId, sinkType: transition.sinkType, proposedCutoverPublicationSlotOrder: transition.proposedCutoverPublicationSlotOrder }; }
  _transitionResult(transition, reasonCode) { return Object.freeze({ modeTransitionId: transition.modeTransitionId, gameSessionId: transition.gameSessionId, consumerId: transition.consumerId, sinkType: transition.sinkType, status: transition.status, requestedMode: transition.requestedMode, effectiveMode: transition.effectiveMode, proposedCutoverPublicationSlotOrder: transition.proposedCutoverPublicationSlotOrder, consumerGeneration: this.consumerGeneration, pendingCount: this._missingRequired(transition).length, ...(reasonCode ? { reasonCode } : {}) }); }
  _rejectTransition(code, value) { this._observeTransition("consumer_mode_transition_rejected", { ...value, gameSessionId: this.gameSessionId, status: "stable", modeTransitionId: null, proposedCutoverPublicationSlotOrder: null }, code); throw deliveryError(code); }
  _staleGenerationAttempts() { for (const attempt of this.attempts.values()) if (!["acknowledged", "evidence_recorded", "failed_terminal"].includes(attempt.state)) attempt.state = "stale_session"; this.activeByPublication.clear(); }
  _attempt(id) { this._live(); const attempt = this.attempts.get(id); if (!attempt) throw deliveryError("publication_not_prepared"); this._current(attempt); return attempt; }
  _current(attempt) { if (this.invalidated || attempt.gameSessionId !== this.gameSessionId) throw deliveryError("stale_publication_session"); if (attempt.consumerGeneration !== this.consumerGeneration) throw deliveryError("stale_consumer_generation"); }
  _currentAck(attempt) { if (this.invalidated || attempt.gameSessionId !== this.gameSessionId) { this._rejectStaleAck("stale_publication_session", attempt); throw deliveryError("stale_publication_session"); } if (attempt.consumerGeneration !== this.consumerGeneration) { this._rejectStaleAck("stale_consumer_generation", attempt); throw deliveryError("stale_consumer_generation"); } }
  _session(gameSessionId) { if (gameSessionId !== this.gameSessionId) throw deliveryError("stale_publication_session"); }
  _live() { if (this.invalidated) throw deliveryError("stale_publication_session"); }
  _rejectStaleAck(reasonCode, attempt) { this._observe("stale_ack_rejected", attempt, reasonCode); }
  _observe(outcomeCategory, attempt, reasonCode) { try { this.observer(Object.freeze({ gameSessionId: attempt.gameSessionId, publicationId: attempt.publicationId, deliveryAttemptId: attempt.deliveryAttemptId, consumerGeneration: attempt.consumerGeneration, sinkType: attempt.sinkType, deliveryMode: attempt.deliveryMode, ...(attempt.modeTransitionId ? { modeTransitionId: attempt.modeTransitionId } : {}), outcomeCategory, ...(reasonCode ? { reasonCode } : {}) })); } catch {} }
  _observeTransition(outcomeCategory, transition, reasonCode) { try { this.observer(Object.freeze({ gameSessionId: transition.gameSessionId, modeTransitionId: transition.modeTransitionId, consumerId: transition.consumerId, sinkType: transition.sinkType, status: transition.status, requestedMode: transition.requestedMode, effectiveMode: transition.effectiveMode, proposedCutoverPublicationSlotOrder: transition.proposedCutoverPublicationSlotOrder, consumerGeneration: this.consumerGeneration, outcomeCategory, ...(reasonCode ? { reasonCode } : {}) })); } catch {} }
}

const MODES = new Set(["legacy", "structured"]);
const DELIVERY_MODES = new Set(["structured", "legacy", "legacy_pre_cutover"]);

function publicAttempt(attempt) { return Object.freeze({ gameSessionId: attempt.gameSessionId, publicationId: attempt.publicationId, consumerId: attempt.consumerId, deliveryAttemptId: attempt.deliveryAttemptId, consumerGeneration: attempt.consumerGeneration, sinkType: attempt.sinkType, deliveryMode: attempt.deliveryMode, modeTransitionId: attempt.modeTransitionId, state: attempt.state, entry: attempt.rendered }); }
function receiptIdentity(receipt) { return Object.freeze({ gameSessionId: receipt.gameSessionId, publicationId: receipt.publicationId, consumerId: receipt.consumerId, consumerGeneration: receipt.consumerGeneration, deliveryAttemptId: receipt.deliveryAttemptId, sinkType: receipt.sinkType, deliveryMode: receipt.deliveryMode, modeTransitionId: receipt.modeTransitionId, receiptId: receipt.receiptId }); }
function validReceiptShape(receipt) { return receipt && [receipt.gameSessionId, receipt.publicationId, receipt.consumerId, receipt.deliveryAttemptId, receipt.sinkType, receipt.deliveryMode, receipt.receiptId].every(nonemptyString) && Number.isSafeInteger(receipt.consumerGeneration) && (receipt.modeTransitionId === null || nonemptyString(receipt.modeTransitionId)); }
function nonemptyString(value) { return typeof value === "string" && value.length > 0; }
function validateSinkIdentity(consumerId, sinkType) { if (!nonemptyString(consumerId) || !["browser", "cli"].includes(sinkType)) throw deliveryError("invalid_sink_success_receipt"); }
export function deliveryError(code) { const error = new Error(code); error.name = "PlayerPublicationDeliveryError"; error.code = code; return error; }
