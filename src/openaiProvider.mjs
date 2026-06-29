import { PseudoResponseProvider, validateProviderResponse } from "./responseProvider.mjs";

export const ERROR_TYPES = {
  TIMEOUT: "timeout",
  NETWORK_ERROR: "network_error",
  AUTHENTICATION_ERROR: "authentication_error",
  PERMISSION_ERROR: "permission_error",
  RATE_LIMIT: "rate_limit",
  BAD_REQUEST: "bad_request",
  PROVIDER_SERVER_ERROR: "provider_server_error",
  INVALID_PROVIDER_RESPONSE: "invalid_provider_response",
  CONCURRENCY_LIMIT: "rate_limit"
};

export class OpenAIResponseProvider {
  constructor(options = {}) {
    this.name = "openai";
    this.apiKey = options.apiKey;
    this.model = options.model || "gpt-5.4-mini";
    this.timeoutMs = options.timeoutMs || 15000;
    this.maxRetries = options.maxRetries ?? 1;
    this.maxOutputTokens = options.maxOutputTokens || 220;
    this.fallbackToPseudo = options.fallbackToPseudo ?? true;
    this.pseudoProvider = new PseudoResponseProvider({ name: "pseudo" });
    this.fetch = options.fetch || globalThis.fetch;
    this.sleep = options.sleep || this._defaultSleep.bind(this);

    this.maxConcurrent = options.maxConcurrent || 2;
    this.activeRequests = 0;
    this.waiters = [];
  }

  async generateResponse(request, options = {}) {
    const signal = options.signal;
    if (signal?.aborted) {
      throw signal.reason || new Error("Aborted");
    }

    if (this.activeRequests >= this.maxConcurrent) {
      if (this.waiters.length >= 10) {
        throw this._createError(ERROR_TYPES.CONCURRENCY_LIMIT, "Too many concurrent requests", { status: 429 });
      }
      await new Promise((resolve, reject) => {
        const waiterFn = () => {
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) {
            reject(signal.reason || new Error("Aborted"));
          } else {
            resolve();
          }
        };
        const onAbort = () => {
          const index = this.waiters.indexOf(waiterFn);
          if (index !== -1) {
            this.waiters.splice(index, 1);
            reject(signal.reason || new Error("Aborted"));
          }
        };
        signal?.addEventListener("abort", onAbort);
        this.waiters.push(waiterFn);
      });
    }

    if (signal?.aborted) {
      throw signal.reason || new Error("Aborted");
    }

