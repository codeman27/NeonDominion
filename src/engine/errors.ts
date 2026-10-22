/** Thrown when an action violates the rules. Engines never partially apply an invalid action. */
export class GameRuleError extends Error {
  override name = 'GameRuleError';
}
