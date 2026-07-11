import { enums } from "./domain.mjs";
import { validateAllowedCommentaryVariantProjections, validateCanonicalClaim, validateControlledCommentaryVariant, validatePublicEvent, validateSelectedCommentaryVariant } from "./validators.mjs";

const labels = Object.freeze({
  ja: Object.freeze({ roles: Object.freeze({ seer: "占い師", werewolf: "人狼", citizen: "市民" }), results: Object.freeze({ werewolf: "人狼", not_werewolf: "人狼ではない" }) }),
  en: Object.freeze({ roles: Object.freeze({ seer: "seer", werewolf: "werewolf", citizen: "citizen" }), results: Object.freeze({ werewolf: "a werewolf", not_werewolf: "not a werewolf" }) })
});

function language(locale) {
  if (!enums.supportedLocale.includes(locale)) throw new TypeError("unsupported locale");
  return locale.startsWith("ja") ? "ja" : "en";
}

function participant(participantsById, participantId) {
  const value = participantsById instanceof Map ? participantsById.get(participantId) : participantsById?.[participantId];
  if (!value || value.id !== participantId || typeof value.displayName !== "string") throw new TypeError(`unknown participant ${participantId}`);
  const length = [...value.displayName].length;
  if (length < 1 || length > 64 || /[<>&\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value.displayName)) throw new TypeError(`unsafe display name for ${participantId}`);
  return value.displayName;
}

function context(options) {
  if (!options || typeof options !== "object" || !options.participantsById) throw new TypeError("renderer requires an engine-owned participant projection");
  return { locale: options.locale, lang: language(options.locale), participantsById: options.participantsById };
}

export function renderCanonicalClaim(claim, options) {
  validateCanonicalClaim(claim);
  const { lang, participantsById } = context(options);
  const actor = participant(participantsById, claim.actorId);
  if (claim.type === "role_claim") return lang === "ja" ? `${actor}は${labels.ja.roles[claim.claimedRole]}を主張しました。` : `${actor} claimed to be a ${labels.en.roles[claim.claimedRole]}.`;
  const target = participant(participantsById, claim.targetId);
  return lang === "ja" ? `${actor}は${target}を${labels.ja.results[claim.result]}と判定しました。` : `${actor} claimed ${target} is ${labels.en.results[claim.result]}.`;
}

function renderTargetEvent(event, options, expectedType, jaText, enText) {
  validatePublicEvent(event);
  if (event.eventType !== expectedType) throw new TypeError(`expected ${expectedType}`);
  const { lang, participantsById } = context(options);
  const actor = participant(participantsById, event.actorId), target = participant(participantsById, event.targetId);
  return lang === "ja" ? jaText(actor, target) : enText(actor, target);
}

export function renderCanonicalVote(event, options) {
  return renderTargetEvent(event, options, "vote_declared", (a, t) => `${a}は${t}への投票を宣言しました。`, (a, t) => `${a} declared a vote for ${t}.`);
}

export function renderCanonicalSuspicion(event, options) {
  return renderTargetEvent(event, options, "suspicion_expressed", (a, t) => `${a}は${t}への疑いを表明しました。`, (a, t) => `${a} expressed suspicion of ${t}.`);
}

function registryIndex(registry) {
  const index = new Map();
  if (!Array.isArray(registry)) throw new TypeError("registry must be an array");
  for (const entry of registry) {
    validateControlledCommentaryVariant(entry);
    const key = `${entry.variantId}\0${entry.variantVersion}\0${entry.locale}`;
    if (index.has(key)) throw new TypeError("duplicate commentary registry key");
    index.set(key, entry);
  }
  return index;
}

export function validateRendererSelection(selection, allowedVariants, registry, expectedIntent) {
  validateSelectedCommentaryVariant(selection);
  validateAllowedCommentaryVariantProjections(allowedVariants);
  const allowed = allowedVariants.find((v) => v.variantId === selection.variantId && v.variantVersion === selection.variantVersion && v.locale === selection.locale);
  if (!allowed || allowed.intent !== expectedIntent) throw new TypeError("selection is not an allowed variant for the requested intent");
  const match = registryIndex(registry).get(`${selection.variantId}\0${selection.variantVersion}\0${selection.locale}`);
  if (!match || match.renderMode !== "controlled_commentary" || match.intent !== expectedIntent || match.enabled !== true || match.lifecycle !== "active" || [...match.text].length > match.maximumRenderedChars) throw new TypeError("registry entry is not eligible for a new selection");
  return match.text;
}

export function resolveHistoricalVariant(selection, registry) {
  validateSelectedCommentaryVariant(selection);
  const match = registryIndex(registry).get(`${selection.variantId}\0${selection.variantVersion}\0${selection.locale}`);
  if (!match) throw new TypeError("historical commentary variant does not exist");
  return match.text;
}

export const resolveSelectedCommentaryVariant = resolveHistoricalVariant;