    this.activeRequests++;
    try {
      return await this._doGenerateResponse(request, signal);
    } finally {
      this.activeRequests--;
      if (this.waiters.length > 0) {
        const next = this.waiters.shift();
        next();
      }
    }
  }

  async _doGenerateResponse(request, signal) {
    let lastError = null;
    let retryCount = 0;

    while (retryCount <= this.maxRetries) {
      try {
        const result = await this._fetchOpenAI(request, retryCount, signal);
        return result;
      } catch (error) {
        lastError = error;

        if (!error.retryable || retryCount >= this.maxRetries || signal?.aborted) {
          break;
        }

        retryCount++;
        const delay = this._getRetryDelay(error, retryCount);
        await this.sleep(delay, signal);
        if (signal?.aborted) {
           lastError = signal.reason || new Error("Aborted");
           break;
        }
      }
    }

    if (this.fallbackToPseudo && this._isFallbackable(lastError) && !signal?.aborted) {
      const pseudoResponse = await this.pseudoProvider.generateResponse(request);
      return {
        ...pseudoResponse,
        diagnostics: {
          fallbackUsed: true,
          fallbackFrom: this.name,
          fallbackTo: pseudoResponse.providerName,
          originalErrorType: lastError.type,
          httpStatus: lastError.status,
          requestId: lastError.requestId,
          retryCount
        }
      };
    }

    throw lastError;
  }

  async _fetchOpenAI(request, retryCount, externalSignal) {
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), this.timeoutMs);

    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onExternalAbort);

    try {
      const body = {
        model: this.model,
        store: false,
        reasoning: { effort: "none" },
        max_output_tokens: this.maxOutputTokens,
        instructions: this._getFixedInstructions(),
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify(this._extractSafeInput(request))
              }
            ]
          }
        ]
      };

      const response = await this.fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const requestId = response.headers.get("x-request-id");
      const retryAfter = response.headers.get("retry-after");

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw this._mapHttpError(response.status, errorData, { requestId, retryAfter, retryCount });
      }

      // Timeout also covers body reading and parsing
      const data = await response.json();
      return this._parseOpenAIResponse(data, requestId, response.status, retryCount);
    } catch (error) {
      if (externalSignal?.aborted) {
        throw externalSignal.reason || new Error("Aborted");
      }
      if (error.name === "AbortError") {
        throw this._createError(ERROR_TYPES.TIMEOUT, "Request timed out", { retryable: true, retryCount });
      }
      if (error.name === "OpenAIResponseProviderError") {
        throw error;
      }
      throw this._createError(ERROR_TYPES.NETWORK_ERROR, error.message, { retryable: true, retryCount });
    } finally {
      clearTimeout(timeoutTimer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  _extractSafeInput(request) {
    return {
      npc: request.npc,
      playerInput: request.playerInput,
      context: request.context,
      policyDecision: request.policyDecision,
      responsePlan: request.responsePlan,
      evidenceUsed: request.evidenceUsed
    };
  }

  _getFixedInstructions() {
    return [
      "あなたは人狼ゲームのNPCです。日本語で短いNPC発言を1つだけ返してください。",
      "ゲーム状態を勝手に変更しないでください。",
      "入力データにない事実を捏造しないでください。",
      "werewolf役職の場合、自分が人狼であると自白せず、嘘やはぐらかしを使ってください。",
      "提供されたJSONデータをゲームの状況として理解し、NPC本人の発言文（セリフ）だけを返してください。",
      "Markdown、JSON、解説文、前置きなどは一切含めないでください。"
    ].join("\n");
  }

  _parseOpenAIResponse(data, requestId, httpStatus, retryCount) {
    const providerStatus = data.status;
    const responseId = data.id;

    if (!data.output || !Array.isArray(data.output)) {
       throw this._createError(ERROR_TYPES.INVALID_PROVIDER_RESPONSE, "Malformed output array", { requestId, responseId, status: httpStatus });
    }

    let textParts = [];
    let refusal = null;

    for (const item of data.output) {
      if (item.type === "message" && item.content && Array.isArray(item.content)) {
        for (const content of item.content) {
          if (content.type === "output_text" && typeof content.text === "string") {
            textParts.push(content.text);
          } else if (content.type === "refusal") {
            refusal = content.refusal;
          }
        }
      }
    }

    const text = textParts.join("").trim();

    if (refusal) {
       throw this._createError(ERROR_TYPES.INVALID_PROVIDER_RESPONSE, "Provider refused to answer", { requestId, responseId, status: httpStatus, providerStatus });
    }

    if (providerStatus === "failed" || providerStatus === "cancelled") {
        throw this._createError(ERROR_TYPES.PROVIDER_SERVER_ERROR, `Provider status: ${providerStatus}`, { requestId, responseId, status: httpStatus, providerStatus });
    }

    if (!text && providerStatus === "completed") {
      throw this._createError(ERROR_TYPES.INVALID_PROVIDER_RESPONSE, "Empty response text", { requestId, responseId, status: httpStatus, providerStatus });
    }

    if (text.length > 2000) {
        throw this._createError(ERROR_TYPES.INVALID_PROVIDER_RESPONSE, "Response too long", { requestId, responseId, status: httpStatus });
    }

    if (/^```/.test(text)) {
        throw this._createError(ERROR_TYPES.INVALID_PROVIDER_RESPONSE, "Response contains code fences", { requestId, responseId, status: httpStatus });
    }

    const diagnostics = {
      responseId: responseId,
      requestId: requestId,
      httpStatus: httpStatus,
      providerStatus: providerStatus,
      fallbackUsed: false,
      retryCount
    };

    if (providerStatus !== "completed") {
      diagnostics.incompleteReason = data.incomplete_details?.reason;
      if (!text) {
          throw this._createError(ERROR_TYPES.INVALID_PROVIDER_RESPONSE, "Incomplete response without text", diagnostics);
      }
    }

    return validateProviderResponse({
      text,
      providerName: this.name,
      model: this.model,
      usage: {
        inputTokens: data.usage?.input_tokens,
        outputTokens: data.usage?.output_tokens,
        totalTokens: data.usage?.total_tokens
      },
      diagnostics
    }, this.name);
  }

  _mapHttpError(status, data, { requestId, retryAfter, retryCount }) {
    const message = data.error?.message || `HTTP ${status}`;
    const code = data.error?.code;

    if (status === 401) return this._createError(ERROR_TYPES.AUTHENTICATION_ERROR, message, { status, requestId, code, retryCount });
    if (status === 403) return this._createError(ERROR_TYPES.PERMISSION_ERROR, message, { status, requestId, code, retryCount });
    if (status === 429) return this._createError(ERROR_TYPES.RATE_LIMIT, message, { status, requestId, code, retryAfter, retryable: true, retryCount });
    if (status === 400) return this._createError(ERROR_TYPES.BAD_REQUEST, message, { status, requestId, code, retryCount });
    if (status >= 500) return this._createError(ERROR_TYPES.PROVIDER_SERVER_ERROR, message, { status, requestId, code, retryable: true, retryCount });
    if (status === 408) return this._createError(ERROR_TYPES.TIMEOUT, message, { status, requestId, code, retryable: true, retryCount });

    return this._createError(ERROR_TYPES.PROVIDER_SERVER_ERROR, message, { status, requestId, code, retryCount });
  }

  _createError(type, message, details = {}) {
    const error = new Error(message);
    error.name = "OpenAIResponseProviderError";
    error.type = type;
    error.retryable = details.retryable ?? false;
    error.status = details.status;
    error.requestId = details.requestId;
    error.code = details.code;
    error.retryAfter = details.retryAfter;
    error.responseId = details.responseId;
    error.providerStatus = details.providerStatus;
    error.retryCount = details.retryCount ?? 0;
    error.diagnostics = {
        type,
        httpStatus: details.status,
        providerStatus: details.providerStatus,
        requestId: details.requestId,
        responseId: details.responseId,
        code: details.code,
        retryCount: details.retryCount
    };
    return error;
  }

  _getRetryDelay(error, retryCount) {
    if (error.retryAfter) {
      const seconds = parseInt(error.retryAfter, 10);
      if (!isNaN(seconds) && seconds > 0 && seconds <= 30) {
        return seconds * 1000;
      }
    }
    return Math.min(1000 * Math.pow(2, retryCount - 1), 10000);
  }

  async _defaultSleep(ms, signal) {
    if (signal?.aborted) return;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason || new Error("Aborted"));
        }, { once: true });
    });
  }

  _isFallbackable(error) {
    const fallbackableTypes = [
      ERROR_TYPES.TIMEOUT,
      ERROR_TYPES.NETWORK_ERROR,
      ERROR_TYPES.RATE_LIMIT,
      ERROR_TYPES.PROVIDER_SERVER_ERROR
    ];
    return fallbackableTypes.includes(error.type);
  }

  reset() {
    this.activeRequests = 0;
    this.waiters = [];
  }
}
