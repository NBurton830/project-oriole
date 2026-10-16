/**
 * specs-two V13 Linguistic Pragmatics & Non-Literal Sentiment Filter.
 * Three markers; a statement is figurative when its literal reading is a
 * disproportionate action AND it either carries mismatched sentiment or lacks
 * the parameters a real operational request would have.
 */

const DESTRUCTIVE = /\b(delete|drop|destroy|wipe|nuke|burn|torch|kill|shut ?down|format|rm -rf|set\b[^.?!]*\bon fire)\b/i;
const SWEEPING = /\b(entire|whole|every|all( the)?|everything|production|prod|servers|datacenter|data center|company|database|databases|cluster|table|tables)\b/i;
const ON_FIRE = /\bon fire\b/i;
const POSITIVE = /\b(fantastic|great|brilliant|wonderful|awesome|perfect|lovely|amazing|excellent|superb|genius|love)\b/i;
const NEGATIVE_OPS = /\b(outage|down|latency|error|errors|crash|crashed|broken|failing|fail|failed|incident|spike|slow|again|disaster|fire)\b/i;
const SARCASM_CUE = /\b(oh|just|why don't we|maybe we should|let's just|that'll|that will)\b/i;
const PARAMETERS = /(\b[A-Z]{2,}-\d+\b|\b[a-z]+(-[a-z0-9]+)*-\d+[a-z0-9-]*\b|(^|\s)--?[a-z][\w-]*|\bticket\b|\bchange request\b)/;

export function analyzePragmatics(body: string) {
  const disproportionate = (DESTRUCTIVE.test(body) && SWEEPING.test(body)) || ON_FIRE.test(body);
  const sentimentMismatch = POSITIVE.test(body) && (NEGATIVE_OPS.test(body) || disproportionate);
  const lacksParameters = !PARAMETERS.test(body);
  const figurative = disproportionate && (sentimentMismatch || (lacksParameters && SARCASM_CUE.test(body)));
  return { figurative, markers: { disproportionate, sentimentMismatch, lacksParameters } };
}
