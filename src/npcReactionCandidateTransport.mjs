import {
  NpcReactionCandidateProviderError,
  createNpcReactionCandidateHttpHandler
} from "./npcReactionCandidateProvider.mjs";

export function createLocalNpcReactionCandidateTransport({ provider, createServerCorrelationId }) {
  const handler = createNpcReactionCandidateHttpHandler({ provider, createServerCorrelationId });
  return Object.freeze({
    async generateCandidateTransport(request, { signal } = {}) {
      const response = await handler.handle({
        method: "POST",
        path: "/api/generate-npc-reaction-candidate",
        contentTypeHeader: "application/json; charset=utf-8",
        contentEncodingHeader: null,
        bodyBytes: new TextEncoder().encode(JSON.stringify(request))
      }, { signal });
      return responseToTransport(response);
    }
  });
}

export function responseToTransport(response) {
  if (response?.status !== 200) {
    const code = {
      provider_timeout: "timeout",
      provider_unavailable: "provider_unavailable",
      provider_auth_failure: "authentication_failure",
      invalid_provider_response: "malformed_provider_output"
    }[response?.body?.error?.code] ?? "invalid_transport_response";
    throw new NpcReactionCandidateProviderError(code, response?.body?.error?.retryable === true);
  }
  return Object.freeze({
    schemaVersion: 1,
    status: "success",
    transportEvidence: Object.freeze({
      schemaVersion: 1,
      evidenceType: "npc_reaction_candidate_http_success",
      httpStatus: 200,
      contentTypeHeader: response.headers["content-type"] ?? null,
      contentEncodingHeader: response.headers["content-encoding"] ?? null,
      bodyBytes: new TextEncoder().encode(JSON.stringify(response.body))
    })
  });
}
