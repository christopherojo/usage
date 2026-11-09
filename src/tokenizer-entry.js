// Bundled into extension/vendor/tokenizer.js and loaded by the background
// service worker via importScripts(). Exposes self.UsageTokenizer.
import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";

let enc = null;
function encoder() {
  if (!enc) enc = new Tiktoken(o200k_base);
  return enc;
}

self.UsageTokenizer = {
  name: "o200k_base",
  count(text) {
    if (!text) return 0;
    try {
      return encoder().encode(text, [], []).length;
    } catch (e) {
      return Math.ceil(text.length / 4);
    }
  },
};
