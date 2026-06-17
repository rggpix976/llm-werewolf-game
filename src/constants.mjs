export const ROLES = Object.freeze({
  WEREWOLF: "werewolf",
  SEER: "seer",
  CITIZEN: "citizen"
});

export const TEAMS = Object.freeze({
  WEREWOLF: "werewolf",
  VILLAGE: "village"
});

export const PHASES = Object.freeze([
  "day_discussion",
  "player_question",
  "npc_response",
  "vote",
  "execution",
  "night",
  "seer_action",
  "werewolf_attack",
  "win_check"
]);

export function teamForRole(role) {
  return role === ROLES.WEREWOLF ? TEAMS.WEREWOLF : TEAMS.VILLAGE;
}

export function publicRoleName(role) {
  switch (role) {
    case ROLES.WEREWOLF:
      return "人狼";
    case ROLES.SEER:
      return "占い師";
    case ROLES.CITIZEN:
      return "市民";
    default:
      return role;
  }
}

export function publicTeamName(team) {
  return team === TEAMS.WEREWOLF ? "人狼陣営" : "村人陣営";
}
