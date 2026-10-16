/** specs-two V16 machine-to-machine loop detection. */

export const ORIGIN_KEY = 'com.enterprise.agent.origin';

export function classifySender(event: { sender: string; content: Record<string, any> }, botPatterns: string[]): 'human' | 'bot' {
  if (event.content?.[ORIGIN_KEY]) return 'bot';
  return botPatterns.some((p) => new RegExp(p).test(event.sender)) ? 'bot' : 'human';
}

export function nextHop(incoming: { content: Record<string, any> }, incomingIsBot: boolean): number {
  if (!incomingIsBot) return 0;
  const hop = Number(incoming.content?.[ORIGIN_KEY]?.hop_count);
  return Number.isFinite(hop) ? hop + 1 : 1;
}

export const hopAllowed = (hop: number, maxHop = 2) => hop <= maxHop;
