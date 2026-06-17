/**
 * Pure text helpers for QVAC output. No SDK, no platform — safe to run and test
 * anywhere. Lifted verbatim from rate's QVACService so every host shares one
 * implementation instead of drifting copies.
 */

/**
 * Clean a raw assistant completion into user-visible text:
 *  - drop `<think>…</think>` reasoning (small models leak it into content),
 *  - drop a leading `{"name":…,"arguments":…}` tool-call object some tiny models
 *    emit as plain text, keeping any natural-language sentence that follows.
 */
export function cleanAssistantVisibleText(text: string): string {
  let cleaned = text
    // Qwen-style reasoning sometimes arrives in contentText. Never show/speak it.
    .replace(/<think\b[\s\S]*?<\/think>/gi, ' ')
    .replace(/<think\b[\s\S]*$/gi, ' ')
    // Tool calls some models emit as text (<tool_call>{…}</tool_call>) are
    // extracted + executed by the Engine (see parse.ts); never show the tags.
    .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, ' ')
    .replace(/<tool_call\b[^>]*>[\s\S]*$/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Some small local models emit a tool-call object as plain text. Drop the
  // leading fragment and keep any natural-language sentence that follows.
  const toolPrefix = cleaned.match(/^\s*\{?\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*/i);
  if (toolPrefix) {
    cleaned = cleaned.slice(toolPrefix[0].length).replace(/^\s*\{?\s*/, '').trim();
  }

  return cleaned
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Make text safe for the SUPERTONIC TTS model: redact payment strings (so they
 * are never read aloud), strip markdown/code, normalize smart punctuation, and
 * drop any non-ASCII or backtick (U+0060) the model can't synthesize.
 */
export function sanitizeForSupertonic(text: string): string {
  const normalized = text
    .replace(/\b(?:lightning:)?ln(?:bc|tb|bcrt)[a-z0-9]{40,}\b/gi, 'Lightning invoice')
    .replace(/\blnurl[0-9a-z]{40,}\b/gi, 'Lightning payment link')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[`´ˋ′*_~#<>|[\]{}]/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[•·]/g, '. ')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ');

  return Array.from(normalized)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return (code === 0x09 || code === 0x0A || code === 0x0D || (code >= 0x20 && code <= 0x7E)) &&
        code !== 0x60;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}
