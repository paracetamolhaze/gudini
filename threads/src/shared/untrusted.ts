/**
 * Foreign text (comments, chains, found posts, source publications) is handed to the models inside
 * an <untrusted_source_content> fence. A stranger who writes the closing tag in their own text would
 * end that fence early and have the rest of their message read as our instructions, so every foreign
 * string is passed through sanitizeUntrusted() before it is interpolated into a prompt.
 */
export const UNTRUSTED_TAG = "untrusted_source_content";

export const UNTRUSTED_OPEN = `<${UNTRUSTED_TAG}>`;
export const UNTRUSTED_CLOSE = `</${UNTRUSTED_TAG}>`;

// Opening and closing tag in any spelling a model would still read as a tag: any case, spaces around
// the slash and the name, a trailing self-closing slash or stray attributes.
const FENCE_TAG = /<\s*\/?\s*untrusted_source_content\b[^>]*>/giu;

/** Defangs the fence tags in a foreign string; the text stays readable, the tags stop being tags. */
export function sanitizeUntrusted(text: string): string {
  return text.replace(FENCE_TAG, `[${UNTRUSTED_TAG}]`);
}
