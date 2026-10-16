/**
 * specs-two V8 Topical Graph Disambiguator. Deterministic clustering of an
 * interleaved timeline: reply links, then shared content words, then mentions.
 */

export interface TopicEntry {
  eventId: string;
  sender: string;
  body: string;
  inReplyTo?: string;
  mentions?: string[];
}

export interface Cluster {
  root: string;
  eventIds: string[];
}

const STOPWORDS = new Set(
  'the and for are but not you your yours our ours his her hers its they them their this that these those with from into onto than then there here what which who whom whose when where why how was were been being have has had having does did doing can could should would will shall may might must about above after again against all also any because before below between both each few further just more most other over own same some such too very only out off once under until while yes yeah okay thanks thank please let lets get got one two'.split(
    ' ',
  ),
);
const SIMILARITY = 0.15;

export function contentWords(body: string): Set<string> {
  const tokens = body
    .toLowerCase()
    .replace(/@[\w.=\-/]+:[\w.-]+/g, ' ')
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(tokens.filter((t) => t.length >= 3 && !STOPWORDS.has(t)));
}

const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
};

export function clusterConversation(history: TopicEntry[]): Cluster[] {
  const clusters: Array<Cluster & { vocab: Set<string> }> = [];
  const clusterOf = new Map<string, number>();
  const lastClusterOfSender = new Map<string, number>();

  const add = (index: number, e: TopicEntry, words: Set<string>) => {
    clusters[index].eventIds.push(e.eventId);
    for (const w of words) clusters[index].vocab.add(w);
    clusterOf.set(e.eventId, index);
    lastClusterOfSender.set(e.sender, index);
  };

  for (const e of history) {
    const words = contentWords(e.body);
    let target: number | undefined;
    if (e.inReplyTo && clusterOf.has(e.inReplyTo)) target = clusterOf.get(e.inReplyTo);
    if (target === undefined) {
      let best = 0;
      clusters.forEach((c, i) => {
        const score = jaccard(words, c.vocab);
        if (score >= SIMILARITY && score > best) {
          best = score;
          target = i;
        }
      });
    }
    if (target === undefined) {
      for (const m of e.mentions ?? []) {
        if (lastClusterOfSender.has(m)) {
          target = lastClusterOfSender.get(m);
          break;
        }
      }
    }
    if (target === undefined) {
      clusters.push({ root: e.eventId, eventIds: [], vocab: new Set() });
      target = clusters.length - 1;
    }
    add(target, e, words);
  }
  return clusters.map(({ root, eventIds }) => ({ root, eventIds }));
}
