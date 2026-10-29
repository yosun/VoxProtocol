/** Parser exceptions can contain a prefix of the input. Never propagate one
 * from a Secret Manager value into an operator's terminal or CI logs. */
export function parseSecretJson(value, label) {
  try { return JSON.parse(value); }
  catch { throw new Error(`${label} could not be decoded as JSON`); }
}
