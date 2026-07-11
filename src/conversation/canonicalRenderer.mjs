import { enums } from "./domain.mjs";

const JA = new Set(["ja", "ja-JP"]);
function localeOf(locale) { if (!enums.supportedLocale.includes(locale)) throw new TypeError("unsupported locale"); return JA.has(locale) ? "ja" : "en"; }

export function renderCanonicalClaim(claim, locale) {
  const lang = localeOf(locale);
  if (claim.type === "role_claim") return lang === "ja" ? `${claim.actorId}は${claim.claimedRole}を主張しました。` : `${claim.actorId} claimed ${claim.claimedRole}.`;
  if (claim.type === "result_claim") return lang === "ja" ? `${claim.actorId}は${claim.targetId}を${claim.result}と判定しました。` : `${claim.actorId} claimed ${claim.targetId} is ${claim.result}.`;
  throw new TypeError("unsupported canonical claim");
}

export function renderCanonicalVote(event, locale) {
  return localeOf(locale) === "ja" ? `${event.actorId}は${event.targetId}への投票を宣言しました。` : `${event.actorId} declared a vote for ${event.targetId}.`;
}

export function renderCanonicalSuspicion(event, locale) {
  return localeOf(locale) === "ja" ? `${event.actorId}は${event.targetId}への疑いを表明しました。` : `${event.actorId} expressed suspicion of ${event.targetId}.`;
}

export function resolveSelectedCommentaryVariant(selection, registry) {
  const match = registry.find((item) => item.variantId === selection.variantId && item.variantVersion === selection.variantVersion && item.locale === selection.locale);
  if (!match) throw new TypeError("selected commentary variant does not exist for the exact locale and version");
  return match.text;
}
